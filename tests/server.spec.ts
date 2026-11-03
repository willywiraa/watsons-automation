import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
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
// The walkthrough recorded from the hosted app (server/scripts/record-walkthrough.cjs, 2026-10-31).
const WALKTHROUGH_DIR = join(__dirname, '..', 'server', 'walkthrough');
interface Walkthrough {
  duration: number;
  steps: { title: string; start: number }[];
  cues: { start: number; step: number; text: string }[];
}

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
const NEEDS_TESTING = 'Enter your testing account first (under "Accounts").';
const NEEDS_BACKOFFICE = 'Enter your backoffice account first (under "Accounts").';
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
    walkthroughDir: join(base, 'walkthrough'), // none, unless a test gives the recorded one
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

test('extraction checks: 2 minutes after the run, every 2 minutes for the first hour, then every 10 (user’s choice 2026-11-03)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { nextCheckAt, TIMING } = require('../server/lib/extraction.cjs');
  const since = Date.parse('2026-11-03T04:00:00Z');
  const minutes = (n: number) => since + n * 60_000;
  expect(nextCheckAt(since, null)).toBe(minutes(2));
  expect(nextCheckAt(since, minutes(2))).toBe(minutes(4));
  expect(nextCheckAt(since, minutes(59))).toBe(minutes(61));
  expect(nextCheckAt(since, minutes(61))).toBe(minutes(71));
  expect(TIMING.giveUpAfterMs).toBe(24 * 3600_000);
});

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
      ['GET', '/api/events'],
      ['GET', '/api/screenshot?run=2026-10-08_10-00-00&name=screenshot-1.png'],
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

    // Carol approves it (Logs / History's "Approve" starts this run): the order run is then approved too.
    await carol.useBackofficeAccount('carol');
    const approval = (await carol.run({ automation: 'approve', orderNumber: '12345678', confirmed: true })).data.runId as string;
    await ended(setup, approval);
    expect(await row()).toMatchObject({ status: 'completed', statusLabel: 'Completed', approvedLater: { runId: approval, by: 'Carol' } });
    expect(setup.app.store.auditEvents().map((event) => event.action)).toContain('order-approved-later');
  });

  test('a run’s question: only its owner answers, and the decision is kept and audited (2026-10-22)', async () => {
    const alice = client(setup.app);
    const bob = client(setup.app);
    await alice.login('alice');
    await alice.useAccounts('alice');
    await bob.login('bob');
    // PLU 3333: the stand-in run asks at "Product Search" what to do with it (out of stock).
    const runId = (await alice.run({ ...ORDER, products: '10117\n3333' })).data.runId as string;
    await expect.poll(() => runLog(setup, runId)).toContain('[ASK] Product 3333 is out of stock. What would you like to do?');
    const { id } = JSON.parse(readFileSync(join(runFolder(setup, runId), 'ask.json'), 'utf8'));
    expect((await alice.call('POST', '/api/state', {})).data.current.question).toMatchObject({ id, kind: 'out_of_stock', step: 'Product Search', plus: ['3333'] });
    // Not Bob: it's not his run.
    expect(await bob.call('POST', '/api/answer', { id, action: 'skip' })).toMatchObject({ status: 409, data: { error: 'You have no run going on.' } });
    expect(await alice.call('POST', '/api/answer', { id, action: 'retry' })).toMatchObject({ status: 409, data: { error: 'That is not one of the choices.' } });
    expect(await alice.call('POST', '/api/answer', { id, action: 'skip' })).toMatchObject({ status: 200, data: { ok: true } });
    await ended(setup, runId);
    const row = ((await bob.history()).data.rows as { runId: string }[]).find((candidate) => candidate.runId === runId);
    expect(row).toMatchObject({ status: 'completed', decisions: [{ action: 'skip', plus: ['3333'], by: 'Alice', outcome: 'PLU 3333 left out of the order' }] });
    expect(setup.app.store.auditEvents().some((event) => event.action === 'run-answer' && event.username === 'alice')).toBe(true);
    expect(runLog(setup, runId)).toContain('[launcher] Alice chose: Skip product and continue');
  });

  test('a product with a "Buy 2" offer: its owner answers how many, which is ordered and audited (2026-11-02)', async () => {
    const alice = client(setup.app);
    await alice.login('alice');
    await alice.useAccounts('alice');
    // PLU 6666: the stand-in run asks at "Add to bag" how many to buy.
    const runId = (await alice.run({ ...ORDER, products: '10117\n6666' })).data.runId as string;
    await expect.poll(() => runLog(setup, runId)).toContain('[ASK] Product 6666 has a Buy 2 offer. How many would you like to buy?');
    const { id } = JSON.parse(readFileSync(join(runFolder(setup, runId), 'ask.json'), 'utf8'));
    expect((await alice.call('POST', '/api/state', {})).data.current.question).toMatchObject({
      id,
      kind: 'buy_option',
      step: 'Add to bag',
      options: [{ action: 'buy', quantity: 1 }, { action: 'buy', quantity: 2 }, { action: 'stop' }],
    });
    expect(await alice.call('POST', '/api/answer', { id, action: 'buy', quantity: 5 })).toMatchObject({ status: 409, data: { error: 'That is not one of the choices.' } });
    expect(await alice.call('POST', '/api/answer', { id, action: 'buy', quantity: 2 })).toMatchObject({ status: 200, data: { ok: true } });
    await ended(setup, runId);
    const row = ((await alice.history()).data.rows as { runId: string }[]).find((candidate) => candidate.runId === runId);
    expect(row).toMatchObject({
      status: 'completed',
      products: { ordered: [{ plu: '10117', quantity: 1 }, { plu: '6666', quantity: 2 }] },
      decisions: [{ action: 'buy', label: 'Buy 2 for the promotional discount', outcome: 'PLU 6666 x2 in the bag', by: 'Alice' }],
    });
    expect(setup.app.store.auditEvents().some((event) => event.action === 'run-answer' && /"quantity":2/.test(String(event.detail)))).toBe(true);
  });

  test('an order left at Order Split is checked in the shop until it is ORDER_EXTRACTED; checks pause while its person is signed out (2026-11-03)', async () => {
    await closeServer(setup);
    setup = await makeServer({ extractionTiming: { tickMs: 200, firstAfterMs: 2_000, earlyEveryMs: 500, lateEveryMs: 500 } });
    type Row = { runId: string; status: string; backoffice: { extractionPending: boolean; finalStatus: string; extractionCheck?: Record<string, unknown>; extractedLater?: { at: string; seenAt: string } } };
    const alice = client(setup.app);
    const carol = client(setup.app);
    await alice.login('alice');
    await alice.useAccounts('alice');
    await carol.login('carol');
    // PLU 2222: the stand-in run approves the order, which then stays at Order Split.
    const runId = (await alice.run({ ...ORDER, products: '2222' })).data.runId as string;
    await ended(setup, runId);
    const row = async () => ((await carol.history()).data.rows as Row[]).find((candidate) => candidate.runId === runId)!;
    expect(await row()).toMatchObject({ status: 'completed', backoffice: { extractionPending: true, finalStatus: 'Order Split' } });

    // Alice signs out before the first check: it waits for her (her testing account goes with her session).
    await alice.call('POST', '/api/logout');
    await expect.poll(async () => (await row()).backoffice.extractionCheck, { timeout: 10_000 }).toMatchObject({ state: 'paused', reason: 'signed_out', who: ['Alice'] });
    const checks = join(setup.options.projectDir as string, 'extraction-checks.log');
    expect(existsSync(checks)).toBe(false);

    // She signs in again (her remembered accounts come back): checked with her testing account,
    // still at Order Split the first time, extracted the second; Carol's open page is told.
    const carolsPage = liveUpdates(setup.app, carol.cookie, 10_000);
    await alice.login('alice');
    await expect.poll(async () => (await row()).backoffice.extractionPending, { timeout: 10_000 }).toBe(false);
    const done = await row();
    expect(done).toMatchObject({
      status: 'completed',
      backoffice: { finalStatus: 'ORDER_EXTRACTED', extractedLater: { at: '2026-11-03T04:20:09.000Z' }, extractionCheck: { state: 'done' } },
    });
    expect(Date.parse(done.backoffice.extractedLater!.seenAt)).toBeGreaterThan(Date.parse('2026-11-03T04:20:09.000Z'));
    expect(readFileSync(checks, 'utf8').trim().split('\n')).toEqual([
      `account=${fingerprint(PEOPLE.alice.testing.username)} orders=12345678`,
      `account=${fingerprint(PEOPLE.alice.testing.username)} orders=12345678`,
    ]);
    const updates = await carolsPage;
    expect(updates).toContain('event: history\ndata: {"extraction":"12345678"}');
    expect(updates).toContain('event: history\ndata: {"extracted":"12345678"}');
    expect(setup.app.store.auditEvents().some((event) => event.action === 'order-extracted' && String(event.detail).includes('12345678'))).toBe(true);
    // Nothing else is checked afterwards, and the check's folders are gone.
    await new Promise((done) => setTimeout(done, 1_500));
    expect(readFileSync(checks, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(filesUnder(join(setup.dataDir, 'extraction-checks'))).toEqual([]);
  });

  test('the page: an order left at Order Split shows "Order extracted" by itself once the check sees it (2026-11-03)', async ({ page }) => {
    await closeServer(setup);
    setup = await makeServer({ extractionTiming: { tickMs: 200, firstAfterMs: 3_000, earlyEveryMs: 1_500, lateEveryMs: 1_500 } });
    await page.goto(setup.app.url);
    await page.locator('#login-username').fill('alice');
    await page.locator('#login-password').fill(PEOPLE.alice.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.locator('#testing-username').fill(PEOPLE.alice.testing.username);
    await page.locator('#testing-password').fill(PEOPLE.alice.testing.password);
    await page.locator('#testing-save').click();
    await page.locator('#backoffice-change').click(); // optional for a new order: its form opens with Add
    await page.locator('#backoffice-username').fill(PEOPLE.alice.backoffice.username);
    await page.locator('#backoffice-password').fill(PEOPLE.alice.backoffice.password);
    await page.locator('#backoffice-save').click();
    await expect(page.locator('#backoffice-masked')).toHaveText('al•••');
    await page.getByLabel('One PLU per line').fill('2222');
    await page.locator('#run').click();
    await page.locator('#confirm').getByRole('button', { name: 'Place test order' }).click();

    // The run ends at Order Split: pending, and checked automatically.
    await expect(page.locator('#result .verdict')).toHaveText('Completed', { timeout: 15_000 });
    const note = page.locator('#result .p-note');
    await expect(note).toContainText('Extraction still pending: WTCSG12345678 is at Order Split, not yet ORDER_EXTRACTED. It is checked automatically, and this page updates by itself once it is extracted.');
    await page.getByRole('tab', { name: /Logs \/ History/ }).click();
    const row = page.locator('tr.hrow').first();
    await expect(row).toContainText('Extraction pending');

    // No reload: the row and its details change once the check sees ORDER_EXTRACTED.
    await expect(row).toContainText('Order extracted', { timeout: 15_000 });
    await expect(row).not.toContainText('Extraction pending');
    await row.click();
    const details = page.locator('tr.hdetail');
    await expect(details).toContainText('Placed and approved in the backoffice. The order is now ORDER_EXTRACTED.');
    await expect(details.locator('.p-note--ok')).toContainText('Order extracted: WTCSG12345678 reached ORDER_EXTRACTED at');
    await expect(details).not.toContainText('Extraction still pending');
    // The run's result on the Automation page too.
    await page.getByRole('tab', { name: 'Automation' }).click();
    await expect(page.locator('#result .p-note--ok')).toContainText('Order extracted: WTCSG12345678 reached ORDER_EXTRACTED');
    await expect(page.locator('#result')).not.toContainText('Extraction still pending');
  });

  test('a partial order (2026-11-03): its owner splits it; both orders await approval, and each is approved on its own', async () => {
    type Order = { orderNumber: string | null; delivery: { mode: string }; approvedLater?: { runId: string; by: string } };
    type Row = { runId: string; status: string; orderNumber: string; orders: Order[]; approvedLater?: { runId: string } };
    const alice = client(setup.app);
    const carol = client(setup.app);
    await alice.login('alice');
    await alice.useTestingAccount('alice'); // no backoffice account: the orders wait for approval
    // PLU 7777: the stand-in run can't send it Express, and Standard takes it.
    const placed = (await alice.run({ ...ORDER, products: '10117\n7777' })).data.runId as string;
    await expect.poll(() => runLog(setup, placed)).toContain('[ASK] Product 7777 is not eligible for Express delivery with Home Delivery.');
    const { id } = JSON.parse(readFileSync(join(runFolder(setup, placed), 'ask.json'), 'utf8'));
    expect((await alice.call('POST', '/api/state', {})).data.current.question.options[0]).toEqual({ action: 'split', mode: 'standard', label: 'Split into 2 orders: Express, then Standard' });
    expect(await alice.call('POST', '/api/answer', { id, action: 'split', mode: 'express' })).toMatchObject({ status: 409, data: { error: 'That is not one of the choices.' } });
    expect(await alice.call('POST', '/api/answer', { id, action: 'split', mode: 'standard' })).toMatchObject({ status: 200 });
    await ended(setup, placed);
    expect(runLog(setup, placed)).toContain('[PASS] Order placed (not approved yet: no backoffice account for this run). Order number: 12345678; order 2: 12345679');

    await carol.login('carol');
    const row = async () => ((await carol.history()).data.rows as Row[]).find((candidate) => candidate.runId === placed)!;
    expect(await row()).toMatchObject({
      status: 'awaiting_approval',
      orderNumber: '12345678',
      orders: [{ orderNumber: '12345678', delivery: { mode: 'express' } }, { orderNumber: '12345679', delivery: { mode: 'standard' } }],
    });
    // Carol approves order 2 first: the run still waits for order 1.
    await carol.useBackofficeAccount('carol');
    const second = (await carol.run({ automation: 'approve', orderNumber: '12345679', confirmed: true })).data.runId as string;
    await ended(setup, second);
    const half = await row();
    expect(half).toMatchObject({ status: 'awaiting_approval', orders: [{ orderNumber: '12345678' }, { orderNumber: '12345679', approvedLater: { runId: second, by: 'Carol' } }] });
    expect(half.orders[0].approvedLater).toBeUndefined();
    const first = (await carol.run({ automation: 'approve', orderNumber: '12345678', confirmed: true })).data.runId as string;
    await ended(setup, first);
    expect(await row()).toMatchObject({
      status: 'completed',
      approvedLater: { runId: first },
      orders: [{ approvedLater: { runId: first, by: 'Carol' } }, { approvedLater: { runId: second, by: 'Carol' } }],
    });
    expect(setup.app.store.auditEvents().filter((event) => event.action === 'order-approved-later')).toHaveLength(2);
  });

  test('a partial order whose order 2 is left at Order Split: only that order is checked, until it is extracted (2026-11-03)', async () => {
    await closeServer(setup);
    setup = await makeServer({ extractionTiming: { tickMs: 200, firstAfterMs: 1_000, earlyEveryMs: 500, lateEveryMs: 500 } });
    type Backoffice = { finalStatus: string; extractionPending?: boolean; extractedLater?: { at: string }; extractionCheck?: { state: string } };
    type Row = { runId: string; status: string; backoffice: Backoffice; orders: { orderNumber: string; backoffice: Backoffice }[] };
    const alice = client(setup.app);
    await alice.login('alice');
    await alice.useAccounts('alice');
    // PLU 2222: order 2 is approved but stays at Order Split; order 1 is extracted.
    const runId = (await alice.run({ ...ORDER, products: '2222\n7777' })).data.runId as string;
    await expect.poll(() => runLog(setup, runId)).toContain('[ASK] Product 7777');
    const { id } = JSON.parse(readFileSync(join(runFolder(setup, runId), 'ask.json'), 'utf8'));
    await alice.call('POST', '/api/answer', { id, action: 'split', mode: 'standard' });
    await ended(setup, runId);
    expect(runLog(setup, runId)).toContain('[PASS] Order test completed successfully. Order number: 12345678 (backoffice: ORDER_EXTRACTED); order 2: 12345679 (backoffice: Order Split; extraction still pending)');
    const row = async () => ((await alice.history()).data.rows as Row[]).find((candidate) => candidate.runId === runId)!;
    expect(await row()).toMatchObject({
      status: 'completed',
      backoffice: { extractionPending: true },
      orders: [{ orderNumber: '12345678', backoffice: { finalStatus: 'ORDER_EXTRACTED' } }, { orderNumber: '12345679', backoffice: { finalStatus: 'Order Split', extractionPending: true } }],
    });
    await expect.poll(async () => (await row()).backoffice.extractionPending, { timeout: 15_000 }).toBe(false);
    expect((await row()).orders[1].backoffice).toMatchObject({ finalStatus: 'ORDER_EXTRACTED', extractionPending: false, extractedLater: { at: '2026-11-03T04:20:09.000Z' }, extractionCheck: { state: 'done' } });
    expect((await row()).orders[0].backoffice.extractedLater).toBeUndefined();
    // Only order 2 was checked: at Order Split the first time, extracted the second.
    const checks = readFileSync(join(setup.options.projectDir as string, 'extraction-checks.log'), 'utf8').trim().split('\n');
    expect(checks).toEqual([`account=${fingerprint(PEOPLE.alice.testing.username)} orders=12345679`, `account=${fingerprint(PEOPLE.alice.testing.username)} orders=12345679`]);
  });

  test('the page: a partial order shows both orders, and order 2’s extraction updates by itself (2026-11-03)', async ({ page }) => {
    await closeServer(setup);
    setup = await makeServer({ extractionTiming: { tickMs: 200, firstAfterMs: 3_000, earlyEveryMs: 1_500, lateEveryMs: 1_500 } });
    await page.goto(setup.app.url);
    await page.locator('#login-username').fill('alice');
    await page.locator('#login-password').fill(PEOPLE.alice.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.locator('#testing-username').fill(PEOPLE.alice.testing.username);
    await page.locator('#testing-password').fill(PEOPLE.alice.testing.password);
    await page.locator('#testing-save').click();
    await page.locator('#backoffice-change').click();
    await page.locator('#backoffice-username').fill(PEOPLE.alice.backoffice.username);
    await page.locator('#backoffice-password').fill(PEOPLE.alice.backoffice.password);
    await page.locator('#backoffice-save').click();
    await expect(page.locator('#backoffice-masked')).toHaveText('al•••');
    await page.getByLabel('One PLU per line').fill('2222\n7777');
    await page.locator('#run').click();
    await page.locator('#confirm').getByRole('button', { name: 'Place test order' }).click();

    const ask = page.locator('#ask');
    await expect(ask.getByRole('button').first()).toHaveText('Split into 2 orders: Express, then Standard', { timeout: 15_000 });
    await ask.getByRole('button', { name: 'Split into 2 orders: Express, then Standard' }).click();
    await expect(page.locator('#result .verdict')).toHaveText('Completed', { timeout: 15_000 });
    const orders = page.locator('#result .p-orders__item');
    await expect(orders).toHaveText([/Order 1.*12345678.*Express · PLU 2222.*ORDER_EXTRACTED/, /Order 2.*12345679.*Standard · PLU 7777.*Order Split, extraction pending/]);
    await expect(page.locator('#result .p-note')).toContainText('Extraction still pending: WTCSG12345679 (order 2) is at Order Split, not yet ORDER_EXTRACTED. It is checked automatically');
    await page.getByRole('tab', { name: /Logs \/ History/ }).click();
    const row = page.locator('tr.hrow').first();
    await expect(row).toContainText('12345678');
    await expect(row).toContainText('12345679');
    await expect(row).toContainText('Extraction pending');
    // No reload: order 2's extraction shows once the check sees it.
    await expect(row).toContainText('Order 2 extracted', { timeout: 15_000 });
    await expect(row).not.toContainText('Extraction pending');
    await row.click();
    await expect(page.locator('tr.hdetail .p-note--ok')).toContainText('Order extracted: WTCSG12345679 (order 2) reached ORDER_EXTRACTED at');
    await page.getByRole('tab', { name: 'Automation' }).click();
    await expect(page.locator('#result .p-orders__item').nth(1)).toContainText('ORDER_EXTRACTED at');
    await expect(page.locator('#result')).not.toContainText('Extraction still pending');
  });

  test('Shell Station: no mode; the person picks the pickup store, and their next page keeps the choice (2026-10-30)', async () => {
    const alice = client(setup.app);
    await alice.login('alice');
    await alice.useAccounts('alice');
    const state = (await alice.call('POST', '/api/state', {})).data;
    expect(state.pickupStores).toMatchObject({ auto: { label: 'Choose for me' }, ask: { label: 'Let me choose' } });
    expect(state.steps.shellStation).toContain('Pickup Store Selection');
    expect(state.steps.shellStation).not.toContain('Express Delivery Selection');
    const runId = (await alice.run({ products: '10117', deliveryMethod: 'shell_station', pickupStore: 'ask', confirmed: true })).data.runId as string;
    await expect.poll(() => runLog(setup, runId)).toContain('[ASK] Which Shell Station should the order be picked up from?');
    const { id } = JSON.parse(readFileSync(join(runFolder(setup, runId), 'ask.json'), 'utf8'));
    expect((await alice.call('POST', '/api/state', {})).data.current.question).toMatchObject({
      id,
      kind: 'choose_store',
      step: 'Pickup Store Selection',
      choices: [{ value: 'FUEL435' }, { value: 'FUEL101' }, { value: 'FUEL202' }],
    });
    expect(await alice.call('POST', '/api/answer', { id, action: 'choose', value: 'FUEL999' })).toMatchObject({ status: 409, data: { error: 'Choose one from the list.' } });
    expect(await alice.call('POST', '/api/answer', { id, action: 'choose', value: 'FUEL101' })).toMatchObject({ status: 200, data: { ok: true } });
    await ended(setup, runId);
    const row = ((await alice.history()).data.rows as { runId: string }[]).find((candidate) => candidate.runId === runId);
    expect(row).toMatchObject({
      status: 'completed',
      delivery: { method: 'shell_station', mode: null, store: 'SHELL ANG MO KIO', label: 'Shell Station · SHELL ANG MO KIO' },
      decisions: [{ action: 'choose', choice: 'SHELL ANG MO KIO', by: 'Alice' }],
    });
    expect(setup.app.store.auditEvents().some((event) => event.action === 'run-answer' && String(event.detail).includes('FUEL101'))).toBe(true);
    // Her next page starts with Shell Station and "Let me choose".
    expect((await alice.call('POST', '/api/state', {})).data.defaults).toMatchObject({ deliveryMethod: 'shell_station', pickupStore: 'ask', source: 'your last run' });
  });

  test('shows a run’s browser live to its owner only, passes clicks and typing on; the run ends by itself once done', async () => {
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

    // Only Alice controls it: a click on the page's button, then typing into its field.
    expect((await bob.call('POST', '/api/live/input', { runId, kind: 'click', x: 100, y: 50 })).status).toBe(403);
    expect((await alice.call('POST', '/api/live/input', { runId, kind: 'click', x: 100, y: 50 })).data).toEqual({ ok: true });
    expect((await alice.call('POST', '/api/live/input', { runId, kind: 'click', x: 150, y: 220 })).data).toEqual({ ok: true });
    expect((await alice.call('POST', '/api/live/input', { runId, kind: 'text', text: 'hello' })).data).toEqual({ ok: true });
    expect((await alice.call('POST', '/api/live/input', { runId, kind: 'key', key: 'Backspace' })).data).toEqual({ ok: true });
    expect((await alice.call('POST', '/api/live/input', { runId, kind: 'key', key: 'F12' })).status).toBe(409);
    await expect.poll(() => runLog(setup, runId)).toContain('fake page: clicked');
    await expect.poll(() => runLog(setup, runId)).toContain('fake page: typed hell');

    // Then the test passes and the run ends by itself: no Close browser (2026-10-23).
    await ended(setup, runId);
    expect(runLog(setup, runId)).toContain('[PASS] Order placed (not approved yet');
    const row = ((await alice.history()).data.rows as { runId: string }[]).find((candidate) => candidate.runId === runId);
    expect(row).toMatchObject({ status: 'awaiting_approval' });
    // Alice can start her next order straight away: nothing to close or cancel first.
    const next = await alice.run({ ...ORDER, products: '10117' });
    expect(next.status).toBe(200);
    await ended(setup, next.data.runId as string);

    // The screen went to Alice's windows only.
    expect(await aliceLive).toContain('event: frame');
    expect(await bobLive).not.toContain('event: frame');
  });

  test('the page: Live browser, the run ending by itself, and Approve from Logs / History', async ({ page }) => {
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
    await page.locator('#confirm').getByRole('button', { name: 'Place test order' }).click();

    // The run's browser shows in the page; a click on its button reaches the real page.
    const screen = page.locator('#live-img');
    await expect(screen).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Close browser' })).toHaveCount(0);
    const runId = [...setup.app.runs.active.keys()][0];
    const box = (await screen.boundingBox())!;
    await screen.click({ position: { x: box.width * (100 / 800), y: box.height * (50 / 450) } });
    await expect.poll(() => runLog(setup, runId)).toContain('fake page: clicked');

    // The run ends by itself: Completed, and the order awaits approval (2026-10-23).
    await expect(page.locator('#result .verdict')).toHaveText('Completed', { timeout: 15_000 });
    await expect(page.locator('#result .p-note')).toContainText('Awaiting approval: someone with a backoffice account must approve order 12345678');
    await expect(page.locator('#live-card')).toBeHidden();
    await expect(page.locator('#steps li.skipped')).toHaveCount(4); // the approval steps

    // Logs / History: the order waits for approval; Approve fills in that approval.
    await page.getByRole('tab', { name: /Logs \/ History/ }).click();
    const row = page.locator('tr.hrow').first();
    await expect(row).toContainText('Awaiting approval');
    await expect(row).toContainText('Needs approval');
    await row.click();
    await row.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.locator('input[name="automation"][value="approve"]')).toBeChecked();
    await expect(page.locator('#order-number')).toHaveValue('12345678');
    await expect(page.locator('#ready-fixes')).toContainText('Backoffice account entered');
    await page.getByRole('button', { name: 'Show checks' }).click();
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

    // No error-report.txt, Playwright report or Evidence (.zip) downloads any more (user's request
    // 2026-10-25): the error report is copied in the page. Its file stays in the run's evidence.
    for (const path of [
      `/api/runs/${failedRun}/files/error-report.txt`,
      `/api/runs/${failedRun}/files/..%2F..%2F..%2Fconfig%2Fusers.json`,
      `/api/runs/${okRun}/report`,
      `/api/runs/${okRun}/report/index.html`,
      `/api/runs/${okRun}/evidence.zip`,
    ]) {
      expect((await bob.call('GET', path)).status, path).toBe(404);
    }
    const errorReport = readFileSync(join(runFolder(setup, failedRun), 'error-report.txt'), 'utf8');
    expect(errorReport).toContain('Code:        PRODUCT_NOT_FOUND');
    expect(errorReport).toContain('Operator:    Alice');
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
    expect((await alice.history()).data.rows[0]).toMatchObject({ runId, status: 'completed', evidenceState: 'deleted', screenshots: [] });
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
    const run = (runId: string, orderNumber: string, passed: string | null, automation = 'order') => {
      const dir = runFolder(setup, runId);
      mkdirSync(dir, { recursive: true });
      const startedAt = `${runId.slice(0, 10)}T${runId.slice(11).replace(/-/g, ':')}.000Z`;
      const record = { runId, automation, operator: 'Felix', state: 'finished', startedAt, finishedAt: startedAt, orderNumber, passed, cancelled: false };
      writeFileSync(join(dir, 'launcher-run.json'), JSON.stringify(record));
      const error = { code: null, step: 'Order confirmation', message: 'browserContext.close: Test ended.' };
      writeFileSync(join(dir, 'result.json'), JSON.stringify({ status: 'failed', outcome: 'failed', automation, orderNumber, error }));
      setup.app.store.startRun(
        { runId, automation, status: 'failed', statusLabel: 'Failed', startedAt, orderNumber, folder: `${runId.slice(0, 10)}\\${runId}` },
        { username: 'bob', displayName: 'Felix' },
      );
    };
    run('2026-10-14_16-16-54', '07110006', 'order_placed_unapproved'); // passed, then the browser was closed
    run('2026-10-14_16-30-00', '07110007', 'order_placed_unapproved'); // the same, approved meanwhile below
    run('2026-10-14_16-40-00', '07110008', null); // really failed
    // An approval that passed, then the browser was closed (2026-10-16): its order counts as approved.
    setup.app.store.startRun(
      { runId: '2026-10-16_09-50-00', automation: 'order', status: 'awaiting_approval', statusLabel: 'Awaiting approval', startedAt: '2026-10-16T09:50:00.000Z', orderNumber: '07114005' },
      { username: 'bob', displayName: 'Felix' },
    );
    run('2026-10-16_10-03-00', '07114005', 'approved', 'approve');
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
    expect(row('2026-10-16_10-03-00')).toMatchObject({ status: 'completed', outcome: 'approved', error: null });
    expect(row('2026-10-16_09-50-00')).toMatchObject({ status: 'completed', approvedLater: { runId: '2026-10-16_10-03-00', by: 'Felix' } });
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
    await expect(page.locator('#user-button')).toContainText('Alice');
    // No walkthrough on this server (its files are not there): neither shown nor offered.
    await expect(page.locator('#tour')).toBeHidden();
    await expect(page.locator('#header-tour')).toBeHidden();

    // Step 2: her own testing and backoffice accounts.
    const run = page.locator('#run');
    await expect(page.locator('#section-accounts')).toBeVisible();
    await page.getByRole('button', { name: 'Show checks' }).click();
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
    // Optional for a new order: its form opens with Add.
    await expect(page.locator('#backoffice-username')).toBeHidden();
    await page.locator('#backoffice-change').click();
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
    await page.locator('#confirm').getByRole('button', { name: 'Place test order' }).click();
    await expect(page.locator('#result .verdict')).toHaveText('Completed', { timeout: 15_000 });
    await expect(page.locator('#result .order-number')).toHaveText('12345678');
    // Its screenshots, and no Evidence (.zip) or Open report (user's request 2026-10-25).
    await expect(page.locator('#result .wa-thumb')).not.toHaveCount(0);
    for (const name of ['Evidence (.zip)', 'Open report', 'Report', 'error-report.txt']) await expect(page.locator('#result').getByRole('button', { name, exact: true })).toHaveCount(0);

    // The shared history: her run and Bob's, with Bob's screenshot.
    await page.getByRole('tab', { name: /Logs \/ History/ }).click();
    const rows = page.locator('tr.hrow');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Alice');
    await expect(rows.nth(1)).toContainText('Bob');
    await page.locator('#history-who').selectOption('mine');
    await expect(rows).toHaveCount(1);
    await page.locator('#history-who').selectOption('all');
    const thumbnail = rows.nth(1).locator('.p-ev__thumb img');
    await expect.poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);

    // Signing out (in the user menu) ends the session; signing in again brings her remembered accounts back.
    await page.locator('#user-button').click();
    await expect(page.locator('#user-menu')).toContainText('Signed in as Alice');
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
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

  test('the page works under IIS’s path, http://<VM>/automation/ (2026-10-22)', async ({ page }) => {
    // A stand-in for IIS (server/iis/web.config): /automation/… goes to the service without
    // "/automation". Anything else asked for would mean the page left its path.
    const service = new URL(setup.app.url);
    const outside: string[] = [];
    const iis = createServer((req, res) => {
      const url = req.url ?? '/';
      if (!url.startsWith('/automation/')) {
        if (url !== '/favicon.ico') outside.push(url);
        res.writeHead(404).end();
        return;
      }
      const forward = request({ host: service.hostname, port: service.port, method: req.method, path: url.slice('/automation'.length), headers: req.headers }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      forward.on('error', () => res.destroy());
      req.pipe(forward);
    });
    await new Promise<void>((resolve) => iis.listen(0, '127.0.0.1', resolve));
    try {
      await page.goto(`http://127.0.0.1:${(iis.address() as AddressInfo).port}/automation/`);
      await page.locator('#login-username').fill('alice');
      await page.locator('#login-password').fill(PEOPLE.alice.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.locator('#user-button')).toContainText('Alice');
      await page.locator('#testing-username').fill(PEOPLE.alice.testing.username);
      await page.locator('#testing-password').fill(PEOPLE.alice.testing.password);
      await page.locator('#testing-save').click();
      await expect(page.locator('#testing-masked')).toHaveText('al•••@e•••.com');
      await page.getByLabel('One PLU per line').fill('10117');
      await page.locator('#run').click();
      await page.locator('#confirm').getByRole('button', { name: 'Place test order' }).click();
      // Without a backoffice account: Completed at once, the order awaiting approval (2026-10-23).
      await expect(page.locator('#result .verdict')).toHaveText('Completed', { timeout: 15_000 });
      await page.getByRole('tab', { name: /Logs \/ History/ }).click();
      const thumbnail = page.locator('tr.hrow').first().locator('.p-ev__thumb img');
      await expect.poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
      expect(outside).toEqual([]);
    } finally {
      iis.closeAllConnections();
      await new Promise((resolve) => iis.close(resolve));
    }
  });

  test('the walkthrough: once per browser by itself, again from the header; its files only for people signed in (2026-10-31)', async ({ page }) => {
    test.skip(!existsSync(join(WALKTHROUGH_DIR, 'walkthrough.webm')), 'No walkthrough recorded yet (server/scripts/record-walkthrough.cjs).');
    await closeServer(setup);
    setup = await makeServer({ walkthroughDir: WALKTHROUGH_DIR });
    const guide = JSON.parse(readFileSync(join(WALKTHROUGH_DIR, 'walkthrough.json'), 'utf8')) as Walkthrough;
    // The whole workflow since 2026-11-01 (user's request): the order to ORDER_EXTRACTED, then Logs / History.
    expect(guide.steps.map((step) => step.title)).toEqual(['Order and delivery', 'Run and follow it', 'Backoffice approval', 'ORDER_EXTRACTED', 'Logs / History']);
    expect(guide.duration).toBeLessThanOrEqual(30);

    // Its files: for people signed in (it shows the shared history), the video in ranges, nothing else.
    const someone = client(setup.app);
    expect((await someone.call('GET', '/walkthrough/walkthrough.webm')).status).toBe(401);
    await someone.login('alice');
    const part = await someone.call('GET', '/walkthrough/walkthrough.webm', undefined, { Range: 'bytes=0-99' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-type')).toBe('video/webm');
    expect(part.headers.get('content-range')).toBe(`bytes 0-99/${statSync(join(WALKTHROUGH_DIR, 'walkthrough.webm')).size}`);
    expect((await someone.call('GET', '/walkthrough/walkthrough.json')).data).toEqual(guide);
    expect((await someone.call('GET', '/walkthrough/walkthrough.jpg')).headers.get('content-type')).toBe('image/jpeg');
    for (const path of ['/walkthrough/users.json', '/walkthrough/..%2Fserver.cjs', '/walkthrough/%2E%2E%2Fserver.cjs', '/walkthrough/']) {
      expect((await someone.call('GET', path)).status, path).toBe(404);
    }

    // The page: it opens by itself after sign-in and plays, with its captions and steps.
    await page.goto(setup.app.url);
    await page.locator('#login-username').fill('alice');
    await page.locator('#login-password').fill(PEOPLE.alice.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    const tour = page.locator('#tour');
    const time = () => page.locator('#tour-video').evaluate((video: HTMLVideoElement) => video.currentTime);
    await expect(tour).toBeVisible();
    await expect(tour.getByRole('heading')).toHaveText('Welcome to Watsons Automation');
    await expect(tour.locator('.p-tour__step')).toHaveText(guide.steps.map((step, index) => `${index + 1}${step.title}`));
    await expect.poll(time).toBeGreaterThan(0.5);
    await expect(page.locator('#tour-caption')).toHaveText(guide.cues[0].text);
    // A step jumps to its part; Watch again starts over.
    await tour.locator('.p-tour__step').nth(3).click();
    await expect.poll(time).toBeGreaterThanOrEqual(guide.steps[3].start);
    await expect(tour.locator('.p-tour__step[aria-current="step"]')).toContainText(guide.steps[3].title);
    await expect(page.locator('#tour-caption')).toHaveText(guide.cues.find((cue) => cue.step === 3)!.text);
    await tour.getByRole('button', { name: 'Watch again' }).click();
    await expect.poll(time).toBeLessThan(guide.steps[1].start);
    await expect(tour.locator('.p-tour__step[aria-current="step"]')).toContainText(guide.steps[0].title);

    // Start using app: closed, the page usable, and not again by itself in this browser.
    await tour.getByRole('button', { name: 'Start using app' }).click();
    await expect(tour).toBeHidden();
    await page.locator('#testing-username').fill(PEOPLE.alice.testing.username);
    await page.reload();
    await expect(page.locator('#header-tour')).toBeVisible(); // the page has its state
    await expect(tour).toBeHidden();
    // Walkthrough, in the header, opens it again from the start; Escape and × close it.
    await page.locator('#header-tour').click();
    await expect(tour).toBeVisible();
    await expect.poll(time).toBeGreaterThan(0.2);
    await page.keyboard.press('Escape');
    await expect(tour).toBeHidden();
    await page.locator('#header-tour').click();
    await tour.getByRole('button', { name: 'Close' }).click();
    await expect(tour).toBeHidden();
    // Paused by the dialog's close event, which comes just after it closes.
    await expect.poll(() => page.locator('#tour-video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
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
