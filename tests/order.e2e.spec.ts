import { DEFAULT_ORDER_FILE, loadOrder, type OrderLine } from '../src/config/order';
import { ADD_DELAY_SECONDS } from '../src/config/settings';
import { deliveryModeSteps } from '../src/flows/delivery-modes';
import { test, expect } from '../src/fixtures/staging';
import { BagPage } from '../src/pages/BagPage';
import { BackofficeLoginPage } from '../src/pages/BackofficeLoginPage';
import { BackofficeOrderPage } from '../src/pages/BackofficeOrderPage';
import { CheckoutPage } from '../src/pages/CheckoutPage';
import { LoginPage } from '../src/pages/LoginPage';
import { OrderConfirmationPage } from '../src/pages/OrderConfirmationPage';
import { PaymentPage } from '../src/pages/PaymentPage';
import { ProductSearch } from '../src/pages/ProductSearch';
import { StepError } from '../src/utils/errors';
import { log } from '../src/utils/log';

// The whole order flow (PRD §9), with the products, delivery method and mode (Express for now)
// from test-data/order.txt (or the file in WATSONS_ORDER_FILE, which the launcher sets).
// - npm run test:e2e  stops at the Checkout button: no order is created.
// - npm run order     also checks out, pays with the staging OTP and verifies the order number
//                     on the confirmation page (sets WATSONS_PLACE_ORDER=yes for that run only).
//                     Creates a real STAGING order. The launcher always runs it this way. With a
//                     backoffice account it then approves the order; without one (2026-10-14) it
//                     stops at the confirmation page and the order waits for approval.
// With the browser shown (--headed, as the launcher does), the run ends by leaving the order
// confirmation page open until the person closes the browser window (at most 5 minutes).
// Each run's evidence goes to reports/<run id>/ (src/reporting/result-reporter.ts).

const plus = (lines: OrderLine[]) => lines.map((line) => (line.quantity > 1 ? `${line.plu} x${line.quantity}` : line.plu)).join(', ') || 'none';

