'use strict';
// Records the walkthrough that the hosted app shows people the first time they open it. Since
// 2026-11-01 (user's request) it shows the whole workflow in at most 30 seconds: a new test order
// with its products and delivery, the run followed step by step (sped up: a run takes minutes),
// its approval in the backoffice, the order at ORDER_EXTRACTED, and Logs / History.
// It films the real hosted app with the person's own accounts, so it PLACES A REAL STAGING TEST
// ORDER, which the run approves: it only does so with --place-order. Anything else that would
// change something is blocked (accounts, the live browser, Stop and answers, except stopping this
// run if staging asks a question).
//
//   node server/scripts/record-walkthrough.cjs --place-order [address] [--out <folder>]
//
// address: the hosted app, by default http://10.101.32.163/automation/ (Watsons network or VPN).
// Edge opens on it: sign in with your own account, whose testing and backoffice accounts are
// remembered under Accounts. The recording then goes on by itself, headless, in that session: an
// order of PLUs 24384 and 22467, Home Delivery, Express. The session is never written to disk; it
// ends by itself after 2 hours (signing it out would also take the person's runs waiting in line
// out of the line). The walkthrough is replaced only when the order reached ORDER_EXTRACTED.
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
const CRF = Number(process.env.WALKTHROUGH_CRF) || 10; // VP8 quality: lower is sharper and larger
const MAX_SECONDS = 30; // the video's length at most (user's request 2026-11-01)
const PRODUCTS = ['24384', '22467']; // both reached ORDER_EXTRACTED with Express in October
const STEPS = ['Order and delivery', 'Run and follow it', 'Backoffice approval', 'ORDER_EXTRACTED', 'Logs / History'];

// The staging backoffice's sign-in page (STAGING_BACKOFFICE_HOST, src/safety/staging-guard.ts). It
// must show before an order is placed, or the run could not approve it (2026-11-01: it was down for
// maintenance, HTTP 503, and two orders were placed but not approved).
const BACKOFFICE_LOGIN = 'https://backoffice.cmb8j9fjhz-apj3aswat1-s1-public.model-t.cc.commerce.ondemand.com/backoffice/login.zul';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Throws when the backoffice's sign-in page doesn't show its user-name field (nothing is typed). */
async function checkBackoffice(browser) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const response = await page.goto(BACKOFFICE_LOGIN, { timeout: 60_000 }).catch(() => null);
    if (await page.locator('input[name="j_username"]').waitFor({ state: 'visible', timeout: 45_000 }).then(() => true, () => false)) return;
    const title = await page.title().catch(() => '');
    throw new Error(`The staging backoffice's sign-in page does not show (HTTP ${response?.status() ?? 'no answer'}${title ? `, "${title}"` : ''}), so no order was placed. Try again when it is back.`);
  } finally {
    await context.close();
  }
}

// What the recording may ask the server: its session and live updates, the page's state and product
// check, placing the order, the history and its screenshots; and stopping its own run when staging
// asks a question (that take is then not used). Anything else is blocked.
function allowed(request) {
  const url = request.url();
  if (/\/api\/(session|events|state|check|run|history|screenshot)(\?|$)/.test(url)) return true;
  if (/\/api\/answer(\?|$)/.test(url)) return request.postDataJSON()?.action === 'stop';
  return false;
}

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

/**
 * Moves the mouse like a person (eased) and clicks; notes the captions' times; and marks the parts
 * to speed up: from fast(seconds) on, the recording is squeezed into that many seconds of video,
 * until realTime().
 */
class Director {
  constructor(page) {
    this.page = page;
    this.at = { x: 860, y: 420 };
    this.t0 = Date.now();
    this.cues = [];
    this.parts = [{ from: 0, seconds: null }];
  }
  now() {
    return (Date.now() - this.t0) / 1000;
  }
  mark(step, text) {
    this.cues.push({ at: this.now(), step, text });
  }
  fast(seconds) {
    this.parts.push({ from: this.now(), seconds });
  }
  realTime() {
    this.parts.push({ from: this.now(), seconds: null });
  }
  get speeding() {
    return this.parts.at(-1).seconds !== null;
  }
  hold(ms) {
    return sleep(ms);
  }
  async moveTo(x, y, ms = 550) {
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
    await sleep(140);
    await this.page.mouse.down();
    await sleep(70);
    await this.page.mouse.up();
  }
}

