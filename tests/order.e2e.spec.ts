import { DEFAULT_ORDER_FILE, loadOrder, type DeliveryMethod, type OrderLine } from '../src/config/order';
import { ADD_DELAY_SECONDS } from '../src/config/settings';
import { chooseDelivery, type ModeResult } from '../src/flows/delivery-modes';
import { errorQuestion, METHOD_NAMES, methodEligibilityQuestion, otherMethods, retryOrAsk, stopped } from '../src/flows/order-issues';
import { OrderProducts } from '../src/flows/order-products';
import { orderStep, placedLine, plannedLine, summaryLines } from '../src/flows/partial-order';
import { choosePickupStore, PICKUP_STORE_STEP } from '../src/flows/shell-station';
import { test, expect } from '../src/fixtures/staging';
import { BagPage } from '../src/pages/BagPage';
import { BackofficeOrderPage } from '../src/pages/BackofficeOrderPage';
import { BackofficeSession } from '../src/pages/BackofficeSession';
import { CheckoutPage, MODE_NAMES } from '../src/pages/CheckoutPage';
import { LoginPage } from '../src/pages/LoginPage';
import { OrderConfirmationPage } from '../src/pages/OrderConfirmationPage';
import { PaymentPage } from '../src/pages/PaymentPage';
import { ProductSearch } from '../src/pages/ProductSearch';
import { ShellStationPickup } from '../src/pages/ShellStationPickup';
import type { RunOrder } from '../src/reporting/order-run';
import { ask, decided, pluList } from '../src/utils/ask';
import { StepError } from '../src/utils/errors';
import { log } from '../src/utils/log';

// The whole order flow (PRD §9), with the products, delivery method and mode (Express or Standard;
// for Shell Station its pickup store instead, 2026-10-30) from test-data/order.txt (or the file in
// WATSONS_ORDER_FILE, which the launcher sets).
// - npm run test:e2e  stops at the Checkout button: no order is created.
// - npm run order     also checks out, pays with the staging OTP and verifies the order number
//                     on the confirmation page (sets WATSONS_PLACE_ORDER=yes for that run only).
//                     Creates a real STAGING order. The launcher always runs it this way. With a
//                     backoffice account it then approves the order; without one (2026-10-14) it
//                     stops at the confirmation page and the order waits for approval.
// A placed order's run ends as soon as it is done (user's request 2026-10-23): on the "Thank you
// for your order" page without a backoffice account, else once the order is ORDER_EXTRACTED, or
// at "Order Split" a minute later with extraction still pending. No waiting for the browser to close.
// Each run's evidence goes to reports/<run id>/ (src/reporting/result-reporter.ts).
// Before Checkout, a run started from the launcher asks the person when something needs a decision
// (src/utils/ask.ts, user's request 2026-10-22): a product out of stock, not found or refused, a
// delivery that can't take some products, an unexpected error. It then goes on from there. After
// an order's Checkout nothing is asked or retried for it (PRD §41–42).
// A partial order (src/flows/partial-order.ts, user's request 2026-11-03): when the chosen mode
// can't take some products and the other mode takes them all, the order can be split in two. Order 1
// goes by the chosen mode; staging keeps the others in the bag, and order 2 takes them from there
// by the other mode (its steps are named "<step> (order 2)"). Then each order is approved.

const plus = (lines: OrderLine[]) => lines.map((line) => (line.quantity > 1 ? `${line.plu} x${line.quantity}` : line.plu)).join(', ') || 'none';

