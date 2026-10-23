'use strict';
// A stand-in for Playwright's command line, used by tests/launcher.spec.ts. It prints the steps
// the way tests/order.e2e.spec.ts and tests/approve.e2e.spec.ts do and writes
// reports/<run>/result.json (and screenshots), without a browser and without opening any website.
//   Order runs:   PLU 404 fails at "Product Search" (with a failure screenshot).
//                 PLU 99 hangs (with a child process standing in for the browser) until the
//                 launcher stops it. PLU 46465 is "not available" for the chosen mode (Express or
//                 Standard, from the order file) and left out.
//   Approve runs: order 00000404 is not found in the backoffice (with a failure screenshot);
//                 order 11111111 is already extracted ("no change"); others are approved.
//   PLU 777: (a bug that never happens in the real tests) writes the shop and backoffice passwords
//            into its log, so tests/server.spec.ts can check that the server finds and removes them.
//   Placing an order without a backoffice account: stops at "Order confirmation", not approved.
//   Questions (WATSONS_INTERACTIVE=yes, as the launcher sets it; src/utils/ask.ts): PLU 3333 is out
//            of stock at "Product Search"; PLU 4444 can't go Express ("<Mode> Delivery Selection");
//            the add of PLU 5555 fails once ("Add to bag"). The run waits for answer-<id>.json.
//   PLU 555: a real browser for the hosted server's live view (with WATSONS_LIVE_VIEW_PORT and
//            FAKE_PLAYWRIGHT_MODULE, the path of Playwright): headless Edge with that DevTools port,
//            showing a page that logs clicks and typing ("fake page: …"). Its last step lasts until
//            the page was clicked (and then left alone for 2 s); then the run ends, browser too.
//   Approving order 22222222, or an order with PLU 2222: ends at "Order Split", extraction pending.
// It prints only fingerprints of the accounts it received (first 8 hex digits of a SHA-256), never them.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const fingerprint = (value) => (value ? crypto.createHash('sha256').update(value).digest('hex').slice(0, 8) : 'none');

// A 1×1 PNG: the "screenshot" the fake browser takes.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const approving = process.argv.includes('--project=approve');
const placeOrder = process.env.WATSONS_PLACE_ORDER === 'yes';
const orderNumberToApprove = process.env.WATSONS_APPROVE_ORDER;
const orderText = approving ? '' : fs.readFileSync(process.env.WATSONS_ORDER_FILE, 'utf8');
const products = orderText
  .split(/\r?\n/)
  .filter((line) => /^\d/.test(line))
  .map((line) => {
    const [plu, quantity] = line.split(' ');
    return { plu, quantity: Number(quantity ?? 1) };
  });
const methods = { 'Home Delivery': 'home_delivery', 'Click & Collect': 'click_collect', 'Shell Station': 'shell_station' };
// The person's answers can change the delivery and the products.
let method = methods[orderText.match(/^delivery: (.+)$/m)?.[1]];
let mode = /^mode: standard\s*$/im.test(orderText) ? 'standard' : 'express';
let modeName = mode === 'standard' ? 'Standard' : 'Express';
let excluded = products.filter((line) => line.plu === '46465');
let ordered = products.filter((line) => line.plu !== '46465');
const soldOut = [];
const steps = approving
  ? ['Backoffice login', 'Find order in backoffice', 'Approve order', 'Order extracted']
  : ['Login', 'Empty bag', 'Product Search', 'Add to bag', 'Cart validation', `${modeName} Delivery Selection`];
// Like tests/order.e2e.spec.ts: a new order is approved only with a backoffice account (2026-10-14).
const approvesNewOrder = placeOrder && Boolean(process.env.WATSONS_BACKOFFICE_USERNAME);
if (placeOrder) steps.push('Checkout', 'Pay', 'OTP', 'Order confirmation');
if (approvesNewOrder) steps.push('Backoffice login', 'Find order in backoffice', 'Approve order', 'Order extracted');
// Approved, but at "Order Split" a minute later, extraction still pending (2026-10-23): approving
// order 22222222, or an order with PLU 2222 (and a backoffice account).
const extractionPending = (approving && orderNumberToApprove === '22222222') || (approvesNewOrder && products.some((line) => line.plu === '2222'));

// PLU 555: a real headless Edge with the live view's DevTools port, opened right away.
const liveBrowser =
  products.some((line) => line.plu === '555') && process.env.WATSONS_LIVE_VIEW_PORT && process.env.FAKE_PLAYWRIGHT_MODULE ? openLiveBrowser() : null;
