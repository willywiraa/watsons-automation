import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The test order: which PLUs to add (and how many of each) and the delivery method.
// Read from a plain text file the user can paste PLUs into (test-data/order.txt) and
// checked before anything runs (PRD §8, §37).

export type DeliveryMethod = 'home_delivery' | 'click_collect' | 'shell_station';

/** How fast: Express ("Fastest" on the checkout summary) or Standard (since 2026-10-13). */
export type DeliveryMode = 'express' | 'standard';

/**
 * Shell Station's pickup store (user's request 2026-10-30): "auto", the run chooses (the store the
 * checkout page already shows, else the first in staging's list), or "ask", the person picks one
 * from staging's list while the run waits. Shell Station has no Express or Standard.
 */
export type PickupStoreChoice = 'auto' | 'ask';

export interface OrderLine {
  plu: string;
  quantity: number;
}

export interface Order {
  deliveryMethod: DeliveryMethod;
  /** Home Delivery and Click & Collect only: Shell Station has one way to deliver (2026-10-30). */
  deliveryMode: DeliveryMode;
  /** Shell Station only. */
  pickupStore: PickupStoreChoice;
  products: OrderLine[];
}

export const DEFAULT_ORDER_FILE = join(__dirname, '..', '..', 'test-data', 'order.txt');

export class OrderFileError extends Error {
  name = 'OrderFileError';
}

const DELIVERY_NAMES: Record<string, DeliveryMethod> = {
  'home delivery': 'home_delivery',
  home_delivery: 'home_delivery',
  'click & collect': 'click_collect',
  'click and collect': 'click_collect',
  click_collect: 'click_collect',
  'shell station': 'shell_station',
  'pickup at shell station': 'shell_station',
  shell_station: 'shell_station',
};

// The pickup store line's values (the launcher writes the first ones).
const PICKUP_STORE_NAMES: Record<string, PickupStoreChoice> = {
  'choose for me': 'auto',
  auto: 'auto',
  'let me choose': 'ask',
  ask: 'ask',
};

// "10321", "10321 2", "10321,2", "10321 x2"
const PRODUCT_LINE = /^(\S+?)(?:(?:\s*[,x×]\s*|\s+)(\S+))?$/i;

export function parseOrder(text: string): Order {
  const problems: string[] = [];
  let deliveryMethod: DeliveryMethod | undefined;
  let deliveryMode: DeliveryMode = 'express';
  let pickupStore: PickupStoreChoice = 'auto';
  const products: OrderLine[] = [];
  const firstLineOf = new Map<string, number>();

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) return;

    const mode = line.match(/^mode\s*:\s*(.*)$/i);
    if (mode) {
      const value = mode[1].trim().toLowerCase();
      if (value === 'express' || value === 'standard') deliveryMode = value;
      else problems.push(`Line ${lineNumber}: unknown mode "${mode[1].trim()}" (use Express or Standard).`);
      return;
    }

    const store = line.match(/^pickup store\s*:\s*(.*)$/i);
    if (store) {
      const choice = PICKUP_STORE_NAMES[store[1].trim().toLowerCase()];
      if (choice) pickupStore = choice;
      else problems.push(`Line ${lineNumber}: unknown pickup store choice "${store[1].trim()}" (use Choose for me or Let me choose).`);
      return;
    }

    const delivery = line.match(/^delivery\s*:\s*(.*)$/i);
    if (delivery) {
      const method = DELIVERY_NAMES[delivery[1].trim().toLowerCase()];
      if (method) deliveryMethod = method;
      else problems.push(`Line ${lineNumber}: unknown delivery method "${delivery[1].trim()}" (use Home Delivery, Click & Collect or Shell Station).`);
      return;
    }

    const [, plu, quantityText] = line.match(PRODUCT_LINE) ?? [];
    if (!plu || !/^\d+$/.test(plu)) {
      problems.push(`Line ${lineNumber}: "${line}" is not a PLU (expected digits, optionally followed by a quantity).`);
      return;
    }
    const quantity = quantityText === undefined ? 1 : Number(quantityText);
    if (!Number.isInteger(quantity) || quantity < 1) {
      problems.push(`Line ${lineNumber}: quantity for PLU ${plu} must be a whole number of 1 or more.`);
      return;
    }
    const earlierLine = firstLineOf.get(plu);
    if (earlierLine !== undefined) {
      problems.push(`Line ${lineNumber}: PLU ${plu} is already on line ${earlierLine}. List it once, with a quantity (e.g. "${plu} 2").`);
      return;
    }
    firstLineOf.set(plu, lineNumber);
    products.push({ plu, quantity });
  });

  if (!deliveryMethod && !problems.some((problem) => problem.includes('delivery'))) {
    problems.push('No delivery method: add a line like "delivery: Home Delivery".');
  }
  if (products.length === 0) problems.push('No products: add at least one PLU.');
  if (problems.length > 0) {
    throw new OrderFileError(`The order file has problems:\n- ${problems.join('\n- ')}`);
  }
  return { deliveryMethod: deliveryMethod!, deliveryMode, pickupStore, products };
}

/**
 * An existing order's number as a person types it: "07091012", or its backoffice code
 * "WTCSG07091012" (spaces are ignored). Returns the 8 digits, or undefined if it isn't one.
 * Staging's order numbers have 8 digits (e.g. 07095000; seen 2026-10-05 to 2026-10-07).
 * launcher/launcher.cjs reads them the same way (tests/launcher.spec.ts keeps the two the same).
 */
export function parseOrderNumber(text: string): string | undefined {
  return text.replace(/\s+/g, '').match(/^(?:WTCSG)?(\d{8})$/i)?.[1];
}

export function loadOrder(path = DEFAULT_ORDER_FILE): Order {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    throw new OrderFileError(`Order file not found: ${path}`);
  }
  return parseOrder(text);
}
