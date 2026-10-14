'use strict';
// WatsonsTester launcher (PRD §7, §32–38). Why it is built this way: docs/launcher-decision.md.
//
// A small web page served on this PC only and shown in an Edge app window, with two tabs:
// - Automation: collects what to run, checks it, and after the person confirms, starts one of the
//   Playwright tests for it with the browser shown, then shows the progress and the result from
//   reports/<run>/result.json:
//     "Place new order" (tests/order.e2e.spec.ts) places a STAGING test order, approves it in the
//       backoffice and ends on the order (user's decisions 2026-10-05 and 2026-10-06);
//     "Approve existing order" (tests/approve.e2e.spec.ts) only approves an order that already
//       exists (user's request 2026-10-07). It never creates an order.
// - Logs / History: every run in reports/, with its status, error and screenshots (2026-10-07).
// The Watsons automation itself stays in the test project: this file never opens the Watsons site.
//
// One file with Node's built-in modules only, because it is also the program inside
// WatsonsTester.exe (scripts/build-exe.mjs), which can't load other files.
// Start it without the exe: npm run launcher

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn, execFile } = require('node:child_process');
const { parseEnv } = require('node:util');

/**
 * The only approved site. The launcher only uses it to say whether .env is set up; the real
 * check is src/safety/staging-guard.ts (tests/launcher.spec.ts keeps the two the same).
 */
const STAGING_HOST = 'wtcsg.cmb8j9fjhz-apj3aswat1-s1-public.model-t.cc.commerce.ondemand.com';

const DELIVERY_METHODS = { home_delivery: 'Home Delivery', click_collect: 'Click & Collect', shell_station: 'Shell Station' };
// Other names src/config/order.ts accepts in an order file.
const DELIVERY_ALIASES = { 'click and collect': 'click_collect', 'pickup at shell station': 'shell_station' };

/**
 * Delivery modes: Express (user's decision 2026-10-07) and Standard (user's request 2026-10-13).
 * Each has its checkout step in src/flows/delivery-modes.ts; a mode with `available: false` is
 * shown but can't be chosen. The window, the checks, the order file and the progress steps all
 * follow from this list.
 */
const MODES = {
  express: { label: 'Express', available: true, tag: 'Fastest', note: 'Products that Express cannot deliver are left out and listed.' },
  standard: { label: 'Standard', available: true, note: 'The regular delivery or pickup date. Products that Standard cannot deliver are left out and listed.' },
};

/** What the launcher runs: a Playwright project (playwright.config.ts) and its test file. */
const AUTOMATIONS = {
  order: { label: 'Place new order', runLabel: 'Run order test', project: 'e2e', spec: 'order.e2e' },
  approve: { label: 'Approve existing order', runLabel: 'Approve in Backoffice', project: 'approve', spec: 'approve.e2e' },
};

// The steps of the tests, for the progress list. The tests log "Step: <name>".
const STEPS = ['Login', 'Empty bag', 'Product Search', 'Add to bag', 'Cart validation']; // then "<Mode> Delivery Selection"
/** From "Checkout" on, an order may be created (CLAUDE.md rule 3). */
const ORDER_STEPS = ['Checkout', 'Pay', 'OTP', 'Order confirmation', 'Backoffice login', 'Find order in backoffice', 'Approve order', 'Order extracted'];
/** tests/approve.e2e.spec.ts: the backoffice steps of the order flow, on an order that exists. */
const APPROVE_STEPS = ['Backoffice login', 'Find order in backoffice', 'Approve order', 'Order extracted'];

/** The steps of a run in order (tests/order.e2e.spec.ts names its delivery step after the mode). */
function stepsFor(automation, mode) {
  if (automation === 'approve') return APPROVE_STEPS;
  return [...STEPS, `${MODES[mode]?.label ?? MODES.express.label} Delivery Selection`, ...ORDER_STEPS];
}

/** From these steps on, stopping a run can leave things unknown; what to check then. */
const RISKS = {
  order: { steps: ORDER_STEPS, warning: 'the order may already have been created. Check My Account > Order History on staging before running again.' },
  approve: { steps: ['Approve order', 'Order extracted'], warning: 'Approve Order may already have been clicked. Check the order in the backoffice before approving it again.' },
};

/** The lines the tests log once they have passed (they then wait for the browser window to close). */
const PASS_LINES = [
  { pattern: /\[PASS\] Order test completed successfully\. Order number: (\d+)/, outcome: 'order_placed' },
  { pattern: /\[PASS\] Order approved successfully\. Order number: (\d+)/, outcome: 'approved' },
  { pattern: /\[PASS\] No change needed\. Order number: (\d+)/, outcome: 'no_change' },
];

/**
 * "Seconds between adds" (user's request 2026-10-07): the time from one "add to bag" click to the
 * next. src/config/settings.ts checks the same limits (tests/launcher.spec.ts keeps them the same).
 */
const ADD_DELAY = { default: 10, min: 0, max: 120 };

/** The status of a run in Logs / History (user's request 2026-10-07). */
const STATUSES = { running: 'Running', completed: 'Completed', failed: 'Failed', stopped: 'Stopped', no_change: 'No change', interrupted: 'Interrupted' };

const ORDER_NUMBER_HELP = 'The order number has 8 digits, optionally with WTCSG in front (e.g. 07091012 or WTCSG07091012).';

// The evidence folder of each run: reports/<run id>/ (src/reporting/result-reporter.ts).
const RUN_ID = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:_\d+)?$/;
const SCREENSHOT_NAME = /^screenshot-[a-z0-9-]+\.png$/i;
/** What the launcher knows about a run (it writes it when the run starts and when it ends). */
const RECORD_FILE = 'launcher-run.json';
/** A failed run's error, ready to send to the team (telemetry, user's request 2026-10-07). */
const ERROR_REPORT_FILE = 'error-report.txt';
/** What the window remembers between runs, in reports/ next to launcher-last-order.txt. */
const SETTINGS_FILE = 'launcher-settings.json';
const HISTORY_LIMIT = 500;

