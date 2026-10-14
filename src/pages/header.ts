import type { Locator, Page } from '@playwright/test';

/** The header's bag button. Its name includes the item count, e.g. "3 MY Bag". Verified 2026-10-05. */
export function bagButton(page: Page): Locator {
  return page.getByRole('button', { name: /MY Bag$/ });
}

/** Number of items in the bag, read from the header's bag button. */
export async function bagCount(page: Page): Promise<number> {
  const text = await bagButton(page).innerText();
  return Number(text.match(/\d+/)?.[0] ?? NaN);
}
