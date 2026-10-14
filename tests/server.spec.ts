import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STAGING_HOST } from '../src/safety/staging-guard';

// Offline checks of the hosted server (server/, decisions 2026-10-08): a real server on a random
// port, a made-up project whose "Playwright" is tests/helpers/fake-playwright-cli.cjs, and made-up
// accounts. No Watsons site is opened.

interface Overview {
  running: { runId: string; operator: string }[];
  waiting: { operator: string; position: number }[];
}
interface AuditEvent {
  action: string;
  username: string | null;
  success: number;
  detail: string | null;
}
interface ServerApp {
  url: string;
  runs: { active: Map<string, unknown>; overview(): Overview };
  store: { auditEvents(limit?: number): AuditEvent[]; startRun(row: object, who: object): void };
  maintenance(now?: Date): Promise<void>;
  close(): Promise<void>;
}
// The hosted server is optional: these checks need it installed (cd server, then npm install).
// The share zip for desktop users leaves it out.
const SERVER_INSTALLED = existsSync(join(__dirname, '..', 'server', 'node_modules', 'express'));
const skipReason = 'The hosted server is not installed here: run "npm install" in the server folder.';
/* eslint-disable @typescript-eslint/no-require-imports */
const startServer = (options: Record<string, unknown>): Promise<ServerApp> => require('../server/server.cjs').startServer(options);
const hashPassword = (password: string): Promise<string> => require('../server/scripts/users.cjs').hashPassword(password);
// For the stand-in runner's real browser (PLU 555, the live view): where Playwright is.
const PLAYWRIGHT_MODULE = require.resolve('@playwright/test');
/* eslint-enable @typescript-eslint/no-require-imports */

type Person = 'alice' | 'bob' | 'carol';
type Account = { username: string; password: string };
// Each person's own staging accounts, entered in the page (decisions 2026-10-08 and 2026-10-09).
const PEOPLE: Record<Person, { password: string; displayName: string; role: string; testing: Account; backoffice: Account }> = {
  alice: {
    password: 'alice-password-1',
    displayName: 'Alice',
    role: 'user',
    testing: { username: 'alice.test@example.com', password: 'alice-shop-pass-1' },
    backoffice: { username: 'alice.support', password: 'alice-backoffice-pass-1' },
  },
  bob: {
    password: 'bob-password-12',
    displayName: 'Bob',
    role: 'user',
    testing: { username: 'bob.test@example.com', password: 'bob-shop-pass-2' },
    backoffice: { username: 'bob.support', password: 'bob-backoffice-pass-2' },
  },
  carol: {
    password: 'carol-password-3',
    displayName: 'Carol',
    role: 'admin',
    testing: { username: 'carol.test@example.com', password: 'carol-shop-pass-3' },
    backoffice: { username: 'carol.support', password: 'carol-backoffice-pass-3' },
  },
};
/** What must never be stored or shown anywhere. */
const SECRETS = Object.values(PEOPLE).flatMap((person) => [person.testing.username, person.testing.password, person.backoffice.username, person.backoffice.password]);
const NEEDS_TESTING = 'Enter your testing account first (step "Your accounts").';
const NEEDS_BACKOFFICE = 'Enter your backoffice account first (step "Your accounts").';
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 8);
const ORDER = { deliveryMethod: 'home_delivery', mode: 'express', confirmed: true };

let hashes: Promise<Record<Person, string>> | null = null;
const passwordHashes = () =>
  (hashes ??= (async () => ({ alice: await hashPassword(PEOPLE.alice.password), bob: await hashPassword(PEOPLE.bob.password), carol: await hashPassword(PEOPLE.carol.password) }))());

interface Setup {
  base: string;
  app: ServerApp;
  configDir: string;
  dataDir: string;
  evidenceDir: string;
  options: Record<string, unknown>;
}

async function makeServer(options: Record<string, unknown> = {}): Promise<Setup> {
  const base = mkdtempSync(join(tmpdir(), 'server-test-'));
  const projectDir = join(base, 'project');
  for (const dir of ['tests', 'test-data', join('node_modules', '@playwright', 'test')]) mkdirSync(join(projectDir, dir), { recursive: true });
  writeFileSync(join(projectDir, 'playwright.config.ts'), '// fake\n');
  writeFileSync(join(projectDir, 'tests', 'order.e2e.spec.ts'), '// fake\n');
  writeFileSync(join(projectDir, 'test-data', 'order.txt'), 'delivery: Home Delivery\nmode: Express\n\n10117\n');
  copyFileSync(join(__dirname, 'helpers', 'fake-playwright-cli.cjs'), join(projectDir, 'node_modules', '@playwright', 'test', 'cli.js'));
  const configDir = join(base, 'config');
  mkdirSync(configDir);
  const hashed = await passwordHashes();
  writeFileSync(
    join(configDir, 'users.json'),
    JSON.stringify({
      users: (Object.keys(PEOPLE) as Person[]).map((username) => ({ username, displayName: PEOPLE[username].displayName, passwordHash: hashed[username], active: true, role: PEOPLE[username].role })),
    }),
  );
  const dataDir = join(base, 'data');
  const evidenceDir = join(base, 'evidence');
  const allOptions = {
    quiet: true,
    port: 0,
    projectDir,
    configDir,
    dataDir,
    evidenceDir,
    stagingUrl: `https://${STAGING_HOST}/`,
    cookieSecure: false, // http://127.0.0.1 in tests; HTTPS (IIS) on the VM
    loginLimitPerMinute: 1000,
    loginFailuresPerUser: 1000,
    ...options,
  };
  return { base, app: await startServer(allOptions), configDir, dataDir, evidenceDir, options: allOptions };
}