const isPackaged = (() => {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
})();

const has = (object, key) => typeof key === 'string' && Object.hasOwn(object, key);
const stripColors = (text) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------------------------
// The order: the same product lines as src/config/order.ts ("10321", "10321 2", "10321,2",
// "10321 x2"). The test checks the order file again with that parser before it starts.

const PRODUCT_LINE = /^(\S+?)(?:(?:\s*[,x×]\s*|\s+)(\S+))?$/i;

/** Reads the pasted product list. Returns the products and, per bad line, what's wrong. */
function parseProducts(text) {
  const products = [];
  const problems = [];
  const firstLineOf = new Map();
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((rawLine, index) => {
      const lineNumber = index + 1;
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) return;
      if (/^(delivery|mode)\s*:/i.test(line)) {
        problems.push(`Line ${lineNumber}: choose the delivery method and mode with the buttons below, not in the list.`);
        return;
      }
      const [, plu, quantityText] = line.match(PRODUCT_LINE) ?? [];
      if (!plu || !/^\d+$/.test(plu)) {
        problems.push(`Line ${lineNumber}: "${line}" is not a PLU (digits, optionally followed by a quantity).`);
        return;
      }
      const quantity = quantityText === undefined ? 1 : Number(quantityText);
      if (!Number.isInteger(quantity) || quantity < 1) {
        problems.push(`Line ${lineNumber}: the quantity for PLU ${plu} must be a whole number of 1 or more.`);
        return;
      }
      if (firstLineOf.has(plu)) {
        problems.push(`Line ${lineNumber}: PLU ${plu} is already on line ${firstLineOf.get(plu)}. List it once, with a quantity (e.g. "${plu} 2").`);
        return;
      }
      firstLineOf.set(plu, lineNumber);
      products.push({ plu, quantity });
    });
  return { products, problems };
}

/**
 * An existing order's number as typed: "07091012" or its backoffice code "WTCSG07091012" (spaces
 * ignored). Returns the 8 digits, or null. Same as parseOrderNumber in src/config/order.ts.
 */
function normalizeOrderNumber(text) {
  return String(text ?? '').replace(/\s+/g, '').match(/^(?:WTCSG)?(\d{8})$/i)?.[1] ?? null;
}

/** "Seconds between adds" from the window: { seconds } or { problem }. Not given: the default. */
function parseAddDelay(value) {
  if (value === undefined || value === null) return { seconds: ADD_DELAY.default };
  const text = String(value).trim();
  if (!/^\d+$/.test(text) || Number(text) < ADD_DELAY.min || Number(text) > ADD_DELAY.max) {
    return { problem: `Seconds between adds must be a whole number from ${ADD_DELAY.min} to ${ADD_DELAY.max}.` };
  }
  return { seconds: Number(text) };
}

/** The order file the test reads (format: README, "The test order"). */
function orderFileText(order) {
  return [
    '# Written by the WatsonsTester launcher.',
    `delivery: ${DELIVERY_METHODS[order.deliveryMethod]}`,
    `mode: ${MODES[order.mode].label}`,
    '',
    ...order.products.map((line) => (line.quantity > 1 ? `${line.plu} ${line.quantity}` : line.plu)),
    '',
  ].join('\n');
}

/** Reads an order file: its product lines, delivery method and mode (null when not given). */
function parseOrderText(text) {
  const productLines = [];
  let deliveryMethod = null;
  let mode = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const delivery = line.match(/^delivery\s*:\s*(.*)$/i);
    const modeLine = line.match(/^mode\s*:\s*(.*)$/i);
    if (delivery) {
      const name = delivery[1].trim().toLowerCase();
      const key = Object.keys(DELIVERY_METHODS).find((method) => method === name || DELIVERY_METHODS[method].toLowerCase() === name);
      deliveryMethod = key ?? DELIVERY_ALIASES[name] ?? deliveryMethod;
    } else if (modeLine) {
      const name = modeLine[1].trim().toLowerCase();
      if (has(MODES, name)) mode = name;
    } else if (line && !line.startsWith('#')) {
      productLines.push(line);
    }
  }
  return { productLines, deliveryMethod, mode };
}

/** What the window remembers between runs: "Seconds between adds". */
function readLauncherSettings(root) {
  const saved = readJson(path.join(root, 'reports', SETTINGS_FILE));
  const delay = parseAddDelay(saved?.addDelaySeconds);
  return { addDelaySeconds: delay.problem ? ADD_DELAY.default : delay.seconds };
}

function saveLauncherSettings(root, settings) {
  try {
    fs.writeFileSync(path.join(root, 'reports', SETTINGS_FILE), JSON.stringify(settings, null, 2));
  } catch {
    // Only a convenience for the next time the window opens.
  }
}

/** What the window starts with: the last order run from the launcher, else test-data/order.txt. */
function readDefaults(root) {
  const { addDelaySeconds } = readLauncherSettings(root);
  const files = [path.join(root, 'reports', 'launcher-last-order.txt'), path.join(root, 'test-data', 'order.txt')];
  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;
    const order = parseOrderText(text);
    return {
      products: order.productLines.join('\n'),
      deliveryMethod: order.deliveryMethod ?? 'home_delivery',
      // A mode that isn't available (yet) is not chosen for the person.
      mode: MODES[order.mode]?.available ? order.mode : 'express',
      source: path.relative(root, file),
      addDelaySeconds,
    };
  }
  return { products: '', deliveryMethod: 'home_delivery', mode: 'express', source: null, addDelaySeconds };
}

// ---------------------------------------------------------------------------------------------
// Checks before running (PRD §37). Setting values are read only to see that they are filled in;
// they are never sent to the window, printed or logged (except WATSONS_OPERATOR, a name).

const playwrightCli = (root) => path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
// Inside WatsonsTester.exe, process.execPath is the exe, which can only run the launcher.
const nodeProgram = () => (isPackaged ? 'node' : process.execPath);