/**
 * The video's timeline: each part of the recording, where it starts in the video (out) and how long
 * it lasts there. Sped-up parts are shortened further when the whole would be longer than max.
 */
function timeline(parts, end, max = MAX_SECONDS) {
  const spans = parts.map((part, index) => ({ from: part.from, to: parts[index + 1]?.from ?? end, seconds: part.seconds }));
  const real = spans.filter((span) => span.seconds === null).reduce((sum, span) => sum + span.to - span.from, 0);
  const fast = spans.filter((span) => span.seconds !== null).reduce((sum, span) => sum + span.seconds, 0);
  const squeeze = real + fast > max ? (max - real) / fast : 1;
  if (squeeze < 0.4) throw new Error(`The take is too long: ${Math.round(real)} s at normal speed (the video may last ${max} s).`);
  let out = 0;
  return spans.map((span) => {
    const length = span.seconds === null ? span.to - span.from : span.seconds * squeeze;
    const piece = { ...span, out, length };
    out += length;
    return piece;
  });
}
/** Where a moment of the recording is in the video. */
function videoTime(pieces, at) {
  const piece = pieces.findLast((candidate) => candidate.from <= at) ?? pieces[0];
  const into = Math.min(Math.max(at - piece.from, 0), piece.to - piece.from);
  return piece.out + into * (piece.length / Math.max(piece.to - piece.from, 1e-6));
}
/** Which moment of the recording a moment of the video shows. */
function recordingTime(pieces, t) {
  const piece = pieces.findLast((candidate) => candidate.out <= t) ?? pieces[0];
  return piece.from + (t - piece.out) * ((piece.to - piece.from) / Math.max(piece.length, 1e-6));
}

/**
 * Follows the run until it reaches step (current or done) or ends. When staging asks a question, the
 * run is stopped (its answer "Stop automation") and the take given up.
 */
async function follow(page, step) {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const seen = await page.evaluate(
      (name) => ({
        reached: [...document.querySelectorAll('#steps li.wa-step')].some((li) => li.querySelector('.wa-step__name')?.textContent === name && /\b(current|done)\b/.test(li.className)),
        ended: !document.getElementById('result').hidden,
        asking: !document.getElementById('ask').hidden ? document.getElementById('ask').textContent.replace(/\s+/g, ' ').trim() : null,
      }),
      step,
    );
    if (seen.asking) {
      await page.locator('#ask button[data-action="stop"]').click();
      throw new Error(`The run asked a question, so it was stopped and the walkthrough not replaced: ${seen.asking.slice(0, 200)}`);
    }
    if (seen.ended || seen.reached) return seen;
    if (Date.now() > deadline) throw new Error(`The run did not reach "${step}" within 10 minutes; the walkthrough was not replaced.`);
    await sleep(400);
  }
}

