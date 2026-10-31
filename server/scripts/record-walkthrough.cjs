'use strict';
// Records the walkthrough that the hosted app shows people the first time they open it
// (2026-10-31): Logs / History, searched for an order and filtered by status, a run opened, its
// screenshots, and what the statuses mean. It films the real page of the hosted app with its real
// history, and only looks: the requests that would change something are blocked.
//
//   node server/scripts/record-walkthrough.cjs [address] [--order <8 digits>] [--out <folder>]
//
// address: the hosted app, by default http://10.101.32.163/automation/ (Watsons network or VPN).
// Edge opens on it: sign in with your own account. The recording then goes on by itself, headless,
// in that session. The session is never written to disk; it ends by itself after 2 hours (signing
// it out would also take the person's runs waiting in line out of the line).
// --order: the order searched for (default: the newest completed order with screenshots).
// Writes server/walkthrough/: walkthrough.webm (VP8), walkthrough.jpg (its poster) and
// walkthrough.json (its steps and captions, timed). Needs Playwright's ffmpeg, once:
//   npx playwright install ffmpeg

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const ADDRESS = 'http://10.101.32.163/automation/';
const OUT_DIR = path.join(__dirname, '..', 'walkthrough');
const SIZE = { width: 1280, height: 720 };
const FPS = 30;
const CRF = Number(process.env.WALKTHROUGH_CRF) || 14; // VP8 quality: lower is sharper and larger
const STEPS = ['Open Logs / History', 'Search and filter', 'Open a run', 'See its screenshots', 'Know the statuses'];
const STATUS_TEXT = {
  completed: 'Completed: the run did all its steps. The order was placed and approved, or the approval was done.',
  awaiting_approval: 'Awaiting approval: the order is placed, and someone with a backoffice account still has to approve it.',
  failed: 'Failed: the run hit a problem. The Error column shows its code; the run’s details show the step and a screenshot.',
  stopped: 'Stopped: someone pressed Stop before the run finished. “Check the order” means it may already have been placed.',
};
// What the recording may ask the server: the session, live updates, the page's state and product
// check, the history and its screenshots. Anything else (a run, Stop, an answer, an account, signing
// out) is blocked.
const ALLOWED = /\/api\/(session|events|state|check|history|screenshot)(\?|$)/;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Playwright's ffmpeg (npx playwright install ffmpeg): VP8 in WebM, from JPEG frames. */
function findFfmpeg() {
  const home = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  const found = fs.existsSync(home)
    ? fs
        .readdirSync(home)
        .filter((name) => /^ffmpeg-\d+$/.test(name))
        .sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)))
        .map((name) => path.join(home, name, process.platform === 'win32' ? 'ffmpeg-win64.exe' : 'ffmpeg-linux'))
        .find((file) => fs.existsSync(file))
    : undefined;
  if (!found) throw new Error('Playwright’s ffmpeg is missing. Install it once: npx playwright install ffmpeg');
  return found;
}

// A mouse pointer drawn into the page (a headless browser draws none). It follows the real mouse
// events, and a ring shows each click. It is a popover, raised again whenever a dialog opens, so it
// stays above the page's dialogs.
function pointerScript() {
  try {
    localStorage.setItem('wa-theme', 'light');
    localStorage.setItem('wa-walkthrough-seen', '1'); // the walkthrough itself stays closed
  } catch {}
  const add = () => {
    const style = document.createElement('style');
    style.textContent =
      '#wt-pointer{position:fixed;inset:auto;left:0;top:0;width:26px;height:26px;margin:0;padding:0;border:0;background:none;overflow:visible;pointer-events:none;transform:translate(-100px,-100px);filter:drop-shadow(0 1px 2px rgb(0 0 0 / .35))}' +
      '#wt-pointer svg{display:block}' +
      '#wt-pointer i{position:absolute;left:-17px;top:-19px;width:44px;height:44px;border-radius:50%;border:3px solid #00787a;opacity:0}' +
      '#wt-pointer i.on{animation:wt-ring .5s ease-out}' +
      '@keyframes wt-ring{from{opacity:.9;transform:scale(.35)}to{opacity:0;transform:scale(1.2)}}';
    const pointer = document.createElement('div');
    pointer.id = 'wt-pointer';
    pointer.popover = 'manual';
    pointer.innerHTML =
      '<i></i><svg width="26" height="26" viewBox="0 0 26 26"><path d="M5 3v18.5l4.9-4.6 3.1 7 3.2-1.4-3.1-6.9H20z" fill="#fff" stroke="#15191d" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.head.append(style);
    document.body.append(pointer);
    const raise = () => {
      if (pointer.matches(':popover-open')) pointer.hidePopover();
      pointer.showPopover();
    };
    raise();
    new MutationObserver(raise).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
    const ring = pointer.querySelector('i');
    window.__wtRing = () => {
      ring.classList.remove('on');
      void ring.offsetWidth;
      ring.classList.add('on');
    };
    document.addEventListener('mousedown', window.__wtRing, true);
    document.addEventListener('mousemove', (event) => (pointer.style.transform = `translate(${event.clientX - 5}px,${event.clientY - 3}px)`), true);
  };
  if (document.body) add();
  else document.addEventListener('DOMContentLoaded', add);
}

