'use strict';
// The runs on the hosted server (decisions 2026-10-08 and 2026-10-09): each signed-in person has
// their own TestRunner (the desktop launcher's, launcher/launcher.cjs), running headless with the
// person's own staging accounts (testing and backoffice). Runs of different people go on in
// parallel, up to WATSONS_MAX_PARALLEL_RUNS; beyond that they wait in line. One run per person, and
// per testing account, at a time.
//
// Since 2026-10-14 (user's requests):
// - The person watches and controls their run's browser in their page (LiveView). The run ends as
//   soon as its test is done (2026-10-23; until then it kept its last page open until Close browser).
// - The backoffice account is optional for a new order: without it the run stops at the order
//   confirmation, and the order shows "Awaiting approval" until an approve run approves it.

const fs = require('node:fs');
const path = require('node:path');
const launcher = require('../../launcher/launcher.cjs');
const { listFiles, removeSecrets, runFolder } = require('./evidence.cjs');
const { LiveView } = require('./liveview.cjs');

// The DevTools ports the runs' browsers open for the live view, on this computer only.
const LIVE_PORTS = { from: 9300, count: 600 };

const { TestRunner, checkRunRequest, rowFromFolder, orderFileText, parseOrderText, readDefaults, STAGING_HOST, AUTOMATIONS } = launcher;

/** Replaces the secrets in every text of an object or array, in place. Returns whether it found one. */
function scrub(value, secrets) {
  const values = secrets.filter((secret) => typeof secret === 'string' && secret.length >= 4);
  if (!value || typeof value !== 'object' || values.length === 0) return false;
  let found = false;
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (typeof item === 'string') {
      let cleaned = item;
      for (const secret of values) cleaned = cleaned.split(secret).join('[removed]');
      if (cleaned !== item) {
        value[key] = cleaned;
        found = true;
      }
    } else if (item && typeof item === 'object') {
      found = scrub(item, values) || found;
    }
  }
  return found;
}

class RunManager {
  /** sendTo(username, event, data): to that person's open windows. broadcast(event, data): to all. */
  constructor({ config, store, sendTo, broadcast }) {
    this.config = config;
    this.store = store;
    this.sendTo = sendTo;
    this.broadcast = broadcast;
    this.runners = new Map(); // username → TestRunner
    this.active = new Map(); // run id → { username, displayName, automation, fingerprint, password, runner, startedAt }
    this.queue = []; // [{ username, displayName, request, account, ip }]
  }

  /** The checks the Run list shows (PRD §37), for this server. Each person's accounts are checked in their window. */
  setup() {
    let stagingOk = false;
    try {
      const url = new URL(this.config.stagingUrl);
      stagingOk = url.protocol === 'https:' && url.host === STAGING_HOST && !url.username && !url.password;
    } catch {
      stagingOk = false;
    }
    const projectFound =
      fs.existsSync(path.join(this.config.projectDir, 'playwright.config.ts')) &&
      fs.existsSync(path.join(this.config.projectDir, 'node_modules', '@playwright', 'test', 'cli.js'));
    const checks = [
      { label: 'Test project found', ok: projectFound, help: 'IT: the server cannot find the test project (WATSONS_PROJECT_DIR, then "npm install" there).' },
      { label: 'Staging environment configured', ok: stagingOk, help: 'IT: set WATSONS_STAGING_URL on the server to the Watsons STAGING address.' },
    ];
    return { checks, ready: checks.every((check) => check.ok) };
  }

  /** What a person's window starts with: their last order on this server, else test-data/order.txt. */
  defaults(username) {
    const prefs = this.store.prefs(username);
    const fallback = readDefaults(this.config.projectDir);
    if (!prefs?.last_order) return fallback;
    const order = parseOrderText(prefs.last_order);
    return {
      products: order.productLines.join('\n'),
      deliveryMethod: order.deliveryMethod ?? fallback.deliveryMethod,
      mode: launcher.MODES[order.mode]?.available ? order.mode : 'express',
      source: 'your last run',
    };
  }

