'use strict';
// WatsonsTester hosted on the company VM (decisions 2026-10-08; setup: docs/server-deployment.md).
// People open it by URL in Edge, sign in (users.json), enter their own staging accounts (testing
// and backoffice) and run. Playwright runs here, headless, several people's runs in parallel, and
// everyone sees one shared history (SQLite). IIS in front passes the visits on; this service
// listens on 127.0.0.1 only.
// The desktop launcher (launcher/launcher.cjs, WatsonsTester.exe) is separate and unchanged.
//   Start: node server/server.cjs   Settings: server/lib/config.cjs   Users: server/scripts/users.cjs

const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const launcher = require('../launcher/launcher.cjs');
const { readConfig } = require('./lib/config.cjs');
const { ACCOUNT_KINDS, UserDirectory, Sessions, publicUser, parseCookies } = require('./lib/auth.cjs');
const { Store } = require('./lib/store.cjs');
const { RunManager } = require('./lib/runs.cjs');
const evidence = require('./lib/evidence.cjs');
const vault = require('./lib/vault.cjs');

const COOKIE = 'wt_session';
// The page: its scripts and styles are inline; it loads nothing from other sites.
const PAGE_CSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'";
const UI_FILE = path.join(__dirname, '..', 'launcher', 'ui.html');

const pad = (n) => String(n).padStart(2, '0');
/** yyyy-mm-dd, this computer's date (as the run ids and day folders). */
const dayOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const text = (value) => (typeof value === 'string' ? value : '');