/** Moves the mouse like a person (eased), clicks, picks, and notes the captions' times. */
class Director {
  constructor(page) {
    this.page = page;
    this.at = { x: 860, y: 420 };
    this.t0 = Date.now();
    this.cues = [];
  }
  now() {
    return (Date.now() - this.t0) / 1000;
  }
  mark(step, text) {
    this.cues.push({ start: Math.round(this.now() * 10) / 10, step, text });
  }
  hold(ms) {
    return sleep(ms);
  }
  async moveTo(x, y, ms = 650) {
    const from = this.at;
    const steps = Math.max(8, Math.round(ms / 16));
    const started = Date.now();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const eased = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
      await this.page.mouse.move(from.x + (x - from.x) * eased, from.y + (y - from.y) * eased);
      const wait = started + t * ms - Date.now();
      if (wait > 0) await sleep(wait);
    }
    this.at = { x, y };
  }
  /** Onto an element: fx and fy are where on it, as fractions of its width and height. */
  async moveOnto(locator, { fx = 0.5, fy = 0.5, ms } = {}) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) throw new Error(`Not on the page: ${locator}`);
    await this.moveTo(Math.round(box.x + box.width * fx), Math.round(box.y + box.height * fy), ms);
  }
  async click(locator, options) {
    await this.moveOnto(locator, options);
    await sleep(160);
    await this.page.mouse.down();
    await sleep(70);
    await this.page.mouse.up();
  }
  /** A <select>: its list is drawn outside the page, so the click is shown and the option set. */
  async pick(select, value) {
    await this.moveOnto(select, { fx: 0.62 });
    await sleep(160);
    await this.page.evaluate(() => window.__wtRing?.());
    await sleep(220);
    await select.selectOption(value);
  }
}

/** The run to search for: the given order, else the newest completed order with screenshots. */
function chooseRun(rows, orderNumber) {
  const shown = (row) => row.orderNumber && row.screenshots?.length > 0 && row.evidenceState !== 'deleted';
  const run = orderNumber
    ? rows.find((row) => row.orderNumber === orderNumber && shown(row))
    : (rows.find((row) => row.status === 'completed' && row.automation === 'order' && shown(row) && row.screenshots.length >= 3) ??
      rows.find((row) => row.status === 'completed' && shown(row)) ??
      rows.find(shown));
  if (!run) throw new Error(orderNumber ? `No run of order ${orderNumber} with screenshots in Logs / History.` : 'No run with an order number and screenshots in Logs / History.');
  return run;
}