  runnerFor(username, displayName) {
    let runner = this.runners.get(username);
    if (!runner) {
      runner = new TestRunner(
        this.config.projectDir,
        (event, data) => this.sendTo(username, event, data),
        () => {}, // each run's log is in its evidence (launcher-log.txt), not the service log
        () => this.runners.get(username).displayName,
        {
          headed: false, // nobody sits at the server
          reportsDir: this.config.evidenceDir, // <evidence>/<yyyy-mm-dd>/<run id>/
          isolate: true, // parallel runs: own Playwright folders
          rememberDefaults: false, // kept per person in the database instead
          onFinished: (run, row) => this.finished(username, run, row),
        },
      );
      this.runners.set(username, runner);
    }
    runner.displayName = displayName;
    return runner;
  }

  /** The person's run going on, waiting in line, or null. */
  activeOf(username) {
    for (const [runId, entry] of this.active) if (entry.username === username) return { runId, ...entry, state: 'running' };
    const position = this.queue.findIndex((entry) => entry.username === username);
    return position >= 0 ? { ...this.queue[position], state: 'queued', position: position + 1 } : null;
  }

  accountInUse(fingerprint) {
    return [...this.active.values(), ...this.queue].some((entry) => entry.fingerprint && entry.fingerprint === fingerprint);
  }

  /**
   * A run request from a signed-in person. Returns { status, body } for the response:
   * started (run id), queued (position), or refused (problems).
   */
  submit(session, body, ip) {
    const checked = checkRunRequest(body, this.setup());
    const problems = [...checked.problems];
    const placing = (checked.order?.automation ?? body?.automation ?? 'order') === 'order';
    const account = session.testingAccount;
    const backoffice = session.backofficeAccount;
    if (placing && !account) problems.push('Enter your testing account first (under "Accounts").');
    // A new order can do without it: it then waits for approval (2026-10-14). Approving can't.
    if (!placing && !backoffice) problems.push('Enter your backoffice account first (under "Accounts").');
    if (problems.length > 0 || !checked.order) return { status: 400, body: { problems } };
    const own = this.activeOf(session.username);
    if (own) return { status: 409, body: { problems: ['You already have a run going on. Wait until it ends, or stop it.'] } };
    if (placing && this.accountInUse(account.fingerprint)) {
      return { status: 409, body: { problems: ['This testing account is in use by another run. Use another testing account, or wait until that run ends.'] } };
    }
    const entry = {
      username: session.username,
      displayName: session.displayName,
      request: checked.order,
      // Copies for this run only: the person may change or forget theirs meanwhile.
      account: placing ? { username: account.username, password: account.password } : null,
      backoffice: backoffice ? { username: backoffice.username, password: backoffice.password } : null,
      fingerprint: placing ? account.fingerprint : null,
      ip,
    };
    if (placing) {
      this.store.savePrefs(session.username, { lastOrder: orderFileText(checked.order), addDelaySeconds: checked.order.addDelaySeconds });
    }
    if (this.active.size >= this.config.maxParallelRuns) {
      this.queue.push(entry);
      this.store.audit({ username: session.username, ip, action: 'run-queued', detail: { automation: checked.order.automation, position: this.queue.length } });
      this.changed();
      return { status: 202, body: { queued: true, position: this.queue.length } };
    }
    const runId = this.start(entry);
    return { status: 200, body: { runId } };
  }

  /** A DevTools port for a run's browser that no other run uses. */
  livePort() {
    const used = new Set([...this.active.values()].map((entry) => entry.live?.port));
    let port;
    do port = LIVE_PORTS.from + Math.floor(Math.random() * LIVE_PORTS.count);
    while (used.has(port));
    return port;
  }

  start(entry) {
    const runner = this.runnerFor(entry.username, entry.displayName);
    const port = this.livePort();
    // This run's accounts go into the test's environment only (TestRunner option "env"). The
    // browser opens a DevTools port for the live view.
    runner.options.env = () => ({
      WATSONS_STAGING_URL: this.config.stagingUrl,
      WATSONS_USERNAME: entry.account?.username,
      WATSONS_PASSWORD: entry.account?.password,
      WATSONS_BACKOFFICE_USERNAME: entry.backoffice?.username,
      WATSONS_BACKOFFICE_PASSWORD: entry.backoffice?.password,
      WATSONS_LIVE_VIEW_PORT: String(port),
    });
    let run;
    try {
      run = runner.start(entry.request);
    } finally {
      runner.options.env = null;
    }
    const live = new LiveView({ runId: run.runId, port, send: (event, data) => this.sendTo(entry.username, event, data) });
    this.active.set(run.runId, {
      username: entry.username,
      displayName: entry.displayName,
      automation: run.automation,
      fingerprint: entry.fingerprint,
      // Kept until the run has ended, only to check its evidence for it (finished()).
      secrets: [entry.account?.password, entry.backoffice?.password],
      runner,
      live,
      startedAt: run.startedAt,
    });
    live.start();
    entry.account = null;
    entry.backoffice = null;
    const row = rowFromFolder(run.dir, run.runId, { currentRunId: run.runId, folder: run.folder });
    this.store.startRun(row, { username: entry.username, displayName: entry.displayName });
    this.store.audit({ username: entry.username, ip: entry.ip, action: 'run-start', runId: run.runId, detail: { automation: run.automation, orderNumber: run.orderNumber ?? undefined } });
    this.changed();
    return run.runId;
  }