test('order flow from the order file', async ({ page, stagingUrl, settings, orderRun }) => {
  const order = loadOrder(settings.orderFile ?? DEFAULT_ORDER_FILE);
  const unitCount = order.products.reduce((sum, line) => sum + line.quantity, 0);
  // Per unit added: the seconds between adds (fixed at 5 since 2026-10-21) plus 35 s for the add
  // itself; orders also wait up to 15 minutes in the backoffice.
  test.setTimeout((settings.placeOrder ? 35 : 15) * 60_000 + unitCount * (35_000 + ADD_DELAY_SECONDS * 1000));
  // The person's decisions can change the delivery, and the products (OrderProducts).
  let method = order.deliveryMethod;
  let mode = order.deliveryMode;
  const decisions = orderRun.data.decisions;
  // Shell Station has no Express or Standard, only a pickup store (user's request 2026-10-30).
  const isShell = () => method === 'shell_station';
  const deliveryNow = () => ({ deliveryMethod: method, deliveryMode: isShell() ? undefined : mode });
  Object.assign(orderRun.data, { placeOrder: settings.placeOrder, ...deliveryNow() });
  const how = isShell() ? `pickup store: ${order.pickupStore === 'ask' ? 'let me choose' : 'choose for me'}` : order.deliveryMode;
  log(`Starting Watsons STAGING order test (${how}, ${order.deliveryMethod}, ${order.products.length} PLU(s), ${ADD_DELAY_SECONDS} s between adds)`);

  const loginPage = new LoginPage(page, stagingUrl);
  const search = new ProductSearch(page);
  const bag = new BagPage(page);
  const checkout = new CheckoutPage(page);
  const pickup = new ShellStationPickup(page);
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
  // The order being prepared: 1, or 2 for the second order of a partial order (2026-11-03), whose
  // steps are named "<step> (order 2)". The run's delivery is its first order's.
  let round = 1;
  const named = (step: string, n = round) => orderStep(step, n);
  const useMethod = (next: DeliveryMethod) => {
    triedMethods.push(method);
    method = next;
    if (round === 1) Object.assign(orderRun.data, deliveryNow());
    decided(decisions, `Delivery method: ${METHOD_NAMES[method]}`);
  };

  // Bag: delivery method, free gift, contents. Products the method can't take (the bag page says
  // so): the person chooses another method, to leave them out, a replacement, or to stop. Any other
  // problem: retry, another method, or stop. Ends on the checkout page, or with a replacement to add.
  type Cart = { kind: 'ready'; names: Record<string, string> } | { kind: 'replace'; plus: string[]; replacements: string[] };
  const validateCart = async (): Promise<Cart> => {
    const step = named('Cart validation');
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
        // Order 2 of a partial order keeps the method that order 1 had.
        const answer = await ask(errorQuestion(step, error, { extra: round === 1 ? otherMethods(method, triedMethods) : [] }), { action: 'stop' }, decisions);
        if (answer.action === 'switch_method' && answer.method) useMethod(answer.method);
        else if (answer.action !== 'retry') stopped(step, answer, error);
        await backToShop();
        continue;
      }
      if (!problem) continue;
      const notTaken = new StepError(
        'DELIVERY_METHOD_NOT_AVAILABLE',
        step,
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
        await retryOrAsk(step, decisions, () => products.leaveOut(leftOut));
        decided(decisions, `PLU ${leftOut.join(', ')} left out of the order`);
        // The bag page can go on showing them for a while (seen 2026-10-22): load it afresh.
        await backToShop();
      } else stopped(step, answer, notTaken);
    }
  };
  // Cart validation until the bag goes on to the checkout page; a product replaced there is added first.
  const cartToCheckout = async (): Promise<Record<string, string>> => {
    for (;;) {
      const cart = await orderRun.step(named('Cart validation'), validateCart);
      if (cart.kind === 'ready') return cart.names;
      await backToShop();
      await orderRun.step(named('Add to bag'), () => products.replace(cart.plus, cart.replacements));
    }
  };

  // Cart validation, then the checkout page's delivery mode (Shell Station: its pickup store); again
  // when the person changes the delivery method or a product there (the mode alone changes on the
  // checkout page itself). Ends on the checkout page, ready to check out. Only the first order of a
  // run can be split (a partial order, 2026-11-03).
  const toCheckout = async (): Promise<ModeResult> => {
    let namesByPlu = await cartToCheckout();
    for (;;) {
      const shell = isShell();
      const next = await orderRun.step(named(shell ? PICKUP_STORE_STEP : `${MODE_NAMES[mode]} Delivery Selection`), async () => {
        await checkout.waitUntilLoaded(shell ? pickup.storeShown : undefined);
        const chosen = shell
          ? await choosePickupStore({ checkout, pickup, choice: order.pickupStore, lines: products.lines, namesByPlu, decisions, triedMethods })
          : await chooseDelivery({ checkout, mode, method, lines: products.lines, namesByPlu, decisions, triedMethods, allowSplit: round === 1 });
        if (chosen.kind === 'ready') {
          await expect(checkout.checkoutButton).toHaveCount(1);
          await expect(checkout.checkoutButton).toBeVisible();
        }
        return chosen;
      });
      if (next.kind === 'ready') return next;
      if (next.kind === 'mode') {
        mode = next.mode;
        if (round === 1) orderRun.data.deliveryMode = mode;
        decided(decisions, `Delivery mode: ${MODE_NAMES[mode]}`);
        continue;
      }
      await backToShop();
      if (next.kind === 'method') useMethod(next.method);
      // Products the mode can't take, out of the order: Cart validation takes them out of the bag.
      else if (next.kind === 'remove') {
        products.drop(next.plus);
        decided(decisions, `PLU ${next.plus.join(', ')} taken out of the order`);
      } else await orderRun.step(named('Add to bag'), () => products.replace(next.plus, next.replacements));
      namesByPlu = await cartToCheckout();
    }
  };

  const first = await toCheckout();
  orderRun.data.ordered = first.kept;
  orderRun.data.excluded = first.excluded.map((line) => line.plu);
  if (isShell()) orderRun.data.pickupStore = first.store;
  // A partial order (2026-11-03): order 2 takes, by the other mode, the products this mode can't.
  const orders: RunOrder[] | null = first.followUp
    ? [
        { deliveryMethod: method, deliveryMode: mode, ordered: first.kept },
        { deliveryMethod: method, deliveryMode: first.followUp.mode, ordered: first.followUp.lines },
      ]
    : null;
  if (orders) {
    orderRun.data.orders = orders;
    orderRun.data.ordered = orders.flatMap((entry) => entry.ordered);
    // The launcher reads this line (launcher/launcher.cjs, PARTIAL_PLAN).
    log(plannedLine(orders));
    // Order 2 and its approval take as long again.
    test.setTimeout(test.info().timeout + 25 * 60_000);
  }
  log(`In the order${orders ? ' 1' : ''}: ${plus(first.kept)}`);
  const leftOut = isShell() ? `not available at ${orderRun.data.pickupStore ?? 'the pickup store'}` : `not ${mode}-eligible`;
  if (orderRun.data.excluded.length > 0) log(`Left out, ${leftOut}: ${orderRun.data.excluded.join(', ')}`, 'WARN');
  await test.info().attach('checkout summary', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

  if (!settings.placeOrder) {
    const then = orders ? ` with order 1 of the partial order; order 2 (PLU ${plus(orders[1].ordered)}, ${MODE_NAMES[orders[1].deliveryMode!]}) would follow from the bag` : '';
    log(`Ready to check out${then}. Placing an order is switched off for this run (npm run order or the launcher option switches it on): no order is placed.`, 'PASS');
    return;
  }

  // Place an order (switched on for this run). Pay and SUBMIT are clicked once each; nothing is
  // ever retried (PRD §41–42).
  const payment = new PaymentPage(page);
  const confirmation = new OrderConfirmationPage(page, stagingUrl);
  const placeIt = async (lines: OrderLine[]): Promise<string> => {
    const which = orders ? `order ${round} of ${orders.length}: ` : '';
    log(`Placing a test order on Watsons STAGING: ${which}${plus(lines)} (${isShell() ? `pickup at ${orderRun.data.pickupStore}` : mode}, ${method})`, 'WARN');
    await orderRun.step(named('Checkout'), () => checkout.checkout(settings.placeOrder));
    await orderRun.step(named('Pay'), () => payment.pay());
    await orderRun.step(named('OTP'), () => payment.submitOtp(settings.paymentOtp));
    const number = await orderRun.step(named('Order confirmation'), () => confirmation.orderNumber());
    await test.info().attach(named('order confirmation'), { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    return number;
  };
  const orderNumber = await placeIt(first.kept);
  orderRun.data.orderNumber = orderNumber;

  if (orders) {
    orders[0].orderNumber = orderNumber;
    // The launcher reads these lines (launcher/launcher.cjs, PARTIAL_PLACED).
    log(placedLine(orders, 0));
    // Order 2, from the bag: staging keeps there the products order 1 didn't take. Nothing is
    // emptied or removed; Cart validation checks that the bag holds exactly them.
    const notice = await confirmation.remainingNotice();
    if (notice) log(`The confirmation page says: "${notice}"`);
    else log('The confirmation page does not say that products were kept in the bag: Cart validation (order 2) checks the bag', 'WARN');
    round = 2;
    mode = orders[1].deliveryMode!;
    products.lines = orders[1].ordered.map((line) => ({ ...line }));
    await backToShop();
    const second = await toCheckout();
    Object.assign(orders[1], { deliveryMethod: method, deliveryMode: mode, ordered: second.kept });
    orderRun.data.ordered = orders.flatMap((entry) => entry.ordered);
    if (second.excluded.length > 0) {
      orderRun.data.excluded.push(...second.excluded.map((line) => line.plu));
      log(`Left out of order 2, not ${mode}-eligible: ${plus(second.excluded)}. They stay in the bag.`, 'WARN');
    }
    log(`In order 2: ${plus(second.kept)}`);
    await test.info().attach(named('checkout summary'), { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    orders[1].orderNumber = await placeIt(second.kept);
    log(placedLine(orders, 1));
  }
  // The orders of this run: a partial order's, or the one.
  const placed: RunOrder[] = orders ?? [{ deliveryMethod: method, deliveryMode: isShell() ? undefined : mode, ordered: first.kept, orderNumber }];
  const others = orders ? `; order 2: ${orders[1].orderNumber}` : '';

  // No backoffice account for this run (user's decision 2026-10-14): the order is placed and waits
  // for approval. Someone with a backoffice account approves it later ("Approve existing order",
  // also from Logs / History). The run ends on the "Thank you for your order" page, at once.
  if (!settings.backoffice) {
    // The launcher reads this line (launcher/launcher.cjs, PASS_LINES).
    log(`Order placed (not approved yet: no backoffice account for this run). Order number: ${orderNumber}${others}`, 'PASS');
    for (const entry of placed) log(`Order ${entry.orderNumber} is awaiting approval: someone with a backoffice account must approve it (Logs / History → Approve).`);
    if (orders) for (const line of summaryLines(orders)) log(line);
    return;
  }

  // Approve ("validate") the new order in the staging backoffice with the Customer Support role,
  // so it is extracted (user's request 2026-10-06). In a second tab: the confirmation page stays
  // in the first one. Approve Order is clicked at most once. If the backoffice signs the run out
  // (its account open in another tab or browser), that tab is closed and a new one signs in again
  // (src/pages/BackofficeSession.ts, user's request 2026-10-25). A partial order: each order is
  // approved, then each one's extraction is waited for.
  const session = new BackofficeSession(await page.context().newPage(), settings.backoffice!);
  const backoffice = new BackofficeOrderPage(session);
  await orderRun.step('Backoffice login', () => session.signIn());
  for (const [index, entry] of placed.entries()) {
    const number = entry.orderNumber!;
    const statusBefore = await orderRun.step(named('Find order in backoffice', index + 1), () => backoffice.open(number));
    const approved = await orderRun.step(named('Approve order', index + 1), () => backoffice.approve(number, statusBefore));
    entry.backoffice = { approved, statuses: [] };
    // The run's own: the order's, or for a partial order whether it approved them all.
    if (!orders) orderRun.data.backoffice = entry.backoffice;
    else if (index === 0) orderRun.data.backoffice = { approved, statuses: [] };
    else orderRun.data.backoffice!.approved &&= approved;
  }
  for (const [index, entry] of placed.entries()) {
    const number = entry.orderNumber!;
    const extraction = await orderRun.step(named('Order extracted', index + 1), () => backoffice.waitUntilExtracted(number));
    Object.assign(entry.backoffice!, { statuses: extraction.statuses, extractionPending: !extraction.extracted });
  }
  if (orders) Object.assign(orderRun.data.backoffice!, { statuses: [...placed[0].backoffice!.statuses], extractionPending: placed.some((entry) => entry.backoffice!.extractionPending) });
  await backoffice.showStatus(placed.at(-1)!.orderNumber!);
  await test.info().attach('backoffice order', { body: await session.page.screenshot(), contentType: 'image/png' });
  const statusText = (entry: RunOrder) => `${entry.backoffice!.statuses.at(-1)}${entry.backoffice!.extractionPending ? '; extraction still pending' : ''}`;
  const more = orders ? `; order 2: ${orders[1].orderNumber} (backoffice: ${statusText(orders[1])})` : '';
  // The launcher reads this line (launcher/launcher.cjs, PASS_LINES).
  log(`Order test completed successfully. Order number: ${orderNumber} (backoffice: ${statusText(placed[0])})${more}`, 'PASS');
  for (const entry of placed) {
    if (!entry.backoffice!.extractionPending) continue;
    log(`WTCSG${entry.orderNumber} is at ${entry.backoffice!.statuses.at(-1)}: extraction to ORDER_EXTRACTED is still pending. Wait a few minutes, then check it in the backoffice.`, 'WARN');
  }
  if (orders) for (const line of summaryLines(orders)) log(line);
  // The run ends here: no waiting for its browser to be closed (user's request 2026-10-23).
});