liveBrowser?.catch((error) => console.log(`fake runner: no live browser: ${error.message.split('\n')[0]}`));
async function openLiveBrowser() {
  const { chromium } = require(process.env.FAKE_PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: [`--remote-debugging-port=${process.env.WATSONS_LIVE_VIEW_PORT}`] });
  const page = await (await browser.newContext({ viewport: { width: 800, height: 450 } })).newPage();
  page.on('console', (message) => console.log(`fake page: ${message.text()}`));
  await page.setContent(
    '<title>Thank you for your order</title><style>body{margin:0}#b{position:absolute;left:0;top:0;width:200px;height:100px}' +
      '#i{position:absolute;left:0;top:200px;width:300px;height:40px}</style>' +
      '<button id="b" onclick="console.log(\'clicked\')">Click</button><input id="i" oninput="console.log(\'typed \' + this.value)">',
  );
  return { browser, page };
}

/** PLU 555: until the page was clicked and then left alone for 2 seconds (the person is done), at most a minute. */
function untilUsed(page) {
  return new Promise((resolve) => {
    let clicked = false;
    let quiet;
    const done = () => {
      clearTimeout(quiet);
      clearTimeout(limit);
      page.off('console', seen);
      resolve();
    };
    const seen = (message) => {
      if (message.text() === 'clicked') clicked = true;
      if (!clicked) return;
      clearTimeout(quiet);
      quiet = setTimeout(done, 2_000);
    };
    const limit = setTimeout(done, 60_000);
    page.on('console', seen);
  });
}

console.log(
  `fake runner: args=${process.argv.slice(2).join(' ')} place=${process.env.WATSONS_PLACE_ORDER} otp=${process.env.WATSONS_PAYMENT_OTP} ` +
    `approve=${orderNumberToApprove}`,
);
console.log(
  `fake runner: account=${fingerprint(process.env.WATSONS_USERNAME)}/${fingerprint(process.env.WATSONS_PASSWORD)} ` +
    `backoffice=${fingerprint(process.env.WATSONS_BACKOFFICE_USERNAME)}/${fingerprint(process.env.WATSONS_BACKOFFICE_PASSWORD)} ` +
    `html-report=${process.env.WATSONS_HTML_REPORT_DIR ? 'own' : 'shared'}`,
);

// Like src/reporting/result-reporter.ts: runs grouped by day when WATSONS_REPORTS_DIR is set.
const runId = process.env.WATSONS_RUN_ID;
const folder = process.env.WATSONS_REPORTS_DIR
  ? path.join(process.env.WATSONS_REPORTS_DIR, runId.slice(0, 10), runId)
  : path.join(process.cwd(), 'reports', runId);
function screenshot(name) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, name), PNG);
  return path.join('reports', process.env.WATSONS_RUN_ID, name);
}

// The evidence the real reporter writes besides result.json: the run's log and its HTML report.
fs.mkdirSync(path.join(folder, 'html-report'), { recursive: true });
fs.writeFileSync(path.join(folder, 'html-report', 'index.html'), '<!doctype html><title>Fake report</title><h1>Fake Playwright report</h1>');
fs.writeFileSync(path.join(folder, 'log.txt'), `fake run ${runId}\n`);
if (products.some((line) => line.plu === '777')) {
  fs.appendFileSync(path.join(folder, 'log.txt'), `password was ${process.env.WATSONS_PASSWORD}\nbackoffice password was ${process.env.WATSONS_BACKOFFICE_PASSWORD}\n`);
}

function writeResult(result) {
  fs.mkdirSync(folder, { recursive: true });
  const base = {
    runId: process.env.WATSONS_RUN_ID,
    automation: approving ? 'approve' : 'order',
    durationMs: 1000,
    startedAt: new Date(Date.now() - 1000).toISOString(),
    finishedAt: new Date().toISOString(),
    placeOrder,
    delivery: approving ? {} : { method, mode },
    products: { ordered: approving ? [] : ordered, soldOut, excludedNotEligible: excluded.map((line) => line.plu), freeGiftRemoved: null },
    decisions,
    consoleErrors: [],
    artifacts: { folder: path.join('reports', process.env.WATSONS_RUN_ID), screenshots: [] },
  };
  fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify({ ...base, ...result }));
}

function fail(step, code, reason, page, orderNumber) {
  const shot = screenshot('screenshot-1-failure.png');
  writeResult({
    status: 'failed',
    outcome: 'failed',
    orderNumber,
    completedStep: steps[steps.indexOf(step) - 1] ?? 'none',
    error: { code, step, message: `❌ ${code}\n\nStep: ${step}\nReason: ${reason}`, at: new Date().toISOString(), pages: [page], screenshots: [shot] },
    artifacts: { folder: path.join('reports', process.env.WATSONS_RUN_ID), screenshots: [shot] },
  });
  process.exitCode = 1;
}

