import { writeFileSync } from 'node:fs';
import { parseOrderNumber } from '../src/config/order';
import { test } from '../src/fixtures/staging';
import { LoginPage } from '../src/pages/LoginPage';
import { isExtractedOrder, MyOrderPage, type ShopOrderStatus } from '../src/pages/MyOrderPage';
import { log } from '../src/utils/log';

// Whether orders are ORDER_EXTRACTED yet (user's request 2026-11-03). The hosted server starts this
// for orders whose run ended at "Order Split" (Logs / History: "Extraction pending"), until they are
// extracted (server/lib/extraction.cjs). It signs in to the staging shop with the testing account
// that placed them and opens each one under My Account (src/pages/MyOrderPage.ts). It only reads: it
// never touches the bag or the backoffice, so it can't change an order.
//   WATSONS_CHECK_ORDERS: the order numbers, separated by spaces.
//   WATSONS_CHECK_RESULT: the file to write what it found to (JSON: one entry per order).
// It has its own Playwright project ("extraction"): npm run test:e2e never runs it.

const orders = (process.env.WATSONS_CHECK_ORDERS ?? '')
  .split(/\s+/)
  .map((text) => parseOrderNumber(text))
  .filter((orderNumber): orderNumber is string => Boolean(orderNumber));

test.skip(orders.length === 0 || !process.env.WATSONS_CHECK_RESULT, 'No orders to check: set WATSONS_CHECK_ORDERS and WATSONS_CHECK_RESULT.');

test('check whether orders are extracted', async ({ page, stagingUrl, settings }) => {
  test.setTimeout(4 * 60_000 + orders.length * 90_000);
  const login = new LoginPage(page, stagingUrl);
  await login.open();
  await login.login(settings.username, settings.password);
  const myOrder = new MyOrderPage(page, stagingUrl);
  const found: (ShopOrderStatus & { checkedAt: string })[] = [];
  for (const orderNumber of orders) {
    const order = await myOrder.status(orderNumber);
    found.push({ ...order, checkedAt: new Date().toISOString() });
    if (!order.found) log(`Order ${orderNumber}: not in this account's orders`, 'WARN');
    else log(`Order ${orderNumber}: ${order.status ?? 'no status'}${isExtractedOrder(order) ? ` (extracted ${order.extractedAt ?? ''})` : ''}`);
  }
  writeFileSync(process.env.WATSONS_CHECK_RESULT!, JSON.stringify(found, null, 2));
});