function readEnvFile(root) {
  try {
    return parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8'));
  } catch {
    return {}; // No .env: every setting counts as missing.
  }
}

function checkSetup(root, nodeFound) {
  const fileSettings = readEnvFile(root);
  // Settings set in Windows itself win over .env, as in playwright.config.ts.
  const filledIn = (name) => String(process.env[name] ?? fileSettings[name] ?? '').trim() !== '';
  let stagingOk = false;
  try {
    const url = new URL(String(process.env.WATSONS_STAGING_URL ?? fileSettings.WATSONS_STAGING_URL ?? '').trim());
    stagingOk = url.protocol === 'https:' && url.host === STAGING_HOST && !url.username && !url.password;
  } catch {
    stagingOk = false;
  }
  const projectFound =
    fs.existsSync(path.join(root, 'playwright.config.ts')) &&
    fs.existsSync(path.join(root, 'tests', 'order.e2e.spec.ts')) &&
    fs.existsSync(playwrightCli(root));
  const checks = [
    { label: 'Test project found', ok: projectFound, help: 'Put the launcher in the project folder and run "npm install" there once.' },
    { label: 'Node.js installed', ok: nodeFound, help: 'Install Node.js (LTS) from nodejs.org, then open the launcher again.' },
    { label: 'Staging environment configured', ok: stagingOk, help: 'Set WATSONS_STAGING_URL in .env to the Watsons STAGING address (README, "Settings").' },
    { label: 'Account configured', ok: filledIn('WATSONS_USERNAME') && filledIn('WATSONS_PASSWORD'), help: 'Fill in WATSONS_USERNAME and WATSONS_PASSWORD in .env.' },
    {
      label: 'Backoffice account configured',
      ok: filledIn('WATSONS_BACKOFFICE_USERNAME') && filledIn('WATSONS_BACKOFFICE_PASSWORD'),
      help: 'Fill in WATSONS_BACKOFFICE_USERNAME and WATSONS_BACKOFFICE_PASSWORD in .env (each order is approved in the backoffice).',
    },
  ];
  return { checks, ready: checks.every((check) => check.ok) };
}

/** Who runs the tests, for Logs / History: WATSONS_OPERATOR (Windows or .env), else the Windows user name. */
function readOperator(root) {
  const configured = String(process.env.WATSONS_OPERATOR ?? readEnvFile(root).WATSONS_OPERATOR ?? '').trim();
  if (configured) return configured.slice(0, 60);
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME ?? 'unknown';
  }
}

/** Checks a run request from the window. Returns what's wrong, or the run to start. */
function checkRunRequest(body, setup) {
  const automation = body?.automation ?? 'order';
  if (!has(AUTOMATIONS, automation)) return { problems: ['Choose what to run: place a new order, or approve an existing one.'] };
  const problems = setup.checks.filter((check) => !check.ok).map((check) => `${check.label}: no. ${check.help}`);

  if (automation === 'approve') {
    const typed = String(body?.orderNumber ?? '').trim();
    const orderNumber = normalizeOrderNumber(typed);
    if (!typed) problems.push('Enter the number of the order to approve.');
    else if (!orderNumber) problems.push(ORDER_NUMBER_HELP);
    // Approving changes the order, so the window asks first; without that answer, no run.
    if (body?.confirmed !== true) problems.push('Approving an order needs your confirmation first.');
    if (problems.length > 0) return { problems };
    return { problems, order: { automation, orderNumber } };
  }

  const { products, problems: lineProblems } = parseProducts(body?.products);
  problems.push(...lineProblems);
  if (products.length === 0 && lineProblems.length === 0) problems.push('Add at least one PLU.');
  if (!has(DELIVERY_METHODS, body?.deliveryMethod)) problems.push('Choose a delivery method.');
  if (!has(MODES, body?.mode)) problems.push('Choose the delivery mode.');
  else if (!MODES[body.mode].available) problems.push(`${MODES[body.mode].label} delivery is not available yet (planned for a later phase). Choose Express.`);
  const delay = parseAddDelay(body?.addDelaySeconds);
  if (delay.problem) problems.push(delay.problem);
  // Every run places an order, so the window asks first (PRD §38); without that answer, no run.
  if (body?.confirmed !== true) problems.push('Placing an order needs your confirmation first.');
  if (problems.length > 0) return { problems };
  return { problems, order: { automation, products, deliveryMethod: body.deliveryMethod, mode: body.mode, addDelaySeconds: delay.seconds } };
}

// ---------------------------------------------------------------------------------------------
// Running a test.

const pad = (n) => String(n).padStart(2, '0');
/** "2026-10-07_13-16-55": a run id, also used for file names. */
const stamp = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;

/**
 * A run's evidence folder: <root>/reports/<run id> (the desktop launcher), or, with reportsDir (the
 * hosted server), <reportsDir>/<yyyy-mm-dd>/<run id>: runs grouped by day (user, 2026-10-08). Same
 * rule as evidenceFolder() in src/reporting/result-reporter.ts, which writes the test's evidence.
 */
function runFolderPath(root, runId, reportsDir = null) {
  return reportsDir ? path.join(reportsDir, runId.slice(0, 10), runId) : path.join(root, 'reports', runId);
}

function newRunId(root, reportsDir = null) {
  const base = stamp(new Date());
  let runId = base;
  for (let n = 2; fs.existsSync(runFolderPath(root, runId, reportsDir)); n++) runId = `${base}_${n}`;
  return runId;
}

/** The settings that hold passwords: on the hosted server, each run gets its own (TestRunner option "env"). */
const SECRET_SETTINGS = ['WATSONS_USERNAME', 'WATSONS_PASSWORD', 'WATSONS_BACKOFFICE_USERNAME', 'WATSONS_BACKOFFICE_PASSWORD'];

