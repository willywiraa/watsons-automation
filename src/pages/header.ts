import type { Locator, Page } from '@playwright/test';

/** The header's bag button. Its name includes the item count, e.g. "3 MY Bag". Verified 2026-10-05. */
export function bagButton(page: Page): Locator {
  return page.getByRole('button', { name: /MY Bag$/ });
}

/**
 * Number of items in the bag, read from the header's bag button. `timeout`: how long to wait for
 * the button (default: the action timeout), e.g. short while a pop-up may be hiding it.
 */
export async function bagCount(page: Page, timeout?: number): Promise<number> {
  const text = await bagButton(page).innerText(timeout === undefined ? undefined : { timeout });
  return Number(text.match(/\d+/)?.[0] ?? NaN);
}
