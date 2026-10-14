import { test, expect } from '../src/fixtures/staging';
import { LoginPage } from '../src/pages/LoginPage';

test('logs in with the test account from .env', async ({ page, stagingUrl, settings }) => {
  const loginPage = new LoginPage(page, stagingUrl);
  await loginPage.open();
  await loginPage.login(settings.username, settings.password);

  // Logged in: My Account opens instead of sending us back to /login.
  await page.goto(new URL('/my-account', stagingUrl).href);
  // Staging first shows a placeholder title ("Web3 BlankPage") while its app loads the page.
  await expect(page).toHaveTitle('My Account | Watsons Singapore', { timeout: 60_000 });
});