async function closeServer(setup: Setup) {
  await setup.app.close();
  rmSync(setup.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

/** A person's browser, as far as the API goes: their cookie and page key. */
function client(app: ServerApp) {
  let cookie = '';
  let csrf = '';
  const responses: string[] = []; // everything the server answered, for the leak check
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(new URL(path, app.url), {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-Launcher-Token': csrf } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const type = response.headers.get('content-type') ?? '';
    const raw = Buffer.from(await response.arrayBuffer());
    responses.push(raw.toString('utf8'));
    const data = type.includes('json') ? JSON.parse(raw.toString('utf8') || '{}') : type.startsWith('text/') ? raw.toString('utf8') : raw;
    if (data && typeof data === 'object' && typeof (data as { csrf?: string }).csrf === 'string') csrf = (data as { csrf: string }).csrf;
    return { status: response.status, data, headers: response.headers };
  };
  return {
    call,
    responses,
    get cookie() {
      return cookie;
    },
    dropPageKey() {
      csrf = '';
    },
    login: (person: Person, password = PEOPLE[person].password) => call('POST', '/api/login', { username: person, password }),
    useTestingAccount: (person: Person, account = PEOPLE[person].testing) => call('POST', '/api/testing-account', account),
    useBackofficeAccount: (person: Person, account = PEOPLE[person].backoffice) => call('POST', '/api/backoffice-account', account),
    /** Both of the person's own accounts, as entered in step 2. */
    async useAccounts(person: Person) {
      await call('POST', '/api/testing-account', PEOPLE[person].testing);
      return call('POST', '/api/backoffice-account', PEOPLE[person].backoffice);
    },
    run: (body: Record<string, unknown>) => call('POST', '/api/run', body),
    history: () => call('POST', '/api/history', {}),
  };
}

const runFolder = (setup: Setup, runId: string) => join(setup.evidenceDir, runId.slice(0, 10), runId);
const runLog = (setup: Setup, runId: string) => readFileSync(join(runFolder(setup, runId), 'launcher-log.txt'), 'utf8');
const ended = (setup: Setup, runId: string) => expect.poll(() => setup.app.runs.active.has(runId), { timeout: 15_000 }).toBe(false);

/** Reads a person's live updates for a while. */
async function liveUpdates(app: ServerApp, cookie: string, ms: number) {
  const controller = new AbortController();
  const response = await fetch(new URL('/api/events', app.url), { headers: { Cookie: cookie }, signal: controller.signal });
  const reader = response.body!.getReader();
  const timer = setTimeout(() => controller.abort(), ms);
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf8');
    }
  } catch {
    // stopped reading
  } finally {
    clearTimeout(timer);
  }
  return text;
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));
}