/** The walkthrough itself (about a minute). */
async function film(page, director, run, statuses) {
  const d = director;
  const imageShown = () => page.waitForFunction(() => document.getElementById('viewer-img').complete && document.getElementById('viewer-img').naturalWidth > 0);
  let poster = null;

  d.mark(0, 'Logs / History keeps every run, yours and your colleagues’, with its screenshots.');
  await d.hold(1600);
  await d.click(page.locator('#tab-history'));
  await page.locator('tr.hrow').first().waitFor();
  await d.hold(1200);
  poster = await page.screenshot({ type: 'jpeg', quality: 80 });
  await d.hold(1300);

  d.mark(1, 'Search by order number, PLU, error code or operator. The filters narrow the list down, e.g. by status.');
  await d.click(page.locator('#history-search'), { fx: 0.3 });
  await page.keyboard.type(run.orderNumber, { delay: 120 });
  await d.hold(1400);
  await d.pick(page.locator('#history-status'), run.status);
  await d.hold(2000);

  d.mark(2, 'Click a run to open it: what happened, its products and steps, who ran it and when.');
  const row = page.locator(`tr.hrow[data-run="${run.runId}"]`);
  await d.click(row.locator('td').nth(1));
  const details = page.locator(`[id="run-${run.runId}"]`);
  await details.waitFor();
  await details.evaluate((node) => node.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  await d.hold(4000);

  d.mark(3, 'The screenshots are the run’s evidence. Click one to see it full size; the arrows show the others.');
  await d.click(details.locator('.p-x__shot').first());
  await page.locator('#viewer').waitFor();
  await imageShown();
  await d.hold(2200);
  for (let i = 1; i < Math.min(3, run.screenshots.length); i++) {
    await d.click(page.locator('#viewer-next'));
    await imageShown();
    await d.hold(1900);
  }
  await d.click(page.locator('#viewer-close'));
  await d.hold(600);

  d.mark(4, 'Each run ends with a status, shown in colour. The Status filter lists the runs of one status.');
  await d.click(row.locator('td').nth(1)); // closes the run again
  await d.click(page.locator('#history-search'), { fx: 0.3 });
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await d.pick(page.locator('#history-status'), 'all');
  await d.hold(1600);
  for (const status of statuses) {
    await d.pick(page.locator('#history-status'), status);
    d.mark(4, STATUS_TEXT[status]);
    await d.hold(3400);
  }
  await d.pick(page.locator('#history-status'), 'all');
  d.mark(4, 'That’s it. Open this walkthrough again any time with Walkthrough, at the top of the page.');
  await d.hold(2800);
  return poster;
}

/** Frames (JPEG, with their times) into a WebM of FPS frames a second, each frame shown until the next. */
async function encode(frames, from, to, file) {
  const ffmpeg = spawn(
    findFfmpeg(),
    // VP8 at "good" quality: sharp text, a few MB a minute. The index goes first, for quick seeking.
    ['-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', 'pipe:0', '-an', '-vf', `scale=${SIZE.width}:${SIZE.height},format=yuv420p`]
      .concat(['-c:v', 'libvpx', '-deadline', 'good', '-cpu-used', '0', '-crf', String(CRF), '-b:v', '1500k', '-qmin', '0', '-qmax', '42', '-auto-alt-ref', '1', '-lag-in-frames', '16'])
      .concat(['-g', String(FPS * 3), '-cues_to_front', '1', '-y', file]),
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const exited = once(ffmpeg, 'exit');
  let index = 0;
  for (let n = 0; from + n / FPS <= to; n++) {
    const t = from + n / FPS;
    while (index + 1 < frames.length && frames[index + 1].at <= t) index++;
    if (!ffmpeg.stdin.write(frames[index].data)) await once(ffmpeg.stdin, 'drain');
  }
  ffmpeg.stdin.end();
  const [code] = await exited;
  if (code !== 0) throw new Error(`ffmpeg ended with code ${code}.`);
}

/** Records the walkthrough from the hosted app at url, in an existing session (storageState), into out. */
async function record({ url, storageState, orderNumber = null, out = OUT_DIR, chromium, log = console.log }) {
  findFfmpeg(); // before anything else: it is needed at the end
  const browser = await chromium.launch({ channel: 'msedge' });
  try {
    const context = await browser.newContext({ storageState, viewport: SIZE, deviceScaleFactor: 1, colorScheme: 'light', locale: 'en-GB', timezoneId: 'Asia/Singapore' });
    await context.route(/\/api\//, (route) => (ALLOWED.test(route.request().url()) ? route.continue() : route.abort()));
    await context.addInitScript(pointerScript);
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => typeof token === 'string' && token !== '' && !document.getElementById('user-menu-wrap').hidden && document.getElementById('login').hidden, null, { timeout: 30_000 });
    const rows = (await page.evaluate(() => api('api/history').then((answer) => answer.data.rows))) ?? [];
    const run = chooseRun(rows, orderNumber);
    const statuses = ['completed', 'awaiting_approval', 'failed', 'stopped'].filter((status) => rows.some((row) => row.status === status));
    log(`Order ${run.orderNumber} (${run.runId}, ${run.screenshots.length} screenshots); statuses shown: ${statuses.join(', ')}.`);
    await page.mouse.move(860, 420);
    await sleep(800); // fonts, the history and the header in place

    const frames = [];
    const cdp = await context.newCDPSession(page);
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      frames.push({ at: metadata.timestamp ?? Date.now() / 1000, data: Buffer.from(data, 'base64') });
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: SIZE.width, maxHeight: SIZE.height, everyNthFrame: 1 });
    await page.mouse.move(861, 421); // a first frame
    while (frames.length === 0) await sleep(20);
    const director = new Director(page);
    const from = director.t0 / 1000;
    const poster = await film(page, director, run, statuses);
    await sleep(200);
    const to = Date.now() / 1000;
    await cdp.send('Page.stopScreencast');

    fs.mkdirSync(out, { recursive: true });
    await encode(frames, from, to, path.join(out, 'walkthrough.webm'));
    fs.writeFileSync(path.join(out, 'walkthrough.jpg'), poster);
    const steps = STEPS.map((title, step) => ({ title, start: director.cues.find((cue) => cue.step === step)?.start ?? 0 }));
    const duration = Math.round((to - from) * 10) / 10;
    fs.writeFileSync(path.join(out, 'walkthrough.json'), `${JSON.stringify({ recorded: new Date().toISOString().slice(0, 10), duration, steps, cues: director.cues }, null, 2)}\n`);
    log(`${duration} s, ${frames.length} frames → ${path.join(out, 'walkthrough.webm')} (${Math.round(fs.statSync(path.join(out, 'walkthrough.webm')).size / 1024)} KB)`);
  } finally {
    await browser.close();
  }
}

