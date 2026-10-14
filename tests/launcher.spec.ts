import { test, expect, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOrder, parseOrderNumber, type OrderLine } from '../src/config/order';
import { DEFAULT_ADD_DELAY_SECONDS, MAX_ADD_DELAY_SECONDS, readSettings } from '../src/config/settings';
import { STAGING_HOST } from '../src/safety/staging-guard';

// Offline checks of the launcher (launcher/launcher.cjs, PRD §32–38). The window tests use a
// made-up project folder whose "Playwright" is tests/helpers/fake-playwright-cli.cjs, so they
// never open the Watsons site.

interface SetupResult {
  checks: { label: string; ok: boolean; help: string }[];
  ready: boolean;
}
interface HistoryRow {
  runId: string;
  automation: string;
  status: string;
  orderNumber: string | null;
  operator: string | null;
  delivery: { label: string } | null;
  products: { requested: OrderLine[]; ordered: OrderLine[]; excluded: string[] };
  error: { code: string | null; step: string | null; reason: string; screenshots: string[] } | null;
  warning: string | null;
  screenshots: string[];
  errorReport: string | null;
}
interface Launcher {
  STAGING_HOST: string;
  ADD_DELAY: { default: number; min: number; max: number };
  parseProducts(text: string): { products: OrderLine[]; problems: string[] };
  normalizeOrderNumber(text: string): string | null;
  parseAddDelay(value: unknown): { seconds?: number; problem?: string };
  orderFileText(order: { products: OrderLine[]; deliveryMethod: string; mode: string }): string;
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

  test('uses the same "Seconds between adds" limits as the order test', () => {
    expect(launcher.ADD_DELAY).toEqual({ default: DEFAULT_ADD_DELAY_SECONDS, min: 0, max: MAX_ADD_DELAY_SECONDS });
    const complete = { WATSONS_STAGING_URL: 'https://staging.example.test/', WATSONS_USERNAME: 'a', WATSONS_PASSWORD: 'b' };
    for (const value of [0, 5, '10', 20, 120, 121, -1, 2.5, 'ten']) {
      const fromLauncher = launcher.parseAddDelay(value);
      let fromSettings: number | 'error';
      try {
        fromSettings = readSettings({ ...complete, WATSONS_ADD_DELAY_SECONDS: String(value) }).addDelaySeconds;
      } catch {
        fromSettings = 'error';
      }
      expect(fromLauncher.problem ? 'error' : fromLauncher.seconds, String(value)).toBe(fromSettings);
    }
    expect(launcher.parseAddDelay(undefined)).toEqual({ seconds: 10 });
    expect(launcher.parseAddDelay('').problem).toBe('Seconds between adds must be a whole number from 0 to 120.');
  });

  test('writes order files the test can read', () => {
    const products = [{ plu: '10117', quantity: 1 }, { plu: '10321', quantity: 2 }];
    for (const deliveryMethod of ['home_delivery', 'click_collect', 'shell_station']) {
      const order = parseOrder(launcher.orderFileText({ products, deliveryMethod, mode: 'express' }));
      expect(order).toEqual({ deliveryMethod, deliveryMode: 'express', products });
    }
    expect(parseOrder(launcher.orderFileText({ products, deliveryMethod: 'home_delivery', mode: 'standard' })).deliveryMode).toBe('standard');
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
      order: { automation: 'order', products: [{ plu: '10321', quantity: 2 }], deliveryMethod: 'home_delivery', mode: 'express', addDelaySeconds: 10 },
    });
    expect(launcher.checkRunRequest({ ...good, products: '' }, ready).problems).toEqual(['Add at least one PLU.']);
    expect(launcher.checkRunRequest({ ...good, deliveryMethod: 'toString' }, ready).problems).toEqual(['Choose a delivery method.']);
    // Standard (user's request 2026-10-13) as well as Express; nothing else.
    expect(launcher.checkRunRequest({ ...good, mode: 'standard' }, ready).order).toMatchObject({ mode: 'standard' });
    expect(launcher.checkRunRequest({ ...good, mode: 'toString' }, ready).problems).toEqual(['Choose the delivery mode.']);
    expect(launcher.checkRunRequest({ ...good, confirmed: undefined }, ready).problems).toEqual(['Placing an order needs your confirmation first.']);
    expect(launcher.checkRunRequest(good, { checks: [{ label: 'Account configured', ok: false, help: 'Fill in .env.' }], ready: false }).order).toBeUndefined();
    expect(launcher.checkRunRequest({ ...good, automation: 'toString' }, ready).order).toBeUndefined();

