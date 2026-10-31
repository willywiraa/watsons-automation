import { test, expect, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOrder, parseOrderNumber, type OrderLine } from '../src/config/order';
import { ADD_DELAY_SECONDS } from '../src/config/settings';
import { PICKUP_STORE_STEP } from '../src/flows/shell-station';
import { STAGING_HOST } from '../src/safety/staging-guard';

// Offline checks of the launcher (launcher/launcher.cjs, PRD §32–38). The window tests use a
// made-up project folder whose "Playwright" is tests/helpers/fake-playwright-cli.cjs, so they
// never open the Watsons site.

interface SetupResult {
  checks: { label: string; ok: boolean; help: string; key?: string; optionalFor?: string; optionalLabel?: string }[];
  ready: boolean;
}
interface HistoryRow {
  runId: string;
  automation: string;
  status: string;
  orderNumber: string | null;
  operator: string | null;
  delivery: { label: string; method: string; mode: string | null; store?: string | null } | null;
  products: { requested: OrderLine[]; ordered: OrderLine[]; excluded: string[] };
  decisions: { step: string; plus: string[]; action: string; label: string; plu?: string; choice?: string; outcome?: string; by?: string }[];
  error: { code: string | null; step: string | null; reason: string; screenshots: string[] } | null;
  warning: string | null;
  screenshots: string[];
  errorReport: string | null;
}
interface Launcher {
  STAGING_HOST: string;
  ADD_DELAY_SECONDS: number;
  PICKUP_STORE_STEP: string;
  parseProducts(text: string): { products: OrderLine[]; problems: string[] };
  normalizeOrderNumber(text: string): string | null;
  orderFileText(order: { products: OrderLine[]; deliveryMethod: string; mode: string | null; pickupStore?: string }): string;
  checkSetup(root: string, nodeFound: boolean): SetupResult;
  checkRunRequest(body: unknown, setup: SetupResult): { problems: string[]; order?: unknown };
  readHistory(root: string): HistoryRow[];
  startLauncher(options: { root: string; openWindow?: boolean; quiet?: boolean; openFile?: (target: string) => void }): Promise<{ url: string; close(): Promise<void> }>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const launcher: Launcher = require('../launcher/launcher.cjs');

const SETTING_NAMES = ['WATSONS_STAGING_URL', 'WATSONS_USERNAME', 'WATSONS_PASSWORD', 'WATSONS_BACKOFFICE_USERNAME', 'WATSONS_BACKOFFICE_PASSWORD'];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function makeFakeProject(withEnv = true): string {
  const root = mkdtempSync(join(tmpdir(), 'launcher-test-'));
  mkdirSync(join(root, 'tests'));
  mkdirSync(join(root, 'test-data'));
  mkdirSync(join(root, 'node_modules', '@playwright', 'test'), { recursive: true });
  writeFileSync(join(root, 'playwright.config.ts'), '// fake\n');
  writeFileSync(join(root, 'tests', 'order.e2e.spec.ts'), '// fake\n');
  writeFileSync(join(root, 'test-data', 'order.txt'), 'delivery: Click & Collect\nmode: Express\n\n10117\n10321 2\n');
  copyFileSync(join(__dirname, 'helpers', 'fake-playwright-cli.cjs'), join(root, 'node_modules', '@playwright', 'test', 'cli.js'));
  if (withEnv) {
    writeFileSync(
      join(root, '.env'),
      `WATSONS_STAGING_URL=https://${STAGING_HOST}/\nWATSONS_USERNAME=fake-user\nWATSONS_PASSWORD=fake-value\n` +
        'WATSONS_BACKOFFICE_USERNAME=fake-support\nWATSONS_BACKOFFICE_PASSWORD=fake-value\n',
    );
  }
  return root;
}

/** Runs `check` with the settings removed from this process (playwright.config.ts loads .env). */
async function withoutSettings<T>(check: () => T | Promise<T>): Promise<T> {
  const saved = SETTING_NAMES.map((name) => [name, process.env[name]] as const);
  for (const name of SETTING_NAMES) delete process.env[name];
  try {
    return await check();
  } finally {
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
  }
}

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The HTTP status the launcher answers with. */
function statusOf(url: string, path: string, headers: Record<string, string> = {}, method = 'GET') {
  const { port } = new URL(url);
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

/** A JSON POST to the launcher, as its window sends one: the status and the answer. */
function postJson(url: string, path: string, body: unknown, key: string) {
  const { port } = new URL(url);
  return new Promise<{ status: number; body: { error?: string } }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'X-Launcher-Token': key, 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data || '{}') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test.describe('launcher checks', () => {
  test('uses the same staging address as the safety lock', () => {
    expect(launcher.STAGING_HOST).toBe(STAGING_HOST);
  });

  test('reads product lines like the order file does', () => {
    for (const text of ['10117\n10321 2\n\n# note\n10031,3\n46700 x2', '10117\n10117', 'abc', '10321 0', '10321 1.5', '']) {
      const fromLauncher = launcher.parseProducts(text);
      let fromOrderFile: OrderLine[] | 'error';
      try {
        fromOrderFile = parseOrder(`delivery: Home Delivery\n${text}`).products;
      } catch {
        fromOrderFile = 'error';
      }
      if (fromOrderFile === 'error') expect(fromLauncher.problems.length + (fromLauncher.products.length === 0 ? 1 : 0), text).toBeGreaterThan(0);
      else expect(fromLauncher, text).toEqual({ products: fromOrderFile, problems: [] });
    }
  });

  test('reads order numbers like the approve test does', () => {
    for (const text of ['07091012', 'WTCSG07091012', ' wtcsg 0709 1012 ', '0709101', '070910123', 'WTCSG', 'WTCSG-07091012', 'abc', '']) {
      expect(launcher.normalizeOrderNumber(text) ?? undefined, text).toBe(parseOrderNumber(text));
    }
  });

  test('the page asks for everything relative to its own address (so it also works under IIS’s /automation/)', () => {
    const page = readFileSync(join(__dirname, '..', 'launcher', 'ui.html'), 'utf8');
    expect(page).not.toMatch(/["'`]\/api\//);
  });

  test('waits the same fixed 5 seconds between adds as the order test (user\'s decision 2026-10-21)', () => {
    expect(launcher.ADD_DELAY_SECONDS).toBe(ADD_DELAY_SECONDS);
    expect(ADD_DELAY_SECONDS).toBe(5);
  });

  test('writes order files the test can read', () => {
    const products = [{ plu: '10117', quantity: 1 }, { plu: '10321', quantity: 2 }];
    for (const deliveryMethod of ['home_delivery', 'click_collect']) {
      const order = parseOrder(launcher.orderFileText({ products, deliveryMethod, mode: 'express' }));
      expect(order).toEqual({ deliveryMethod, deliveryMode: 'express', pickupStore: 'auto', products });
    }
    expect(parseOrder(launcher.orderFileText({ products, deliveryMethod: 'home_delivery', mode: 'standard' })).deliveryMode).toBe('standard');
    // Shell Station: no mode, how its pickup store is chosen instead (2026-10-30).
    const shell = launcher.orderFileText({ products, deliveryMethod: 'shell_station', mode: null, pickupStore: 'ask' });
    expect(shell).not.toMatch(/^mode:/m);
    expect(shell).toContain('pickup store: Let me choose');
    expect(parseOrder(shell)).toMatchObject({ deliveryMethod: 'shell_station', pickupStore: 'ask', products });
    expect(parseOrder(launcher.orderFileText({ products, deliveryMethod: 'shell_station', mode: null })).pickupStore).toBe('auto');
    // The window's step is the order test's.
    expect(launcher.PICKUP_STORE_STEP).toBe(PICKUP_STORE_STEP);
  });

  test('names what is missing before a run (PRD §37)', async () => {
    const root = makeFakeProject(false);
    try {
      const setup = await withoutSettings(() => launcher.checkSetup(root, true));
      expect(setup.ready).toBe(false);
      expect(setup.checks.filter((check) => !check.ok).map((check) => check.label)).toEqual([
        'Staging environment configured',
        'Account configured',
        'Backoffice account configured',
      ]);
      writeFileSync(join(root, '.env'), 'WATSONS_STAGING_URL=https://www.watsons.com.sg/\nWATSONS_USERNAME=a\nWATSONS_PASSWORD=b\n');
      const production = await withoutSettings(() => launcher.checkSetup(root, true));
      expect(production.checks.find((check) => check.label === 'Staging environment configured')?.ok).toBe(false);
      const noProject = launcher.checkSetup(join(root, 'nowhere'), false);
      expect(noProject.checks.filter((check) => !check.ok).map((check) => check.label)).toEqual(expect.arrayContaining(['Test project found', 'Node.js installed']));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses bad runs, and any run without confirmation', () => {
    const ready: SetupResult = { checks: [{ label: 'x', ok: true, help: '' }], ready: true };
    const good = { products: '10321 2', deliveryMethod: 'home_delivery', mode: 'express', confirmed: true };
    expect(launcher.checkRunRequest(good, ready)).toEqual({
      problems: [],
      order: { automation: 'order', products: [{ plu: '10321', quantity: 2 }], deliveryMethod: 'home_delivery', mode: 'express', addDelaySeconds: 5 },
    });
    expect(launcher.checkRunRequest({ ...good, products: '' }, ready).problems).toEqual(['Add at least one PLU.']);
    expect(launcher.checkRunRequest({ ...good, deliveryMethod: 'toString' }, ready).problems).toEqual(['Choose a delivery method.']);
    // Standard (user's request 2026-10-13) as well as Express; nothing else.
    expect(launcher.checkRunRequest({ ...good, mode: 'standard' }, ready).order).toMatchObject({ mode: 'standard' });
    expect(launcher.checkRunRequest({ ...good, mode: 'toString' }, ready).problems).toEqual(['Choose the delivery mode.']);
    expect(launcher.checkRunRequest({ ...good, confirmed: undefined }, ready).problems).toEqual(['Placing an order needs your confirmation first.']);
    expect(launcher.checkRunRequest(good, { checks: [{ label: 'Account configured', ok: false, help: 'Fill in .env.' }], ready: false }).order).toBeUndefined();
    expect(launcher.checkRunRequest({ ...good, automation: 'toString' }, ready).order).toBeUndefined();

    // The time between adds is fixed (user's decision 2026-10-21): a value sent along is ignored.
    expect(launcher.checkRunRequest({ ...good, addDelaySeconds: '20' }, ready).order).toMatchObject({ addDelaySeconds: 5 });
    expect(launcher.checkRunRequest({ ...good, addDelaySeconds: 'ten' }, ready).problems).toEqual([]);

    // Shell Station has no mode, only a pickup store, which the run chooses unless told (2026-10-30).
    const shell = { ...good, deliveryMethod: 'shell_station', mode: undefined };
    expect(launcher.checkRunRequest(shell, ready)).toEqual({
      problems: [],
      order: { automation: 'order', products: [{ plu: '10321', quantity: 2 }], deliveryMethod: 'shell_station', mode: null, pickupStore: 'auto', addDelaySeconds: 5 },
    });
    expect(launcher.checkRunRequest({ ...shell, mode: 'standard', pickupStore: 'ask' }, ready).order).toMatchObject({ mode: null, pickupStore: 'ask' });
    expect(launcher.checkRunRequest({ ...shell, pickupStore: 'toString' }, ready).problems).toEqual(['Choose how the pickup store is chosen.']);
    expect(launcher.checkRunRequest({ ...good, pickupStore: 'ask' }, ready).order).not.toHaveProperty('pickupStore');
  });

  test('approves an existing order only with a valid number and confirmation', () => {
    const ready: SetupResult = { checks: [{ label: 'x', ok: true, help: '' }], ready: true };
    const approve = { automation: 'approve', orderNumber: 'WTCSG07091012', confirmed: true };
    // Only the order number goes along: never products, so the approval can't place an order.
    expect(launcher.checkRunRequest({ ...approve, products: '10117' }, ready)).toEqual({ problems: [], order: { automation: 'approve', orderNumber: '07091012' } });
    expect(launcher.checkRunRequest({ ...approve, orderNumber: ' ' }, ready).problems).toEqual(['Enter the number of the order to approve.']);
    expect(launcher.checkRunRequest({ ...approve, orderNumber: '0709101' }, ready).problems).toEqual([
      'The order number has 8 digits, optionally with WTCSG in front (e.g. 07091012 or WTCSG07091012).',
    ]);
    expect(launcher.checkRunRequest({ ...approve, confirmed: undefined }, ready).problems).toEqual(['Approving an order needs your confirmation first.']);
    expect(launcher.checkRunRequest(approve, { checks: [{ label: 'Backoffice account configured', ok: false, help: 'Fill in .env.' }], ready: false }).order).toBeUndefined();
  });

  test('a new order can do without the backoffice account; approving cannot (2026-10-14)', async () => {
    const root = makeFakeProject(false);
    try {
      const env = `WATSONS_STAGING_URL=https://${STAGING_HOST}/\nWATSONS_USERNAME=a\nWATSONS_PASSWORD=b\n`;
      writeFileSync(join(root, '.env'), env);
      const setup = await withoutSettings(() => launcher.checkSetup(root, true));
      expect(setup.ready).toBe(true);
      expect(setup.checks.find((check) => check.key === 'backoffice')).toMatchObject({ ok: false, optionalFor: 'order' });
      const order = { products: '10321', deliveryMethod: 'home_delivery', mode: 'express', confirmed: true };
      expect(launcher.checkRunRequest(order, setup).problems).toEqual([]);
      const approve = { automation: 'approve', orderNumber: '07091012', confirmed: true };
      expect(launcher.checkRunRequest(approve, setup).problems).toEqual([
        'Backoffice account configured: no. Fill in WATSONS_BACKOFFICE_USERNAME and WATSONS_BACKOFFICE_PASSWORD in .env (needed to approve orders).',
      ]);
      // Half filled in is a mistake for both.
      writeFileSync(join(root, '.env'), `${env}WATSONS_BACKOFFICE_USERNAME=c\n`);
      const half = await withoutSettings(() => launcher.checkSetup(root, true));
      expect(half.ready).toBe(false);
      expect(launcher.checkRunRequest(order, half).problems).toEqual([
        'Backoffice account configured: no. Fill in both WATSONS_BACKOFFICE_USERNAME and WATSONS_BACKOFFICE_PASSWORD in .env, or neither (new orders then wait for approval).',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a run stays passed when something failed only after its PASS line', () => {
    // E.g. the browser was closed while the test kept its last page open (seen 2026-10-14).
    const root = makeFakeProject();
    try {
      const write = (runId: string, passed: string | null) => {
        const dir = join(root, 'reports', runId);
        mkdirSync(dir, { recursive: true });
        const startedAt = `${runId.slice(0, 10)}T${runId.slice(11).replace(/-/g, ':')}.000Z`;
        writeFileSync(join(dir, 'launcher-run.json'), JSON.stringify({ runId, automation: 'order', operator: 'Felix', state: 'finished', startedAt, orderNumber: '07110006', passed, cancelled: false }));
        const error = { step: 'Order confirmation', message: 'browserContext.close: Test ended.' };
        writeFileSync(join(dir, 'result.json'), JSON.stringify({ status: 'failed', outcome: 'failed', automation: 'order', orderNumber: '07110006', error }));
      };
      write('2026-10-14_16-16-54', 'order_placed_unapproved');
      write('2026-10-14_16-20-00', null);
      const rows = launcher.readHistory(root);
      expect(rows.find((row) => row.runId === '2026-10-14_16-16-54')).toMatchObject({ status: 'awaiting_approval', outcome: 'order_placed_unapproved', error: null, errorReport: null });
      expect(rows.find((row) => row.runId === '2026-10-14_16-20-00')).toMatchObject({ status: 'failed', error: { step: 'Order confirmation' } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Logs / History also shows runs from before it existed', () => {
    const root = makeFakeProject();
    try {
      const reports = join(root, 'reports');
      // From the first launcher version: result.json, but no launcher record.
      const passed = join(reports, '2026-10-07_08-41-12');
      mkdirSync(passed, { recursive: true });
      writeFileSync(
        join(passed, 'result.json'),
        JSON.stringify({
          status: 'passed',
          outcome: 'order_placed',
          orderNumber: '07095000',
          startedAt: new Date(2026, 9, 7, 8, 41, 12).toISOString(),
          durationMs: 545_378,
          delivery: { method: 'home_delivery', mode: 'express' },
          products: { ordered: [{ plu: '43640', quantity: 1 }], soldOut: [], excludedNotEligible: [], freeGiftRemoved: null },
          backoffice: { approved: true, statuses: ['ORDER_EXTRACTED'], finalStatus: 'ORDER_EXTRACTED' },
        }),
      );
      writeFileSync(join(passed, 'screenshot-3-backoffice-order.png'), PNG);
      writeFileSync(join(passed, 'screenshot-1-checkout-summary.png'), PNG);
      // A failed one: its failure screenshot has no name of its own.
      const failed = join(reports, '2026-10-07_08-50-00');
      mkdirSync(failed);
      writeFileSync(
        join(failed, 'result.json'),
        JSON.stringify({ status: 'failed', outcome: 'failed', completedStep: 'Login', error: { code: 'PRODUCT_NOT_FOUND', step: 'Product Search', message: '❌ PRODUCT_NOT_FOUND\n\nStep: Product Search\nReason: No product found for PLU 1.' }, products: { ordered: [], soldOut: [], excludedNotEligible: [], freeGiftRemoved: null } }),
      );
      writeFileSync(join(failed, 'order.txt'), 'delivery: Home Delivery\nmode: Express\n\n1\n');
      writeFileSync(join(failed, 'screenshot-1.png'), PNG);
      // Stopped: only the order file and the log.
      const stopped = join(reports, '2026-10-07_09-00-00');
      mkdirSync(stopped);
      writeFileSync(join(stopped, 'order.txt'), 'delivery: Click & Collect\nmode: Express\n\n10117\n10321 2\n');
      writeFileSync(join(stopped, 'launcher-log.txt'), '[launcher] Run 2026-10-07_09-00-00: places a STAGING test order\n[launcher] Test cancelled by user.\n');
      // Not runs.
      mkdirSync(join(reports, 'something-else'));
      mkdirSync(join(reports, '2026-10-07_10-00-00')); // empty

      const rows = launcher.readHistory(root);
      expect(rows.map((row) => [row.runId, row.status])).toEqual([
        ['2026-10-07_09-00-00', 'stopped'],
        ['2026-10-07_08-50-00', 'failed'],
        ['2026-10-07_08-41-12', 'completed'],
      ]);
      expect(rows[0]).toMatchObject({ automation: 'order', operator: null, delivery: { label: 'Express · Click & Collect' }, error: null });
      expect(rows[0].products.requested).toEqual([{ plu: '10117', quantity: 1 }, { plu: '10321', quantity: 2 }]);
      expect(rows[1].error).toMatchObject({ code: 'PRODUCT_NOT_FOUND', step: 'Product Search', reason: 'No product found for PLU 1.', screenshots: ['screenshot-1.png'] });
      expect(rows[1].errorReport).toContain('Step:        Product Search');
      expect(rows[1].errorReport).toContain('Screenshot:  reports\\2026-10-07_08-50-00\\screenshot-1.png');
      expect(rows[2]).toMatchObject({ orderNumber: '07095000', delivery: { label: 'Express · Home Delivery' } });
      expect(rows[2].screenshots).toEqual(['screenshot-1-checkout-summary.png', 'screenshot-3-backoffice-order.png']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test.describe('launcher window', () => {
  let root: string;
  let app: { url: string; close(): Promise<void> };
  let opened: string[];
  const savedOperator = process.env.WATSONS_OPERATOR;
  // The desktop's tests read the backoffice account from .env; the stand-in reads it from here.
  const savedBackoffice = [process.env.WATSONS_BACKOFFICE_USERNAME, process.env.WATSONS_BACKOFFICE_PASSWORD];
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  test.beforeEach(async () => {
    process.env.WATSONS_OPERATOR = 'Test Operator';
    process.env.WATSONS_BACKOFFICE_USERNAME = 'fake-backoffice';
    process.env.WATSONS_BACKOFFICE_PASSWORD = 'fake-value';
    root = makeFakeProject();
    opened = [];
    // Files and folders the window asks to open are only noted here (no Explorer during tests).
    app = await launcher.startLauncher({ root, openWindow: false, quiet: true, openFile: (target) => opened.push(target) });
  });
  test.afterEach(async () => {
    await app.close();
    // Windows keeps the folder locked for a moment while stopped processes end.
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    restore('WATSONS_OPERATOR', savedOperator);
    restore('WATSONS_BACKOFFICE_USERNAME', savedBackoffice[0]);
    restore('WATSONS_BACKOFFICE_PASSWORD', savedBackoffice[1]);
  });

  /** Waits until the run just started has ended (Logs / History counts it from its start). */
  async function runEnded(page: Page, runsBefore: number) {
    await expect(page.locator('#history-summary')).toHaveText(new RegExp(`^${runsBefore + 1} runs? · `));
    await expect(page.locator('#result')).toBeVisible({ timeout: 15_000 });
  }

  async function placeOrder(page: Page, products: string, runsBefore: number) {
    // A click on the workflow (even the one chosen) goes back from a result to the form.
    await page.getByLabel('Place new order').click();
    await page.getByLabel('One PLU per line').fill(products);
    await expect(page.locator('#run')).toBeEnabled();
    await page.locator('#run').click();
    await page.locator('#confirm').getByRole('button', { name: 'Place test order' }).click();
    await runEnded(page, runsBefore);
  }

  async function approveOrder(page: Page, orderNumber: string, runsBefore: number) {
    await page.getByLabel('Approve existing order').click();
    await page.getByLabel('Order number').fill(orderNumber);
    await page.locator('#run').click();
    await page.locator('#confirm').getByRole('button', { name: 'Approve order' }).click();
    await runEnded(page, runsBefore);
  }

  test('only answers with its key, on its own address', async () => {
    const key = new URL(app.url).searchParams.get('token')!;
    const page = new URL(app.url).pathname + new URL(app.url).search;
    const { port } = new URL(app.url);
    expect(await statusOf(app.url, '/')).toBe(403);
    expect(await statusOf(app.url, page, { Host: `localhost:${port}` })).toBe(403);
    expect(await statusOf(app.url, page)).toBe(200);
    expect(await statusOf(app.url, '/api/run', { 'X-Launcher-Token': key, 'Content-Type': 'text/plain' }, 'POST')).toBe(415);
    expect(await statusOf(app.url, '/api/run', { 'X-Launcher-Token': key, 'Content-Type': 'application/json' }, 'POST')).toBe(400);
  });

  test('serves the screenshots of run folders, and nothing else', async () => {
    const key = new URL(app.url).searchParams.get('token')!;
    const runId = '2026-10-07_10-00-00';
    mkdirSync(join(root, 'reports', runId), { recursive: true });
    writeFileSync(join(root, 'reports', runId, 'screenshot-1-failure.png'), PNG);
    writeFileSync(join(root, 'reports', runId, 'result.json'), '{}');
    writeFileSync(join(root, 'secret.png'), PNG);
    const shot = (query: string) => statusOf(app.url, `/api/screenshot?${query}`);
    expect(await shot(`token=${key}&run=${runId}&name=screenshot-1-failure.png`)).toBe(200);
    expect(await shot(`run=${runId}&name=screenshot-1-failure.png`)).toBe(403);
    expect(await shot(`token=${key}&run=${runId}&name=result.json`)).toBe(404);
    expect(await shot(`token=${key}&run=${runId}&name=..%5C..%5C..%5Csecret.png`)).toBe(404);
    expect(await shot(`token=${key}&run=..&name=secret.png`)).toBe(404);
    expect(await shot(`token=${key}&run=${runId}&name=screenshot-9.png`)).toBe(404);
  });

  test('checks the input, asks first, and places the order', async ({ page }) => {
    await page.goto(app.url);
    await expect(page.getByLabel('One PLU per line')).toHaveValue('10117\n10321 2');
    await expect(page.getByLabel('Click & Collect')).toBeChecked();
    await expect(page.getByLabel('Place new order')).toBeChecked();
    await expect(page.locator('#preview [data-plu]')).toHaveCount(2);
    // No OTP or options to fill in (user's decision 2026-10-05), and no time between adds (fixed at 5 s, 2026-10-21).
    await expect(page.getByRole('textbox')).toHaveCount(1);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('spinbutton')).toHaveCount(0);
    await expect(page.getByText('Seconds between adds')).toHaveCount(0);
    // Express is the default; Standard can be chosen too (user's request 2026-10-13).
    await expect(page.locator('input[name=mode][value=express]')).toBeChecked();
    await expect(page.locator('input[name=mode][value=standard]')).toBeEnabled();
    await expect(page.locator('#modes')).not.toContainText('Coming later');
    await expect(page.locator('#operator')).toHaveText('Test Operator');
    // The walkthrough is the hosted app's only (user's decision 2026-10-31).
    await expect(page.locator('#tour')).toBeHidden();
    await expect(page.locator('#header-tour')).toBeHidden();
    const run = page.locator('#run');
    await expect(run).toHaveText('Place test order');
    await expect(run).toBeEnabled();

    await page.getByRole('button', { name: 'Show checks' }).click();
    await page.getByLabel('One PLU per line').fill('10117\nabc');
    await expect(page.locator('#problems')).toContainText('"abc" is not a PLU');
    await expect(page.locator('.check-bad', { hasText: 'All PLUs valid format' })).toBeVisible();
    await expect(page.locator('.check-ok', { hasText: 'All quantities > 0' })).toBeVisible();
    await expect(run).toBeDisabled();
    await page.getByLabel('One PLU per line').fill('10117\n10321 0');
    await expect(page.locator('.check-bad', { hasText: 'All quantities > 0' })).toBeVisible();
    await expect(page.locator('.check-ok', { hasText: 'All PLUs valid format' })).toBeVisible();
    await page.getByLabel('One PLU per line').fill('10117\n10321 2');
    await page.getByLabel('Home Delivery').check();
    await expect(run).toBeEnabled();

    await run.click();
    const dialog = page.locator('#confirm');
    await expect(dialog).toContainText('Place a staging test order?');
    await expect(dialog).toContainText('Watsons STAGING');
    await expect(dialog).toContainText('Delivery methodHome Delivery');
    await expect(dialog).toContainText('Delivery modeExpress');
    await expect(dialog).toContainText('2 products, 3 items');
    await expect(dialog).not.toContainText('Between adds');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#progress')).toBeHidden(); // nothing ran

    await run.click();
    await dialog.getByRole('button', { name: 'Place test order' }).click();
    // Done: the run ends by itself once the order is extracted (2026-10-23: no Close browser).
    await expect(page.locator('#result .order-number')).toHaveText('12345678');
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    // The browser runs hidden: Live browser shows it, no separate Edge window (user's request 2026-10-22).
    await expect(page.locator('#log')).toContainText('order.e2e place=yes');
    await expect(page.locator('#log')).not.toContainText('--headed');
    await expect(page.locator('#steps li.done')).toHaveCount(14);
    await expect(page.locator('#result')).toContainText('Placed and approved in the backoffice. The order is now ORDER_EXTRACTED.');
  });

  test('reports the products the delivery mode left out', async ({ page }) => {
    await page.goto(app.url);
    await placeOrder(page, '10117\n46465', 0);
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#result')).toContainText('46465×1Left out: not available for Express');
    await expect(page.locator('#result')).toContainText('1 of 2 ordered');
  });

  test('places an order without a backoffice account: it ends at the confirmation and waits for approval', async ({ page }) => {
    // No backoffice account in .env, nor for the stand-in (user's decision 2026-10-14).
    writeFileSync(join(root, '.env'), `WATSONS_STAGING_URL=https://${STAGING_HOST}/\nWATSONS_USERNAME=fake-user\nWATSONS_PASSWORD=fake-value\n`);
    delete process.env.WATSONS_BACKOFFICE_USERNAME;
    delete process.env.WATSONS_BACKOFFICE_PASSWORD;
    await page.goto(app.url);
    await page.getByRole('button', { name: 'Show checks' }).click();
    await expect(page.locator('.check-optional', { hasText: 'No backoffice account in .env: the order will wait for approval' })).toBeVisible();
    await expect(page.locator('#run-note')).toContainText('stops at "Thank you for your order"');
    await page.getByLabel('One PLU per line').fill('10117');
    await page.locator('#run').click();
    await expect(page.locator('#confirm')).toContainText('None: the order waits for approval');
    await page.locator('#confirm').getByRole('button', { name: 'Place test order' }).click();
    // It ends at "Thank you for your order" at once, Completed, and says the order awaits approval (2026-10-23).
    await runEnded(page, 0);
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#result .order-number')).toHaveText('12345678');
    await expect(page.locator('#result .p-note')).toHaveText('Awaiting approval: someone with a backoffice account must approve order 12345678 (Logs / History → Approve). Until then it is not extracted.');
    await expect(page.locator('#steps li.skipped')).toHaveCount(4); // the approval steps

    // Approving needs the backoffice account.
    await page.getByLabel('Approve existing order').click();
    await page.getByLabel('Order number').fill('12345678');
    await expect(page.locator('.check-bad', { hasText: 'Backoffice account configured' })).toBeVisible();
    await expect(page.locator('#run')).toBeDisabled();

    // With one, Logs / History's Approve fills in the approval; the order then counts as approved.
    writeFileSync(join(root, '.env'), `WATSONS_STAGING_URL=https://${STAGING_HOST}/\nWATSONS_USERNAME=fake-user\nWATSONS_PASSWORD=fake-value\nWATSONS_BACKOFFICE_USERNAME=fake-support\nWATSONS_BACKOFFICE_PASSWORD=fake-value\n`);
    process.env.WATSONS_BACKOFFICE_USERNAME = 'fake-backoffice';
    process.env.WATSONS_BACKOFFICE_PASSWORD = 'fake-value';
    await page.reload();
    await page.getByRole('tab', { name: /Logs \/ History/ }).click();
    const rows = page.locator('tr.hrow');
    await expect(rows.first()).toContainText('Awaiting approval');
    await expect(rows.first()).toContainText('Needs approval');
    await rows.first().click();
    await rows.first().getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.locator('#order-number')).toHaveValue('12345678');
    await page.locator('#run').click();
    await page.locator('#confirm').getByRole('button', { name: 'Approve order' }).click();
    await runEnded(page, 1);
    await page.getByRole('tab', { name: /Logs \/ History/ }).click();
    await expect(rows.nth(1)).toContainText('Place new order');
    await expect(rows.nth(1)).toContainText('Completed');
    // Its details are still open from before.
    await expect(page.locator('tr.hdetail')).toContainText('Approved later by Test Operator');
  });

  test('places a Standard order: the test gets Standard, and its progress and result say so', async ({ page }) => {
    await page.goto(app.url);
    await page.locator('input[name=mode][value=standard]').check();
    await page.getByLabel('One PLU per line').fill('10117\n46465');
    await page.locator('#run').click();
    await expect(page.locator('#confirm')).toContainText('Delivery methodClick & Collect');
    await expect(page.locator('#confirm')).toContainText('Delivery modeStandard');
    await page.locator('#confirm').getByRole('button', { name: 'Place test order' }).click();
    await runEnded(page, 0);
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#steps')).toContainText('Standard Delivery Selection');
    await expect(page.locator('#result')).toContainText('46465×1Left out: not available for Standard');
    // The order file the test read, in the run's evidence.
    const [runId] = readdirSync(join(root, 'reports')).filter((name) => /^\d{4}-\d{2}-\d{2}_/.test(name));
    expect(readFileSync(join(root, 'reports', runId, 'order.txt'), 'utf8')).toContain('mode: Standard');
    // The time between adds is fixed at 5 seconds (2026-10-21); the run's record says so.
    expect(JSON.parse(readFileSync(join(root, 'reports', runId, 'launcher-run.json'), 'utf8'))).toMatchObject({ addDelaySeconds: 5 });
    await expect(page.locator('#log')).toContainText('by Test Operator: places a STAGING test order');
  });

  test('Shell Station: no Mode, how its pickup store is chosen instead; the result names the store (2026-10-30)', async ({ page }) => {
    await page.goto(app.url);
    await expect(page.locator('#mode-field')).toBeVisible();
    await expect(page.locator('#pickup-field')).toBeHidden();
    await page.getByLabel('Shell Station').check();
    await expect(page.locator('#mode-field')).toBeHidden();
    await expect(page.locator('#pickup-field')).toBeVisible();
    await expect(page.locator('#pickup-stores label')).toHaveText(['Choose for me', 'Let me choose']);
    await expect(page.getByLabel('Choose for me')).toBeChecked();
    await expect(page.locator('#pickup-note')).toHaveText('Keeps the store already chosen at checkout; if none, the first Shell station that has all the products.');
    await page.getByLabel('Let me choose').check();
    await expect(page.locator('#pickup-note')).toHaveText('The run shows staging’s Shell stations and waits for you to pick one.');
    await page.getByLabel('Choose for me').check();
    // Back to Home Delivery: Mode again.
    await page.getByLabel('Home Delivery').check();
    await expect(page.locator('#mode-field')).toBeVisible();
    await expect(page.locator('#pickup-field')).toBeHidden();
    await page.getByLabel('Shell Station').check();

    await page.getByLabel('One PLU per line').fill('10117\n46465');
    await page.locator('#run').click();
    const dialog = page.locator('#confirm');
    await expect(dialog).toContainText('Delivery methodShell Station');
    await expect(dialog).toContainText('Pickup storeChoose for me');
    await expect(dialog).not.toContainText('Delivery mode');
    await dialog.getByRole('button', { name: 'Place test order' }).click();
    await expect(page.locator('#run-details')).toHaveText('· 2 products · Shell Station');
    await runEnded(page, 0);
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#steps')).toContainText(PICKUP_STORE_STEP);
    await expect(page.locator('#steps')).not.toContainText('Delivery Selection');
    await expect(page.locator('#result')).toContainText('46465×1Left out: not available at the pickup store');
    // The order file the test read: the pickup store choice, no mode.
    const [runId] = readdirSync(join(root, 'reports')).filter((name) => /^\d{4}-\d{2}-\d{2}_/.test(name));
    const orderFile = readFileSync(join(root, 'reports', runId, 'order.txt'), 'utf8');
    expect(orderFile).toContain('delivery: Shell Station\npickup store: Choose for me\n');
    expect(orderFile).not.toMatch(/^mode:/m);
    const [row] = launcher.readHistory(root);
    expect(row.delivery).toEqual({ method: 'shell_station', mode: null, store: 'SHELL BUKIT BATOK ROAD', label: 'Shell Station · SHELL BUKIT BATOK ROAD' });
    expect(row.products.excluded).toEqual(['46465']);
    // Logs / History: Shell Station over its store, no mode.
    await page.getByRole('tab', { name: /Logs \/ History/ }).click();
    const first = page.locator('tr.hrow').first();
    await expect(first).toContainText('Shell StationSHELL BUKIT BATOK ROAD');
    await expect(first).not.toContainText('Express');
    await first.click();
    await expect(page.locator('tr.hdetail')).toContainText('DeliveryShell Station · SHELL BUKIT BATOK ROAD');
    // The next window starts with Shell Station and the same choice.
    await page.reload();
    await expect(page.getByLabel('Shell Station')).toBeChecked();
    await expect(page.getByLabel('Choose for me')).toBeChecked();
    await expect(page.locator('#mode-field')).toBeHidden();
  });

  test('shows the run’s browser live, passes clicks on, and the run ends by itself once done (2026-10-23)', async ({ page }) => {
    // PLU 555: the stand-in opens a real (headless) Edge with the run's DevTools port; its last step
    // lasts until the page is clicked.
    process.env.FAKE_PLAYWRIGHT_MODULE = require.resolve('@playwright/test');
    try {
      await page.goto(app.url);
      await expect(page.locator('#live-idle')).toContainText('No browser open');
      await expect(page.locator('#live-idle')).toContainText('Your run’s browser on this PC');
      await page.getByLabel('One PLU per line').fill('555');
      await page.locator('#run').click();
      await page.locator('#confirm').getByRole('button', { name: 'Place test order' }).click();
      const screen = page.locator('#live-img');
      await expect(screen).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('#live-tabs')).toContainText('Thank you for your order');
      // No Close browser any more: nothing to click to end a run.
      await expect(page.getByRole('button', { name: 'Close browser' })).toHaveCount(0);
      const box = (await screen.boundingBox())!;
      await screen.click({ position: { x: box.width * (100 / 800), y: box.height * (50 / 450) } });
      await expect(page.locator('#log')).toContainText('fake page: clicked');
      await expect(page.locator('#result .verdict')).toHaveText('Completed', { timeout: 15_000 });
      await expect(page.locator('#live-card')).toBeHidden();
    } finally {
      delete process.env.FAKE_PLAYWRIGHT_MODULE;
    }
  });

  test('shows the failed step, code and reason, with the error report and screenshot', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(app.url);
    await page.getByLabel('One PLU per line').fill('404');
    await page.locator('#run').click();
    await page.locator('#confirm').getByRole('button', { name: 'Place test order' }).click();
    const result = page.locator('#result');
    await expect(result.locator('.verdict')).toHaveText('Failed at Product Search');
    await expect(result).toContainText('Product Search');
    await expect(result).toContainText('PRODUCT_NOT_FOUND');
    await expect(result).toContainText('No product found for PLU 404.');
    await expect(page.locator('#steps li.failed .wa-step__name')).toHaveText('Product Search');

    // Telemetry (user's request 2026-10-07): when, where, and the screenshot taken then, under the failed step.
    const error = page.locator('#steps li.failed .wa-failure');
    await expect(error).toContainText('https://staging.example.test/search');
    await expect(error).toContainText(/PRODUCT_NOT_FOUND · \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/);
    const image = error.locator('.wa-thumb img');
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
    await error.locator('.wa-thumb').click();
    await expect(page.locator('#viewer')).toBeVisible();
    await expect(page.locator('#viewer-title')).toHaveText('screenshot-1-failure.png');
    await page.locator('#viewer-close').click();

    // The error report: in the evidence folder, and on the clipboard for the team.
    const [runId] = readdirSync(join(root, 'reports')).filter((name) => /^\d{4}-\d{2}-\d{2}_/.test(name));
    const runFolder = join('reports', runId);
    const report = readFileSync(join(root, runFolder, 'error-report.txt'), 'utf8');
    expect(report).toContain('Status:      FAILED');
    expect(report).toContain('Step:        Product Search');
    expect(report).toContain('Code:        PRODUCT_NOT_FOUND');
    expect(report).toContain('Message:     No product found for PLU 404.');
    expect(report).toContain('Page:        https://staging.example.test/search');
    expect(report).toContain(`Screenshot:  ${join(runFolder, 'screenshot-1-failure.png')}`);
    expect(report).toContain('Operator:    Test Operator');
    await result.getByRole('button', { name: 'Copy error report' }).click();
    await expect(page.locator('#toast')).toContainText('Error report copied');
    // (Windows keeps text with \r\n line ends, the file and the clipboard alike.)
    const lines = (text: string) => text.split(/\r?\n/);
    expect(lines(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(lines(report));
  });

  test('Stop ends the test and everything it started (PRD §34)', async ({ page }) => {
    await page.goto(app.url);
    await page.getByLabel('One PLU per line').fill('99');
    await page.locator('#run').click();
    await page.locator('#confirm').getByRole('button', { name: 'Place test order' }).click();
    await expect(page.locator('#steps li.current .wa-step__name')).toHaveText('Pay');
    // (The fake runner logs its browser's process id just after the step.)
    await expect(page.locator('#log')).toContainText(/fake browser pid=\d+/);
    const pid = Number((await page.locator('#log').textContent())?.match(/fake browser pid=(\d+)/)?.[1]);
    expect(isRunning(pid)).toBe(true);

    // Past Checkout, Stop asks first.
    await page.locator('#stop').click();
    await expect(page.locator('#stop-confirm')).toContainText('Stop during Pay?');
    await page.locator('#stop-confirm').getByRole('button', { name: 'Stop run' }).click();
    await expect(page.locator('#result .verdict')).toHaveText('Stopped at Pay');
    await expect(page.locator('#result')).toContainText('Stopped during Pay.');
    await expect(page.locator('#result')).toContainText('Check My Account → Order History');
    await expect.poll(() => isRunning(pid)).toBe(false);
  });

  // ---- Questions during a run (user's request 2026-10-22; the fake runner asks them) ----

  async function startOrder(page: Page, products: string) {
    await page.goto(app.url);
    await page.getByLabel('One PLU per line').fill(products);
    await page.locator('#run').click();
    await page.locator('#confirm').getByRole('button', { name: 'Place test order' }).click();
  }
  /** The run's folder (the only one in reports/). */
  const runFolder = () => join(root, 'reports', readdirSync(join(root, 'reports')).filter((name) => /^\d{4}-\d{2}-\d{2}_/.test(name))[0]);

  test('pauses on a product out of stock; skipping it goes on without it, and the decision is kept (2026-10-22)', async ({ page }) => {
    await startOrder(page, '10117\n3333');
    const ask = page.locator('#ask');
    await expect(ask).toContainText('Product 3333 is out of stock. What would you like to do?');
    await expect(ask).toContainText('Paused at Product Search · Out of stock');
    await expect(ask.getByRole('button')).toHaveText(['Skip product and continue', 'Replace with another PLU', 'Stop automation']);
    await expect(page.locator('#status')).toHaveText('Paused at Product Search: waiting for your decision below.');
    await expect(page).toHaveTitle(/^Decision needed · /);
    await expect(page.locator('#steps li.current .wa-step__name')).toHaveText('Product Search');
    await ask.getByRole('button', { name: 'Skip product and continue' }).click();
    await expect(ask).toBeHidden();
    await runEnded(page, 0);
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#result')).toContainText('3333×1Skipped: sold out');
    await expect(page.locator('#result')).toContainText('1 of 2 ordered');
    await expect(page.locator('#result')).toContainText('Product 3333 is out of stock. What would you like to do?→ Skip product and continue: PLU 3333 left out of the order');
    // The log: the question, who chose what, and what came of it.
    const log = readFileSync(join(runFolder(), 'launcher-log.txt'), 'utf8');
    expect(log).toContain('[ASK] Product 3333 is out of stock. What would you like to do?');
    expect(log).toContain('[launcher] Test Operator chose: Skip product and continue');
    expect(log).toContain('Outcome: PLU 3333 left out of the order');
    // Logs / History: the decision, with who made it.
    const [row] = launcher.readHistory(root);
    expect(row.decisions).toMatchObject([{ step: 'Product Search', plus: ['3333'], action: 'skip', label: 'Skip product and continue', outcome: 'PLU 3333 left out of the order', by: 'Test Operator' }]);
    await page.getByRole('tab', { name: /Logs \/ History/ }).click();
    await page.locator('tr.hrow').first().click();
    await expect(page.locator('tr.hdetail')).toContainText('Decisions');
    await expect(page.locator('tr.hdetail')).toContainText('→ Skip product and continue: PLU 3333 left out of the order');
    await expect(page.locator('tr.hdetail')).toContainText('3333 ×1 Skipped: sold out');
  });

  test('a product can be replaced by another PLU; only the choices offered are taken (2026-10-22)', async ({ page }) => {
    await startOrder(page, '3333 2');
    const ask = page.locator('#ask');
    // Its only product: nothing to skip it for.
    await expect(ask.getByRole('button')).toHaveText(['Replace with another PLU', 'Stop automation']);
    const { id } = JSON.parse(readFileSync(join(runFolder(), 'ask.json'), 'utf8'));
    const key = new URL(app.url).searchParams.get('token')!;
    const answer = (body: object) => postJson(app.url, '/api/answer', body, key);
    expect(await answer({ id: id + 1, action: 'replace', plu: '45606' })).toMatchObject({ status: 409, body: { error: 'That question has already been answered.' } });
    expect(await answer({ id, action: 'skip' })).toMatchObject({ status: 409, body: { error: 'That is not one of the choices.' } });
    expect(await answer({ id, action: 'replace', plu: '45x' })).toMatchObject({ status: 409, body: { error: 'Enter the PLU to use instead (digits only).' } });
    expect(await answer({ id, action: 'replace', plu: '3333' })).toMatchObject({ status: 409, body: { error: 'Enter a different PLU.' } });
    expect(existsSync(join(runFolder(), `answer-${id}.json`))).toBe(false);
    await expect(ask).toBeVisible();

    await ask.getByRole('button', { name: 'Replace with another PLU' }).click();
    await ask.getByLabel('PLU to use instead').fill('abc');
    await ask.getByRole('button', { name: 'Use this PLU' }).click();
    await expect(ask).toContainText('Enter the PLU to use instead (digits only).');
    await ask.getByLabel('PLU to use instead').fill('45606');
    await ask.getByRole('button', { name: 'Use this PLU' }).click();
    await runEnded(page, 0);
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#result')).toContainText('3333×2Replaced by PLU 45606');
    await expect(page.locator('#result')).toContainText('45606×2Ordered');
    expect(launcher.readHistory(root)[0].decisions).toMatchObject([{ action: 'replace', plu: '45606', outcome: 'PLU 45606 is available: it replaces PLU 3333' }]);
    // Nothing is waiting now.
    expect(await answer({ id, action: 'replace', plu: '45606' })).toMatchObject({ status: 409, body: { error: 'The run is not waiting for an answer.' } });
  });

  test('"Stop automation" stops the run where it paused (2026-10-22)', async ({ page }) => {
    await startOrder(page, '3333');
    await page.locator('#ask').getByRole('button', { name: 'Stop automation' }).click();
    await expect(page.locator('#result .verdict')).toHaveText('Stopped at Product Search');
    await expect(page.locator('#result')).toContainText('→ Stop automation');
    const [row] = launcher.readHistory(root);
    expect(row.status).toBe('stopped');
    expect(row.decisions).toMatchObject([{ action: 'stop', label: 'Stop automation', plus: ['3333'], by: 'Test Operator' }]);
  });

  test('a product Express can’t take: "Use Standard instead" goes on with Standard, and the steps follow (2026-10-22)', async ({ page }) => {
    await startOrder(page, '10117\n4444');
    const ask = page.locator('#ask');
    await expect(ask).toContainText('Product 4444 is not eligible for Express delivery with Click & Collect.');
    await expect(ask.getByRole('button')).toHaveText(['Remove it and continue', 'Replace with another PLU', 'Use Standard instead', 'Try Home Delivery', 'Try Shell Station', 'Stop automation']);
    await expect(page.locator('#steps li.current .wa-step__name')).toHaveText('Express Delivery Selection');
    await ask.getByRole('button', { name: 'Use Standard instead' }).click();
    await expect(page.locator('#run-details')).toContainText('Standard');
    await runEnded(page, 0);
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#steps')).toContainText('Standard Delivery Selection');
    const [row] = launcher.readHistory(root);
    expect(row.delivery).toMatchObject({ method: 'click_collect', mode: 'standard' });
    expect(row.decisions).toMatchObject([{ action: 'switch_mode', label: 'Use Standard instead', outcome: 'Delivery mode: Standard' }]);
  });

  test('a product the delivery can’t take is removed from the bag, and the run goes on with the others (2026-10-22)', async ({ page }) => {
    await startOrder(page, '10117\n4444');
    await page.locator('#ask').getByRole('button', { name: 'Remove it and continue' }).click();
    await runEnded(page, 0);
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#result')).toContainText('4444×1Removed: delivery not possible');
    await expect(page.locator('#result')).toContainText('1 of 2 ordered');
    // Back to the bag (Cart validation takes it out), then the checkout page again.
    expect(readFileSync(join(runFolder(), 'launcher-log.txt'), 'utf8')).toMatch(/Step: Express Delivery Selection[\s\S]*Remove it and continue[\s\S]*Step: Cart validation[\s\S]*Step: Express Delivery Selection/);
    expect(launcher.readHistory(root)[0].decisions).toMatchObject([{ action: 'skip', plus: ['4444'], outcome: 'PLU 4444 taken out of the order' }]);
  });

  test('a product the delivery can’t take can be replaced by several PLUs (2026-10-22)', async ({ page }) => {
    await startOrder(page, '10117\n4444 2');
    const ask = page.locator('#ask');
    await ask.getByRole('button', { name: 'Replace with another PLU' }).click();
    await expect(ask.getByLabel('PLUs to add (separate several with spaces)')).toBeVisible();
    await ask.getByLabel('PLUs to add (separate several with spaces)').fill('45606 abc');
    await ask.getByRole('button', { name: 'Add these PLUs' }).click();
    await expect(ask).toContainText('Enter the PLUs to add (digits; separate several with spaces).');
    // The launcher checks it too: a list of digits, not the product itself.
    const { id } = JSON.parse(readFileSync(join(runFolder(), 'ask.json'), 'utf8'));
    const key = new URL(app.url).searchParams.get('token')!;
    expect(await postJson(app.url, '/api/answer', { id, action: 'replace', plu: '45606 4444' }, key)).toMatchObject({ status: 409, body: { error: 'Enter a different PLU.' } });
    await ask.getByLabel('PLUs to add (separate several with spaces)').fill('45606, 21679');
    await ask.getByRole('button', { name: 'Add these PLUs' }).click();
    await runEnded(page, 0);
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#result')).toContainText('4444×2Replaced by PLU 45606, 21679');
    await expect(page.locator('#result')).toContainText('45606×2Ordered');
    await expect(page.locator('#result')).toContainText('21679×2Ordered');
    await expect(page.locator('#result')).toContainText('→ Replace with another PLU (PLU 45606, 21679): PLU 4444 removed; PLU 45606, 21679 added instead');
  });

  test('another delivery method can be tried; the run goes back to the bag (2026-10-22)', async ({ page }) => {
    await startOrder(page, '10117\n4444');
    await page.locator('#ask').getByRole('button', { name: 'Try Shell Station' }).click();
    // Shell Station has no mode: the steps follow it (2026-10-30).
    await expect(page.locator('#run-details')).toHaveText('· 2 products · Shell Station');
    await runEnded(page, 0);
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#steps')).toContainText(PICKUP_STORE_STEP);
    const [row] = launcher.readHistory(root);
    expect(row.delivery).toMatchObject({ method: 'shell_station', mode: null, store: 'SHELL BUKIT BATOK ROAD' });
    expect(readFileSync(join(runFolder(), 'launcher-log.txt'), 'utf8')).toMatch(/Step: Express Delivery Selection[\s\S]*Step: Cart validation[\s\S]*Step: Pickup Store Selection/);
  });

  test('Shell Station, "Let me choose": the run lists the stores and goes on with the one picked (2026-10-30)', async ({ page }) => {
    await page.goto(app.url);
    await page.getByLabel('Shell Station').check();
    await page.getByLabel('Let me choose').check();
    await page.getByLabel('One PLU per line').fill('10117');
    await page.locator('#run').click();
    await expect(page.locator('#confirm')).toContainText('Pickup storeLet me choose');
    await page.locator('#confirm').getByRole('button', { name: 'Place test order' }).click();
    const ask = page.locator('#ask');
    await expect(ask).toContainText('Paused at Pickup Store Selection · Choose the pickup store');
    await expect(ask).toContainText('Which Shell Station should the order be picked up from?');
    await expect(ask.locator('.p-choice__label')).toHaveText(['SHELL BUKIT BATOK ROAD', 'SHELL ANG MO KIO', 'SHELL CLEMENTI']);
    await expect(ask.locator('.p-choice').first()).toContainText('11 Bukit Batok West Avenue 3, 659166');
    // Few stores: no search box. Nothing chosen yet: "Use this store" waits for one.
    await expect(page.locator('#ask-filter')).toBeHidden();
    const use = ask.getByRole('button', { name: 'Use this store' });
    await expect(use).toBeDisabled();
    await expect(ask.getByRole('button', { name: 'Stop automation' })).toBeEnabled();
    // Only a store from the list is taken.
    const { id } = JSON.parse(readFileSync(join(runFolder(), 'ask.json'), 'utf8'));
    const key = new URL(app.url).searchParams.get('token')!;
    expect(await postJson(app.url, '/api/answer', { id, action: 'choose', value: 'FUEL999' }, key)).toMatchObject({ status: 409, body: { error: 'Choose one from the list.' } });
    await ask.getByText('SHELL CLEMENTI').click();
    await expect(ask.getByRole('radio', { name: /SHELL CLEMENTI/ })).toBeChecked();
    await use.click();
    await expect(ask).toBeHidden();
    await runEnded(page, 0);
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#result')).toContainText('→ Use this store (SHELL CLEMENTI)');
    const log = readFileSync(join(runFolder(), 'launcher-log.txt'), 'utf8');
    expect(log).toContain('[launcher] Test Operator chose: Use this store (SHELL CLEMENTI)');
    expect(log).toContain('Pickup store chosen: SHELL CLEMENTI (FUEL202)');
    const [row] = launcher.readHistory(root);
    expect(row.delivery).toMatchObject({ method: 'shell_station', store: 'SHELL CLEMENTI', label: 'Shell Station · SHELL CLEMENTI' });
    expect(row.decisions).toMatchObject([{ step: PICKUP_STORE_STEP, action: 'choose', label: 'Use this store', choice: 'SHELL CLEMENTI', by: 'Test Operator' }]);
  });

  test('an add that failed can be tried again (2026-10-22)', async ({ page }) => {
    await startOrder(page, '10117\n5555');
    const ask = page.locator('#ask');
    await expect(ask).toContainText('Something went wrong at Add to bag (PLU 5555). How would you like to proceed?');
    await expect(ask).toContainText('Details: Adding unit 1 of 1 for PLU 5555 did not increase the bag count (still 1).');
    await expect(ask.getByRole('button')).toHaveText(['Retry', 'Skip product 5555', 'Stop automation']);
    await ask.getByRole('button', { name: 'Retry' }).click();
    await runEnded(page, 0);
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#result')).toContainText('→ Retry: PLU 5555 is in the bag');
  });

  test('approves an existing order, and never places one', async ({ page }) => {
    await page.goto(app.url);
    await page.getByLabel('Approve existing order').check();
    for (const section of ['#section-products', '#section-delivery', '#section-timing']) await expect(page.locator(section)).toBeHidden();
    const run = page.locator('#run');
    await expect(run).toHaveText('Approve order');
    await expect(run).toBeDisabled();
    const orderNumber = page.getByLabel('Order number');
    await orderNumber.fill('0709101');
    await page.getByRole('button', { name: 'Show checks' }).click();
    await expect(page.locator('.check-bad', { hasText: 'Order number entered (8 digits)' })).toBeVisible();
    await expect(page.locator('#order-code')).toHaveText('8 digits needed');
    await expect(run).toBeDisabled();
    await orderNumber.fill('wtcsg 0709 1012');
    await expect(page.locator('#order-code')).toHaveText('→ WTCSG07091012');
    await expect(run).toBeEnabled();

    await run.click();
    const dialog = page.locator('#confirm');
    await expect(dialog).toContainText('Approve order WTCSG07091012?');
    await expect(dialog).toContainText('No new order is created.');
    await dialog.getByRole('button', { name: 'Approve order' }).click();
    await expect(page.locator('#status')).toContainText('Order WTCSG07091012 approved and extracted');
    await expect(page.locator('#stop')).toBeHidden();
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#result .order-number')).toHaveText('07091012');
    await expect(page.locator('#result')).toContainText('Approved in the backoffice: Approve Order was clicked once. The order is now ORDER_EXTRACTED.');
    await expect(page.locator('#steps li.done')).toHaveCount(4);
    // Only the approve test runs: no order switch, no order file.
    await expect(page.locator('#log')).toContainText('args=test --project=approve approve.e2e place=undefined');
    await expect(page.locator('#log')).toContainText('approve=07091012');
    await expect(page.locator('#log')).toContainText('approves existing order WTCSG07091012 in the STAGING backoffice (no new order)');
  });

  test('approving an order that is already extracted changes nothing', async ({ page }) => {
    await page.goto(app.url);
    await approveOrder(page, '11111111', 0);
    await expect(page.locator('#result .verdict')).toHaveText('No change');
    await expect(page.locator('#result')).toContainText('WTCSG11111111 was already ORDER_EXTRACTED, so Approve Order was not clicked.');
  });

  test('an approval that reaches Order Split completes, saying extraction is still pending (2026-10-23)', async ({ page }) => {
    await page.goto(app.url);
    // Order 22222222: the stand-in ends at "Order Split", extraction pending.
    await approveOrder(page, '22222222', 0);
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#result')).toContainText('Approved in the backoffice: Approve Order was clicked once. The order is now Order Split.');
    await expect(page.locator('#result .p-note')).toHaveText(
      'Extraction still pending: WTCSG22222222 is at Order Split, not yet ORDER_EXTRACTED. Wait a few minutes, then check it in the backoffice.',
    );
    const [row] = launcher.readHistory(root);
    expect(row).toMatchObject({ status: 'completed', backoffice: { finalStatus: 'Order Split', extractionPending: true } });
    // Logs / History says so too.
    await page.getByRole('tab', { name: /Logs \/ History/ }).click();
    await expect(page.locator('tr.hrow').first()).toContainText('Extraction pending');
    // And another run can start straight away: nothing to close or cancel first.
    await page.getByRole('tab', { name: 'Automation' }).click();
    await placeOrder(page, '10117\n2222', 1);
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#result')).toContainText('Placed and approved in the backoffice. The order is now Order Split.');
    await expect(page.locator('#result .p-note')).toContainText('Extraction still pending: WTCSG12345678 is at Order Split');
  });

  test('Logs / History lists every run with its status, error and evidence', async ({ page }) => {
    await page.goto(app.url);
    await placeOrder(page, '10117\n46465', 0);
    await placeOrder(page, '404', 1);
    await approveOrder(page, '00000404', 2);
    await approveOrder(page, '11111111', 3);

    await page.getByRole('tab', { name: /Logs \/ History/ }).click();
    const rows = page.locator('tr.hrow');
    await expect(rows).toHaveCount(4);
    await expect(page.locator('#history-summary')).toHaveText('4 runs · 1 completed · 2 failed · 1 no change · 4 screenshots');
    await expect(rows.nth(0)).toContainText('Approve existing order');
    await expect(rows.nth(0)).toContainText('11111111');
    await expect(rows.nth(0)).toContainText('No change');
    await expect(rows.nth(1)).toContainText('Failed');
    await expect(rows.nth(1)).toContainText('ORDER_NOT_FOUND_IN_BACKOFFICE');
    await expect(rows.nth(2)).toContainText('Place new order');
    await expect(rows.nth(2)).toContainText('PRODUCT_NOT_FOUND');
    await expect(rows.nth(2)).toContainText('Product Search');
    await expect(rows.nth(3)).toContainText('12345678');
    await expect(rows.nth(3).locator('td').nth(4)).toHaveText('ExpressClick & Collect'); // mode, then method below it
    await expect(rows.nth(3)).toContainText('10117');
    await expect(rows.nth(3)).toContainText('1 left out (not eligible)');
    await expect(rows.nth(3)).toContainText('Completed');
    await expect(rows.nth(3)).toContainText('Test Operator');

    // Logs / History has no "Reports folder" (2026-10-22); each run's evidence is in its details.
    await expect(page.getByRole('button', { name: 'Reports folder' })).toHaveCount(0);

    // Search and filters.
    await page.getByLabel('Search runs').fill('wtcsg00000404');
    await expect(rows).toHaveCount(1);
    await page.getByLabel('Search runs').fill('');
    await page.locator('#history-status').selectOption('failed');
    await expect(rows).toHaveCount(2);
    await page.locator('#history-type').selectOption('order');
    await expect(rows).toHaveCount(1);
    await page.locator('#history-status').selectOption('all');
    await page.locator('#history-type').selectOption('all');

    // A failed run's details: its error, with the screenshot taken then.
    await rows.nth(1).click();
    const details = page.locator('tr.hdetail');
    const happened = details.getByRole('region', { name: 'What happened' });
    await expect(happened).toContainText("WTCSG00000404 is not in the backoffice's Orders list.");
    await expect(happened).toContainText('https://backoffice.example.test/backoffice/');
    await expect(details).toContainText('WTCSG00000404');
    await details.locator('.p-x__shot').first().click();
    await expect(page.locator('#viewer-title')).toHaveText('screenshot-1-failure.png');
    await page.locator('#viewer-open').click();
    await expect.poll(() => opened.at(-1)).toMatch(/screenshot-1-failure\.png$/);
    await page.locator('#viewer-close').click();
    // No Evidence folder, Playwright report or error-report.txt (user's request 2026-10-25): the
    // error report is copied, and the window opens nothing but a screenshot.
    for (const name of ['Evidence folder', 'Playwright report', 'error-report.txt']) await expect(page.getByRole('button', { name })).toHaveCount(0);
    await expect(details.getByRole('button', { name: 'Copy error report' })).toBeVisible();
    const key = new URL(app.url).searchParams.get('token')!;
    const runId = (await details.locator('.p-x__facts dt:has-text("Run") + dd').textContent())!.trim();
    for (const what of ['folder', 'report', 'error-report']) {
      expect(await postJson(app.url, '/api/open', { runId, what }, key)).toMatchObject({ status: 400, body: { error: 'Only screenshots can be opened.' } });
    }

    // Export: the runs shown, as a CSV file for Excel.
    await page.getByRole('button', { name: 'Export CSV' }).click();
    await expect.poll(() => opened.find((file) => file.endsWith('.csv'))).toBeTruthy();
    const csv = readFileSync(opened.find((file) => file.endsWith('.csv'))!, 'utf8');
    expect(csv.trimEnd().split('\r\n')).toHaveLength(5);
    expect(csv).toContain('"WTCSG12345678"');
    expect(csv).toContain('"PRODUCT_NOT_FOUND"');
    expect(csv).toContain('"Test Operator"');
    // Nothing to remember between windows any more but the last order (2026-10-21).
    expect(existsSync(join(root, 'reports', 'launcher-settings.json'))).toBe(false);
  });
});