async function startServer(overrides = {}) {
  const config = { ...readConfig(), ...overrides };
  const log = overrides.quiet ? () => {} : (line) => console.log(`[${new Date().toISOString()}] ${line}`);
  fs.mkdirSync(config.evidenceDir, { recursive: true });

  const users = new UserDirectory(path.join(config.configDir, 'users.json'));
  if (users.all().length === 0) log(`No users yet: add them with "node server/scripts/users.cjs add <name>" (${users.file}).`);
  const sessions = new Sessions({ users, idleHours: config.sessionIdleHours, maxHours: config.sessionMaxHours });
  const store = new Store(config.dataDir);
  const interrupted = store.markInterrupted();
  if (interrupted > 0) log(`${interrupted} run(s) were going on when the service stopped: marked "Interrupted".`);

  // Open windows (live updates over Server-Sent Events), each with its session and person.
  const clients = new Set();
  const write = (client, event, data) => client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const sendTo = (username, event, data) => {
    for (const client of clients) if (client.username === username) write(client, event, data);
  };
  const sendToSession = (sessionId, event, data) => {
    for (const client of clients) if (client.sessionId === sessionId) write(client, event, data);
  };
  const broadcast = (event, data) => {
    for (const client of clients) write(client, event, data);
  };
  const runs = new RunManager({ config, store, sendTo, broadcast });
  const corrected = runs.recheckFailedRuns();
  if (corrected > 0) log(`${corrected} run(s) saved as failed had in fact passed (browser closed afterwards): corrected.`);

  /** What a person's window may know about one of their accounts: whether it is set (masked), and remembered. */
  const accountState = (account) => (account ? { set: true, masked: account.masked, remembered: account.remember } : { set: false });

  // Remembered accounts (vault.cjs): sealed with the key made from the person's portal password at
  // sign-in. Changing or forgetting one account leaves the other as it is (also for a second window).
  const rememberChange = (session, kind) => {
    if (!session.vaultKey) return;
    let kept = {};
    const sealed = store.savedAccounts(session.username);
    if (sealed) {
      try {
        kept = vault.open(session.vaultKey, session.username, sealed);
      } catch {
        kept = {}; // sealed for another password: replaced
      }
    }
    const account = session[ACCOUNT_KINDS[kind].field];
    if (account?.remember) kept[kind] = { username: account.username, password: account.password };
    else delete kept[kind];
    store.saveAccounts(session.username, Object.keys(kept).length > 0 ? vault.seal(session.vaultKey, session.username, kept) : null);
  };
  /** At sign-in: the accounts the person had remembered, back into their session. */
  const restoreAccounts = (session, ip) => {
    const sealed = store.savedAccounts(session.username);
    if (!sealed) return;
    let kept;
    try {
      kept = vault.open(session.vaultKey, session.username, sealed);
    } catch {
      // Sealed with an earlier portal password (an admin reset it): nobody can open it any more.
      store.saveAccounts(session.username, null);
      store.audit({ username: session.username, ip, action: 'saved-accounts-dropped', success: false });
      return;
    }
    const kinds = Object.keys(ACCOUNT_KINDS).filter((kind) => kept?.[kind] && !sessions.setAccount(session, kind, { ...kept[kind], remember: true }));
    if (kinds.length > 0) store.audit({ username: session.username, ip, action: 'saved-accounts-restored', detail: { kinds } });
  };
  /** What a person's window needs (never a password, an account or other people's logs). */
  const state = (session) => ({
    mode: 'server',
    setup: runs.setup(),
    defaults: runs.defaults(session.username),
    automations: launcher.AUTOMATIONS,
    deliveryMethods: launcher.DELIVERY_METHODS,
    modes: launcher.MODES,
    steps: { approve: launcher.APPROVE_STEPS, order: Object.fromEntries(Object.keys(launcher.MODES).map((mode) => [mode, launcher.stepsFor('order', mode)])) },
    statuses: launcher.STATUSES,
    riskWarnings: Object.fromEntries(Object.entries(launcher.RISKS).map(([automation, risk]) => [automation, risk.warning])),
    operator: session.displayName,
    user: publicUser(session),
    stagingHost: launcher.STAGING_HOST,
    testingAccount: accountState(session.testingAccount),
    backofficeAccount: accountState(session.backofficeAccount),
    overview: runs.overview(),
    ...runs.personal(session),
  });

  const app = express();
  app.disable('x-powered-by');
  // IIS on this computer forwards each request: the person's address is in X-Forwarded-For.
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' });
    req.session = sessions.get(parseCookies(req.headers.cookie)[COOKIE]);
    next();
  });
  app.use('/api', express.json({ limit: '200kb' }));

  const expectedOrigin = (req) => config.publicOrigin ?? `${req.protocol}://${req.get('host')}`;
  /** Requests that change something must come from this site's own pages. */
  const sameOrigin = (req, res, next) => {
    const origin = req.get('origin');
    if (origin && origin !== expectedOrigin(req)) return res.status(403).json({ error: 'Request from another website refused.' });
    next();
  };
  const signedIn = (req, res, next) => (req.session ? next() : res.status(401).json({ error: 'Please sign in.', signedIn: false }));
  /** …and carry the page's key (against requests forged by other sites). */
  const pageKey = (req, res, next) =>
    req.get('x-launcher-token') === req.session.csrf ? next() : res.status(403).json({ error: 'Missing or wrong page key. Reload the page.' });
  const changes = [signedIn, sameOrigin, pageKey];
  const adminOnly = (req, res, next) => (req.session.role === 'admin' ? next() : res.status(403).json({ error: 'Only an admin can do this.' }));
  const setCookie = (res, value, maxAge) =>
    res.append('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict${config.cookieSecure ? '; Secure' : ''}${maxAge === undefined ? '' : `; Max-Age=${maxAge}`}`);
  const audit = (req, action, extra = {}) => store.audit({ username: req.session?.username ?? null, ip: req.ip, action, ...extra });

  // Sign-in limits (PRD): per address, and per user name for failures (against password guessing).
  const loginPerAddress = rateLimit({
    windowMs: 60_000,
    limit: config.loginLimitPerMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      audit(req, 'login-limited', { success: false });
      res.status(429).json({ error: 'Too many sign-in attempts from this computer. Wait a minute and try again.' });
    },
  });
  const loginPerUser = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.loginFailuresPerUser,
    skipSuccessfulRequests: true,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => `user:${text(req.body?.username).trim().toLowerCase()}`,
    handler: (req, res) => {
      store.audit({ username: text(req.body?.username).trim().slice(0, 60) || null, ip: req.ip, action: 'login-limited', success: false });
      res.status(429).json({ error: 'Too many failed sign-ins for this user name. Wait 15 minutes, or ask the admin.' });
    },
  });

  // ---- The page and the session ---------------------------------------------------------------

  // The same ui.html as the desktop launcher, in its server mode. Read once, at start: the page
  // always matches the code that runs, also when new files are in place but the service hasn't
  // restarted yet (seen 2026-10-14: the new page with the old rules).
  const page = fs.readFileSync(UI_FILE, 'utf8').replace('<html lang="en">', '<html lang="en" data-mode="server">');
  app.get('/', (req, res) => {
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP });
    res.send(page);
  });

  app.get('/api/health', (req, res) => {
    const { running, waiting } = runs.overview();
    res.json({ ok: true, running: running.length, waiting: waiting.length });
  });

  app.get('/api/session', (req, res) => {
    if (!req.session) return res.json({ signedIn: false });
    res.json({
      signedIn: true,
      user: publicUser(req.session),
      csrf: req.session.csrf,
      testingAccount: accountState(req.session.testingAccount),
      backofficeAccount: accountState(req.session.backofficeAccount),
    });
  });

  app.post('/api/login', sameOrigin, loginPerAddress, loginPerUser, async (req, res) => {
    const username = text(req.body?.username).trim();
    const user = await users.verify(username, req.body?.password);
    if (!user) {
      store.audit({ username: username.slice(0, 60) || null, ip: req.ip, action: 'login', success: false });
      return res.status(401).json({ error: 'Wrong user name or password.' });
    }
    // The key to the person's remembered accounts, from the password just checked (which is not kept).
    const vaultKey = await vault.deriveKey(req.body?.password, store.accountsSalt(user.username));
    if (req.session) sessions.destroy(req.session.id);
    const session = sessions.create(user);
    session.vaultKey = vaultKey;
    setCookie(res, session.id);
    store.audit({ username: user.username, ip: req.ip, action: 'login' });
    restoreAccounts(session, req.ip);
    res.json({
      user: publicUser(session),
      csrf: session.csrf,
      testingAccount: accountState(session.testingAccount),
      backofficeAccount: accountState(session.backofficeAccount),
    });
  });

  app.post('/api/logout', ...changes, (req, res) => {
    const { id, username } = req.session;
    runs.forget(username);
    audit(req, 'logout');
    sessions.destroy(id);
    for (const client of clients) if (client.sessionId === id) client.res.end();
    setCookie(res, '', 0);
    res.status(204).end();
  });

  // The person's own staging accounts, testing and backoffice: kept in this session's memory, and
  // remembered for their next sign-in unless they untick Remember (decisions 2026-10-08 and 2026-10-09).
  for (const kind of Object.keys(ACCOUNT_KINDS)) {
    app.post(`/api/${kind}-account`, ...changes, (req, res) => {
      const problem = sessions.setAccount(req.session, kind, req.body);
      if (problem) return res.status(400).json({ error: problem });
      const account = req.session[ACCOUNT_KINDS[kind].field];
      rememberChange(req.session, kind);
      audit(req, `${kind}-account-set`, { detail: { remembered: account.remember } });
      sendToSession(req.session.id, 'state', state(req.session));
      res.json(accountState(account));
    });
    // Forget: for this session and for the next sign-in.
    app.delete(`/api/${kind}-account`, ...changes, (req, res) => {
      sessions.clearAccount(req.session, kind);
      rememberChange(req.session, kind);
      audit(req, `${kind}-account-cleared`);
      sendToSession(req.session.id, 'state', state(req.session));
      res.json({ set: false });
    });
  }

  app.get('/api/events', signedIn, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const client = { res, sessionId: req.session.id, username: req.session.username };
    clients.add(client);
    write(client, 'state', state(req.session));
    // A run going on: its live browser view so far.
    runs.replayLive(req.session.username, (event, data) => write(client, event, data));
    req.on('close', () => clients.delete(client));
  });
  // Keeps the connections open through IIS, and closes those of sessions that have ended.
  const ping = setInterval(() => {
    for (const client of clients) {
      if (sessions.peek(client.sessionId)) client.res.write(': ping\n\n');
      else {
        client.res.end();
        clients.delete(client);
      }
    }
  }, 25_000);
  ping.unref();

  // ---- Running --------------------------------------------------------------------------------

  app.post('/api/state', ...changes, (req, res) => res.json(state(req.session)));
  app.post('/api/check', ...changes, (req, res) => res.json(launcher.parseProducts(req.body?.products)));
  app.post('/api/run', ...changes, (req, res) => {
    const outcome = runs.submit(req.session, req.body, req.ip);
    res.status(outcome.status).json(outcome.body);
  });
  // The live browser view of the person's own run (2026-10-14): clicks, scrolling and typing; the
  // tab shown.
  app.post('/api/live/input', ...changes, async (req, res) => {
    const found = runs.liveOf(req.session, req.body?.runId);
    if (found.error) return res.status(found.status).json({ error: found.error });
    const problem = await found.live.input(req.body);
    res.status(problem ? 409 : 200).json(problem ? { error: problem } : { ok: true });
  });
  app.post('/api/live/select', ...changes, async (req, res) => {
    const found = runs.liveOf(req.session, req.body?.runId);
    if (found.error) return res.status(found.status).json({ error: found.error });
    const problem = await found.live.select(text(req.body?.targetId));
    res.status(problem ? 409 : 200).json(problem ? { error: problem } : { ok: true });
  });

  app.post('/api/stop', ...changes, (req, res) => {
    const problem = runs.stop(req.session, typeof req.body?.runId === 'string' ? req.body.runId : null, req.ip);
    res.status(problem ? 409 : 200).json(problem ? { stopped: false, error: problem } : { stopped: true });
  });
  // The answer to the question the person's run is waiting on (2026-10-22).
  app.post('/api/answer', ...changes, (req, res) => {
    const problem = runs.answer(req.session, req.body, req.ip);
    res.status(problem ? 409 : 200).json(problem ? { error: problem } : { ok: true });
  });

  // ---- Shared Logs / History --------------------------------------------------------------------

  /** Every run (those going on, live), newest first. Evidence removed after the retention period shows as such. */
  const allRows = (limit) => {
    const live = runs.liveRows();
    const liveIds = new Set(live.map((row) => row.runId));
    return [...live, ...store.listRuns(limit).filter((row) => !liveIds.has(row.runId))]
      .map((row) => (row.evidenceState === 'deleted' ? { ...row, screenshots: [] } : row))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId));
  };
  app.post('/api/history', ...changes, (req, res) => res.json({ rows: allRows(500), me: req.session.username }));

  const runDir = (runId) => evidence.runFolder(config.evidenceDir, runId);
  const sendFile = (res, file, downloadName) => {
    res.set({ 'Content-Type': evidence.typeOf(file), 'Cache-Control': 'private, max-age=3600' });
    if (downloadName) res.attachment(downloadName);
    fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  };
  // Screenshots, asked for as the desktop launcher's window asks (shown in the page).
  app.get('/api/screenshot', signedIn, (req, res) => {
    const runId = text(req.query.run);
    const name = text(req.query.name);
    const file = launcher.SCREENSHOT_NAME.test(name) ? evidence.fileInside(runDir(runId), [name]) : null;
    if (!file) return res.status(404).json({ error: 'No such screenshot.' });
    sendFile(res, file, req.query.download === '1' ? `${runId}-${name}` : null);
  });
  // (A run's other files, its Playwright report and its evidence as a zip are no longer offered:
  // the page lost those buttons, user's request 2026-10-25. They stay in the evidence folder.)
  app.post('/api/export', ...changes, (req, res) => {
    const wanted = Array.isArray(req.body?.runIds) ? new Set(req.body.runIds.map(String)) : null;
    const rows = allRows(100_000).filter((row) => !wanted || wanted.has(row.runId));
    audit(req, 'export', { detail: { runs: rows.length } });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.attachment(`watsons-automation-history-${dayOf(new Date())}.csv`);
    res.send(launcher.historyCsv(rows));
  });
  app.delete('/api/runs/:runId', ...changes, adminOnly, (req, res) => {
    const { runId } = req.params;
    if (runs.active.has(runId)) return res.status(409).json({ error: 'This run is still going on.' });
    const folder = runDir(runId);
    if (!folder || !store.getRun(runId)) return res.status(404).json({ error: 'No such run.' });
    fs.rmSync(folder, { recursive: true, force: true });
    store.deleteRun(runId);
    audit(req, 'run-delete', { runId });
    broadcast('history', { deleted: runId });
    res.status(204).end();
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((req, res) => res.status(404).type('text/plain').send('Not found.'));
  app.use((error, req, res, next) => {
    // Never log a request's body or the parser's message about it: it can hold a password.
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request is not JSON.' });
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
    log(`Error on ${req.method} ${req.path}: ${error?.message ?? error}`);
    if (res.headersSent) return next(error);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  // ---- Upkeep: evidence retention and database backups --------------------------------------------

  async function maintenance(now = new Date()) {
    const cutoff = dayOf(new Date(now.getTime() - config.retentionDays * 86_400_000));
    for (const { day, dir, runs: runIds } of evidence.daysBefore(config.evidenceDir, cutoff)) {
      for (const runId of runIds) store.markEvidenceDeleted(runId);
      fs.rmSync(dir, { recursive: true, force: true });
      store.audit({ action: 'evidence-retention', detail: { day, runs: runIds.length } });
      log(`Retention: removed the evidence of ${day} (${runIds.length} run(s)); their rows stay in the history.`);
    }
    const backups = path.join(config.dataDir, 'backups');
    fs.mkdirSync(backups, { recursive: true });
    const target = path.join(backups, `automation-${dayOf(now)}.db`);
    if (!fs.existsSync(target)) await store.backup(target);
    const old = fs
      .readdirSync(backups)
      .filter((name) => /^automation-\d{4}-\d{2}-\d{2}\.db$/.test(name))
      .sort()
      .reverse()
      .slice(config.backupsKept);
    for (const name of old) fs.rmSync(path.join(backups, name), { force: true });
  }
  const upkeep = () => maintenance().catch((error) => log(`Upkeep failed: ${error.message}`));
  const firstUpkeep = setTimeout(upkeep, 60_000);
  const upkeepTimer = setInterval(upkeep, 6 * 3600_000);
  firstUpkeep.unref();
  upkeepTimer.unref();

  const server = app.listen(config.port, config.host);
  await once(server, 'listening');
  const url = `http://${config.host}:${server.address().port}/`;
  log(`WatsonsTester server on ${url} (evidence: ${config.evidenceDir}; up to ${config.maxParallelRuns} runs in parallel).`);

  return {
    url,
    config,
    store,
    sessions,
    runs,
    users,
    maintenance,
    async close() {
      clearTimeout(firstUpkeep);
      clearInterval(upkeepTimer);
      clearInterval(ping);
      runs.shutdown();
      // Let the stopped runs end (and be saved) before the database closes.
      for (let waited = 0; runs.active.size > 0 && waited < 10_000; waited += 100) await new Promise((done) => setTimeout(done, 100));
      for (const client of clients) client.res.end();
      sessions.close();
      await new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
      store.close();
    },
  };
}

if (require.main === module) {
  startServer()
    .then((app) => {
      const stop = async () => {
        console.log('[server] Stopping: runs going on are stopped (their history shows "Stopped" or, if cut off, "Interrupted").');
        await app.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((error) => {
      console.error(`[server] Could not start: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { startServer };