/** The walkthrough itself: the order, its run, its approval, ORDER_EXTRACTED, Logs / History. */
async function film(page, d) {
  d.mark(0, 'Place new order: type the PLUs, one per line, then choose the delivery: Home Delivery, Express.');
  await d.hold(900);
  await d.click(page.locator('#products'), { fx: 0.3, fy: 0.1 });
  await page.keyboard.press('Control+A');
  await page.keyboard.type(PRODUCTS.join('\n'), { delay: 70 });
  await d.hold(400);
  await d.click(page.locator('input[name=delivery][value=home_delivery]'));
  await d.hold(250);
  await d.click(page.locator('input[name=mode][value=express]'));
  await d.hold(700);

  d.mark(1, 'Place test order, check the summary and confirm: the run starts on the server.');
  await d.click(page.locator('#run'));
  const confirm = page.locator('#confirm');
  await confirm.waitFor();
  await d.hold(1500);
  await d.click(confirm.getByRole('button', { name: 'Place test order' }));
  d.fast(0.6); // until the server has started it (or it waited in line)
  await page.locator('#steps li.wa-step.current').waitFor({ timeout: 10 * 60_000 });
  d.realTime();
  d.mark(1, 'It runs by itself, in about 4 minutes (sped up here): the steps tick off, and Live browser shows the shop.');
  await d.moveTo(125, 470); // out of the way, on the side navigation's empty part
  d.fast(6.5);
  if ((await follow(page, 'Backoffice login')).ended) throw new Error(`The run ended before the backoffice: ${await resultText(page)}`);
  d.realTime();
  const poster = await page.screenshot({ type: 'jpeg', quality: 80 });
  d.mark(2, 'Then it approves the order in the backoffice, with your backoffice account…');
  d.fast(3.5);
  await follow(page, 'the end');
  d.realTime();
  const verdict = (await page.locator('#result .verdict').textContent()).trim();
  const result = await resultText(page);
  if (verdict !== 'Completed' || !result.includes('The order is now ORDER_EXTRACTED') || /extraction still pending/i.test(result)) {
    const failure = await page.locator('#result .wa-failure').first().textContent({ timeout: 2000 }).catch(() => null);
    const order = await page.locator('#result .order-number').first().textContent({ timeout: 2000 }).catch(() => null);
    throw new Error(
      `The order did not reach ORDER_EXTRACTED, so the walkthrough was not replaced. The run: ${verdict}` +
        `${failure ? ` (${failure.replace(/\s+/g, ' ').trim()})` : ''}.` +
        `${order ? ` Order ${order.trim()} was placed: approve it from Logs / History (Approve) if it is still waiting.` : ''}`,
    );
  }
  d.mark(3, '…and waits until the order is ORDER_EXTRACTED: the run is Completed, with its order number.');
  await d.hold(2600);

  d.mark(4, 'Every run is kept in Logs / History with its screenshots: yours and your colleagues’.');
  await d.click(page.locator('#tab-history'));
  await page.locator('tr.hrow').first().waitFor();
  await d.hold(2300);
  return poster;
}
const resultText = (page) => page.locator('#result').evaluate((node) => node.textContent.replace(/\s+/g, ' ').trim());

