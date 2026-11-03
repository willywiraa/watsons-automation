'use strict';
// Orders left at "Order Split" are followed until they are ORDER_EXTRACTED (user's request
// 2026-11-03; hosted app only). A run that approves an order waits at most a minute at Order Split
// and then ends, its order "Extraction pending" in Logs / History (2026-10-23). From then on this
// service checks the order in the staging shop, with the testing account that placed it
// (tests/extraction-check.e2e.spec.ts: it signs in and opens the order under My Account; it only
// reads). Every 2 minutes for the first hour, then every 10 minutes, for up to 24 hours (the user's
// choices). Once the shop says ORDER_EXTRACTED, the order's runs are updated and every open page
// reloads Logs / History, so people see it without refreshing.
//
// A testing account is in this service's memory only while its person is signed in (decision
// 2026-10-09): while nobody who ran the order is, its checks pause, and they go on at that person's
// next sign-in (their remembered account comes back then). One check at a time; none while that
// account is in use by a run, nor while the server runs as many runs as it allows.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { killTree } = require('../../launcher/launcher.cjs');

const TIMING = {
  tickMs: 30_000, // how often the pending orders are looked at
  firstAfterMs: 2 * 60_000, // the first check, after the run ended
  earlyEveryMs: 2 * 60_000, // then every 2 minutes…
  earlyForMs: 60 * 60_000, // …for the first hour
  lateEveryMs: 10 * 60_000, // then every 10 minutes
  giveUpAfterMs: 24 * 3600_000,
  checkTimeoutMs: 6 * 60_000, // one check (sign-in and the orders' pages) at most
};

// Switches a check never inherits from the service's own environment: it sets the ones it needs.
const NOT_INHERITED = [
  'WATSONS_USERNAME',
  'WATSONS_PASSWORD',
  'WATSONS_BACKOFFICE_USERNAME',
  'WATSONS_BACKOFFICE_PASSWORD',
  'WATSONS_PLACE_ORDER',
  'WATSONS_ORDER_FILE',
  'WATSONS_APPROVE_ORDER',
  'WATSONS_INTERACTIVE',
  'WATSONS_LIVE_VIEW_PORT',
];

/** When an order is checked next: `since` its run ended, last checked at `last` (ms, or null: never). */
function nextCheckAt(since, last, timing = TIMING) {
  if (last === null || last === undefined) return since + timing.firstAfterMs;
  return last + (last - since < timing.earlyForMs ? timing.earlyEveryMs : timing.lateEveryMs);
}

/** Extracted: the shop's status says so, or it has an extraction time (as src/pages/MyOrderPage.ts). */
const isExtracted = (order) => /EXTRACTED/i.test(order.status ?? '') || Boolean(order.extractedAt);

/** Deletes a check's folder; one Windows still holds a moment (its browser closing) is left for the next start. */
function removeFolder(folder) {
  try {
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // left for the next start
  }
}

const pad = (n) => String(n).padStart(2, '0');
const stampOf = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;

class ExtractionWatcher {
  constructor({ config, store, runs, sessions, broadcast, log = () => {} }) {
    this.config = config;
    this.store = store;
    this.runs = runs;
    this.sessions = sessions;
    this.broadcast = broadcast;
    this.log = log;
    this.timing = { ...TIMING, ...config.extractionTiming };
    this.workRoot = path.join(config.dataDir, 'extraction-checks');
    /** order number → { lastCheckedAt (ms), notIn: account fingerprints the shop doesn't give it for } */
    this.orders = new Map();
    /** The check going on: { child, closed }. One at a time. */
    this.checking = null;
    this.stopped = false;
  }