// ---- Questions, as src/utils/ask.ts asks them: ask.json, the "[ASK]" line, then answer-<id>.json.
const interactive = process.env.WATSONS_INTERACTIVE === 'yes';
const decisions = [];
let questions = 0;
function ask(question, then) {
  const id = ++questions;
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'ask.json'), JSON.stringify({ id, ...question, askedAt: new Date().toISOString() }));
  console.log(`[12:00:00] [ASK] ${question.message}`);
  const file = path.join(folder, `answer-${id}.json`);
  const poll = setInterval(() => {
    if (!fs.existsSync(file)) return;
    clearInterval(poll);
    const answer = JSON.parse(fs.readFileSync(file, 'utf8'));
    const option = question.options.find((candidate) => candidate.action === answer.action && candidate.mode === answer.mode && candidate.method === answer.method);
    decisions.push({ at: new Date().toISOString(), step: question.step, kind: question.kind, plus: question.plus, message: question.message, action: answer.action, label: option.label, ...(answer.plu ? { plu: answer.plu } : {}) });
    console.log(`[12:00:00] [INFO] Decision: ${option.label}${answer.plu ? ` (PLU ${answer.plu})` : ''}`);
    then(answer);
  }, 50);
}
function decided(outcome) {
  decisions.at(-1).outcome = outcome;
  console.log(`[12:00:00] [INFO] Outcome: ${outcome}`);
}
const others = (plu) => ordered.filter((line) => line.plu !== plu).length;
const without = (plu) => ordered.filter((line) => line.plu !== plu);
const replaced = (plu, replacement) => ordered.map((line) => (line.plu === plu ? { plu: replacement, quantity: line.quantity } : line));
const METHOD_LABELS = { home_delivery: 'Home Delivery', click_collect: 'Click & Collect', shell_station: 'Shell Station' };
const asked = new Set();

/** The step's question, if it has one: asks it and goes on with the answer (true), or not (false). */
function question(step) {
  if (!interactive) return false;
  if (step === 'Product Search' && ordered.some((line) => line.plu === '3333') && !asked.has(step)) {
    asked.add(step);
    const options = [
      ...(others('3333') > 0 ? [{ action: 'skip', label: 'Skip product and continue' }] : []),
      { action: 'replace', label: 'Replace with another PLU' },
      { action: 'stop', label: 'Stop automation' },
    ];
    ask({ kind: 'out_of_stock', step, plus: ['3333'], message: 'Product 3333 is out of stock. What would you like to do?', options }, (answer) => {
      soldOut.push('3333');
      if (answer.action === 'skip') {
        ordered = without('3333');
        decided('PLU 3333 left out of the order');
      } else {
        ordered = replaced('3333', answer.plu);
        decided(`PLU ${answer.plu} is available: it replaces PLU 3333`);
      }
      next();
    });
    return true;
  }
  if (step === 'Add to bag' && ordered.some((line) => line.plu === '5555') && !asked.has(step)) {
    asked.add(step);
    const options = [{ action: 'retry', label: 'Retry' }, ...(others('5555') > 0 ? [{ action: 'skip', label: 'Skip product 5555' }] : []), { action: 'stop', label: 'Stop automation' }];
    const message = 'Something went wrong at Add to bag (PLU 5555). How would you like to proceed?';
    const detail = 'Adding unit 1 of 1 for PLU 5555 did not increase the bag count (still 1).';
    ask({ kind: 'error', step, plus: ['5555'], message, detail, options }, (answer) => {
      if (answer.action === 'retry') {
        console.log('[12:00:00] [WARN] Retrying: Add to bag');
        decided('PLU 5555 is in the bag');
      } else {
        ordered = without('5555');
        decided('PLU 5555 left out of the order');
      }
      next();
    });
    return true;
  }
  if (step === 'Express Delivery Selection' && ordered.some((line) => line.plu === '4444') && method !== 'shell_station') {
    // As src/flows/order-issues.ts asks it (2026-10-22): remove it, or replace it (one or several
    // PLUs), first; then the other mode and the other methods.
    const options = [
      ...(others('4444') > 0 ? [{ action: 'skip', label: 'Remove it and continue' }] : []),
      { action: 'replace', label: 'Replace with another PLU', many: true },
      { action: 'switch_mode', mode: 'standard', label: 'Use Standard instead' },
      ...['home_delivery', 'click_collect', 'shell_station'].filter((other) => other !== method).map((other) => ({ action: 'switch_method', method: other, label: `Try ${METHOD_LABELS[other]}` })),
      { action: 'stop', label: 'Stop automation' },
    ];
    const message = `Product 4444 is not eligible for Express delivery with ${METHOD_LABELS[method]}.`;
    ask({ kind: 'not_eligible', step, plus: ['4444'], message, options }, (answer) => {
      if (answer.action === 'switch_mode') {
        [mode, modeName] = ['standard', 'Standard'];
        steps.splice(index, 0, 'Standard Delivery Selection');
        decided('Delivery mode: Standard');
      } else if (answer.action === 'switch_method') {
        method = answer.method;
        steps.splice(index, 0, 'Cart validation', step); // back to the bag, then the checkout page again (Shell Station takes it)
        decided(`Delivery method: ${METHOD_LABELS[method]}`);
      } else if (answer.action === 'skip') {
        // Out of the order; Cart validation takes it out of the bag, then the checkout page again.
        ordered = without('4444');
        steps.splice(index, 0, 'Cart validation', step);
        decided('PLU 4444 taken out of the order');
      } else {
        const added = answer.plu.split(/\s+/);
        const quantity = ordered.find((line) => line.plu === '4444').quantity;
        ordered = [...without('4444'), ...added.map((plu) => ({ plu, quantity }))];
        steps.splice(index, 0, 'Add to bag', 'Cart validation', step);
        decided(`PLU 4444 removed; PLU ${added.join(', ')} added instead`);
      }
      next();
    });
    return true;
  }
  return false;
}