/** Saves what the launcher knows about a run in its evidence folder (Logs / History reads it). */
function writeRecord(run, state) {
  const record = {
    runId: run.runId,
    automation: run.automation,
    operator: run.operator,
    state, // "running" until the run has ended
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    orderNumber: run.orderNumber,
    deliveryMethod: run.deliveryMethod,
    mode: run.mode,
    products: run.products,
    addDelaySeconds: run.addDelaySeconds,
    step: run.step,
    risky: run.risky,
    passed: run.passed,
    cancelled: run.cancelled,
    exitCode: run.exitCode ?? null,
  };
  try {
    fs.writeFileSync(path.join(run.dir, RECORD_FILE), JSON.stringify(record, null, 2));
  } catch {
    // The evidence folder was deleted during the run.
  }
}

/**
 * Runs one test at a time and follows it. The desktop launcher has one; the hosted server
 * (server/lib/runs.cjs) has one per signed-in person. Options (the defaults are the desktop's):
 *   headed            show the browser (true); the server runs headless
 *   reportsDir        evidence folder elsewhere, grouped by day (runFolderPath); null: <root>/reports
 *   isolate           own Playwright output and HTML report folders per run, so runs can go on in parallel
 *   rememberDefaults  save the last order and "seconds between adds" for the next window (true)
 *   env               (request) => settings for this run only, e.g. the person's testing account. They
 *                     go into the test's environment only: never onto the run, into files or logs.
 *   onFinished        (run, row) => called when a run has ended, before the window hears of it
 */
class TestRunner {
  constructor(root, send, echo, operator, options = {}) {
    this.root = root;
    this.send = send; // to the window
    this.echo = echo; // to the console
    this.operator = operator; // who runs it (read for each run)
    this.options = { headed: true, reportsDir: null, isolate: false, rememberDefaults: true, env: null, onFinished: null, ...options };
    this.current = null;
    this.last = null;
  }

  get running() {
    return this.current !== null;
  }

  /** Starts a run checked by checkRunRequest(). */
  start(request) {
    if (this.current) throw new Error('A test is already running.');
    const { headed, reportsDir, isolate, rememberDefaults } = this.options;
    const automation = has(AUTOMATIONS, request.automation) ? request.automation : 'order';
    const runId = newRunId(this.root, reportsDir);
    const folder = runFolderPath(this.root, runId, reportsDir);
    fs.mkdirSync(folder, { recursive: true });

    const env = { ...process.env, WATSONS_RUN_ID: runId };
    // Each run sets exactly the switches it needs: none come along from Windows' own settings.
    for (const name of ['WATSONS_PLACE_ORDER', 'WATSONS_ORDER_FILE', 'WATSONS_ADD_DELAY_SECONDS', 'WATSONS_APPROVE_ORDER', 'WATSONS_REPORTS_DIR', 'WATSONS_HTML_REPORT_DIR']) {
      delete env[name];
    }
    if (reportsDir) env.WATSONS_REPORTS_DIR = reportsDir; // the test writes its evidence there too
    if (this.options.env) {
      for (const name of SECRET_SETTINGS) delete env[name];
      for (const [name, value] of Object.entries(this.options.env(request) ?? {})) if (value !== undefined && value !== null) env[name] = String(value);
    }
    let what;
    if (automation === 'approve') {
      // The person confirmed approving this existing order. Nothing in this run can place an order.
      env.WATSONS_APPROVE_ORDER = request.orderNumber;
      what = `approves existing order WTCSG${request.orderNumber} in the STAGING backoffice (no new order)`;
    } else {
      const orderFile = path.join(folder, 'order.txt');
      fs.writeFileSync(orderFile, orderFileText(request));
      if (rememberDefaults) {
        fs.writeFileSync(path.join(this.root, 'reports', 'launcher-last-order.txt'), orderFileText(request));
        saveLauncherSettings(this.root, { addDelaySeconds: request.addDelaySeconds });
      }
      env.WATSONS_ORDER_FILE = orderFile;
      // The person confirmed placing a STAGING test order for this run.
      env.WATSONS_PLACE_ORDER = 'yes';
      env.WATSONS_ADD_DELAY_SECONDS = String(request.addDelaySeconds);
      what = `places a STAGING test order (${request.addDelaySeconds} s between adds)`;
    }

    const { project, spec } = AUTOMATIONS[automation];
    const args = [playwrightCli(this.root), 'test', `--project=${project}`, spec];
    // --headed: the browser is shown, and the test then leaves its last page open (desktop).
    if (headed) args.push('--headed');
    // Parallel runs (the hosted server): Playwright empties its output folder when a run starts, and
    // writes one HTML report folder, so each run gets its own; deleted when the run has ended.
    const workDir = isolate ? path.join(reportsDir ?? path.join(this.root, 'reports'), '.work', runId) : null;
    if (workDir) {
      args.push('--output', path.join(workDir, 'test-results'));
      env.WATSONS_HTML_REPORT_DIR = path.join(workDir, 'html-report');
    }
    const child = spawn(nodeProgram(), args, { cwd: this.root, windowsHide: true, env });
    const run = {
      runId,
      automation,
      // Where the evidence is (for files; never sent to the window), and how the window shows it.
      dir: folder,
      folder: path.relative(reportsDir ?? this.root, folder),
      workDir,
      logFile: path.join(folder, 'launcher-log.txt'),
      operator: this.operator(),
      deliveryMethod: request.deliveryMethod ?? null,
      mode: request.mode ?? null,
      products: request.products ?? [],
      addDelaySeconds: request.addDelaySeconds ?? null,
      startedAt: new Date().toISOString(),
      lines: [],
      step: null,
      // From the risky steps on (RISKS), stopping can leave the order or its approval unknown.
      risky: false,
      // "order_placed", "approved" or "no_change" once the test has passed (PASS_LINES); the run then
      // ends when the browser window is closed.
      passed: null,
      // Approve runs know it from the start; order runs once the test logs it.
      orderNumber: request.orderNumber ?? null,
      // Products the delivery mode left out, as the test logs them.
      excluded: [],
      cancelled: false,
      child,
    };
    this.current = run;
    writeRecord(run, 'running');
    this.send('started', this.publicRun(run));
    this.addLine(run, `[launcher] Run ${runId} by ${run.operator}: ${what}`);

    for (const stream of [child.stdout, child.stderr]) {
      readline.createInterface({ input: stream }).on('line', (line) => this.addLine(run, stripColors(line)));
    }
    child.on('error', (error) => {
      this.addLine(run, `[launcher] Could not start the test: ${error.message}`);
      if (!child.pid) this.finish(run, null); // never started, so no "close" follows
    });
    child.on('close', (exitCode) => this.finish(run, exitCode));
    return run;
  }

