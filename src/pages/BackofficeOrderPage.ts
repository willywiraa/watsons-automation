import { expect, type Locator, type Page } from '@playwright/test';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';

// The backoffice's Orders list and an order opened from it (Customer Support view, Phase 13).
// The backoffice code of shop order 07091025 is WTCSG07091025 (also the invoice's file name).
// See docs/staging-notes.md, "Backoffice".

export const backofficeCode = (orderNumber: string) => `WTCSG${orderNumber}`;

export class BackofficeOrderPage {
  // Verified on staging 2026-10-06 (inspection/backoffice-home, -orders): the left menu row,
  // and the text search above the list (the backoffice's own search widget).
  readonly ordersMenu: Locator;
  readonly searchBox: Locator;
  // Verified 2026-10-06 (inspection/backoffice-order): the opened order's tab.
  readonly fraudReportTab: Locator;

  constructor(private readonly page: Page) {
    this.ordersMenu = page.getByRole('row', { name: 'Orders', exact: true });
    this.searchBox = page.locator('.yw-textsearch-searchbox input');
    this.fraudReportTab = page.getByRole('tab', { name: 'Fraud Report', exact: true });
  }

  /**
   * The order's row once the list shows only it (verified 2026-10-06): named "Row 1 of 1,
   * Order Number: WTCSG…, Customer: …, …, Status: …, Total Price: …,". Once the order is
   * opened, its row is renamed, so this only works before that.
   */
  private onlyRowFor(code: string): Locator {
    return this.page.getByRole('row', { name: new RegExp(`^Row 1 of 1, Order Number: ${code},`) });
  }

  /** The order's row by its "Order Number" cell, opened or not (verified 2026-10-06). */
  private rowFor(code: string): Locator {
    return this.page.getByRole('row').filter({ has: this.page.getByRole('gridcell', { name: 'Order Number' }).getByText(code, { exact: true }) });
  }

  /**
   * Searches the list for this order and returns its "Status" cell ("Waiting For Manual
   * Validation", "ORDER_EXTRACTED", …). Works while the order is opened too (verified 2026-10-06).
   */
  async status(orderNumber: string): Promise<string> {
    const code = backofficeCode(orderNumber);
    await this.searchBox.fill(code);
    await this.searchBox.press('Enter');
    const row = this.rowFor(code);
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    return (await row.getByRole('gridcell', { name: 'Status' }).innerText()).trim();
  }

  /**
   * Opens Orders, finds the order (a new order can take a moment to reach the backoffice),
   * gives it up to 5 minutes to reach "Waiting For Manual Validation" (or be extracted), and
   * opens it. The waiting happens before opening: reading the list closes an opened order.
   * Returns its status.
   */
  async open(orderNumber: string): Promise<string> {
    const code = backofficeCode(orderNumber);
    let status = '';
    try {
      await this.ordersMenu.click();
      await expect(this.searchBox).toBeVisible({ timeout: 60_000 });
      await expect(async () => {
        status = await this.status(orderNumber);
      }).toPass({ timeout: 3 * 60_000, intervals: [10_000] });
    } catch (error) {
      throw new StepError('ORDER_NOT_FOUND_IN_BACKOFFICE', 'Find order in backoffice', `${code} is not in the backoffice's Orders list.`, [
        'the order is still on its way to the backoffice',
        'the backoffice is slow',
      ], error);
    }
    // Already approved: "Order Split" (on its way to ORDER_EXTRACTED) or extracted. Nothing to wait for.
    if (status !== WAITING_FOR_VALIDATION && !isExtracted(status) && !isSplit(status)) {
      log(`Backoffice: ${code} is "${status}"; waiting for "${WAITING_FOR_VALIDATION}"`);
      await expect(async () => {
        status = await this.status(orderNumber);
        expect(status === WAITING_FOR_VALIDATION || isExtracted(status) || isSplit(status)).toBe(true);
      })
        .toPass({ timeout: 5 * 60_000, intervals: [15_000] })
        .catch(() => {}); // approve() refuses any other status, naming it
    }
    try {
      // Verified 2026-10-06: one click on the order number opens the order with its tabs. A
      // click while the list is still refreshing after a search gets lost (seen twice), so the
      // number is clicked again while the row isn't selected (opening an order changes nothing).
      await expect(this.onlyRowFor(code)).toHaveCount(1, { timeout: 30_000 });
      const row = this.rowFor(code);
      await expect(async () => {
        if ((await row.getAttribute('aria-selected')) !== 'true') await row.getByText(code, { exact: true }).click();
        await expect(this.fraudReportTab).toBeVisible({ timeout: 15_000 });
      }).toPass({ timeout: 90_000 });
    } catch (error) {
      throw new StepError('ORDER_NOT_FOUND_IN_BACKOFFICE', 'Find order in backoffice', `${code} was found but did not open.`, ['the backoffice is slow'], error);
    }
    log(`Backoffice: opened ${code} (status: ${status})`);
    return status;
  }

