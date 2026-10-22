import { DEFAULT_ORDER_FILE, loadOrder, type DeliveryMethod, type OrderLine } from '../src/config/order';
import { ADD_DELAY_SECONDS } from '../src/config/settings';
import { chooseDelivery } from '../src/flows/delivery-modes';
import { errorQuestion, METHOD_NAMES, methodEligibilityQuestion, otherMethods, retryOrAsk, stopped } from '../src/flows/order-issues';
import { OrderProducts } from '../src/flows/order-products';
import { test, expect } from '../src/fixtures/staging';
import { BagPage } from '../src/pages/BagPage';
import { BackofficeLoginPage } from '../src/pages/BackofficeLoginPage';
import { BackofficeOrderPage } from '../src/pages/BackofficeOrderPage';
import { CheckoutPage, MODE_NAMES } from '../src/pages/CheckoutPage';
import { LoginPage } from '../src/pages/LoginPage';
import { OrderConfirmationPage } from '../src/pages/OrderConfirmationPage';
import { PaymentPage } from '../src/pages/PaymentPage';
import { ProductSearch } from '../src/pages/ProductSearch';
import { ask, decided, pluList } from '../src/utils/ask';
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
// Before Checkout, a run started from the launcher asks the person when something needs a decision
// (src/utils/ask.ts, user's request 2026-10-22): a product out of stock, not found or refused, a
// delivery that can't take some products, an unexpected error. It then goes on from there. After
// Checkout nothing is asked or retried (PRD §41–42).

const plus = (lines: OrderLine[]) => lines.map((line) => (line.quantity > 1 ? `${line.plu} x${line.quantity}` : line.plu)).join(', ') || 'none';

