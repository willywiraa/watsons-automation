import { test } from '../src/fixtures/staging';
import { backofficeCode, BackofficeOrderPage } from '../src/pages/BackofficeOrderPage';
import { BackofficeSession } from '../src/pages/BackofficeSession';
import { log } from '../src/utils/log';

// Approves an order that ALREADY EXISTS, in the staging backoffice (user's request 2026-10-07):
// Backoffice login → Orders → the order → Fraud Report → Approve Order, then waits until it is
// ORDER_EXTRACTED, the same steps as the end of the order flow (tests/order.e2e.spec.ts). Once it is
// "Order Split", it gets one more minute; then the run ends either way, saying whether extraction is
// still pending (user's request 2026-10-23). It never
// opens the shop, so it can't create an order. "Approve Order" is clicked at most once (PRD §41–42);
// an order that is already extracted is left alone ("no change").
//
// The order number comes from WATSONS_APPROVE_ORDER ("07091012" or "WTCSG07091012"), which the
// launcher sets for an "Approve existing order" run. Without it, this test is skipped. By hand:
//   $env:WATSONS_APPROVE_ORDER = '07091012'; npm run approve; $env:WATSONS_APPROVE_ORDER = ''
// It has its own Playwright project ("approve"), so npm run test:e2e never approves anything.

test.skip(!process.env.WATSONS_APPROVE_ORDER?.trim(), 'No order to approve: set WATSONS_APPROVE_ORDER to its order number.');

test('approve an existing order in the backoffice', async ({ page, settings, orderRun }) => {
  // readSettings() has checked the number and that the backoffice account is filled in.
  const orderNumber = settings.approveOrder!;
  // Up to 3 minutes to find the order and 5 for it to wait for validation, then 10 to be extracted.
  test.setTimeout(25 * 60_000);
  orderRun.data.automation = 'approve';
  orderRun.data.orderNumber = orderNumber;
  const code = backofficeCode(orderNumber);
  log(`Starting approval of existing order ${code} in the Watsons STAGING backoffice (no new order is created)`);

  // Signed out by the backoffice (its account open in another tab or browser): this tab is closed
  // and a new one signs in again (src/pages/BackofficeSession.ts, user's request 2026-10-25).
  const session = new BackofficeSession(page, settings.backoffice!);
  const backoffice = new BackofficeOrderPage(session);
  await orderRun.step('Backoffice login', () => session.signIn());
  const statusBefore = await orderRun.step('Find order in backoffice', () => backoffice.open(orderNumber));
  const approved = await orderRun.step('Approve order', () => backoffice.approve(orderNumber, statusBefore));
  orderRun.data.backoffice = { approved, statuses: [] };
  const extraction = await orderRun.step('Order extracted', () => backoffice.waitUntilExtracted(orderNumber));
  Object.assign(orderRun.data.backoffice, { statuses: extraction.statuses, extractionPending: !extraction.extracted });
  await backoffice.showStatus(orderNumber);
  await test.info().attach('backoffice order', { body: await session.page.screenshot(), contentType: 'image/png' });
  const finalStatus = extraction.statuses.at(-1);
  const pending = extraction.extracted ? '' : '; extraction still pending';
  // The launcher reads these lines (launcher/launcher.cjs, PASS_LINES).
  if (approved) log(`Order approved successfully. Order number: ${orderNumber} (backoffice: ${finalStatus}${pending})`, 'PASS');
  else log(`No change needed. Order number: ${orderNumber} (backoffice: already ${finalStatus}${pending})`, 'PASS');
  if (!extraction.extracted) log(`${code} is at ${finalStatus}: extraction to ORDER_EXTRACTED is still pending. Wait a few minutes, then check it in the backoffice.`, 'WARN');
  // The run ends here: no waiting for its browser to be closed (user's request 2026-10-23).
});