test.describe('hosted server', () => {
  test.skip(!SERVER_INSTALLED, skipReason);
  let setup: Setup;
  test.beforeEach(async () => {
    process.env.FAKE_PLAYWRIGHT_MODULE = PLAYWRIGHT_MODULE;
    setup = await makeServer();
  });
  test.afterEach(async () => {
    await closeServer(setup);
    delete process.env.FAKE_PLAYWRIGHT_MODULE;
  });

  test('signs people in, and answers nothing else without a session', async () => {
    const page = await fetch(setup.app.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<html lang="en" data-mode="server">');
    const alice = client(setup.app);
    expect((await alice.call('GET', '/api/session')).data).toEqual({ signedIn: false });
    for (const [method, path] of [
      ['POST', '/api/run'],
      ['POST', '/api/history'],
      ['POST', '/api/testing-account'],
      ['POST', '/api/backoffice-account'],
      ['POST', '/api/live/input'],
      ['POST', '/api/live/close'],
      ['GET', '/api/events'],
      ['GET', '/api/screenshot?run=2026-10-08_10-00-00&name=screenshot-1.png'],
      ['GET', '/api/runs/2026-10-08_10-00-00/files/log.txt'],
      ['GET', '/api/runs/2026-10-08_10-00-00/evidence.zip'],
    ]) {
      expect((await alice.call(method, path, method === 'POST' ? {} : undefined)).status, path).toBe(401);
    }
    // The server's own files are never served.
    for (const path of ['/users.json', '/secrets.json', '/config/users.json', '/data/automation.db']) expect((await alice.call('GET', path)).status, path).toBe(404);

    expect((await alice.login('alice', 'wrong-password')).data).toEqual({ error: 'Wrong user name or password.' });
    expect((await alice.call('POST', '/api/login', { username: 'nobody', password: 'x' })).status).toBe(401);
    const signedIn = await alice.login('alice');
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get('set-cookie')).toMatch(/^wt_session=[\w-]+; Path=\/; HttpOnly; SameSite=Strict$/);
    expect((await alice.call('GET', '/api/session')).data).toMatchObject({
      signedIn: true,
      user: { username: 'alice', displayName: 'Alice', role: 'user' },
      testingAccount: { set: false },
      backofficeAccount: { set: false },
    });
    const events = setup.app.store.auditEvents().map((event) => `${event.action}:${event.username}:${event.success}`);
    expect(events).toEqual(expect.arrayContaining(['login:alice:0', 'login:nobody:0', 'login:alice:1']));
  });

  test('refuses changes without the page key or from another website', async () => {
    const alice = client(setup.app);
    await alice.login('alice');
    expect((await alice.call('POST', '/api/run', {}, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await alice.call('POST', '/api/run', {}, { Origin: new URL(setup.app.url).origin })).status).toBe(400); // allowed through, then checked
    alice.dropPageKey();
    expect((await alice.call('POST', '/api/run', {})).status).toBe(403);
    expect((await alice.call('POST', '/api/testing-account', PEOPLE.alice.testing)).status).toBe(403);
    expect((await alice.call('POST', '/api/backoffice-account', PEOPLE.alice.backoffice)).status).toBe(403);
  });

  test('signs out a person removed from users.json at their next click', async () => {
    const alice = client(setup.app);
    await alice.login('alice');
    expect((await alice.history()).status).toBe(200);
    const users = JSON.parse(readFileSync(join(setup.configDir, 'users.json'), 'utf8'));
    users.users = users.users.filter((user: { username: string }) => user.username !== 'alice');
    writeFileSync(join(setup.configDir, 'users.json'), JSON.stringify(users));
    expect((await alice.history()).status).toBe(401);
    expect((await alice.call('GET', '/api/session')).data).toEqual({ signedIn: false });
  });

  test('keeps both accounts for the session, and shows their owner masked names', async () => {
    const alice = client(setup.app);
    await alice.login('alice');
    expect((await alice.call('POST', '/api/testing-account', { username: 'x' })).data).toEqual({ error: 'Enter the testing account’s email (or user name) and password.' });
    expect((await alice.call('POST', '/api/backoffice-account', { password: 'x' })).data).toEqual({ error: 'Enter the backoffice user name and password.' });
    expect((await alice.useTestingAccount('alice')).data).toEqual({ set: true, masked: 'al•••@e•••.com', remembered: true });
    expect((await alice.useBackofficeAccount('alice')).data).toEqual({ set: true, masked: 'al•••', remembered: true });
    expect((await alice.call('GET', '/api/session')).data).toMatchObject({
      testingAccount: { set: true, masked: 'al•••@e•••.com' },
      backofficeAccount: { set: true, masked: 'al•••' },
    });
    expect((await alice.call('DELETE', '/api/backoffice-account', {})).data).toEqual({ set: false });
    expect((await alice.call('GET', '/api/session')).data).toMatchObject({ testingAccount: { set: true }, backofficeAccount: { set: false } });
    expect((await alice.call('DELETE', '/api/testing-account', {})).data).toEqual({ set: false });
    const answers = alice.responses.join('\n');
    for (const secret of [PEOPLE.alice.testing.username, PEOPLE.alice.testing.password, PEOPLE.alice.backoffice.username, PEOPLE.alice.backoffice.password]) {
      expect(answers.includes(secret), `answers contain ${secret}`).toBe(false);
    }
    const actions = setup.app.store.auditEvents().map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(['testing-account-set', 'backoffice-account-set', 'backoffice-account-cleared', 'testing-account-cleared']));
  });

  test('remembers both accounts for the next sign-in, sealed with the person’s own portal password', async () => {
    const alice = client(setup.app);
    await alice.login('alice');
    await alice.useAccounts('alice');
    await alice.call('POST', '/api/logout', {});

    // Signing in again brings them back: she runs without typing them.
    const again = client(setup.app);
    expect((await again.login('alice')).data).toMatchObject({
      testingAccount: { set: true, masked: 'al•••@e•••.com', remembered: true },
      backofficeAccount: { set: true, masked: 'al•••', remembered: true },
    });
    const runId = (await again.run({ ...ORDER, products: '10117' })).data.runId as string;
    await ended(setup, runId);
    const { testing, backoffice } = PEOPLE.alice;
    expect(runLog(setup, runId)).toContain(
      `account=${fingerprint(testing.username)}/${fingerprint(testing.password)} backoffice=${fingerprint(backoffice.username)}/${fingerprint(backoffice.password)}`,
    );

    // Only her sign-in opens them: Bob gets nothing, and the database holds nothing readable.
    expect((await client(setup.app).login('bob')).data).toMatchObject({ testingAccount: { set: false }, backofficeAccount: { set: false } });
    const stored = filesUnder(setup.dataDir).map((file) => readFileSync(file).toString('latin1')).join('\n');
    for (const secret of [testing.username, testing.password, backoffice.username, backoffice.password]) {
      expect(stored.includes(secret), `the database contains ${secret}`).toBe(false);
    }

    // After an admin resets her portal password, nobody can open them: they are dropped.
    const users = JSON.parse(readFileSync(join(setup.configDir, 'users.json'), 'utf8'));
    users.users.find((user: { username: string }) => user.username === 'alice').passwordHash = await hashPassword('alice-new-password-1');
    writeFileSync(join(setup.configDir, 'users.json'), JSON.stringify(users));
    expect((await client(setup.app).login('alice', 'alice-new-password-1')).data).toMatchObject({ testingAccount: { set: false }, backofficeAccount: { set: false } });
    const actions = setup.app.store.auditEvents().map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(['saved-accounts-restored', 'saved-accounts-dropped']));
  });

  test('Remember can be unticked, and Forget forgets the remembered copy too', async () => {
    const alice = client(setup.app);
    await alice.login('alice');
    expect((await alice.call('POST', '/api/testing-account', { ...PEOPLE.alice.testing, remember: false })).data).toEqual({ set: true, masked: 'al•••@e•••.com', remembered: false });
    await alice.useBackofficeAccount('alice');
    await alice.call('POST', '/api/logout', {});

    const again = client(setup.app);
    expect((await again.login('alice')).data).toMatchObject({ testingAccount: { set: false }, backofficeAccount: { set: true, remembered: true } });
    expect((await again.call('DELETE', '/api/backoffice-account', {})).data).toEqual({ set: false });
    await again.call('POST', '/api/logout', {});
    expect((await client(setup.app).login('alice')).data).toMatchObject({ testingAccount: { set: false }, backofficeAccount: { set: false } });
  });

  test('runs each person with their own accounts, in parallel, headless, in their own folders', async () => {
    const alice = client(setup.app);
    const bob = client(setup.app);
    const carol = client(setup.app);
    for (const [person, browser] of [['alice', alice], ['bob', bob], ['carol', carol]] as const) await browser.login(person);
    // A new order needs the testing account; the backoffice account is optional (2026-10-14).
    expect((await alice.run({ ...ORDER, products: '10117' })).data).toEqual({ problems: [NEEDS_TESTING] });
    await alice.useAccounts('alice');
    await bob.useAccounts('bob');

    // PLU 99: the fake run waits at "Pay" until it is stopped, so both go on at the same time.
    const aliceRun = (await alice.run({ ...ORDER, products: '99' })).data.runId as string;
    const bobRun = (await bob.run({ ...ORDER, products: '99' })).data.runId as string;
    await expect.poll(() => setup.app.runs.overview().running.map((run) => run.operator).sort()).toEqual(['Alice', 'Bob']);
    for (const [runId, person] of [[aliceRun, 'alice'], [bobRun, 'bob']] as const) {
      await expect.poll(() => runLog(setup, runId)).toContain('fake runner: account=');
      const log = runLog(setup, runId);
      // Its own accounts (fingerprints: the runner never prints an account).
      expect(log).toContain(`account=${fingerprint(PEOPLE[person].testing.username)}/${fingerprint(PEOPLE[person].testing.password)}`);
      expect(log).toContain(`backoffice=${fingerprint(PEOPLE[person].backoffice.username)}/${fingerprint(PEOPLE[person].backoffice.password)}`);
      // Headless, with its own Playwright folders.
      expect(log).toContain(`args=test --project=e2e order.e2e --output ${join(setup.evidenceDir, '.work', runId, 'test-results')} place=yes`);
      expect(log).toContain('html-report=own');
      expect(log).not.toContain('--headed');
    }

    // Only the owner, or an admin, stops a run.
    expect((await bob.call('POST', '/api/stop', { runId: aliceRun })).data).toEqual({ stopped: false, error: 'You can only stop your own runs.' });
    expect((await alice.call('POST', '/api/stop', {})).data).toEqual({ stopped: true });
    expect((await carol.call('POST', '/api/stop', { runId: bobRun })).data).toEqual({ stopped: true });
    await ended(setup, aliceRun);
    await ended(setup, bobRun);
    const rows = (await carol.history()).data.rows as { runId: string; status: string; username: string }[];
    expect(rows.map((row) => [row.runId, row.status, row.username]).sort()).toEqual([[aliceRun, 'stopped', 'alice'], [bobRun, 'stopped', 'bob']].sort());
    expect(existsSync(join(setup.evidenceDir, '.work', aliceRun))).toBe(false);
  });

  test('one run per testing account, and per person, at a time', async () => {
    const alice = client(setup.app);
    const bob = client(setup.app);
    await alice.login('alice');
    await alice.useAccounts('alice');
    await bob.login('bob');
    await bob.useTestingAccount('bob', { username: 'ALICE.Test@example.com', password: 'another-pass-5' }); // the same account
    await bob.useBackofficeAccount('bob');
    const first = (await alice.run({ ...ORDER, products: '99' })).data.runId as string;
    expect((await bob.run({ ...ORDER, products: '10117' })).data).toEqual({
      problems: ['This testing account is in use by another run. Use another testing account, or wait until that run ends.'],
    });
    expect((await alice.run({ ...ORDER, products: '10117' })).data).toEqual({ problems: ['You already have a run going on. Wait until it ends, or stop it.'] });
    await alice.call('POST', '/api/stop', {});
    await ended(setup, first);
    const second = await bob.run({ ...ORDER, products: '10117' });
    expect(second.status).toBe(200);
    await ended(setup, second.data.runId);
  });

  test('runs wait in line beyond the server’s limit', async () => {
    await closeServer(setup);
    setup = await makeServer({ maxParallelRuns: 1 });
    const alice = client(setup.app);
    const bob = client(setup.app);
    for (const [person, browser] of [['alice', alice], ['bob', bob]] as const) {
      await browser.login(person);
      await browser.useAccounts(person);
    }
    expect((await alice.run({ ...ORDER, products: '99' })).status).toBe(200);
    expect((await bob.run({ ...ORDER, products: '99' }))).toMatchObject({ status: 202, data: { queued: true, position: 1 } });
    expect(setup.app.runs.overview().waiting).toEqual([expect.objectContaining({ operator: 'Bob', position: 1 })]);
    await alice.call('POST', '/api/stop', {});
    await expect.poll(() => setup.app.runs.overview().running.map((run) => run.operator)).toEqual(['Bob']);
    await bob.call('POST', '/api/stop', {});
    await expect.poll(() => setup.app.runs.active.size).toBe(0);
  });

  test('approving an existing order needs only the backoffice account, and never places an order', async () => {
    const alice = client(setup.app);
    await alice.login('alice');
    const approve = { automation: 'approve', orderNumber: 'WTCSG07091012', confirmed: true };
    expect((await alice.run(approve)).data).toEqual({ problems: [NEEDS_BACKOFFICE] });
    await alice.useBackofficeAccount('alice');
    const started = await alice.run(approve);
    expect(started.status).toBe(200);
    await ended(setup, started.data.runId);
    const log = runLog(setup, started.data.runId);
    expect(log).toContain('args=test --project=approve approve.e2e --output');
    expect(log).toContain('place=undefined');
    expect(log).toContain(`account=none/none backoffice=${fingerprint(PEOPLE.alice.backoffice.username)}/${fingerprint(PEOPLE.alice.backoffice.password)}`);
    const row = (await alice.history()).data.rows[0];
    expect(row).toMatchObject({ runId: started.data.runId, status: 'completed', automation: 'approve', orderNumber: '07091012', username: 'alice', operator: 'Alice' });
  });

  test('an order placed without a backoffice account awaits approval, until someone approves it', async () => {
    const alice = client(setup.app);
    const carol = client(setup.app);
    await alice.login('alice');
    await alice.useTestingAccount('alice'); // no backoffice account
    const placed = (await alice.run({ ...ORDER, products: '10117' })).data.runId as string;
    await ended(setup, placed);
    const log = runLog(setup, placed);
    expect(log).toContain('backoffice=none/none');
    expect(log).toContain('[PASS] Order placed (not approved yet: no backoffice account for this run). Order number: 12345678');
    expect(log).not.toContain('Step: Backoffice login');

    await carol.login('carol');
    const row = async () => ((await carol.history()).data.rows as { runId: string }[]).find((candidate) => candidate.runId === placed);
    expect(await row()).toMatchObject({ status: 'awaiting_approval', statusLabel: 'Awaiting approval', outcome: 'order_placed_unapproved', orderNumber: '12345678' });

    // Carol approves it (Logs / History's "Approve in Backoffice" starts this run): the order run is then approved too.
    await carol.useBackofficeAccount('carol');
    const approval = (await carol.run({ automation: 'approve', orderNumber: '12345678', confirmed: true })).data.runId as string;
    await ended(setup, approval);
    expect(await row()).toMatchObject({ status: 'completed', statusLabel: 'Completed', approvedLater: { runId: approval, by: 'Carol' } });
    expect(setup.app.store.auditEvents().map((event) => event.action)).toContain('order-approved-later');
  });

  test('shows a run’s browser live to its owner only, passes clicks and typing on, and keeps the last page until Close browser', async () => {
    const alice = client(setup.app);
    const bob = client(setup.app);
    await alice.login('alice');
    await alice.useTestingAccount('alice');
    await bob.login('bob');
    const aliceLive = liveUpdates(setup.app, alice.cookie, 12_000);
    const bobLive = liveUpdates(setup.app, bob.cookie, 12_000);
    // PLU 555: the stand-in runner opens a real headless Edge with the run's DevTools port.
    const runId = (await alice.run({ ...ORDER, products: '555' })).data.runId as string;
    const live = () => (setup.app.runs.active.get(runId) as { live?: { lastFrame: unknown } } | undefined)?.live;
    await expect.poll(() => Boolean(live()?.lastFrame), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => runLog(setup, runId), { timeout: 15_000 }).toContain('[PASS] Order placed (not approved yet');

    // Only Alice controls it: a click on the page's button, then typing into its field.
    expect((await bob.call('POST', '/api/live/input', { runId, kind: 'click', x: 100, y: 50 })).status).toBe(403);
    expect((await alice.call('POST', '/api/live/input', { runId, kind: 'click', x: 100, y: 50 })).data).toEqual({ ok: true });
    expect((await alice.call('POST', '/api/live/input', { runId, kind: 'click', x: 150, y: 220 })).data).toEqual({ ok: true });
    expect((await alice.call('POST', '/api/live/input', { runId, kind: 'text', text: 'hello' })).data).toEqual({ ok: true });
    expect((await alice.call('POST', '/api/live/input', { runId, kind: 'key', key: 'Backspace' })).data).toEqual({ ok: true });
    expect((await alice.call('POST', '/api/live/input', { runId, kind: 'key', key: 'F12' })).status).toBe(409);
    await expect.poll(() => runLog(setup, runId)).toContain('fake page: clicked');
    await expect.poll(() => runLog(setup, runId)).toContain('fake page: typed hell');

    // The test has passed, but its page stays open until Close browser.
    expect(setup.app.runs.active.has(runId)).toBe(true);
    expect((await bob.call('POST', '/api/live/close', { runId })).status).toBe(403);
    expect((await alice.call('POST', '/api/live/close', { runId })).data).toEqual({ closed: true });
    await ended(setup, runId);
    const row = ((await alice.history()).data.rows as { runId: string }[]).find((candidate) => candidate.runId === runId);
    expect(row).toMatchObject({ status: 'awaiting_approval' });

    // The screen went to Alice's windows only.
    expect(await aliceLive).toContain('event: frame');
    expect(await bobLive).not.toContain('event: frame');
  });

  test('the page: Live browser, Close browser, and Approve in Backoffice from Logs / History', async ({ page }) => {
    await page.goto(setup.app.url);
    await page.locator('#login-username').fill('alice');
    await page.locator('#login-password').fill(PEOPLE.alice.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.locator('#testing-username').fill(PEOPLE.alice.testing.username);
    await page.locator('#testing-password').fill(PEOPLE.alice.testing.password);
    await page.locator('#testing-save').click();
    await expect(page.locator('#testing-masked')).toHaveText('al•••@e•••.com');
    await page.getByLabel('One PLU per line').fill('555');
    await page.locator('#run').click();
    await expect(page.locator('#confirm')).toContainText('None: the order waits for approval');
    await page.locator('#confirm').getByRole('button', { name: 'Run test' }).click();

    // The run's browser shows in the page; a click on its button reaches the real page.
    const screen = page.locator('#live-img');
    await expect(screen).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#live-close')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#banner-title')).toHaveText('Order placed, awaiting approval');
    const runId = [...setup.app.runs.active.keys()][0];
    const box = (await screen.boundingBox())!;
    await screen.click({ position: { x: box.width * (100 / 800), y: box.height * (50 / 450) } });
    await expect.poll(() => runLog(setup, runId)).toContain('fake page: clicked');

    await page.locator('#live-close').click();
    await expect(page.locator('#result .verdict')).toHaveText('Awaiting approval', { timeout: 15_000 });
    await expect(page.locator('#live-card')).toBeHidden();
    await expect(page.locator('#steps li.skipped')).toHaveCount(4); // the approval steps

    // Logs / History: the order waits for approval; Approve in Backoffice fills in that approval.
    await page.getByRole('tab', { name: /Logs \/ History/ }).click();
    const row = page.locator('tr.hrow').first();
    await expect(row).toContainText('Awaiting approval');
    await expect(row).toContainText('Needs approval');
    await row.click();
    await page.getByRole('button', { name: 'Approve in Backoffice' }).click();
    await expect(page.locator('input[name="automation"][value="approve"]')).toBeChecked();
    await expect(page.locator('#order-number')).toHaveValue('12345678');
    await expect(page.locator('.check-bad', { hasText: 'Backoffice account entered' })).toBeVisible();
  });

  test('shares the history: everyone sees every run, and its evidence only when signed in', async () => {
    const alice = client(setup.app);
    const bob = client(setup.app);
    const carol = client(setup.app);
    await alice.login('alice');
    await alice.useAccounts('alice');
    await bob.login('bob');
    await carol.login('carol');
    const okRun = (await alice.run({ ...ORDER, products: '10117' })).data.runId as string;
    await ended(setup, okRun);
    const failedRun = (await alice.run({ ...ORDER, products: '404' })).data.runId as string;
    await ended(setup, failedRun);

    const rows = (await bob.history()).data.rows as { runId: string; status: string; operator: string; screenshots: string[] }[];
    expect(rows.map((row) => [row.runId, row.status, row.operator])).toEqual([
      [failedRun, 'failed', 'Alice'],
      [okRun, 'completed', 'Alice'],
    ]);
    const screenshot = `/api/screenshot?run=${okRun}&name=${rows[1].screenshots[0]}`;
    const shot = await bob.call('GET', screenshot);
    expect(shot.status).toBe(200);
    expect(shot.headers.get('content-type')).toBe('image/png');
    expect((await client(setup.app).call('GET', screenshot)).status).toBe(401);

    const report = await bob.call('GET', `/api/runs/${failedRun}/files/error-report.txt`);
    expect(report.status).toBe(200);
    expect(report.headers.get('content-disposition')).toContain('attachment');
    expect(String(report.data)).toContain('Code:        PRODUCT_NOT_FOUND');
    expect(String(report.data)).toContain('Operator:    Alice');
    for (const path of [`/api/runs/${failedRun}/files/..%2F..%2F..%2Fconfig%2Fusers.json`, `/api/runs/${failedRun}/files/order.exe`, '/api/runs/not-a-run/files/log.txt']) {
      expect((await bob.call('GET', path)).status, path).toBe(404);
    }
    const html = await bob.call('GET', `/api/runs/${okRun}/report/index.html`);
    expect(html.status).toBe(200);
    expect(String(html.data)).toContain('Fake Playwright report');
    const zip = await bob.call('GET', `/api/runs/${okRun}/evidence.zip`);
    expect(zip.status).toBe(200);
    expect((zip.data as Buffer).subarray(0, 2).toString()).toBe('PK');
    const csv = await bob.call('POST', '/api/export', { runIds: [okRun, failedRun] });
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(String(csv.data).trimEnd().split('\r\n')).toHaveLength(3);
    expect(String(csv.data)).toContain('"PRODUCT_NOT_FOUND"');

    // Only an admin deletes a run, with its evidence.
    expect((await bob.call('DELETE', `/api/runs/${okRun}`, {})).status).toBe(403);
    expect((await carol.call('DELETE', `/api/runs/${okRun}`, {})).status).toBe(204);
    expect(existsSync(runFolder(setup, okRun))).toBe(false);
    expect(((await bob.history()).data.rows as { runId: string }[]).map((row) => row.runId)).toEqual([failedRun]);
  });

  test('never keeps or shows a password or an account: files, database, answers, live updates', async () => {
    const alice = client(setup.app);
    const bob = client(setup.app);
    await alice.login('alice');
    await alice.useAccounts('alice');
    await bob.login('bob');
    await bob.useAccounts('bob');
    const live = liveUpdates(setup.app, alice.cookie, 6_000);
    const order = (await alice.run({ ...ORDER, products: '10117\n46465' })).data.runId as string;
    // PLU 777: the fake runner (wrongly) writes Bob's passwords into its log.
    const leaky = (await bob.run({ ...ORDER, products: '777' })).data.runId as string;
    await ended(setup, order);
    await ended(setup, leaky);
    const approval = (await alice.run({ automation: 'approve', orderNumber: '07091012', confirmed: true })).data.runId as string;
    const failing = (await bob.run({ ...ORDER, products: '404' })).data.runId as string;
    await ended(setup, approval);
    await ended(setup, failing);

    // The server found the planted passwords, removed them and noted it.
    const leakyLog = readFileSync(join(runFolder(setup, leaky), 'log.txt'), 'utf8');
    expect(leakyLog).toContain('\npassword was [removed]');
    expect(leakyLog).toContain('\nbackoffice password was [removed]');
    expect(setup.app.store.auditEvents().some((event) => event.action === 'evidence-secret-removed' && event.username === 'bob')).toBe(true);

    // Nothing the server keeps, or answered, holds a password or an account.
    await alice.history();
    await bob.history();
    await alice.call('POST', '/api/state', {});
    await bob.call('POST', '/api/export', {});
    const answers = [...alice.responses, ...bob.responses, await live].join('\n');
    expect(answers).toContain('event: finished'); // the live updates were read
    const kept = [...filesUnder(setup.evidenceDir), ...filesUnder(setup.dataDir)].map((file) => readFileSync(file).toString('utf8')).join('\n');
    for (const secret of SECRETS) {
      expect(answers.includes(secret), `answers contain ${secret}`).toBe(false);
      expect(kept.includes(secret), `stored files contain ${secret}`).toBe(false);
    }
  });

  test('upkeep removes old evidence but keeps the history, backs up the database, and marks interrupted runs', async () => {
    const alice = client(setup.app);
    await alice.login('alice');
    await alice.useAccounts('alice');
    const runId = (await alice.run({ ...ORDER, products: '10117' })).data.runId as string;
    await ended(setup, runId);

    const later = new Date(Date.now() + 200 * 86_400_000);
    await setup.app.maintenance(later);
    expect(existsSync(runFolder(setup, runId))).toBe(false);
    expect((await alice.history()).data.rows[0]).toMatchObject({ runId, status: 'completed', evidenceState: 'deleted', screenshots: [], hasReport: false });
    const pad = (n: number) => String(n).padStart(2, '0');
    const backups = readdirSync(join(setup.dataDir, 'backups'));
    expect(backups).toEqual([`automation-${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}.db`]);
    expect(statSync(join(setup.dataDir, 'backups', backups[0])).size).toBeGreaterThan(0);

    // A run going on when the service stopped shows as "Interrupted" after the restart.
    setup.app.store.startRun(
      { runId: '2026-01-02_03-04-05', automation: 'order', status: 'running', statusLabel: 'Running', startedAt: '2026-01-02T03:04:05.000Z' },
      { username: 'alice', displayName: 'Alice' },
    );
    await setup.app.close();
    setup.app = await startServer(setup.options);
    const again = client(setup.app);
    await again.login('alice');
    const rows = (await again.history()).data.rows as { runId: string }[];
    expect(rows.find((row) => row.runId === '2026-01-02_03-04-05')).toMatchObject({ status: 'interrupted', statusLabel: 'Interrupted' });
  });

  test('runs saved as failed after their test had passed are corrected at the next start', async () => {
    // Until 2026-10-14, Close browser closed the whole browser and the test's clean-up then failed.
    const run = (runId: string, orderNumber: string, passed: string | null) => {
      const dir = runFolder(setup, runId);
      mkdirSync(dir, { recursive: true });
      const startedAt = `${runId.slice(0, 10)}T${runId.slice(11).replace(/-/g, ':')}.000Z`;
      const record = { runId, automation: 'order', operator: 'Felix', state: 'finished', startedAt, finishedAt: startedAt, orderNumber, passed, cancelled: false };
      writeFileSync(join(dir, 'launcher-run.json'), JSON.stringify(record));
      const error = { code: null, step: 'Order confirmation', message: 'browserContext.close: Test ended.' };
      writeFileSync(join(dir, 'result.json'), JSON.stringify({ status: 'failed', outcome: 'failed', automation: 'order', orderNumber, error }));
      setup.app.store.startRun(
        { runId, automation: 'order', status: 'failed', statusLabel: 'Failed', startedAt, orderNumber, folder: `${runId.slice(0, 10)}\\${runId}` },
        { username: 'bob', displayName: 'Felix' },
      );
    };
    run('2026-10-14_16-16-54', '07110006', 'order_placed_unapproved'); // passed, then the browser was closed
    run('2026-10-14_16-30-00', '07110007', 'order_placed_unapproved'); // the same, approved meanwhile below
    run('2026-10-14_16-40-00', '07110008', null); // really failed
    setup.app.store.startRun(
      { runId: '2026-10-14_17-00-00', automation: 'approve', status: 'completed', statusLabel: 'Completed', startedAt: '2026-10-14T17:00:00.000Z', finishedAt: '2026-10-14T17:03:00.000Z', orderNumber: '07110007' },
      { username: 'carol', displayName: 'Carol' },
    );
    await setup.app.close();
    setup.app = await startServer(setup.options);
    const carol = client(setup.app);
    await carol.login('carol');
    const rows = (await carol.history()).data.rows as { runId: string }[];
    const row = (runId: string) => rows.find((candidate) => candidate.runId === runId);
    expect(row('2026-10-14_16-16-54')).toMatchObject({ status: 'awaiting_approval', outcome: 'order_placed_unapproved', orderNumber: '07110006', error: null });
    expect(row('2026-10-14_16-30-00')).toMatchObject({ status: 'completed', approvedLater: { runId: '2026-10-14_17-00-00', by: 'Carol' } });
    expect(row('2026-10-14_16-40-00')).toMatchObject({ status: 'failed' });
  });

  test('the page: sign in, both accounts, run, and the shared history', async ({ page }) => {
    // Bob ran something earlier: Alice sees it too.
    const bob = client(setup.app);
    await bob.login('bob');
    await bob.useAccounts('bob');
    const bobRun = (await bob.run({ ...ORDER, products: '10117' })).data.runId as string;
    await ended(setup, bobRun);

    await page.goto(setup.app.url);
    await expect(page.locator('#login')).toBeVisible();
    await page.locator('#login-username').fill('alice');
    await page.locator('#login-password').fill('wrong-password-0');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#login-error')).toHaveText('Wrong user name or password.');
    await page.locator('#login-password').fill(PEOPLE.alice.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#login')).toBeHidden();
    await expect(page.locator('#operator-item')).toContainText('Signed in as Alice');

    // Step 2: her own testing and backoffice accounts.
    const run = page.locator('#run');
    await expect(page.locator('#section-accounts')).toBeVisible();
    await expect(page.locator('.check-bad', { hasText: 'Testing account entered' })).toBeVisible();
    // The backoffice account is optional for a new order: without it, the order waits for approval.
    await expect(page.locator('.check-optional', { hasText: 'No backoffice account: the order will wait for approval' })).toBeVisible();
    await expect(run).toBeDisabled();
    await page.locator('#testing-username').fill(PEOPLE.alice.testing.username);
    await page.locator('#testing-password').fill(PEOPLE.alice.testing.password);
    await page.locator('#testing-save').click();
    await expect(page.locator('#testing-masked')).toHaveText('al•••@e•••.com');
    await expect(page.locator('#testing-password')).toHaveValue('');
    await expect(page.locator('.check-ok', { hasText: 'Testing account entered' })).toBeVisible();
    await expect(run).toBeEnabled();
    await page.locator('#backoffice-username').fill(PEOPLE.alice.backoffice.username);
    await page.locator('#backoffice-password').fill(PEOPLE.alice.backoffice.password);
    await page.locator('#backoffice-password').press('Enter');
    await expect(page.locator('#backoffice-masked')).toHaveText('al•••');
    await expect(page.locator('#backoffice-password')).toHaveValue('');
    await expect(page.locator('.check-ok', { hasText: 'Backoffice account entered' })).toBeVisible();
    await expect(run).toBeEnabled();

    // Approving an existing order asks only for the backoffice account.
    await page.getByLabel('Approve existing order').check();
    await expect(page.locator('#account-testing')).toBeHidden();
    await expect(page.locator('#account-backoffice')).toBeVisible();
    await expect(page.locator('#checklist')).not.toContainText('Testing account entered');
    await page.getByLabel('Place new order').check();
    await expect(page.locator('#account-testing')).toBeVisible();

    await run.click();
    await expect(page.locator('#confirm')).toContainText('al•••@e•••.com');
    await expect(page.locator('#confirm')).toContainText('Backoffice account');
    await page.locator('#confirm').getByRole('button', { name: 'Run test' }).click();
    await expect(page.locator('#result .verdict')).toHaveText('Completed', { timeout: 15_000 });
    await expect(page.locator('#result .order-number')).toHaveText('Order Number: 12345678');
    await expect(page.locator('#result')).toContainText('Download evidence (.zip)');

    // The shared history: her run and Bob's, with Bob's screenshot.
    await page.getByRole('tab', { name: /Logs \/ History/ }).click();
    const rows = page.locator('tr.hrow');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Alice');
    await expect(rows.nth(1)).toContainText('Bob');
    await page.locator('#history-who').selectOption('mine');
    await expect(rows).toHaveCount(1);
    await page.locator('#history-who').selectOption('all');
    const thumbnail = rows.nth(1).locator('.thumb img');
    await expect.poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);

    // Signing out ends the session; signing in again brings her remembered accounts back.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#login-password')).toHaveValue('');
    await page.locator('#login-username').fill('alice');
    await page.locator('#login-password').fill(PEOPLE.alice.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('tab', { name: 'Automation' })).toBeVisible();
    await page.getByRole('tab', { name: 'Automation' }).click();
    await expect(page.locator('#testing-masked')).toHaveText('al•••@e•••.com');
    await expect(page.locator('#backoffice-masked')).toHaveText('al•••');
    await expect(page.locator('#testing-remembered')).toBeVisible();
    await expect(page.locator('#backoffice-remembered')).toBeVisible();
    await expect(run).toBeEnabled();
  });
});

test.describe('hosted server sign-in limits', () => {
  test.skip(!SERVER_INSTALLED, skipReason);
  test('per address (the PRD: 5 a minute), and per user name for failures', async () => {
    const strict = await makeServer({ loginLimitPerMinute: 5 });
    try {
      const someone = client(strict.app);
      for (let attempt = 0; attempt < 5; attempt++) expect((await someone.login('alice', 'wrong-password')).status).toBe(401);
      expect((await someone.login('alice')).data).toEqual({ error: 'Too many sign-in attempts from this computer. Wait a minute and try again.' });
    } finally {
      await closeServer(strict);
    }
    const perUser = await makeServer({ loginFailuresPerUser: 3 });
    try {
      const someone = client(perUser.app);
      for (let attempt = 0; attempt < 3; attempt++) expect((await someone.login('alice', 'wrong-password')).status).toBe(401);
      expect((await someone.login('alice')).data).toEqual({ error: 'Too many failed sign-ins for this user name. Wait 15 minutes, or ask the admin.' });
      expect((await someone.login('bob')).status).toBe(200);
      expect(perUser.app.store.auditEvents().filter((event) => event.action === 'login-limited').length).toBeGreaterThan(0);
    } finally {
      await closeServer(perUser);
    }
  });
});