test('order flow from the order file', async ({ page, stagingUrl, settings, orderRun, headless }) => {
  const order = loadOrder(settings.orderFile ?? DEFAULT_ORDER_FILE);
  const unitCount = order.products.reduce((sum, line) => sum + line.quantity, 0);
  // Per unit added: the seconds between adds (fixed at 5 since 2026-10-21) plus 35 s for the add
  // itself; orders also wait up to 15 minutes in the backoffice.
  test.setTimeout((settings.placeOrder ? 35 : 15) * 60_000 + unitCount * (35_000 + ADD_DELAY_SECONDS * 1000));
  // The person's decisions can change the delivery, and the products (OrderProducts).
  let method = order.deliveryMethod;
  let mode = order.deliveryMode;
  const decisions = orderRun.data.decisions;
  Object.assign(orderRun.data, { placeOrder: settings.placeOrder, deliveryMethod: method, deliveryMode: mode });
  log(
    `Starting Watsons STAGING order test (${order.deliveryMode}, ${order.deliveryMethod}, ${order.products.length} PLU(s), ${ADD_DELAY_SECONDS} s between adds)`,
  );

  const loginPage = new LoginPage(page, stagingUrl);
  const search = new ProductSearch(page);
  const bag = new BagPage(page);
  const checkout = new CheckoutPage(page);
  const products = new OrderProducts(page, search, bag, decisions, order.products);
  orderRun.data.soldOut = products.soldOut;

  await orderRun.step('Login', async () => {
    await loginPage.open();
    await loginPage.login(settings.username, settings.password);
  });

  // Start from an empty bag, so leftovers from earlier runs can't end up in the order.
  await orderRun.step('Empty bag', () =>
    retryOrAsk('Empty bag', decisions, async () => {
      await bag.open();
      await bag.empty();
    }),
  );

  // Check every PLU before adding anything (PRD §12); then add them.
  await orderRun.step('Product Search', () => products.check());
  await orderRun.step('Add to bag', () => products.addAll());

  // The checkout page has no "MY Bag" button (seen 2026-10-22): back to the bag through the shop.
  const backToShop = () => page.goto(stagingUrl.href);
  // Methods the person moved away from: not offered again.
  const triedMethods: DeliveryMethod[] = [];
  const useMethod = (next: DeliveryMethod) => {
    triedMethods.push(method);
    method = next;
    orderRun.data.deliveryMethod = method;
    decided(decisions, `Delivery method: ${METHOD_NAMES[method]}`);
  };

  // Bag: delivery method, free gift, contents. Products the method can't take (the bag page says
  // so): the person chooses another method, to leave them out, a replacement, or to stop. Any other
  // problem: retry, another method, or stop. Ends on the checkout page, or with a replacement to add.
  type Cart = { kind: 'ready'; names: Record<string, string> } | { kind: 'replace'; plus: string[]; replacements: string[] };
  const validateCart = async (): Promise<Cart> => {
    for (;;) {
      let problem: { message: string; plus: string[] } | null = null;
      try {
        await bag.open();
        await bag.selectDeliveryMethod(method);
        problem = await bag.methodProblem();
        if (!problem) {
          orderRun.data.freeGiftRemoved = (await bag.removeFreeGiftIfPresent()) ?? orderRun.data.freeGiftRemoved;
          await products.tidyBag();
          await bag.expectContents(products.lines);
          const free = await bag.freeItems();
          if (free.length > 0) log(`Free item(s) staging added by itself (e.g. Buy 1 Get 1 Free): PLU ${plus(free)}. They come with the order.`);
          const names = await bag.productNames();
          await bag.next();
          return { kind: 'ready', names };
        }
      } catch (error) {
        const answer = await ask(errorQuestion('Cart validation', error, { extra: otherMethods(method, triedMethods) }), { action: 'stop' }, decisions);
        if (answer.action === 'switch_method' && answer.method) useMethod(answer.method);
        else if (answer.action !== 'retry') stopped('Cart validation', answer, error);
        await backToShop();
        continue;
      }
      if (!problem) continue;
      const notTaken = new StepError(
        'DELIVERY_METHOD_NOT_AVAILABLE',
        'Cart validation',
        `${METHOD_NAMES[method]} can't take PLU ${problem.plus.join(', ') || '(not shown)'}. The bag page says: "${problem.message}"`,
        ['these products need another delivery method (e.g. Home Delivery)'],
      );
      log(`Not available for ${METHOD_NAMES[method]} (the bag page): PLU ${problem.plus.join(', ') || '(not shown)'}`, 'WARN');
      const others = products.lines.filter((line) => !problem.plus.includes(line.plu)).length;
      const answer = await ask(methodEligibilityQuestion({ plus: problem.plus, method, message: problem.message, othersLeft: others, triedMethods }), { action: 'stop' }, decisions);
      if (answer.action === 'switch_method' && answer.method) useMethod(answer.method);
      else if (answer.action === 'replace' && answer.plu) return { kind: 'replace', plus: problem.plus, replacements: pluList(answer.plu) };
      else if (answer.action === 'skip') {
        const leftOut = problem.plus;
        await retryOrAsk('Cart validation', decisions, () => products.leaveOut(leftOut));
        decided(decisions, `PLU ${leftOut.join(', ')} left out of the order`);
        // The bag page can go on showing them for a while (seen 2026-10-22): load it afresh.
        await backToShop();
      } else stopped('Cart validation', answer, notTaken);
    }
  };
  // Cart validation until the bag goes on to the checkout page; a product replaced there is added first.
  const cartToCheckout = async (): Promise<Record<string, string>> => {
    for (;;) {
      const cart = await orderRun.step('Cart validation', validateCart);
      if (cart.kind === 'ready') return cart.names;
      await backToShop();
      await orderRun.step('Add to bag', () => products.replace(cart.plus, cart.replacements));
    }
  };

  // Cart validation, then the checkout page's delivery mode; again when the person changes the
  // delivery method or a product there (the mode alone changes on the checkout page itself).
  let namesByPlu = await cartToCheckout();
  for (;;) {
    const next = await orderRun.step(`${MODE_NAMES[mode]} Delivery Selection`, async () => {
      await checkout.waitUntilLoaded();
      const chosen = await chooseDelivery({ checkout, mode, method, lines: products.lines, namesByPlu, decisions, triedMethods });
      if (chosen.kind === 'ready') {
        await expect(checkout.checkoutButton).toHaveCount(1);
        await expect(checkout.checkoutButton).toBeVisible();
      }
      return chosen;
    });
    if (next.kind === 'ready') {
      orderRun.data.ordered = next.kept;
      orderRun.data.excluded = next.excluded.map((line) => line.plu);
      break;
    }
    if (next.kind === 'mode') {
      mode = next.mode;
      orderRun.data.deliveryMode = mode;
      decided(decisions, `Delivery mode: ${MODE_NAMES[mode]}`);
      continue;
    }
    await backToShop();
    if (next.kind === 'method') useMethod(next.method);
    // Products the mode can't take, out of the order: Cart validation takes them out of the bag.
    else if (next.kind === 'remove') {
      products.drop(next.plus);
      decided(decisions, `PLU ${next.plus.join(', ')} taken out of the order`);
    } else await orderRun.step('Add to bag', () => products.replace(next.plus, next.replacements));
    namesByPlu = await cartToCheckout();
  }
  log(`In the order: ${plus(orderRun.data.ordered)}`);
  if (orderRun.data.excluded.length > 0) log(`Left out, not ${mode}-eligible: ${orderRun.data.excluded.join(', ')}`, 'WARN');
  await test.info().attach('checkout summary', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

  if (!settings.placeOrder) {
    log('Ready to check out. Placing an order is switched off for this run (npm run order or the launcher option switches it on): no order is placed.', 'PASS');
    return;
  }

  // Place the order (switched on for this run). Pay and SUBMIT are clicked once each; nothing is
  // ever retried (PRD §41–42).
  log(`Placing a test order on Watsons STAGING: ${plus(orderRun.data.ordered)} (${mode}, ${method})`, 'WARN');
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
