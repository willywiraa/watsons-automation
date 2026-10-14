import { test, expect } from '../src/fixtures/staging';
import { BagPage } from '../src/pages/BagPage';
import { bagCount } from '../src/pages/header';
import { LoginPage } from '../src/pages/LoginPage';
import { log } from '../src/utils/log';

// Empties the test account's bag (also useful on its own: npx playwright test bag-empty).
test('empties the bag', async ({ page, stagingUrl, settings }) => {
  test.setTimeout(10 * 60_000);
  const loginPage = new LoginPage(page, stagingUrl);
  const bag = new BagPage(page);
  await loginPage.open();
  await loginPage.login(settings.username, settings.password);

  await bag.open();
  log(`Bag holds ${await bag.items.count()} product(s) before emptying`);
  await bag.empty();

  await expect(bag.items).toHaveCount(0);
  expect(await bagCount(page)).toBe(0);
});