  /** TestRunner's onFinished: check the evidence, save the run, start the next one in line. */
  finished(username, run, row) {
    const entry = this.active.get(run.runId);
    const secrets = entry?.secrets ?? [];
    const removed = removeSecrets(run.dir, secrets);
    // The row and the log in memory were read before: clean them too (the window gets them next).
    const leakedInRow = scrub(row, secrets);
    const leakedInLog = scrub(run.lines, secrets);
    if (removed.length > 0 || leakedInRow || leakedInLog) {
      this.store.audit({ username, action: 'evidence-secret-removed', runId: run.runId, success: false, detail: { files: removed } });
    }
    if (row) this.store.finishRun(row, listFiles(run.dir), { username, displayName: entry?.displayName });
    const succeeded = ['completed', 'no_change', 'awaiting_approval'].includes(row?.status);
    this.store.audit({ username, action: 'run-end', runId: run.runId, success: succeeded, detail: { status: row?.status, orderNumber: row?.orderNumber ?? undefined } });
    // An approval of an order that was placed without one: that order run is now approved too.
    if (row?.automation === 'approve' && ['completed', 'no_change'].includes(row.status) && row.orderNumber) {
      const approval = { runId: run.runId, by: entry?.displayName ?? username, at: row.finishedAt ?? new Date().toISOString() };
      if (this.store.markApprovedLater(row.orderNumber, approval) > 0) {
        this.store.audit({ username, action: 'order-approved-later', runId: run.runId, detail: { orderNumber: row.orderNumber } });
        this.broadcast('history', { approved: row.orderNumber });
      }
    }
    if (entry) {
      entry.secrets = null;
      entry.live?.stop();
    }
    this.active.delete(run.runId);
    setImmediate(() => this.next());
    this.changed();
  }

  next() {
    while (this.queue.length > 0 && this.active.size < this.config.maxParallelRuns) this.start(this.queue.shift());
    this.changed();
  }

  /** Stops a person's own run (or any run, for an admin). Returns a reason it can't, or null. */
  stop(session, runId, ip) {
    const own = this.activeOf(session.username);
    const targetId = runId ?? own?.runId ?? null;
    if (!runId && own?.state === 'queued') {
      this.queue.splice(own.position - 1, 1);
      this.store.audit({ username: session.username, ip, action: 'run-unqueued' });
      this.changed();
      return null;
    }
    const entry = targetId ? this.active.get(targetId) : null;
    if (!entry) return 'There is no such run going on.';
    if (entry.username !== session.username && session.role !== 'admin') return 'You can only stop your own runs.';
    if (!entry.runner.stop()) return 'This run can no longer be stopped (it has passed and is ending).';
    this.store.audit({ username: session.username, ip, action: 'run-stop', runId: targetId, detail: entry.username === session.username ? undefined : { owner: entry.username } });
    return null;
  }

  /**
   * A person's answer to the question their own run is waiting on (2026-10-22): only the owner
   * answers, since it decides what goes into their order. Returns a reason it can't, or null.
   */
  answer(session, body, ip) {
    const own = this.activeOf(session.username);
    if (own?.state !== 'running') return 'You have no run going on.';
    const problem = own.runner.answer(body, own.displayName);
    if (problem) return problem;
    const plu = typeof body?.plu === 'string' && /^\d{1,12}$/.test(body.plu.trim()) ? body.plu.trim() : undefined;
    this.store.audit({ username: session.username, ip, action: 'run-answer', runId: own.runId, detail: { action: String(body?.action), plu } });
    return null;
  }