  /**
   * Clicks the opened order's "Approve Order" once, only when its status (from open()) is
   * "Waiting For Manual Validation". An order already at "Order Split" or extracted is left alone. Returns whether
   * it was approved here. Never clicks twice (PRD §41–42).
   */
  async approve(orderNumber: string, status: string): Promise<boolean> {
    const code = backofficeCode(orderNumber);
    if (status !== WAITING_FOR_VALIDATION && !isExtracted(status) && !isSplit(status)) {
      throw new StepError('ORDER_APPROVAL_FAILED', 'Approve order', `${code} is "${status}", not "${WAITING_FOR_VALIDATION}", so it was not approved.`, [
        'the order failed its checks (e.g. "Checked Invalid")',
        'the order is still being processed',
      ]);
    }
    // Approved before: "Order Split" (2026-10-23) or already extracted.
    if (isExtracted(status) || isSplit(status)) {
      log(`Backoffice: ${code} is already ${status}; nothing to approve`, 'WARN');
      return false;
    }

    // Verified on staging 2026-10-06 (inspection/backoffice-fraud-report, approving 07091025):
    // the Fraud Report tab lists the order's fraud report ("…, null: WTCSG…_FR0, null: hybris,
    // null: CHECK, …") with icon buttons titled "Approve Order" and "Reject Order". After
    // approving, Approve Order gets the class "disabled" (once the order is opened again).
    const fraudReport = this.page.getByRole('row', { name: new RegExp(`null: ${code}_FR\\d+,`) });
    const approveButton = fraudReport.locator('button[title="Approve Order"]');
    try {
      await this.fraudReportTab.click();
      await expect(fraudReport).toHaveCount(1, { timeout: 60_000 });
      await expect(approveButton).toHaveCount(1);
      await expect(approveButton).not.toHaveClass(/\bdisabled\b/);
      await expect(approveButton).toBeEnabled();
    } catch (error) {
      throw new StepError('ORDER_APPROVAL_FAILED', 'Approve order', `${code} has no single enabled "Approve Order" button in its Fraud Report tab, so it was not approved.`, [
        'the order has no or several fraud reports',
        'the order was already approved',
        'the backoffice is slow',
      ], error);
    }
    try {
      await approveButton.click(); // once, never again
    } catch (error) {
      throw new StepError('ORDER_APPROVAL_UNKNOWN', 'Approve order', `Clicking "Approve Order" for ${code} did not finish. ${CHECK_BY_HAND}`, [], error);
    }
    log(`Backoffice: Approve Order clicked for ${code}`);
    return true;
  }

  /**
   * Waits until the order is extracted (seen 2026-10-06: ORDER_EXTRACTED 1–2 minutes after
   * approving), reading its status from the list every 15 s for up to 10 minutes. (The opened
   * order's summary keeps its old status, even after its Refresh button: seen 2026-10-06.)
   * Reading the list folds the opened order away.
   *
   * Once the order is "Order Split" (user's request 2026-10-23: extraction can take much longer on
   * staging), it gets at most 1 more minute: ORDER_EXTRACTED then or not, the approval is done and
   * the run can end. `extracted` says whether it got there. Returns the statuses seen.
   */
  async waitUntilExtracted(
    orderNumber: string,
    { timeoutMs = 10 * 60_000, splitWaitMs = 60_000, intervalMs = 15_000 } = {},
  ): Promise<{ statuses: string[]; extracted: boolean }> {
    const code = backofficeCode(orderNumber);
    const seen: string[] = [];
    const started = Date.now();
    let status = '';
    let splitAt: number | null = null;
    let lastError: unknown;
    for (;;) {
      try {
        status = await this.status(orderNumber);
        if (seen.at(-1) !== status) {
          seen.push(status);
          log(`Backoffice: ${code} is ${status}`);
        }
        if (isExtracted(status)) return { statuses: seen, extracted: true };
        if (isSplit(status)) splitAt ??= Date.now();
      } catch (error) {
        lastError = error; // the list didn't answer this time: read it again
      }
      if (splitAt !== null && Date.now() - splitAt >= splitWaitMs) {
        log(`Backoffice: ${code} is still ${status} ${Math.round(splitWaitMs / 1000)} s after Order Split: extraction is pending`, 'WARN');
        return { statuses: seen, extracted: false };
      }
      if (Date.now() - started >= timeoutMs) break;
      // Every 10 s once it is split, so the minute is measured closely.
      await this.page.waitForTimeout(splitAt !== null ? Math.min(intervalMs, 10_000) : intervalMs);
    }
    const minutes = Math.round(timeoutMs / 60_000);
    if (status === WAITING_FOR_VALIDATION) {
      throw new StepError('ORDER_APPROVAL_UNKNOWN', 'Order extracted', `${code} still waits for manual validation ${minutes} minutes after "Approve Order" was clicked. ${CHECK_BY_HAND}`, [], lastError);
    }
    throw new StepError('ORDER_NOT_EXTRACTED', 'Order extracted', `${code} is "${status || 'unknown'}" ${minutes} minutes after approving: neither Order Split nor ORDER_EXTRACTED.`, [
      'the backoffice is slow on staging',
      'the order is stuck: check it in the backoffice',
    ], lastError);
  }

  /**
   * For the person watching: scrolls the list (only the list, not the page) sideways so the
   * order's Status cell is in view; the list is wider than the window. Scrolling changes
   * nothing; a failure is ignored.
   */
  async showStatus(orderNumber: string): Promise<void> {
    await this.rowFor(backofficeCode(orderNumber))
      .getByRole('gridcell', { name: 'Status' })
      .evaluate((cell) => {
        let list = cell.parentElement;
        const scrollsSideways = (element: HTMLElement) =>
          element.scrollWidth > element.clientWidth && /(auto|scroll)/.test(getComputedStyle(element).overflowX);
        while (list && !scrollsSideways(list)) list = list.parentElement;
        if (!list || list === document.body || list === document.documentElement) return;
        list.scrollLeft += cell.getBoundingClientRect().right - list.getBoundingClientRect().right + 40;
      })
      .catch(() => {});
  }
}

export const WAITING_FOR_VALIDATION = 'Waiting For Manual Validation';
const isExtracted = (status: string) => /EXTRACTED/i.test(status);
/** "Order Split": approved, on its way to ORDER_EXTRACTED (seen 2026-10-23). */
export const isSplit = (status: string) => /order split/i.test(status);
const CHECK_BY_HAND = 'Check the order in the backoffice by hand before running again: "Approve Order" is never clicked twice automatically.';