  start() {
    removeFolder(this.workRoot); // a check cut off when the service stopped
    this.timer = setInterval(() => this.tick().catch((error) => this.log(`Extraction checks: ${error.message}`)), this.timing.tickMs);
    this.timer.unref();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.checking) {
      killTree(this.checking.child);
      await Promise.race([this.checking.closed, new Promise((done) => setTimeout(done, 5_000))]);
    }
  }

  /** Writes how the checks of an order stand on its runs, when that changed, and tells the open pages. */
  note(orderNumber, rows, check) {
    const before = rows[0]?.backoffice?.extractionCheck ?? null;
    const same = (key) => (before?.[key] ?? null) === (check[key] ?? null);
    if (before && ['state', 'reason', 'lastCheckedAt', 'lastStatus', 'nextCheckAt', 'problem'].every(same) && (before.who ?? []).join() === (check.who ?? []).join()) return;
    if (this.store.noteExtractionCheck(orderNumber, check) > 0) this.broadcast('history', { extraction: orderNumber });
  }

  /** Looks at the orders still pending: notes how they stand, and starts the check that is due. */
  async tick(now = Date.now()) {
    if (this.stopped || this.checking) return;
    const byOrder = new Map();
    for (const row of this.store.extractionPending()) {
      if (!byOrder.has(row.orderNumber)) byOrder.set(row.orderNumber, []);
      byOrder.get(row.orderNumber).push(row);
    }
    for (const orderNumber of this.orders.keys()) if (!byOrder.has(orderNumber)) this.orders.delete(orderNumber);

    const due = new Map(); // account fingerprint → { account, orders }
    for (const [orderNumber, rows] of byOrder) {
      const check = rows[0].backoffice?.extractionCheck ?? null;
      if (check?.state === 'stopped') continue;
      const since = Math.min(...rows.map((row) => Date.parse(row.finishedAt ?? row.startedAt)).filter(Number.isFinite));
      if (!Number.isFinite(since)) continue;
      if (!this.orders.has(orderNumber)) {
        const last = Date.parse(check?.lastCheckedAt ?? '');
        this.orders.set(orderNumber, { lastCheckedAt: Number.isFinite(last) ? last : null, notIn: new Set() });
      }
      const memory = this.orders.get(orderNumber);
      if (now - since > this.timing.giveUpAfterMs) {
        this.note(orderNumber, rows, { state: 'stopped', lastCheckedAt: check?.lastCheckedAt ?? null, lastStatus: check?.lastStatus ?? null });
        this.orders.delete(orderNumber);
        continue;
      }
      // Who can check it: the people who ran something for this order, the one who placed it first
      // (their testing account has it; it may have been approved later by someone else), while they
      // are signed in with a testing account.
      const people = [...new Map(this.store.peopleOf(orderNumber).map((person) => [person.username, person.operator])).entries()];
      const signedIn = people.map(([username]) => this.sessions.testingAccountOf(username)).filter(Boolean);
      const account = signedIn.find((candidate) => !memory.notIn.has(candidate.fingerprint));
      const next = nextCheckAt(since, memory.lastCheckedAt, this.timing);
      const lastCheckedAt = memory.lastCheckedAt ? new Date(memory.lastCheckedAt).toISOString() : null;
      if (!account) {
        const reason = signedIn.length > 0 ? 'not_found' : 'signed_out';
        this.note(orderNumber, rows, { state: 'paused', reason, who: people.map(([, name]) => name), lastCheckedAt, lastStatus: check?.lastStatus ?? null });
        continue;
      }
      this.note(orderNumber, rows, { state: 'checking', lastCheckedAt, lastStatus: check?.lastStatus ?? null, nextCheckAt: new Date(next).toISOString(), problem: check?.problem ?? null });
      if (now < next || this.runs.accountInUse(account.fingerprint)) continue;
      if (!due.has(account.fingerprint)) due.set(account.fingerprint, { account, orders: [] });
      due.get(account.fingerprint).orders.push(orderNumber);
    }
    // One check at a time, and never in the way of runs: the server is not busy with as many as it allows.
    const [first] = due.values();
    if (first && this.runs.active.size < this.config.maxParallelRuns) await this.check(first.account, first.orders);
  }

  /** One check: signs in to the shop with `account` and reads these orders (the check's test). */
  check(account, orders) {
    const startedAt = new Date();
    fs.mkdirSync(this.workRoot, { recursive: true });
    const work = fs.mkdtempSync(path.join(this.workRoot, `${stampOf(startedAt)}-`));
    const resultFile = path.join(work, 'result.json');
    const env = { ...process.env };
    for (const name of NOT_INHERITED) delete env[name];
    Object.assign(env, {
      WATSONS_STAGING_URL: this.config.stagingUrl,
      WATSONS_USERNAME: account.username,
      WATSONS_PASSWORD: account.password,
      WATSONS_CHECK_ORDERS: orders.join(' '),
      WATSONS_CHECK_RESULT: resultFile,
      WATSONS_RUN_ID: `${stampOf(startedAt)}_extraction-check`,
      // Its own Playwright folders, deleted afterwards: never another run's.
      WATSONS_REPORTS_DIR: path.join(work, 'reports'),
      WATSONS_HTML_REPORT_DIR: path.join(work, 'html-report'),
    });
    const cli = path.join(this.config.projectDir, 'node_modules', '@playwright', 'test', 'cli.js');
    const args = [cli, 'test', '--project=extraction', 'extraction-check', '--reporter=line', '--output', path.join(work, 'test-results')];
    const child = spawn(process.execPath, args, { cwd: this.config.projectDir, windowsHide: true, env });
    const output = [];
    const keep = (chunk) => {
      output.push(...String(chunk).split(/\r?\n/).filter(Boolean));
      output.splice(0, Math.max(0, output.length - 40));
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => killTree(child), this.timing.checkTimeoutMs);
    const closed = new Promise((done) => {
      child.on('error', () => done(null));
      child.on('close', (exitCode) => done(exitCode));
    });
    this.checking = { child, closed };
    return closed.then((exitCode) => {
      clearTimeout(timer);
      let found = null;
      try {
        found = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      } catch {
        found = null;
      }
      removeFolder(work);
      this.checking = null;
      if (this.stopped) return;
      this.apply(account, orders, Array.isArray(found) ? found : null, startedAt);
      if (!Array.isArray(found)) {
        // Never a password in the service's log (the test doesn't print it; this makes sure).
        const lines = output.map((line) => [account.password, account.username].reduce((text, secret) => text.split(secret).join('[removed]'), line));
        this.log(`Extraction check of ${orders.join(', ')} did not finish (exit ${exitCode}): ${lines.slice(-8).join(' | ')}`);
      }
    });
  }

  /** What a check found: extracted orders are marked so; the others noted for their next check. */
  apply(account, orders, found, checkedAt) {
    const at = checkedAt.toISOString();
    const pending = new Map();
    for (const row of this.store.extractionPending()) if (!pending.has(row.orderNumber)) pending.set(row.orderNumber, row);
    for (const orderNumber of orders) {
      const memory = this.orders.get(orderNumber) ?? { lastCheckedAt: null, notIn: new Set() };
      this.orders.set(orderNumber, memory);
      const row = pending.get(orderNumber);
      const order = found?.find((entry) => entry?.orderNumber === orderNumber);
      if (found && order && !order.found) {
        memory.notIn.add(account.fingerprint); // another person's account may have it: the next look decides
        continue;
      }
      memory.lastCheckedAt = checkedAt.getTime();
      if (order && isExtracted(order)) {
        const extractedAt = typeof order.extractedAt === 'string' ? order.extractedAt : at;
        if (this.store.markExtracted(orderNumber, { extractedAt, seenAt: at }) > 0) {
          this.store.audit({ action: 'order-extracted', detail: { orderNumber, extractedAt } });
          this.broadcast('history', { extracted: orderNumber });
        }
        this.orders.delete(orderNumber);
        continue;
      }
      if (!row) continue;
      const since = Date.parse(row.finishedAt ?? row.startedAt);
      this.note(orderNumber, [row], {
        state: 'checking',
        lastCheckedAt: at,
        lastStatus: order?.status ?? row.backoffice?.extractionCheck?.lastStatus ?? null,
        nextCheckAt: new Date(nextCheckAt(since, memory.lastCheckedAt, this.timing)).toISOString(),
        problem: order ? null : 'The last check could not finish; it is tried again.',
      });
    }
  }
}

module.exports = { ExtractionWatcher, nextCheckAt, TIMING };
