import { test, expect } from '../src/fixtures/staging';

// Online checks against the approved staging site. Look-only: nothing is clicked, typed
// or submitted. Expected values come from the inspection/ captures of 2026-10-04.

test('opens the approved staging site', async ({ page, stagingUrl }) => {
  const response = await page.goto(stagingUrl.href);

  expect(response?.ok()).toBe(true);
  expect(new URL(page.url()).host).toBe(stagingUrl.host);
  await expect(page).toHaveTitle(/Watsons Singapore/);
});

test('sends a logged-out visitor from My Account to the login page', async ({ page, stagingUrl }) => {
  // "/my-account" is the home page's "My Account" link.
  await page.goto(new URL('/my-account', stagingUrl).href);

  await expect(page).toHaveURL(/\/login$/);
  await expect(page).toHaveTitle('Login | Watsons Singapore');
  // Verified on staging 2026-10-04: the login page's only level-1 heading.
  await expect(page.getByRole('heading', { name: 'Login', level: 1, exact: true })).toBeVisible();
});
