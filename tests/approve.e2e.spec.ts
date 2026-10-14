import { test } from '../src/fixtures/staging';
import { BackofficeLoginPage } from '../src/pages/BackofficeLoginPage';
import { backofficeCode, BackofficeOrderPage } from '../src/pages/BackofficeOrderPage';
import { log } from '../src/utils/log';

// Approves an order that ALREADY EXISTS, in the staging backoffice (user's request 2026-10-07):
// Backoffice login → Orders → the order → Fraud Report → Approve Order, then waits until it is
// ORDER_EXTRACTED, the same steps as the end of the order flow (tests/order.e2e.spec.ts). It never
// opens the shop, so it can't create an order. "Approve Order" is clicked at most once (PRD §41–42);
// an order that is already extracted is left alone ("no change").
//
// The order number comes from WATSONS_APPROVE_ORDER ("07091012" or "WTCSG07091012"), which the
// launcher sets for an "Approve existing order" run. Without it, this test is skipped. By hand:
//   $env:WATSONS_APPROVE_ORDER = '07091012'; npm run approve; $env:WATSONS_APPROVE_ORDER = ''
// It has its own Playwright project ("approve"), so npm run test:e2e never approves anything.

test.skip(!process.env.WATSONS_APPROVE_ORDER?.trim(), 'No order to approve: set WATSONS_APPROVE_ORDER to its order number.');

test('approve an existing order in the backoffice', async ({ page, settings, orderRun, headless }) => {
  // readSettings() has checked the number and that the backoffice account is filled in.
  const orderNumber = settings.approveOrder!;
  // Up to 3 minutes to find the order and 5 for it to wait for validation, then 10 to be extracted.
  test.setTimeout(25 * 60_000);
  orderRun.data.automation = 'approve';
  orderRun.data.orderNumber = orderNumber;
  const code = backofficeCode(orderNumber);
  log(`Starting approval of existing order ${code} in the Watsons STAGING backoffice (no new order is created)`);

  const backoffice = new BackofficeOrderPage(page);
  await orderRun.step('Backoffice login', () => new BackofficeLoginPage(page).signIn(settings.backoffice!));
  const statusBefore = await orderRun.step('Find order in backoffice', () => backoffice.open(orderNumber));
  const approved = await orderRun.step('Approve order', () => backoffice.approve(orderNumber, statusBefore));
  orderRun.data.backoffice = { approved, statuses: [] };
  orderRun.data.backoffice.statuses = await orderRun.step('Order extracted', () => backoffice.waitUntilExtracted(orderNumber));
  await backoffice.showStatus(orderNumber);
  await test.info().attach('backoffice order', { body: await page.screenshot(), contentType: 'image/png' });
  const finalStatus = orderRun.data.backoffice.statuses.at(-1);
  // The launcher reads these lines (launcher/launcher.cjs, PASS_LINES).
  if (approved) log(`Order approved successfully. Order number: ${orderNumber} (backoffice: ${finalStatus})`, 'PASS');
  else log(`No change needed. Order number: ${orderNumber} (backoffice: already ${finalStatus})`, 'PASS');

  // With the browser shown (the launcher), leave the backoffice order open until the person closes
  // the browser window, at most 5 minutes (as the order flow does).
  if (!headless) {
    log('The backoffice order stays open. Close the browser window to finish (it closes by itself after 5 minutes).');
    test.setTimeout(test.info().timeout + 6 * 60_000);
    // Either way the test has passed, so a timeout here is not an error.
    await page.waitForEvent('close', { timeout: 5 * 60_000 }).catch(() => {});
  }
});