test('order flow from the order file', async ({ page, stagingUrl, settings, orderRun, headless }) => {
  const order = loadOrder(settings.orderFile ?? DEFAULT_ORDER_FILE);
  const unitCount = order.products.reduce((sum, line) => sum + line.quantity, 0);
  // Per unit added: the seconds between adds (fixed at 5 since 2026-10-21) plus 35 s for the add
  // itself; orders also wait up to 15 minutes in the backoffice.
  test.setTimeout((settings.placeOrder ? 35 : 15) * 60_000 + unitCount * (35_000 + ADD_DELAY_SECONDS * 1000));
  const mode = deliveryModeSteps(order.deliveryMode);
  Object.assign(orderRun.data, { placeOrder: settings.placeOrder, deliveryMethod: order.deliveryMethod, deliveryMode: order.deliveryMode });
  log(
    `Starting Watsons STAGING order test (${order.deliveryMode}, ${order.deliveryMethod}, ${order.products.length} PLU(s), ${ADD_DELAY_SECONDS} s between adds)`,
  );

  const loginPage = new LoginPage(page, stagingUrl);
  const search = new ProductSearch(page);
  const bag = new BagPage(page);
  const checkout = new CheckoutPage(page);

  await orderRun.step('Login', async () => {
    await loginPage.open();
    await loginPage.login(settings.username, settings.password);
  });

  // Start from an empty bag, so leftovers from earlier runs can't end up in the order.
  await orderRun.step('Empty bag', async () => {
    await bag.open();
    await bag.empty();
  });

  // Check every PLU before adding anything (PRD §12).
  const available = await orderRun.step('Product Search', async () => {
    await search.searchAll(order.products.map((line) => line.plu));
    const found: OrderLine[] = [];
    const notFound: OrderLine[] = [];
    for (const line of order.products) {
      const availability = await search.availabilityOf(line.plu);
      if (availability === 'available') found.push(line);
      else if (availability === 'sold_out') orderRun.data.soldOut.push(line.plu);
      else notFound.push(line);
    }
    if (notFound.length > 0) {
      throw new StepError('PRODUCT_NOT_FOUND', 'Product Search', `No product found for PLU ${plus(notFound)}. Nothing was added.`, [
        'a typo in the order',
        'the product does not exist on staging',
      ]);
    }
    if (orderRun.data.soldOut.length > 0) log(`Skipping sold-out PLU(s): ${orderRun.data.soldOut.join(', ')}`, 'WARN');
    if (found.length === 0) throw new StepError('PRODUCT_NOT_FOUND', 'Product Search', 'Every product in the order is sold out.');
    return found;
  });

  await orderRun.step('Add to bag', async () => {
    for (const line of available) await search.add(line);
  });

  // Bag: delivery method, free gift, contents.
  const namesByPlu = await orderRun.step('Cart validation', async () => {
    await bag.open();
    await bag.selectDeliveryMethod(order.deliveryMethod);
    orderRun.data.freeGiftRemoved = await bag.removeFreeGiftIfPresent();
    await bag.expectContents(available);
    const names = await bag.productNames();
    await bag.next();
    return names;
  });

  // Checkout summary: the delivery mode reports products it can't deliver.
  await orderRun.step(`${order.deliveryMode === 'express' ? 'Express' : 'Standard'} Delivery Selection`, async () => {
    await checkout.waitUntilLoaded();
    const { kept, excluded } = await mode.selectOnCheckout(checkout, available, namesByPlu);
    orderRun.data.ordered = kept;
    orderRun.data.excluded = excluded.map((line) => line.plu);
    await expect(checkout.checkoutButton).toHaveCount(1);
    await expect(checkout.checkoutButton).toBeVisible();
  });
  log(`In the order: ${plus(orderRun.data.ordered)}`);
  if (orderRun.data.excluded.length > 0) log(`Left out, not ${order.deliveryMode}-eligible: ${orderRun.data.excluded.join(', ')}`, 'WARN');
  await test.info().attach('checkout summary', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

  if (!settings.placeOrder) {
    log('Ready to check out. Placing an order is switched off for this run (npm run order or the launcher option switches it on): no order is placed.', 'PASS');
    return;
  }

  // Place the order (switched on for this run). Pay and SUBMIT are clicked once each; nothing is
  // ever retried (PRD §41–42).
  log(`Placing a test order on Watsons STAGING: ${plus(orderRun.data.ordered)} (${order.deliveryMode}, ${order.deliveryMethod})`, 'WARN');
  const payment = new PaymentPage(page);
  const confirmation = new OrderConfirmationPage(page, stagingUrl);
  await orderRun.step('Checkout', () => checkout.checkout(settings.placeOrder));
  await orderRun.step('Pay', () => payment.pay());
  await orderRun.step('OTP', () => payment.submitOtp(settings.paymentOtp));
  const orderNumber = await orderRun.step('Order confirmation', () => confirmation.orderNumber());
  orderRun.data.orderNumber = orderNumber;
  await test.info().attach('order confirmation', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  // With the browser shown (the desktop launcher), or watched in the hosted server's live view
  // (WATSONS_HOLD_LAST_PAGE), the last pages stay open until the browser is closed, at most 5 minutes.
  const holdLastPage = !headless || settings.holdLastPage;

  // No backoffice account for this run (user's decision 2026-10-14): the order is placed and waits
  // for approval. Someone with a backoffice account approves it later ("Approve existing order",
  // also from Logs / History). The run ends on the "Thank you for your order" page.
  if (!settings.backoffice) {
    // The launcher reads this line (launcher/launcher.cjs, PASS_LINES).
    log(`Order placed (not approved yet: no backoffice account for this run). Order number: ${orderNumber}`, 'PASS');
    if (holdLastPage) {
      log('The order confirmation page stays open. Close the browser to finish (it closes by itself after 5 minutes).');
      test.setTimeout(test.info().timeout + 6 * 60_000);
      // Either way the test has passed, so a timeout here is not an error.
      await page.waitForEvent('close', { timeout: 5 * 60_000 }).catch(() => {});
    }
    return;
  }

  // Approve ("validate") the new order in the staging backoffice with the Customer Support role,
  // so it is extracted (user's request 2026-10-06). In a second tab: the confirmation page stays
  // in the first one. Approve Order is clicked at most once.
  const backofficeTab = await page.context().newPage();
  const backoffice = new BackofficeOrderPage(backofficeTab);
  await orderRun.step('Backoffice login', () => new BackofficeLoginPage(backofficeTab).signIn(settings.backoffice!));
  const statusBefore = await orderRun.step('Find order in backoffice', () => backoffice.open(orderNumber));
  const approved = await orderRun.step('Approve order', () => backoffice.approve(orderNumber, statusBefore));
  orderRun.data.backoffice = { approved, statuses: [] };
  orderRun.data.backoffice.statuses = await orderRun.step('Order extracted', () => backoffice.waitUntilExtracted(orderNumber));
  await backoffice.showStatus(orderNumber);
  await test.info().attach('backoffice order', { body: await backofficeTab.screenshot(), contentType: 'image/png' });
  log(`Order test completed successfully. Order number: ${orderNumber} (backoffice: ${orderRun.data.backoffice.statuses.at(-1)})`, 'PASS');

  // The run ends on the backoffice order; the shop's confirmation page stays in the first tab
  // (user's choice 2026-10-06). Leave both open until the person closes the browser, at most 5
  // minutes.
  if (holdLastPage) {
    log('The backoffice order and the order confirmation page stay open. Close the browser to finish (it closes by itself after 5 minutes).');
    test.setTimeout(test.info().timeout + 6 * 60_000);
    await backofficeTab.bringToFront();
    // Either way the test has passed, so a timeout here is not an error.
    await Promise.all([page, backofficeTab].map((tab) => tab.waitForEvent('close', { timeout: 5 * 60_000 }).catch(() => {})));
  }
});
