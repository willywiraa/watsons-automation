'use strict';
// The live browser view of a run on the hosted server (user's request 2026-10-14): the person who
// started a run sees its browser in their page, and can click, scroll and type into it, as they
// could with a browser on their own PC.
//
// The run's browser (Playwright, headless Edge) also opens a DevTools port on this computer only
// (playwright.config.ts, WATSONS_LIVE_VIEW_PORT). This connects to that port with the Chrome
// DevTools Protocol, next to Playwright: screencast frames out, mouse and keyboard in. The run ends
// as soon as its test is done (2026-10-23: no keeping the last page open until Close browser).

const POLL_MS = 1000; // looking for the browser and its tabs
const FRAME_GAP_MS = 300; // at most about 3 frames a second to the person's windows
const SCREENCAST = { format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 };

// The keys passed on as key presses; everything else typed arrives as text (Input.insertText).
const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
};

/** One DevTools connection (a tab, or the browser itself): commands out, events in. */
class Connection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve());
      this.socket.addEventListener('error', () => reject(new Error('Could not connect to the browser.')));
    });
    // Whoever sends waits for it; a connection nobody used must not fail the whole service.
    this.opened.catch(() => {});
    this.socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        this.handlers.get(message.method)?.(message.params);
      }
    });
    this.socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('The browser connection closed.'));
      this.pending.clear();
    });
  }

  async send(method, params = {}) {
    await this.opened;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // already closed
    }
  }
}

const number = (value, max) => (Number.isFinite(value) && value >= 0 && value <= max ? value : null);

class LiveView {
  /** port: the run's DevTools port. send(event, data): to the run owner's open windows. */
  constructor({ runId, port, send }) {
    this.runId = runId;
    this.port = port;
    this.send = send;
    this.state = 'connecting'; // until the browser is there; then "on"; "ended" when stopped
    this.tabs = []; // [{ id, title, url, ws, seenAt }]
    this.selected = null; // the tab shown
    this.picked = false; // the person chose a tab themselves
    this.connection = null; // to the selected tab
    this.lastFrame = null; // { runId, targetId, data, width, height }
    this.lastSentAt = 0;
    this.frameTimer = null;
    this.stopped = false;
  }

  get base() {
    return `http://127.0.0.1:${this.port}`;
  }

  start() {
    this.timer = setInterval(() => this.poll().catch(() => {}), POLL_MS);
    this.timer.unref?.();
    this.poll().catch(() => {});
  }

  /** Looks for the browser's tabs; shows the newest one unless the person picked one. */
  async poll() {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const response = await fetch(`${this.base}/json/list`, { signal: AbortSignal.timeout(2_000) });
      const targets = (await response.json()).filter((target) => target.type === 'page' && target.webSocketDebuggerUrl && !String(target.url).startsWith('devtools://'));
      if (this.stopped) return;
      const before = new Map(this.tabs.map((tab) => [tab.id, tab]));
      this.tabs = targets.map((target) => ({
        id: target.id,
        title: String(target.title || target.url || 'Tab').slice(0, 80),
        url: String(target.url),
        ws: target.webSocketDebuggerUrl,
        seenAt: before.get(target.id)?.seenAt ?? Date.now(),
      }));
      const newest = [...this.tabs].sort((a, b) => b.seenAt - a.seenAt)[0];
      const selectedGone = !this.tabs.some((tab) => tab.id === this.selected);
      if (newest && (selectedGone || (!this.picked && newest.id !== this.selected))) await this.show(newest.id);
      const changed = this.state !== 'on' || this.tabs.length !== before.size || this.tabs.some((tab) => before.get(tab.id)?.title !== tab.title);
      this.state = 'on';
      if (changed) this.announce();
    } catch {
      // The browser isn't up yet (or has just closed): try again at the next poll.
    } finally {
      this.polling = false;
    }
  }

  /** What the person's windows know: whether it's on, the tabs and which one is shown. */
  announce() {
    this.send('live', {
      runId: this.runId,
      state: this.state,
      tabs: this.tabs.map(({ id, title }) => ({ id, title })),
      selected: this.selected,
    });
  }

  async show(targetId) {
    const tab = this.tabs.find((candidate) => candidate.id === targetId);
    if (!tab || this.stopped) return;
    this.connection?.close();
    this.selected = targetId;
    const connection = new Connection(tab.ws);
    this.connection = connection;
    connection.on('Page.screencastFrame', (params) => {
      connection.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
      if (connection !== this.connection) return;
      this.lastFrame = { runId: this.runId, targetId, data: params.data, width: params.metadata.deviceWidth, height: params.metadata.deviceHeight };
      this.sendFrameSoon();
    });
    try {
      await connection.send('Page.startScreencast', SCREENCAST);
    } catch {
      // The tab closed meanwhile: the next poll shows another one.
    }
    this.announce();
  }

  /** At most one frame every FRAME_GAP_MS, always ending on the latest one. */
  sendFrameSoon() {
    if (this.frameTimer) return;
    const wait = Math.max(0, this.lastSentAt + FRAME_GAP_MS - Date.now());
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      this.lastSentAt = Date.now();
      if (this.lastFrame && !this.stopped) this.send('frame', this.lastFrame);
    }, wait);
  }

  /** For a window that opens while the run goes on: where things are, and the latest frame. */
  replay(write) {
    write('live', { runId: this.runId, state: this.state, tabs: this.tabs.map(({ id, title }) => ({ id, title })), selected: this.selected });
    if (this.lastFrame) write('frame', this.lastFrame);
  }

  /** The person chose a tab. Returns what's wrong, or null. */
  async select(targetId) {
    if (!this.tabs.some((tab) => tab.id === targetId)) return 'That tab is no longer open.';
    this.picked = true;
    await this.show(targetId);
    return null;
  }

  /**
   * A click, scroll or typing from the person's page, on the tab shown. x and y are in the page's
   * pixels (the frame's width and height). Returns what's wrong, or null.
   */
  async input(event) {
    const connection = this.connection;
    if (this.state !== 'on' || !connection) return 'The browser is not showing yet.';
    const x = number(event?.x, 10_000);
    const y = number(event?.y, 10_000);
    try {
      switch (event?.kind) {
        case 'click': {
          if (x === null || y === null) return 'A click needs a position.';
          await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
          return null;
        }
        case 'wheel': {
          if (x === null || y === null) return 'Scrolling needs a position.';
          const deltaY = Math.max(-5_000, Math.min(5_000, Number(event.deltaY) || 0));
          const deltaX = Math.max(-5_000, Math.min(5_000, Number(event.deltaX) || 0));
          await connection.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
          return null;
        }
        case 'text': {
          const text = typeof event.text === 'string' ? event.text.slice(0, 500) : '';
          if (!text) return 'Nothing to type.';
          await connection.send('Input.insertText', { text });
          return null;
        }
        case 'key': {
          const key = Object.hasOwn(KEYS, event.key) ? KEYS[event.key] : null;
          if (!key) return 'That key is not passed on.';
          const base = { key: event.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
          await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(key.text ? { text: key.text } : {}) });
          await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
          return null;
        }
        default:
          return 'Unknown input.';
      }
    } catch {
      return 'The browser did not take it (the tab may have just closed).';
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.frameTimer);
    this.connection?.close();
    this.state = 'ended';
    this.send('live', { runId: this.runId, state: 'ended', tabs: [], selected: null });
  }
}

module.exports = { LiveView, KEYS };
