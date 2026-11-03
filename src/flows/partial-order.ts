import type { DeliveryMethod } from '../config/order';
import { MODE_NAMES } from '../pages/CheckoutPage';
import type { RunOrder } from '../reporting/order-run';
import { METHOD_NAMES, plusText } from './order-issues';

// A partial order (user's request 2026-11-03). When some products can't go by the chosen delivery
// mode but the other mode takes them all, the run can split the order in two: order 1 goes by the
// chosen mode without them, staging keeps them in the bag ("The remaining 1 items have been added to
// your bag."), and order 2 takes them from there by the other mode. Nothing is removed from the
// bag. The run is complete once every order is placed (and approved, with a backoffice account).
//
// The steps of order 2 are named "<step> (order 2)", and the launcher reads the plan and placed
// lines below (launcher/launcher.cjs: PARTIAL_PLAN, PARTIAL_PLACED; tests/launcher.spec.ts keeps
// the two the same).

/** A step of order `n`: "Checkout" for order 1, "Checkout (order 2)" for order 2. */
export const orderStep = (step: string, n: number): string => (n > 1 ? `${step} (order ${n})` : step);

const howDelivered = (order: RunOrder) => (order.deliveryMode ? MODE_NAMES[order.deliveryMode] : METHOD_NAMES[order.deliveryMethod as DeliveryMethod]);

/** "Partial order planned: order 1 by Express (PLU 10031, 46700), order 2 by Standard (PLU 17562)" */
export const plannedLine = (orders: RunOrder[]): string =>
  `Partial order planned: ${orders.map((order, index) => `order ${index + 1} by ${howDelivered(order)} (PLU ${plusText(order.ordered)})`).join(', ')}`;

/** "Order 2 of 2 placed: 07156004 (Standard, Click & Collect)" */
export const placedLine = (orders: RunOrder[], index: number): string =>
  `Order ${index + 1} of ${orders.length} placed: ${orders[index].orderNumber} (${howDelivered(orders[index])}, ${METHOD_NAMES[orders[index].deliveryMethod]})`;

/** The order's status for the summary: the backoffice's last one, else that it waits for approval. */
const statusOf = (order: RunOrder): string => {
  const final = order.backoffice?.statuses.at(-1);
  if (!final) return order.orderNumber ? 'placed, awaiting approval' : 'not placed';
  return `${final}${order.backoffice?.extractionPending ? ' (extraction still pending)' : ''}`;
};

/** One line per order, for the end of the run: "Order 1 of 2: 07156003 (Express, Click & Collect, PLU 10031, 46700): ORDER_EXTRACTED". */
export const summaryLines = (orders: RunOrder[]): string[] =>
  orders.map(
    (order, index) =>
      `Order ${index + 1} of ${orders.length}: ${order.orderNumber ?? 'not placed'} (${howDelivered(order)}, ${METHOD_NAMES[order.deliveryMethod]}, PLU ${plusText(order.ordered)}): ${statusOf(order)}`,
  );