/** Edge on the hosted app: the person signs in; their session, in memory only. */
async function signIn(url, chromium) {
  const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--start-maximized'] });
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    await page.goto(url);
    await page.bringToFront();
    console.log(`Sign in, in the Edge window that opened (${url}).`);
    // Signed in: the session cookie is there, the sign-in form is hidden and the page shows the
    // person's name (the user menu itself shows before the page has asked the server).
    const signedIn = async () =>
      (await context.cookies()).some((cookie) => cookie.name === 'wt_session' && cookie.value) &&
      (await page.evaluate(() => document.getElementById('login').hidden && document.getElementById('user-name').textContent.trim() !== ''));
    for (const until = Date.now() + 20 * 60_000; !(await signedIn().catch(() => false)); await page.waitForTimeout(1000)) {
      if (Date.now() > until) throw new Error('No sign-in within 20 minutes.');
    }
    console.log(`Signed in as ${(await page.locator('#user-name').textContent()).trim()}. Recording…`);
    return await context.storageState();
  } finally {
    await browser.close();
  }
}

async function main(argv) {
  const option = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? null : argv[at + 1];
  };
  const url = argv.find((arg, index) => /^https?:\/\//.test(arg) && !['--order', '--out'].includes(argv[index - 1])) ?? ADDRESS;
  const orderNumber = option('--order');
  if (orderNumber && !/^\d{8}$/.test(orderNumber)) throw new Error('--order: the order number’s 8 digits, e.g. 07128001.');
  const { chromium } = require(require.resolve('@playwright/test', { paths: [path.join(__dirname, '..', '..')] }));
  findFfmpeg();
  const storageState = await signIn(url, chromium);
  await record({ url, storageState, orderNumber, out: option('--out') ? path.resolve(option('--out')) : OUT_DIR, chromium });
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { record, chooseRun, STEPS };