  addLine(run, line) {
    run.lines.push(line);
    if (run.lines.length > 5000) run.lines.splice(0, run.lines.length - 5000);
    try {
      fs.appendFileSync(run.logFile, `${line}\n`);
    } catch {
      // The evidence folder was deleted during the run; the window still shows the line.
    }
    const step = line.match(/\[INFO\] Step: (.+)$/)?.[1]?.trim();
    if (step) {
      run.step = step;
      if (RISKS[run.automation].steps.includes(step)) run.risky = true;
    }
    for (const { pattern, outcome } of PASS_LINES) {
      const orderNumber = line.match(pattern)?.[1];
      if (orderNumber) {
        run.passed = outcome;
        run.orderNumber = orderNumber;
      }
    }
    // src/flows/delivery-modes.ts logs the products the mode can't deliver.
    const excluded = line.match(/Not available for \w+, left out of this order: PLU (.+)$/)?.[1];
    if (excluded) run.excluded = excluded.split(/,\s*/);
    this.echo(line);
    this.send('line', { line, step: run.step, risky: run.risky, passed: run.passed, orderNumber: run.orderNumber, excluded: run.excluded });
  }

  stop() {
    const run = this.current;
    // Once the test has passed, the run ends when the browser window is closed; stopping it then
    // would only lose its result.
    if (!run || run.cancelled || run.passed) return false;
    run.cancelled = true;
    this.addLine(run, '[launcher] Test cancelled by user. Stopping the test and its browser...');
    killTree(run.child);
    return true;
  }

  finish(run, exitCode) {
    if (this.current !== run) return;
    if (run.cancelled) this.addLine(run, '[launcher] Test cancelled by user.');
    if (run.cancelled && run.risky) this.addLine(run, `[launcher] WARNING: ${RISKS[run.automation].warning}`);
    run.exitCode = exitCode;
    run.finishedAt = new Date().toISOString();
    writeRecord(run, 'finished');
    const row = rowFromFolder(run.dir, run.runId, { folder: run.folder });
    // Telemetry: a failed run's error, ready to send to the team, next to its screenshots.
    if (row?.errorReport) {
      try {
        fs.writeFileSync(path.join(run.dir, ERROR_REPORT_FILE), row.errorReport.replace(/\n/g, '\r\n')); // Windows line ends
        row.hasErrorReport = true;
        this.addLine(run, `[launcher] Error report: ${path.join(run.folder, ERROR_REPORT_FILE)}`);
      } catch {
        // The evidence folder was deleted; the window still shows the error.
      }
    }
    if (run.workDir) fs.rmSync(run.workDir, { recursive: true, force: true });
    // First (the server checks and cleans the evidence there), then what the window gets.
    this.options.onFinished?.(run, row);
    const result = readJson(path.join(run.dir, 'result.json'));
    this.last = { ...run, result, row };
    this.current = null;
    this.send('finished', this.publicRun(this.last));
  }

  /** What the window may see about a run (no process, no settings, no folders on the PC). */
  publicRun(run) {
    if (!run) return null;
    const { child, logFile, dir, workDir, ...rest } = run;
    return { ...rest, running: run === this.current };
  }
}

/** Stops a process and everything it started (the test's Edge too), without leftovers (PRD §34). */
function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    child.kill('SIGTERM');
  }
}

// ---------------------------------------------------------------------------------------------
// Logs / History (user's request 2026-10-07): every run's evidence folder in reports/, read when
// the window asks. Runs from before this version have no launcher record: what they show comes
// from their result.json, order.txt and log.

/** 07/10/2026 14:32:05 (this PC's time). */
function formatTime(iso) {
  const date = new Date(iso ?? NaN);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The start time in a run id, for runs that saved no start time. */
function timeFromRunId(runId) {
  const [year, month, day, hours, minutes, seconds] = runId.match(/\d+/g).map(Number);
  return new Date(year, month - 1, day, hours, minutes, seconds).toISOString();
}

/** "10117, 10321 ×2" */
const productsText = (lines) => (lines ?? []).map((line) => (line.quantity > 1 ? `${line.plu} ×${line.quantity}` : line.plu)).join(', ');
const screenshotNumber = (name) => Number(name.match(/^screenshot-(\d+)/i)?.[1] ?? 0);
/** A StepError's "Reason:" line (src/utils/errors.ts), else the message's first line. */
const reasonOf = (message) => message.match(/^Reason: (.+)$/m)?.[1] ?? (message.split('\n').find((line) => line.trim()) ?? '').trim();

/** What went wrong in a failed run: from result.json, else from the launcher's record and log. */
function errorOf(result, record, log, screenshots, status) {
  if (result?.error) {
    const message = String(result.error.message ?? '');
    // Runs from before the telemetry (2026-10-07) list no failure screenshots: Playwright's are the unnamed ones.
    const failureShots = Array.isArray(result.error.screenshots)
      ? result.error.screenshots.map((file) => path.basename(String(file)))
      : screenshots.filter((name) => /^screenshot-\d+(?:-failure)?\.png$/i.test(name));
    return {
      code: result.error.code ?? null,
      step: result.error.step ?? result.completedStep ?? null,
      reason: reasonOf(message),
      message,
      at: result.error.at ?? result.finishedAt ?? null,
      pages: Array.isArray(result.error.pages) ? result.error.pages : [],
      screenshots: failureShots.filter((name) => screenshots.includes(name)),
    };
  }
  // No result.json: the test ended before it could write one (e.g. a setting is missing), or the
  // launcher was closed during the run. The end of the log says why.
  const lines = log.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('[launcher]'));
  return {
    code: null,
    step: record?.step ?? 'Start',
    reason:
      status === 'interrupted'
        ? 'The launcher was closed while this run was going on, so its result is unknown.'
        : `The test ended without a result (exit code ${record?.exitCode ?? 'unknown'}). The log shows why.`,
    message: lines.slice(-12).join('\n'),
    at: record?.finishedAt ?? null,
    pages: [],
    screenshots: [],
  };
}