    // Seconds between adds (user's request 2026-10-07).
    expect(launcher.checkRunRequest({ ...good, addDelaySeconds: '20' }, ready).order).toMatchObject({ addDelaySeconds: 20 });
    for (const wrong of [121, -1, 2.5, '', 'ten']) {
      expect(launcher.checkRunRequest({ ...good, addDelaySeconds: wrong }, ready).problems, String(wrong)).toEqual(['Seconds between adds must be a whole number from 0 to 120.']);
    }
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

  test.beforeEach(async () => {
    process.env.WATSONS_OPERATOR = 'Test Operator';
    root = makeFakeProject();
    opened = [];
    // Files and folders the window asks to open are only noted here (no Explorer during tests).
    app = await launcher.startLauncher({ root, openWindow: false, quiet: true, openFile: (target) => opened.push(target) });
  });
  test.afterEach(async () => {
    await app.close();
    // Windows keeps the folder locked for a moment while stopped processes end.
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    if (savedOperator === undefined) delete process.env.WATSONS_OPERATOR;
    else process.env.WATSONS_OPERATOR = savedOperator;
  });

  /** Waits until the run just started has ended (Logs / History counts it from its start). */
  async function runEnded(page: Page, runsBefore: number) {
    await expect(page.locator('#history-count')).toHaveText(String(runsBefore + 1));
    await expect(page.locator('#result')).toBeVisible({ timeout: 15_000 });
  }

  async function placeOrder(page: Page, products: string, runsBefore: number) {
    await page.getByLabel('Place new order').check();
    await page.getByLabel('One PLU per line').fill(products);
    await expect(page.locator('#run')).toBeEnabled();
    await page.locator('#run').click();
    await page.locator('#confirm').getByRole('button', { name: 'Run test' }).click();
    await runEnded(page, runsBefore);
  }

  async function approveOrder(page: Page, orderNumber: string, runsBefore: number) {
    await page.getByLabel('Approve existing order').check();
    await page.getByLabel('Order number').fill(orderNumber);
    await page.locator('#run').click();
    await page.locator('#confirm').getByRole('button', { name: 'Approve in Backoffice' }).click();
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
    await expect(page.locator('#preview tr')).toHaveCount(2);
    // No OTP or options to fill in (user's decision 2026-10-05); the only number is the time between adds.
    await expect(page.getByRole('textbox')).toHaveCount(1);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByLabel('Seconds between adds')).toHaveValue('10');
    // Express is the default; Standard can be chosen too (user's request 2026-10-13).
    await expect(page.locator('input[name=mode][value=express]')).toBeChecked();
    await expect(page.locator('input[name=mode][value=standard]')).toBeEnabled();
    await expect(page.locator('#modes')).not.toContainText('Coming later');
    await expect(page.locator('#operator')).toHaveText('Test Operator');
    const run = page.locator('#run');
    await expect(run).toHaveText('Run order test');
    await expect(run).toBeEnabled();

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
    await expect(dialog).toContainText('Watsons STAGING');
    await expect(dialog).toContainText('Home Delivery (Express)');
    await expect(dialog).toContainText('2 product(s), 3 item(s)');
    await expect(dialog).toContainText('10 seconds');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#progress')).toBeHidden(); // nothing ran

