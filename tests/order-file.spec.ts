import { test, expect } from '@playwright/test';
import { loadOrder, OrderFileError, parseOrder, parseOrderNumber } from '../src/config/order';

// Offline checks of the order file reader. No browser and no website are involved.
test.describe('order file', () => {
  test('reads pasted PLUs, blank lines, notes and quantities', () => {
    const order = parseOrder(['# note', 'delivery: Click & Collect', '', '10117', '', '10321 2', '10031, 3', '46700 x4'].join('\n'));
    expect(order).toEqual({
      deliveryMethod: 'click_collect',
      deliveryMode: 'express',
      pickupStore: 'auto',
      products: [
        { plu: '10117', quantity: 1 },
        { plu: '10321', quantity: 2 },
        { plu: '10031', quantity: 3 },
        { plu: '46700', quantity: 4 },
      ],
    });
  });

  test('accepts each delivery method name', () => {
    expect(parseOrder('delivery: Home Delivery\n1').deliveryMethod).toBe('home_delivery');
    expect(parseOrder('delivery: shell station\n1').deliveryMethod).toBe('shell_station');
    expect(parseOrder('delivery: Pickup at Shell Station\n1').deliveryMethod).toBe('shell_station');
  });

  test('reads the mode, Express when not given', () => {
    expect(parseOrder('delivery: Home Delivery\n1').deliveryMode).toBe('express');
    expect(parseOrder('delivery: Home Delivery\nmode: Standard\n1').deliveryMode).toBe('standard');
    expect(() => parseOrder('delivery: Home Delivery\nmode: Rocket\n1')).toThrow(/Line 2: unknown mode "Rocket"/);
  });

  test('Shell Station: how its pickup store is chosen, the run choosing when not given (2026-10-30)', () => {
    expect(parseOrder('delivery: Shell Station\n1').pickupStore).toBe('auto');
    expect(parseOrder('delivery: Shell Station\npickup store: Let me choose\n1').pickupStore).toBe('ask');
    expect(parseOrder('delivery: Shell Station\npickup store: choose for me\n1').pickupStore).toBe('auto');
    expect(() => parseOrder('delivery: Shell Station\npickup store: Bukit Batok\n1')).toThrow(/Line 2: unknown pickup store choice "Bukit Batok"/);
  });

  test('lists every problem with its line number', () => {
    const text = ['delivery: Drone', '10117', 'abc', '10321 0', '10117'].join('\n');
    expect(() => parseOrder(text)).toThrow(OrderFileError);
    expect(() => parseOrder(text)).toThrow(/Line 1: unknown delivery method "Drone"/);
    expect(() => parseOrder(text)).toThrow(/Line 3: "abc" is not a PLU/);
    expect(() => parseOrder(text)).toThrow(/Line 4: quantity for PLU 10321 must be a whole number of 1 or more/);
    expect(() => parseOrder(text)).toThrow(/Line 5: PLU 10117 is already on line 2/);
  });

  test('needs a delivery method and at least one product', () => {
    expect(() => parseOrder('10117')).toThrow(/No delivery method/);
    expect(() => parseOrder('delivery: Home Delivery')).toThrow(/No products/);
  });

  test('the order file in test-data is valid', () => {
    const order = loadOrder();
    expect(order.products.length).toBeGreaterThan(0);
  });
});

test.describe('order number (approving an existing order)', () => {
  test('reads 8 digits, also as the backoffice code', () => {
    expect(parseOrderNumber('07091012')).toBe('07091012');
    expect(parseOrderNumber('WTCSG07091012')).toBe('07091012');
    expect(parseOrderNumber(' wtcsg 07091012 ')).toBe('07091012');
  });

  test('refuses anything else', () => {
    for (const wrong of ['', '0709101', '070910123', 'WTCSG', 'WTCSG-07091012', 'order 07091012', '07091012x']) {
      expect(parseOrderNumber(wrong), wrong).toBeUndefined();
    }
  });
});
