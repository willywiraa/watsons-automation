import { test, expect } from '@playwright/test';

// Phase 0 check: proves Playwright can start Microsoft Edge and read a page.
// The page is created right here in the test, so no website is visited.
test('Edge opens and shows our test page', async ({ page }) => {
  await page.setContent('<h1>Hello from Playwright</h1>');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hello from Playwright');
});