    await run.click();
    await dialog.getByRole('button', { name: 'Run Test' }).click();
    // While the browser shows the confirmation page, the number is already there, without Stop.
    await expect(page.locator('#status')).toContainText('order 12345678 placed and extracted');
    await expect(page.locator('#stop')).toBeHidden();
    await expect(page.locator('#result .order-number')).toHaveText('Order Number: 12345678');
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#log')).toContainText('--headed place=yes');
    await expect(page.locator('#log')).toContainText('delay=10');
    await expect(page.locator('#steps li.done')).toHaveCount(14);
    await expect(page.locator('#result')).toContainText('ORDER_EXTRACTED (approved by this run)');
  });

  test('reports the products the delivery mode left out', async ({ page }) => {
    await page.goto(app.url);
    await placeOrder(page, '10117\n46465', 0);
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#result .callout.warn')).toHaveText('Not available for Express, left out of this order: PLU 46465');
    await expect(page.locator('#result')).toContainText('Left out (not eligible)');
  });

  test('places a Standard order: the test gets Standard, and its progress and result say so', async ({ page }) => {
    await page.goto(app.url);
    await page.locator('input[name=mode][value=standard]').check();
    await page.getByLabel('One PLU per line').fill('10117\n46465');
    await page.locator('#run').click();
    await expect(page.locator('#confirm')).toContainText('Click & Collect (Standard)');
    await page.locator('#confirm').getByRole('button', { name: 'Run test' }).click();
    await runEnded(page, 0);
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#steps')).toContainText('Standard Delivery Selection');
    await expect(page.locator('#result .callout.warn')).toHaveText('Not available for Standard, left out of this order: PLU 46465');
    // The order file the test read, in the run's evidence.
    const [runId] = readdirSync(join(root, 'reports')).filter((name) => /^\d{4}-\d{2}-\d{2}_/.test(name));
    expect(readFileSync(join(root, 'reports', runId, 'order.txt'), 'utf8')).toContain('mode: Standard');
  });

  test('"Seconds between adds" goes to the test and is remembered', async ({ page }) => {
    await page.goto(app.url);
    const delay = page.getByLabel('Seconds between adds');
    await expect(delay).toHaveValue('10');
    await delay.fill('500');
    await expect(page.locator('.check-bad', { hasText: 'Seconds between adds' })).toBeVisible();
    await expect(page.locator('#run')).toBeDisabled();
    await page.getByRole('button', { name: '20 s', exact: true }).click();
    await expect(delay).toHaveValue('20');
    await expect(page.locator('#add-delay-hint')).toContainText('For 3 item(s): about 1 min 00 s of adding.');
    await page.locator('#run').click();
    await expect(page.locator('#confirm')).toContainText('20 seconds');
    await page.locator('#confirm').getByRole('button', { name: 'Run test' }).click();
    await runEnded(page, 0);
    await expect(page.locator('#log')).toContainText('delay=20');
    await expect(page.locator('#log')).toContainText('by Test Operator: places a STAGING test order (20 s between adds)');
    await expect(page.locator('#result')).toContainText('20 s');
    expect(JSON.parse(readFileSync(join(root, 'reports', 'launcher-settings.json'), 'utf8'))).toEqual({ addDelaySeconds: 20 });
    await page.reload();
    await expect(page.getByLabel('Seconds between adds')).toHaveValue('20');
  });

  test('shows the failed step, code and reason, with the error report and screenshot', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(app.url);
    await page.getByLabel('One PLU per line').fill('404');
    await page.locator('#run').click();
    await page.locator('#confirm').getByRole('button', { name: 'Run Test' }).click();
    const result = page.locator('#result');
    await expect(result.locator('.verdict')).toHaveText('Failed');
    await expect(result).toContainText('Product Search');
    await expect(result).toContainText('PRODUCT_NOT_FOUND');
    await expect(result).toContainText('No product found for PLU 404.');
    await expect(page.locator('#steps li.failed')).toHaveText('Product Search');

    // Telemetry (user's request 2026-10-07): when, where, and the screenshot taken then.
    const error = result.locator('.errbox');
    await expect(error).toContainText('https://staging.example.test/search');
    await expect(error).toContainText(/Time\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/);
    const image = error.locator('.thumb img');
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
    await error.locator('.thumb').click();
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
    await error.getByRole('button', { name: 'Copy error report' }).click();
    await expect(page.locator('#toast')).toContainText('Error report copied');
    // (Windows keeps text with \r\n line ends, the file and the clipboard alike.)
    const lines = (text: string) => text.split(/\r?\n/);
    expect(lines(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(lines(report));
  });

  test('Stop ends the test and everything it started (PRD §34)', async ({ page }) => {
    await page.goto(app.url);
    await page.getByLabel('One PLU per line').fill('99');
    await page.locator('#run').click();
    await page.locator('#confirm').getByRole('button', { name: 'Run Test' }).click();
    await expect(page.locator('#steps li.now')).toHaveText('Pay');
    // (The fake runner logs its browser's process id just after the step.)
    await expect(page.locator('#log')).toContainText(/fake browser pid=\d+/);
    const pid = Number((await page.locator('#log').textContent())?.match(/fake browser pid=(\d+)/)?.[1]);
    expect(isRunning(pid)).toBe(true);

    // Past Checkout, Stop asks first.
    page.once('dialog', (question) => question.accept());
    await page.locator('#stop').click();
    await expect(page.locator('#result .verdict')).toHaveText('Stopped');
    await expect(page.locator('#result')).toContainText('Test cancelled by user.');
    await expect(page.locator('#result')).toContainText('Check My Account → Order History');
    await expect.poll(() => isRunning(pid)).toBe(false);
  });

  test('approves an existing order, and never places one', async ({ page }) => {
    await page.goto(app.url);
    await page.getByLabel('Approve existing order').check();
    for (const section of ['#section-products', '#section-delivery', '#section-timing']) await expect(page.locator(section)).toBeHidden();
    const run = page.locator('#run');
    await expect(run).toHaveText('Approve in Backoffice');
    await expect(run).toBeDisabled();
    const orderNumber = page.getByLabel('Order number');
    await orderNumber.fill('0709101');
    await expect(page.locator('.check-bad', { hasText: 'Order number entered (8 digits)' })).toBeVisible();
    await expect(page.locator('#order-code')).toHaveText('✗ 8 digits needed (e.g. 07091012)');
    await expect(run).toBeDisabled();
    await orderNumber.fill('wtcsg 0709 1012');
    await expect(page.locator('#order-code')).toHaveText('✓ Backoffice code WTCSG07091012');
    await expect(run).toBeEnabled();

    await run.click();
    const dialog = page.locator('#confirm');
    await expect(dialog).toContainText('Approve an existing order?');
    await expect(dialog).toContainText('WTCSG07091012');
    await expect(dialog).toContainText('No new order is created.');
    await dialog.getByRole('button', { name: 'Approve in Backoffice' }).click();
    await expect(page.locator('#status')).toContainText('order WTCSG07091012 approved and extracted');
    await expect(page.locator('#stop')).toBeHidden();
    await expect(page.locator('#result .verdict')).toHaveText('Completed');
    await expect(page.locator('#result .order-number')).toHaveText('Order Number: 07091012');
    await expect(page.locator('#result')).toContainText('ORDER_EXTRACTED (approved by this run)');
    await expect(page.locator('#steps li.done')).toHaveCount(4);
    // Only the approve test runs: no order switch, no order file.
    await expect(page.locator('#log')).toContainText('args=test --project=approve approve.e2e --headed place=undefined');
    await expect(page.locator('#log')).toContainText('approve=07091012');
    await expect(page.locator('#log')).toContainText('approves existing order WTCSG07091012 in the STAGING backoffice (no new order)');
  });

  test('approving an order that is already extracted changes nothing', async ({ page }) => {
    await page.goto(app.url);
    await approveOrder(page, '11111111', 0);
    await expect(page.locator('#result .verdict')).toHaveText('No change');
    await expect(page.locator('#result')).toContainText('WTCSG11111111 was already ORDER_EXTRACTED, so Approve Order was not clicked.');
    await expect(page.locator('#result')).toContainText('ORDER_EXTRACTED (was already extracted)');
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
    await expect(rows.nth(3).locator('td').nth(3)).toHaveText('ExpressClick & Collect'); // mode, then method below it
    await expect(rows.nth(3)).toContainText('10117');
    await expect(rows.nth(3)).toContainText('1 left out (not eligible)');
    await expect(rows.nth(3)).toContainText('Completed');
    await expect(rows.nth(3)).toContainText('Test Operator');

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
    await expect(details.locator('.errbox')).toContainText("WTCSG00000404 is not in the backoffice's Orders list.");
    await expect(details.locator('.errbox')).toContainText('https://backoffice.example.test/backoffice/');
    await expect(details.locator('.errbox')).toContainText('WTCSG00000404');
    await details.locator('.errbox .thumb').click();
    await expect(page.locator('#viewer-title')).toHaveText('screenshot-1-failure.png');
    await page.locator('#viewer-open').click();
    await expect.poll(() => opened.at(-1)).toMatch(/screenshot-1-failure\.png$/);
    await page.locator('#viewer-close').click();
    await details.getByRole('button', { name: 'Open evidence folder' }).click();
    await expect.poll(() => opened.at(-1)).toMatch(/reports[\\/]\d{4}-\d{2}-\d{2}_[\d_-]+$/);

    // Export: the runs shown, as a CSV file for Excel.
    await page.getByRole('button', { name: 'Export CSV' }).click();
    await expect.poll(() => opened.find((file) => file.endsWith('.csv'))).toBeTruthy();
    const csv = readFileSync(opened.find((file) => file.endsWith('.csv'))!, 'utf8');
    expect(csv.trimEnd().split('\r\n')).toHaveLength(5);
    expect(csv).toContain('"WTCSG12345678"');
    expect(csv).toContain('"PRODUCT_NOT_FOUND"');
    expect(csv).toContain('"Test Operator"');
    expect(existsSync(join(root, 'reports', 'launcher-settings.json'))).toBe(true);
  });
});