/**
 * One run for Logs / History, from its evidence folder reports/<run id>/. currentRunId is the run
 * going on now. Returns null for a folder that holds no run.
 */
function historyRow(root, runId, currentRunId = null) {
  return rowFromFolder(path.join(root, 'reports', runId), runId, { currentRunId, folder: path.join('reports', runId) });
}

/**
 * historyRow() for an evidence folder anywhere (the hosted server keeps them in day folders).
 * folder: how the row names the evidence folder.
 */
function rowFromFolder(folderPath, runId, { currentRunId = null, folder = runId } = {}) {
  let files;
  try {
    files = fs.readdirSync(folderPath);
  } catch {
    return null;
  }
  const record = readJson(path.join(folderPath, RECORD_FILE));
  const result = readJson(path.join(folderPath, 'result.json'));
  const orderFile = readText(path.join(folderPath, 'order.txt'));
  if (!record && !result && orderFile === null) return null;
  const log = readText(path.join(folderPath, 'launcher-log.txt')) ?? '';
  const automation = has(AUTOMATIONS, record?.automation) ? record.automation : has(AUTOMATIONS, result?.automation) ? result.automation : 'order';
  const fromFile = orderFile === null ? null : parseOrderText(orderFile);

  let status;
  if (runId === currentRunId) status = 'running';
  else if (record?.cancelled || (!record && !result && log.includes('[launcher] Test cancelled by user.'))) status = 'stopped';
  else if (result?.status === 'passed') status = result.outcome === 'no_change' ? 'no_change' : 'completed';
  else if (result?.status === 'failed') status = 'failed';
  else if (record?.state === 'running') status = 'interrupted';
  else status = 'failed';

  const screenshots = files.filter((name) => SCREENSHOT_NAME.test(name)).sort((a, b) => screenshotNumber(a) - screenshotNumber(b));
  const method = result?.delivery?.method ?? record?.deliveryMethod ?? fromFile?.deliveryMethod ?? null;
  const mode = result?.delivery?.mode ?? record?.mode ?? fromFile?.mode ?? null;
  const row = {
    runId,
    folder,
    automation,
    automationLabel: AUTOMATIONS[automation].label,
    status,
    statusLabel: STATUSES[status],
    outcome: result?.outcome ?? null,
    startedAt: record?.startedAt ?? result?.startedAt ?? timeFromRunId(runId),
    finishedAt: record?.finishedAt ?? result?.finishedAt ?? null,
    durationMs: result?.durationMs ?? null,
    operator: record?.operator ?? null,
    orderNumber: result?.orderNumber ?? record?.orderNumber ?? null,
    delivery:
      automation === 'order' && (method || mode)
        ? { method, mode, label: `${MODES[mode]?.label ?? mode ?? '?'} · ${DELIVERY_METHODS[method] ?? method ?? '?'}` }
        : null,
    products: {
      requested: record?.products ?? (fromFile ? parseProducts(fromFile.productLines.join('\n')).products : []),
      ordered: result?.products?.ordered ?? [],
      soldOut: result?.products?.soldOut ?? [],
      excluded: result?.products?.excludedNotEligible ?? [],
      freeGiftRemoved: result?.products?.freeGiftRemoved ?? null,
    },
    addDelaySeconds: record?.addDelaySeconds ?? null,
    backoffice: result?.backoffice ?? null,
    error: null,
    warning: null,
    screenshots,
    hasReport: fs.existsSync(path.join(folderPath, 'html-report', 'index.html')),
    hasErrorReport: files.includes(ERROR_REPORT_FILE),
    errorReport: null,
  };
  if (row.durationMs === null && record?.finishedAt) row.durationMs = Date.parse(record.finishedAt) - Date.parse(row.startedAt);
  if (status === 'stopped' && (record?.risky || log.includes('[launcher] WARNING:'))) {
    row.warning = `Stopped during ${record?.step ?? 'the order'}: ${RISKS[automation].warning}`;
  }
  if (status === 'failed' || status === 'interrupted') {
    row.error = errorOf(result, record, log, screenshots, status);
    row.errorReport = errorReportText(row);
  }
  return row;
}

