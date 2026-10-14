import { test, expect } from '@playwright/test';
import { buildOrderResult, formatResultBox } from '../src/reporting/order-result';
import { pageAddress, type OrderRunSnapshot } from '../src/reporting/order-run';

// Offline checks of the order result (reports/<run>/result.json) and the PASS/FAIL box.
const run: OrderRunSnapshot = {
  startedAt: '2026-10-05T13:26:00.000Z',
  completedStep: 'Order confirmation',
  currentStep: 'Order confirmation',
  placeOrder: true,
  deliveryMethod: 'home_delivery',
  deliveryMode: 'express',
  ordered: [{ plu: '10321', quantity: 1 }, { plu: '10031', quantity: 2 }],
  soldOut: ['10117'],
  excluded: ['46465'],
  freeGiftRemoved: null,
  orderNumber: '07088016',
  backoffice: { approved: true, statuses: ['Order Split', 'ORDER_EXTRACTED'] },
  consoleErrors: [],
};
const artifacts = { folder: 'reports/x', screenshots: [] };

test.describe('order result', () => {
  test('a placed order passes with its number', () => {
    const result = buildOrderResult({ runId: 'x', run, passed: true, durationMs: 252_000, artifacts });
    expect(result).toMatchObject({ status: 'passed', outcome: 'order_placed', orderNumber: '07088016', completedStep: 'Order confirmation' });
    expect(result.error).toBeUndefined();
    const box = formatResultBox(result);
    expect(box).toContain('ORDER TEST PASSED');
    expect(box).toContain('Order Number: 07088016');
    expect(box).toContain('Backoffice: ORDER_EXTRACTED');
    expect(result.backoffice).toEqual({ approved: true, statuses: ['Order Split', 'ORDER_EXTRACTED'], finalStatus: 'ORDER_EXTRACTED' });
    expect(box).toContain('Left out (not eligible): 46465');
    expect(box).toContain('Duration: 04:12');
  });

  test('a run with ordering switched off is "ready to check out"', () => {
    const dryRun = { ...run, placeOrder: false, orderNumber: undefined, completedStep: 'Express Delivery Selection' };
    const result = buildOrderResult({ runId: 'x', run: dryRun, passed: true, durationMs: 1_000, artifacts });
    expect(result.outcome).toBe('ready_to_check_out');
    expect(formatResultBox(result)).toContain('READY TO CHECK OUT (NO ORDER PLACED)');
  });

  test('a failure names the step, code and reason from the StepError', () => {
    const failed = { ...run, orderNumber: undefined, completedStep: 'Login', currentStep: 'Product Search' };
    const message = '\u001b[31m❌ PRODUCT_NOT_FOUND\u001b[39m\n\nStep: Product Search\nReason: No product found for PLU 99999.\n    at somewhere (file.ts:1:1)';
    const result = buildOrderResult({ runId: 'x', run: failed, passed: false, durationMs: 5_000, errorMessage: message, artifacts });
    expect(result).toMatchObject({ status: 'failed', outcome: 'failed', completedStep: 'Login' });
    expect(result.error).toMatchObject({ code: 'PRODUCT_NOT_FOUND', step: 'Product Search' });
    expect(result.error!.message).not.toContain('at somewhere');
    const box = formatResultBox(result);
    expect(box).toContain('ORDER TEST FAILED');
    expect(box).toContain('Step: Product Search');
    expect(box).toContain('Reason: No product found for PLU 99999.');
  });

  test('a failure without a StepError falls back to the step that was running', () => {
    const result = buildOrderResult({ runId: 'x', run: { ...run, currentStep: 'Pay' }, passed: false, durationMs: 1, errorMessage: 'TimeoutError: boom', artifacts });
    expect(result.error).toMatchObject({ step: 'Pay', code: undefined });
  });

  test('runs from before the automation type are order runs', () => {
    const result = buildOrderResult({ runId: 'x', run, passed: true, durationMs: 1, artifacts });
    expect(result.automation).toBe('order');
  });

  test('an approval run is "approved", or "no change" when the order was already extracted', () => {
    const approval: OrderRunSnapshot = {
      ...run,
      automation: 'approve',
      placeOrder: false,
      deliveryMethod: undefined,
      deliveryMode: undefined,
      ordered: [],
      soldOut: [],
      excluded: [],
      orderNumber: '07091012',
      completedStep: 'Order extracted',
      backoffice: { approved: true, statuses: ['Waiting For Manual Validation', 'ORDER_EXTRACTED'] },
    };
    const approved = buildOrderResult({ runId: 'x', run: approval, passed: true, durationMs: 90_000, artifacts });
    expect(approved).toMatchObject({ status: 'passed', automation: 'approve', outcome: 'approved', orderNumber: '07091012' });
    const box = formatResultBox(approved);
    expect(box).toContain('ORDER APPROVED');
    expect(box).toContain('Order Number: 07091012');
    expect(box).toContain('Backoffice: ORDER_EXTRACTED');
    expect(box).not.toContain('Delivery:');

    const unchanged = buildOrderResult({ runId: 'x', run: { ...approval, backoffice: { approved: false, statuses: ['ORDER_EXTRACTED'] } }, passed: true, durationMs: 1, artifacts });
    expect(unchanged.outcome).toBe('no_change');
    expect(formatResultBox(unchanged)).toContain('NO CHANGE (ALREADY EXTRACTED)');

    const failed = buildOrderResult({
      runId: 'x',
      run: { ...approval, backoffice: undefined, currentStep: 'Find order in backoffice' },
      passed: false,
      durationMs: 1,
      errorMessage: '❌ ORDER_NOT_FOUND_IN_BACKOFFICE\n\nStep: Find order in backoffice\nReason: WTCSG07091012 is not in the backoffice\'s Orders list.',
      artifacts,
    });
    expect(failed).toMatchObject({ outcome: 'failed', automation: 'approve', error: { code: 'ORDER_NOT_FOUND_IN_BACKOFFICE' } });
    expect(formatResultBox(failed)).toContain('APPROVAL FAILED');
    expect(formatResultBox(failed)).toContain('Order Number: 07091012');
  });

  test('a failure records when it happened, the open pages and their screenshots', () => {
    const failing = { ...run, orderNumber: undefined, failure: { at: '2026-10-07T06:32:05.000Z', pages: ['https://testsecureacceptance.cybersource.com/pay'] } };
    const result = buildOrderResult({
      runId: 'x',
      run: failing,
      passed: false,
      durationMs: 5_000,
      errorMessage: '❌ PAYMENT_FAILED\n\nStep: Checkout\nReason: Clicking Checkout did not open the payment page.',
      artifacts: { folder: 'reports/x', screenshots: ['reports/x/screenshot-1-checkout-summary.png', 'reports/x/screenshot-2-failure.png'] },
      failureScreenshots: ['reports/x/screenshot-2-failure.png'],
    });
    expect(result.error).toMatchObject({
      code: 'PAYMENT_FAILED',
      step: 'Checkout',
      at: '2026-10-07T06:32:05.000Z',
      pages: ['https://testsecureacceptance.cybersource.com/pay'],
      screenshots: ['reports/x/screenshot-2-failure.png'],
    });
    // Without a recorded failure time, the run's end stands in for it.
    const untimed = buildOrderResult({ runId: 'x', run: { ...run, failure: undefined }, passed: false, durationMs: 5_000, errorMessage: 'boom', artifacts });
    expect(untimed.error).toMatchObject({ at: untimed.finishedAt, pages: [], screenshots: [] });
  });

  test('page addresses in the evidence leave out query strings, which can hold login details', () => {
    expect(pageAddress('https://shop.example.test/login?code=secret#token=x')).toBe('https://shop.example.test/login');
    expect(pageAddress('https://backoffice.example.test/backoffice/')).toBe('https://backoffice.example.test/backoffice/');
    expect(pageAddress('about:blank')).toBe('about:blank');
    expect(pageAddress('not an address?x=1')).toBe('not an address');
  });
});
