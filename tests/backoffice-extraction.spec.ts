import { expect, test, type Page } from '@playwright/test';
import { BackofficeOrderPage } from '../src/pages/BackofficeOrderPage';
import { BackofficeSession } from '../src/pages/BackofficeSession';
import { StepError } from '../src/utils/errors';
import { STAND_IN_ACCOUNT } from './helpers/stand-in-backoffice';

// Offline checks of the wait after "Approve Order" (user's request 2026-10-23): ORDER_EXTRACTED
// ends it at once; once the order is "Order Split" it gets at most one more minute (shortened
// here), then the run ends either way, saying whether extraction is still pending.

/** A backoffice whose order shows these statuses, one per look (the last one stays). */
function backofficeShowing(page: Page, statuses: string[]): BackofficeOrderPage {
  const orders = new BackofficeOrderPage(new BackofficeSession(page, STAND_IN_ACCOUNT));
  let look = 0;
  orders.status = async () => statuses[Math.min(look++, statuses.length - 1)];
  return orders;
}
// 3 s instead of 10 minutes, 0.4 s instead of the minute after Order Split.
const fast = { timeoutMs: 3_000, splitWaitMs: 400, intervalMs: 100 };

test.describe('waiting for extraction after Approve Order', () => {
  test('ORDER_EXTRACTED: done at once', async ({ page }) => {
    const result = await backofficeShowing(page, ['Waiting For Manual Validation', 'Order Split', 'ORDER_EXTRACTED']).waitUntilExtracted('07131022', fast);
    expect(result).toEqual({ statuses: ['Waiting For Manual Validation', 'Order Split', 'ORDER_EXTRACTED'], extracted: true });
  });

  test('"Order Split" and no ORDER_EXTRACTED within the minute: done, extraction pending', async ({ page }) => {
    const started = Date.now();
    const result = await backofficeShowing(page, ['Waiting For Manual Validation', 'Order Split']).waitUntilExtracted('07131022', fast);
    expect(result).toEqual({ statuses: ['Waiting For Manual Validation', 'Order Split'], extracted: false });
    // The minute after Order Split, not the whole wait.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('neither Order Split nor ORDER_EXTRACTED in time: ORDER_NOT_EXTRACTED, as before', async ({ page }) => {
    const error = await backofficeShowing(page, ['Fraud Check']).waitUntilExtracted('07131022', fast).catch((caught) => caught);
    expect(error).toBeInstanceOf(StepError);
    expect(error.code).toBe('ORDER_NOT_EXTRACTED');
    expect(error.message).toContain('WTCSG07131022 is "Fraud Check"');
  });

  test('still waiting for manual validation after Approve Order: the approval is unknown', async ({ page }) => {
    const error = await backofficeShowing(page, ['Waiting For Manual Validation']).waitUntilExtracted('07131022', fast).catch((caught) => caught);
    expect(error).toBeInstanceOf(StepError);
    expect(error.code).toBe('ORDER_APPROVAL_UNKNOWN');
  });

  test('an order already at "Order Split" was approved before: Approve Order is not clicked', async ({ page }) => {
    expect(await new BackofficeOrderPage(new BackofficeSession(page, STAND_IN_ACCOUNT)).approve('07131022', 'Order Split')).toBe(false);
  });
});