/** Every run in reports/, newest first. */
function readHistory(root, currentRunId = null) {
  let names;
  try {
    names = fs
      .readdirSync(path.join(root, 'reports'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return names
    .map((runId) => historyRow(root, runId, currentRunId))
    .filter(Boolean)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId))
    .slice(0, HISTORY_LIMIT);
}

/** A failed run's error as plain text, to send to the team (telemetry, user's request 2026-10-07). */
function errorReportText(row) {
  const { error } = row;
  const indent = '\n             ';
  const lines = [
    'WATSONS AUTOMATION - ERROR REPORT',
    '',
    `Status:      ${row.statusLabel.toUpperCase()}`,
    `Automation:  ${row.automationLabel}${row.delivery ? ` (${row.delivery.label})` : ''}`,
    `Time:        ${formatTime(error.at ?? row.finishedAt ?? row.startedAt)}`,
    `Step:        ${error.step ?? 'unknown'}`,
    ...(error.code ? [`Code:        ${error.code}`] : []),
    `Message:     ${error.reason || 'unknown'}`,
    `Order:       ${row.orderNumber ? `WTCSG${row.orderNumber}` : 'none'}`,
    `Page:        ${error.pages.length > 0 ? error.pages.join(indent) : 'not recorded'}`,
    `Screenshot:  ${error.screenshots.length > 0 ? error.screenshots.map((name) => path.join(row.folder, name)).join(indent) : 'none'}`,
    ...(row.automation === 'order' ? [`Products:    ${productsText(row.products.requested) || 'none'}`] : []),
    `Run:         ${row.runId}`,
    `Operator:    ${row.operator ?? 'unknown'}`,
    `Environment: Watsons STAGING (${STAGING_HOST})`,
    '',
    'Details:',
    error.message || error.reason || 'none',
    '',
  ];
  return lines.join('\n');
}

/** Logs / History as a CSV file for Excel (order numbers as backoffice codes, so no digits get lost). */
function historyCsv(rows) {
  const cell = (value) => {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) text = `'${text}`; // never a formula in Excel
    return `"${text.replace(/"/g, '""')}"`;
  };
  const header = ['Time', 'Run', 'Automation', 'Order', 'Delivery', 'Products', 'Excluded (not eligible)', 'Status', 'Error code', 'Error step', 'Error', 'Operator', 'Screenshots', 'Evidence'];
  const lines = rows.map((row) =>
    [
      formatTime(row.startedAt),
      row.runId,
      row.automationLabel,
      row.orderNumber ? `WTCSG${row.orderNumber}` : '',
      row.delivery?.label ?? '',
      productsText(row.products.ordered.length > 0 ? row.products.ordered : row.products.requested),
      row.products.excluded.join(', '),
      row.statusLabel,
      row.error?.code ?? '',
      row.error?.step ?? '',
      row.error?.reason ?? row.warning ?? '',
      row.operator ?? '',
      row.screenshots.length,
      row.folder,
    ]
      .map(cell)
      .join(','),
  );
  return `\ufeff${[header.map(cell).join(','), ...lines].join('\r\n')}\r\n`;
}

/** A screenshot of a run, if the name is one (never a path outside the run's evidence folder). */
function evidenceFile(root, runId, name) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId) || typeof name !== 'string' || !SCREENSHOT_NAME.test(name)) return null;
  const file = path.join(root, 'reports', runId, name);
  return fs.existsSync(file) ? file : null;
}

// ---------------------------------------------------------------------------------------------
// The local web server. Only this PC can reach it (127.0.0.1), and every request must carry the
// random key from the window's address, so other programs and websites can't start a test.

