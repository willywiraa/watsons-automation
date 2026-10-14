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
const method = methods[orderText.match(/^delivery: (.+)$/m)?.[1]];
const mode = /^mode: standard\s*$/im.test(orderText) ? 'standard' : 'express';
const modeName = mode === 'standard' ? 'Standard' : 'Express';
const excluded = products.filter((line) => line.plu === '46465');
const ordered = products.filter((line) => line.plu !== '46465');
const steps = approving
  ? ['Backoffice login', 'Find order in backoffice', 'Approve order', 'Order extracted']
  : ['Login', 'Empty bag', 'Product Search', 'Add to bag', 'Cart validation', `${modeName} Delivery Selection`];
if (placeOrder) steps.push('Checkout', 'Pay', 'OTP', 'Order confirmation', 'Backoffice login', 'Find order in backoffice', 'Approve order', 'Order extracted');
// Like the real tests with the browser shown: at the end, they wait for the window to close.
const holdsLastPage = (placeOrder || approving) && process.argv.includes('--headed');

console.log(
  `fake runner: args=${process.argv.slice(2).join(' ')} place=${process.env.WATSONS_PLACE_ORDER} otp=${process.env.WATSONS_PAYMENT_OTP} ` +
    `delay=${process.env.WATSONS_ADD_DELAY_SECONDS} approve=${orderNumberToApprove}`,
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
    products: { ordered: approving ? [] : ordered, soldOut: [], excludedNotEligible: excluded.map((line) => line.plu), freeGiftRemoved: null },
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

let index = 0;
function next() {
  if (index === steps.length) {
    const approved = approving && orderNumberToApprove !== '11111111';
    const orderNumber = approving ? orderNumberToApprove : placeOrder ? '12345678' : undefined;
    const finish = () => {
      const shot = placeOrder || approving ? screenshot('screenshot-1-backoffice-order.png') : null;
      writeResult({
        status: 'passed',
        outcome: approving ? (approved ? 'approved' : 'no_change') : placeOrder ? 'order_placed' : 'ready_to_check_out',
        orderNumber,
        completedStep: steps.at(-1),
        backoffice: placeOrder || approving ? { approved: !approving || approved, statuses: ['ORDER_EXTRACTED'], finalStatus: 'ORDER_EXTRACTED' } : undefined,
        artifacts: { folder: path.join('reports', process.env.WATSONS_RUN_ID), screenshots: shot ? [shot] : [] },
      });
      console.log('fake runner: passed');
    };
    if (!placeOrder && !approving) return finish();
    if (approving && approved) console.log(`[12:00:00] [PASS] Order approved successfully. Order number: ${orderNumber} (backoffice: ORDER_EXTRACTED)`);
    else if (approving) console.log(`[12:00:00] [PASS] No change needed. Order number: ${orderNumber} (backoffice: already ORDER_EXTRACTED)`);
    else console.log('[12:00:00] [PASS] Order test completed successfully. Order number: 12345678 (backoffice: ORDER_EXTRACTED)');
    if (!holdsLastPage) return finish();
    console.log('[12:00:00] [INFO] The backoffice order stays open. Close the browser window to finish.');
    setTimeout(finish, 1500); // the person looks at the page, then closes the window
    return;
  }
  const step = steps[index++];
  console.log(`[12:00:00] [INFO] Step: ${step}`);
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