let index = 0;
function next() {
  if (index === steps.length) {
    const approved = approving && orderNumberToApprove !== '11111111';
    const orderNumber = approving ? orderNumberToApprove : placeOrder ? '12345678' : undefined;
    const usesBackoffice = approving || approvesNewOrder;
    const finalStatus = extractionPending ? 'Order Split' : 'ORDER_EXTRACTED';
    const pending = extractionPending ? '; extraction still pending' : '';
    const finish = () => {
      const shot = placeOrder || approving ? screenshot(usesBackoffice ? 'screenshot-1-backoffice-order.png' : 'screenshot-1-order-confirmation.png') : null;
      writeResult({
        status: 'passed',
        outcome: approving ? (approved ? 'approved' : 'no_change') : placeOrder ? (approvesNewOrder ? 'order_placed' : 'order_placed_unapproved') : 'ready_to_check_out',
        orderNumber,
        completedStep: steps.at(-1),
        backoffice: usesBackoffice ? { approved: !approving || approved, statuses: [finalStatus], finalStatus, ...(extractionPending ? { extractionPending: true } : {}) } : undefined,
        artifacts: { folder: path.join('reports', process.env.WATSONS_RUN_ID), screenshots: shot ? [shot] : [] },
      });
      console.log('fake runner: passed');
      // Like the real tests since 2026-10-23: the run ends as soon as it is done, its browser too.
      liveBrowser?.then(({ browser }) => browser.close()).catch(() => {});
    };
    if (!placeOrder && !approving) return finish();
    const pass = () => {
      if (approving && approved) console.log(`[12:00:00] [PASS] Order approved successfully. Order number: ${orderNumber} (backoffice: ${finalStatus}${pending})`);
      else if (approving) console.log(`[12:00:00] [PASS] No change needed. Order number: ${orderNumber} (backoffice: already ${finalStatus}${pending})`);
      else if (approvesNewOrder) console.log(`[12:00:00] [PASS] Order test completed successfully. Order number: 12345678 (backoffice: ${finalStatus}${pending})`);
      else console.log('[12:00:00] [PASS] Order placed (not approved yet: no backoffice account for this run). Order number: 12345678');
      if (extractionPending) console.log(`[12:00:00] [WARN] WTCSG${orderNumber} is at Order Split: extraction to ORDER_EXTRACTED is still pending. Wait a few minutes, then check it in the backoffice.`);
      finish();
    };
    // The live view (PLU 555): the last step lasts until the person has used the page.
    if (liveBrowser) return liveBrowser.then(({ page }) => untilUsed(page)).catch(() => {}).then(pass);
    return pass();
  }
  const step = steps[index++];
  console.log(`[12:00:00] [INFO] Step: ${step}`);
  if (question(step)) return;
  if (step === 'Product Search' && products.some((line) => line.plu === '404')) {
    return fail(step, 'PRODUCT_NOT_FOUND', 'No product found for PLU 404.', 'https://staging.example.test/search');
  }
  if (step === 'Find order in backoffice' && orderNumberToApprove === '00000404') {
    return fail(step, 'ORDER_NOT_FOUND_IN_BACKOFFICE', "WTCSG00000404 is not in the backoffice's Orders list.", 'https://backoffice.example.test/backoffice/', orderNumberToApprove);
  }
  if (step === `${modeName} Delivery Selection` && excluded.length > 0) {
    console.log(`[12:00:00] [WARN] Not available for ${modeName}, left out of this order: PLU ${excluded.map((line) => line.plu).join(', ')}`);
  }
  if (step === (placeOrder ? 'Pay' : 'Login') && products.some((line) => line.plu === '99')) {
    const browser = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    console.log(`fake browser pid=${browser.pid}`);
    return; // never finishes: the launcher must stop it
  }
  setTimeout(next, 20);
}
next();