  /** Who is running what now, for everyone's window (no accounts, no logs). */
  overview() {
    const running = [...this.active].map(([runId, entry]) => ({
      runId,
      operator: entry.displayName,
      automation: entry.automation,
      automationLabel: AUTOMATIONS[entry.automation].label,
      step: entry.runner.current?.step ?? null,
      startedAt: entry.startedAt,
      state: 'running',
    }));
    const waiting = this.queue.map((entry, index) => ({
      operator: entry.displayName,
      automation: entry.request.automation,
      automationLabel: AUTOMATIONS[entry.request.automation].label,
      state: 'queued',
      position: index + 1,
    }));
    return { running, waiting, maxParallelRuns: this.config.maxParallelRuns };
  }

  /** A person's own run state for their window. */
  personal(session) {
    const runner = this.runners.get(session.username);
    const own = this.activeOf(session.username);
    return {
      current: runner?.publicRun(runner.current) ?? null,
      last: runner?.publicRun(runner.last) ?? null,
      queuePosition: own?.state === 'queued' ? own.position : null,
    };
  }

  /** The live rows of the runs going on (for Logs / History), from their evidence folders. */
  liveRows() {
    return [...this.active.entries()].flatMap(([runId, entry]) => {
      const run = entry.runner.current;
      if (!run) return [];
      const row = rowFromFolder(run.dir, runId, { currentRunId: runId, folder: run.folder });
      return row ? [{ ...row, username: entry.username, operator: entry.displayName }] : [];
    });
  }

  changed() {
    this.broadcast('runs', this.overview());
    for (const entry of this.queue) this.sendTo(entry.username, 'queue', { position: this.activeOf(entry.username)?.position ?? null });
  }

  /** A person signed out: their runs waiting in line go (with their account copies); a run going on finishes. */
  forget(username) {
    const before = this.queue.length;
    this.queue = this.queue.filter((entry) => entry.username !== username);
    if (this.queue.length !== before) this.changed();
  }

  /** The live view of a run that the person may watch and control: their own. Returns { live } or { status, error }. */
  liveOf(session, runId) {
    const entry = typeof runId === 'string' ? this.active.get(runId) : undefined;
    if (!entry) return { status: 404, error: 'That run has ended.' };
    if (entry.username !== session.username) return { status: 403, error: 'You can only control your own run’s browser.' };
    return { live: entry.live, entry };
  }

  /**
   * Runs saved as failed although their test had passed: Close browser used to close the whole
   * browser, which made the test's clean-up fail afterwards (until 2026-10-14). Read again from
   * their evidence (launcher.cjs, rowFromFolder now goes by the test's PASS line). Returns how many
   * rows changed.
   */
  recheckFailedRuns() {
    let changed = 0;
    for (const old of this.store.listRuns()) {
      if (!['failed', 'interrupted'].includes(old.status)) continue;
      const dir = runFolder(this.config.evidenceDir, old.runId);
      const row = dir && fs.existsSync(dir) ? rowFromFolder(dir, old.runId, { folder: old.folder }) : null;
      if (!row || ['failed', 'interrupted'].includes(row.status)) continue;
      this.store.finishRun(row, listFiles(dir), { username: old.username, displayName: old.operator });
      changed++;
    }
    if (changed === 0) return 0;
    // A corrected order may have been approved meanwhile, and a corrected approval may have
    // approved an order waiting for it: link each order to its first approval.
    const approvals = this.store
      .listRuns()
      .filter((row) => row.automation === 'approve' && row.orderNumber && ['completed', 'no_change'].includes(row.status))
      .reverse(); // oldest first
    for (const approval of approvals) {
      this.store.markApprovedLater(approval.orderNumber, { runId: approval.runId, by: approval.operator, at: approval.finishedAt ?? approval.startedAt });
    }
    return changed;
  }

  /** A window that opens while the person's run goes on: the live view so far. */
  replayLive(username, write) {
    for (const entry of this.active.values()) if (entry.username === username) entry.live?.replay(write);
  }

  /** The service is stopping: stop the runs (their rows become "interrupted" at the next start). */
  shutdown() {
    this.queue.length = 0;
    // A run that has passed is ending by itself, with its result.
    for (const entry of this.active.values()) if (!entry.runner.current?.passed) entry.runner.stop();
  }
}

module.exports = { RunManager, scrub };