function readPage() {
  if (isPackaged) return require('node:sea').getAsset('ui.html', 'utf8');
  return fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 200_000) reject(new Error('Request too large.'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Request is not JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function openWithWindows(target) {
  // explorer.exe opens a folder in File Explorer and a file with its usual program.
  spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'), [target], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * Starts the launcher. Options: root (the test project folder), openWindow (default true),
 * quiet (no console output), onIdle (called when no window has been connected for a while and
 * no test is running), openFile (opens a file or folder for the person; default: with Windows).
 */
async function startLauncher({ root, openWindow = true, quiet = false, onIdle, openFile = openWithWindows } = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const clients = new Set();
  const echo = quiet ? () => {} : (line) => console.log(line);
  const send = (event, data) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(message);
  };
  const runner = new TestRunner(root, send, echo, () => readOperator(root));
  // Not packaged, this very program is Node. Packaged, the test needs Node.js installed.
  const nodeFound = !isPackaged || (await new Promise((done) => execFile('node', ['--version'], { windowsHide: true }, (error) => done(!error))));
  const setup = () => checkSetup(root, nodeFound);
  let port = 0;
  let idleTimer = null;

  const state = () => ({
    setup: setup(),
    defaults: readDefaults(root),
    automations: AUTOMATIONS,
    deliveryMethods: DELIVERY_METHODS,
    modes: MODES,
    steps: { approve: APPROVE_STEPS, order: Object.fromEntries(Object.keys(MODES).map((mode) => [mode, stepsFor('order', mode)])) },
    addDelay: ADD_DELAY,
    statuses: STATUSES,
    riskWarnings: Object.fromEntries(Object.entries(RISKS).map(([automation, risk]) => [automation, risk.warning])),
    operator: readOperator(root),
    stagingHost: STAGING_HOST,
    current: runner.publicRun(runner.current),
    last: runner.publicRun(runner.last),
  });

  const json = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      // Only this address (blocks other websites that point their own names at 127.0.0.1).
      if (req.headers.host !== `127.0.0.1:${port}`) return json(res, 403, { error: 'Wrong address.' });
      const key = req.method === 'GET' ? url.searchParams.get('token') : req.headers['x-launcher-token'];
      if (key !== token) return json(res, 403, { error: 'Missing or wrong key. Open the launcher window again.' });

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:",
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer',
        });
        return res.end(readPage());
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
        clients.add(res);
        clearTimeout(idleTimer);
        req.on('close', () => {
          clients.delete(res);
          if (clients.size === 0) checkIdle();
        });
        return;
      }
      // A run's screenshot, for Logs / History and the error report.
      if (req.method === 'GET' && url.pathname === '/api/screenshot') {
        const file = evidenceFile(root, url.searchParams.get('run'), url.searchParams.get('name'));
        if (!file) return json(res, 404, { error: 'No such screenshot.' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
        fs.createReadStream(file)
          .on('error', () => res.destroy())
          .pipe(res);
        return;
      }
      if (req.method !== 'POST') return json(res, 404, { error: 'Not found.' });
      // POSTs must be JSON: browsers then refuse to send them from other websites.
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'Expected JSON.' });
      const body = await readBody(req);

      if (url.pathname === '/api/state') return json(res, 200, state());
      if (url.pathname === '/api/check') return json(res, 200, parseProducts(body.products));
      if (url.pathname === '/api/run') {
        if (runner.running) return json(res, 409, { problems: ['A test is already running.'] });
        const checked = checkRunRequest(body, setup());
        if (!checked.order) return json(res, 400, { problems: checked.problems });
        const run = runner.start(checked.order);
        return json(res, 200, { runId: run.runId });
      }
      if (url.pathname === '/api/stop') return json(res, 200, { stopped: runner.stop() });
      if (url.pathname === '/api/history') return json(res, 200, { rows: readHistory(root, runner.current?.runId) });
      if (url.pathname === '/api/export') {
        const wanted = Array.isArray(body.runIds) ? new Set(body.runIds) : null;
        const rows = readHistory(root, runner.current?.runId).filter((row) => !wanted || wanted.has(row.runId));
        fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
        const file = path.join(root, 'reports', `history-${stamp(new Date())}.csv`);
        fs.writeFileSync(file, historyCsv(rows));
        openFile(file);
        return json(res, 200, { file: path.relative(root, file), rows: rows.length });
      }
      if (url.pathname === '/api/open') {
        if (body.what === 'reports') {
          const reports = path.join(root, 'reports');
          fs.mkdirSync(reports, { recursive: true });
          openFile(reports);
          return json(res, 200, { opened: 'reports' });
        }
        if (typeof body.runId !== 'string' || !RUN_ID.test(body.runId)) return json(res, 404, { error: 'No such run.' });
        const folder = path.join(root, 'reports', body.runId);
        if (!fs.existsSync(folder)) return json(res, 404, { error: 'The evidence folder no longer exists.' });
        let target = folder;
        if (body.what === 'report') {
          const report = path.join(folder, 'html-report', 'index.html');
          if (fs.existsSync(report)) target = report;
        } else if (body.what === 'error-report') {
          const report = path.join(folder, ERROR_REPORT_FILE);
          if (fs.existsSync(report)) target = report;
        } else if (body.what === 'screenshot') {
          target = evidenceFile(root, body.runId, body.name);
          if (!target) return json(res, 404, { error: 'No such screenshot.' });
        }
        openFile(target);
        return json(res, 200, { opened: path.relative(root, target) });
      }
      return json(res, 404, { error: 'Not found.' });
    } catch (error) {
      return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  // When the window is closed (no connection for 20 s) and no test runs, the launcher can stop.
  // A test that is running continues (stopping it during payment could leave the order unknown);
  // the launcher stops after it.
  function checkIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (clients.size > 0) return;
      if (runner.running) {
        echo('[launcher] The window was closed; the test continues here. Its result will be in the reports folder.');
        const wait = setInterval(() => {
          if (!runner.running) {
            clearInterval(wait);
            onIdle?.();
          }
        }, 2000);
        return;
      }
      onIdle?.();
    }, 20_000);
  }

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      const url = `http://127.0.0.1:${port}/?token=${token}`;
      const edge = openWindow ? openAppWindow(url, echo) : null;
      checkIdle(); // in case the window never connects
      resolve({
        url,
        runner,
        close: () =>
          new Promise((done) => {
            if (runner.current) killTree(runner.current.child);
            if (edge) killTree(edge);
            for (const client of clients) client.end();
            clearTimeout(idleTimer);
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

/** Opens the page in an Edge app window with its own profile (no tabs or address bar). */
function openAppWindow(url, echo) {
  const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter(Boolean)
    .map((dir) => path.join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    .find((file) => fs.existsSync(file));
  if (!edge) {
    echo('[launcher] Microsoft Edge not found; opening the launcher in the default browser.');
    openWithWindows(url);
    return null;
  }
  const profile = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'WatsonsTester', 'edge-profile');
  // Fits a 1280×800 laptop screen (seen 2026-10-07); on a smaller window the page stacks its columns.
  const child = spawn(edge, [`--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1240,740'], {
    stdio: 'ignore',
  });
  child.on('error', () => openWithWindows(url));
  return child;
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const root = isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');
  const noWindow = process.argv.includes('--no-window');
  console.log('WatsonsTester: Watsons STAGING automation launcher');
  console.log(`Project folder: ${root}`);
  let launcher;
  const quit = async (code = 0) => {
    if (launcher) await launcher.close();
    process.exit(code);
  };
  launcher = await startLauncher({
    root,
    openWindow: !noWindow,
    // Stop when the window is closed (with --no-window there is no window to wait for).
    onIdle: noWindow
      ? undefined
      : () => {
          console.log('[launcher] Window closed. Goodbye.');
          quit(0);
        },
  });
  console.log(noWindow ? `Open this address in Edge: ${launcher.url}` : 'The launcher window opens in Edge. Keep this window open while using it.');
  console.log('Closing this window stops the launcher and any test it is running.');
  // Ctrl+C, or closing the console window: stop the test (and its browser) too.
  process.on('SIGINT', () => quit(130));
  process.on('SIGHUP', () => quit(129));
}

if (require.main === module || isPackaged) {
  main().catch((error) => {
    console.error(`[launcher] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  STAGING_HOST,
  DELIVERY_METHODS,
  MODES,
  AUTOMATIONS,
  ADD_DELAY,
  // Also used by the hosted server (server/), which runs the same tests for signed-in people.
  STEPS,
  ORDER_STEPS,
  APPROVE_STEPS,
  RISKS,
  STATUSES,
  RUN_ID,
  SCREENSHOT_NAME,
  ERROR_REPORT_FILE,
  stepsFor,
  parseProducts,
  normalizeOrderNumber,
  parseAddDelay,
  orderFileText,
  parseOrderText,
  readDefaults,
  checkSetup,
  checkRunRequest,
  TestRunner,
  killTree,
  runFolderPath,
  historyRow,
  rowFromFolder,
  readHistory,
  errorReportText,
  historyCsv,
  formatTime,
  startLauncher,
};