/** Frames (JPEG, with their times) into a WebM of FPS frames a second along the timeline. */
async function encode(frames, pieces, file) {
  const length = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const ffmpeg = spawn(
    findFfmpeg(),
    // VP8 at "good" quality: sharp text, a few MB. The index goes first, for quick seeking.
    ['-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', 'pipe:0', '-an', '-vf', `scale=${SIZE.width}:${SIZE.height},format=yuv420p`]
      .concat(['-c:v', 'libvpx', '-deadline', 'good', '-cpu-used', '0', '-crf', String(CRF), '-b:v', '2000k', '-qmin', '0', '-qmax', '42', '-auto-alt-ref', '1', '-lag-in-frames', '16'])
      .concat(['-g', String(FPS * 3), '-cues_to_front', '1', '-y', file]),
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const exited = once(ffmpeg, 'exit');
  let index = 0;
  for (let n = 0; n / FPS <= length; n++) {
    const at = recordingTime(pieces, n / FPS);
    while (index + 1 < frames.length && frames[index + 1].at <= at) index++;
    if (!ffmpeg.stdin.write(frames[index].data)) await once(ffmpeg.stdin, 'drain');
  }
  ffmpeg.stdin.end();
  const [code] = await exited;
  if (code !== 0) throw new Error(`ffmpeg ended with code ${code}.`);
  return length;
}

/** Records the walkthrough from the hosted app at url, in an existing session (storageState), into out. */
async function record({ url, storageState, out = OUT_DIR, chromium, log = console.log, backofficeCheck = true }) {
  findFfmpeg(); // before anything else: it is needed at the end
  const browser = await chromium.launch({ channel: 'msedge' });
  try {
    if (backofficeCheck) await checkBackoffice(browser); // again, right before the order
    const context = await browser.newContext({ storageState, viewport: SIZE, deviceScaleFactor: 1, colorScheme: 'light', locale: 'en-GB', timezoneId: 'Asia/Singapore' });
    await context.route(/\/api\//, (route) => (allowed(route.request()) ? route.continue() : route.abort()));
    await context.addInitScript(pointerScript);
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => typeof token === 'string' && token !== '' && document.getElementById('user-name').textContent.trim() !== '', null, { timeout: 30_000 });
    await page.locator('input[name=automation][value=order]').check();
    const accounts = await page.evaluate(() => [info?.testingAccount?.set, info?.backofficeAccount?.set]);
    if (!accounts.every(Boolean)) throw new Error('Under Accounts, enter your testing and backoffice accounts in the app first (Remember ticked): the run places the order and approves it.');
    await page.mouse.move(860, 420);
    await sleep(800); // fonts, the history and the header in place

    const director = new Director(page);
    const frames = [];
    let kept = -Infinity;
    const cdp = await context.newCDPSession(page);
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      const at = (metadata.timestamp ?? Date.now() / 1000) - director.t0 / 1000;
      // Sped-up parts need far fewer frames (and a run lasts minutes).
      if (at - kept < (director.speeding ? 0.25 : 0.9 / FPS)) return;
      kept = at;
      frames.push({ at, data: Buffer.from(data, 'base64') });
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: SIZE.width, maxHeight: SIZE.height, everyNthFrame: 1 });
    await page.mouse.move(861, 421); // a first frame
    while (frames.length === 0) await sleep(20);
    director.t0 = Date.now();
    const poster = await film(page, director);
    await sleep(200);
    const end = director.now();
    await cdp.send('Page.stopScreencast');

    const pieces = timeline(director.parts, end);
    fs.mkdirSync(out, { recursive: true });
    const length = await encode(frames, pieces, path.join(out, 'walkthrough.webm'));
    fs.writeFileSync(path.join(out, 'walkthrough.jpg'), poster);
    const cues = director.cues.map((cue) => ({ start: Math.round(videoTime(pieces, cue.at) * 10) / 10, step: cue.step, text: cue.text }));
    const steps = STEPS.map((title, step) => ({ title, start: cues.find((cue) => cue.step === step)?.start ?? 0 }));
    const duration = Math.round(length * 10) / 10;
    fs.writeFileSync(path.join(out, 'walkthrough.json'), `${JSON.stringify({ recorded: new Date().toISOString().slice(0, 10), duration, steps, cues }, null, 2)}\n`);
    log(`${Math.round(end)} s recorded, ${duration} s of video, ${frames.length} frames → ${path.join(out, 'walkthrough.webm')} (${Math.round(fs.statSync(path.join(out, 'walkthrough.webm')).size / 1024)} KB)`);
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
    console.log(`Signed in as ${(await page.locator('#user-name').textContent()).trim()}. Recording (a real staging test order, about 5 minutes)…`);
    return await context.storageState();
  } finally {
    await browser.close();
  }
}

async function main(argv) {
  if (!argv.includes('--place-order')) {
    throw new Error('The walkthrough shows a whole run: recording it places a real STAGING test order (PLUs 24384 and 22467, Home Delivery, Express), which the run approves. Run it again with --place-order if that is OK.');
  }
  const out = argv.includes('--out') ? path.resolve(argv[argv.indexOf('--out') + 1]) : OUT_DIR;
  const url = argv.find((arg, index) => /^https?:\/\//.test(arg) && argv[index - 1] !== '--out') ?? ADDRESS;
  const { chromium } = require(require.resolve('@playwright/test', { paths: [path.join(__dirname, '..', '..')] }));
  findFfmpeg();
  // No sign-in, and no order, while the backoffice is down.
  const browser = await chromium.launch({ channel: 'msedge' });
  await checkBackoffice(browser).finally(() => browser.close());
  const storageState = await signIn(url, chromium);
  await record({ url, storageState, out, chromium });
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { record, signIn, checkBackoffice, timeline, videoTime, recordingTime, STEPS };
