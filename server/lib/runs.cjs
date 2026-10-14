'use strict';
// The runs on the hosted server (decisions 2026-10-08 and 2026-10-09): each signed-in person has
// their own TestRunner (the desktop launcher's, launcher/launcher.cjs), running headless with the
// person's own staging accounts (testing and backoffice). Runs of different people go on in
// parallel, up to WATSONS_MAX_PARALLEL_RUNS; beyond that they wait in line. One run per person, and
// per testing account, at a time.

const fs = require('node:fs');
const path = require('node:path');
const launcher = require('../../launcher/launcher.cjs');
const { listFiles, removeSecrets } = require('./evidence.cjs');

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
    if (!prefs?.last_order) return { ...fallback, addDelaySeconds: prefs?.add_delay_seconds ?? fallback.addDelaySeconds };
    const order = parseOrderText(prefs.last_order);
    return {
      products: order.productLines.join('\n'),
      deliveryMethod: order.deliveryMethod ?? fallback.deliveryMethod,
      mode: launcher.MODES[order.mode]?.available ? order.mode : 'express',
      source: 'your last run',
      addDelaySeconds: prefs.add_delay_seconds ?? fallback.addDelaySeconds,
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
    if (placing && !account) problems.push('Enter your testing account first (step "Your accounts").');
    if (!backoffice) problems.push('Enter your backoffice account first (step "Your accounts").');
    if (problems.length > 0 || !checked.order) return { status: 400, body: { problems } };
    if (this.activeOf(session.username)) return { status: 409, body: { problems: ['You already have a run going on. Wait until it ends, or stop it.'] } };
    if (placing && this.accountInUse(account.fingerprint)) {
      return { status: 409, body: { problems: ['This testing account is in use by another run. Use another testing account, or wait until that run ends.'] } };
    }
    const entry = {
      username: session.username,
      displayName: session.displayName,
      request: checked.order,
      // Copies for this run only: the person may change or forget theirs meanwhile.
      account: placing ? { username: account.username, password: account.password } : null,
      backoffice: { username: backoffice.username, password: backoffice.password },
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

  start(entry) {
    const runner = this.runnerFor(entry.username, entry.displayName);
    // This run's accounts go into the test's environment only (TestRunner option "env").
    runner.options.env = () => ({
      WATSONS_STAGING_URL: this.config.stagingUrl,
      WATSONS_USERNAME: entry.account?.username,
      WATSONS_PASSWORD: entry.account?.password,
      WATSONS_BACKOFFICE_USERNAME: entry.backoffice.username,
      WATSONS_BACKOFFICE_PASSWORD: entry.backoffice.password,
    });
    let run;
    try {
      run = runner.start(entry.request);
    } finally {
      runner.options.env = null;
    }
    this.active.set(run.runId, {
      username: entry.username,
      displayName: entry.displayName,
      automation: run.automation,
      fingerprint: entry.fingerprint,
      // Kept until the run has ended, only to check its evidence for it (finished()).
      secrets: [entry.account?.password, entry.backoffice.password],
      runner,
      startedAt: run.startedAt,
    });
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
    this.store.audit({ username, action: 'run-end', runId: run.runId, success: row?.status === 'completed' || row?.status === 'no_change', detail: { status: row?.status, orderNumber: row?.orderNumber ?? undefined } });
    if (entry) entry.secrets = null;
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

  /** The service is stopping: stop the runs (their rows become "interrupted" at the next start). */
  shutdown() {
    this.queue.length = 0;
    for (const entry of this.active.values()) entry.runner.stop();
  }
}

module.exports = { RunManager, scrub };
