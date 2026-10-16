import { expect, test, type Page } from '@playwright/test';
import { BackofficeLoginPage } from '../src/pages/BackofficeLoginPage';
import { STAGING_BACKOFFICE_HOST } from '../src/safety/staging-guard';

// Offline checks of the backoffice sign-in against a stand-in backoffice (never the real one).
// When the same backoffice account is open in another browser, the backoffice can send a new
// sign-in back to its sign-in page (seen 2026-10-16): the sign-in then starts a fresh session once.

const ACCOUNT = { username: 'stand.in', password: 'stand-in-password' };
// The page reads typed values through ZK (src/utils/secrets.ts, enterPrivateTextZk): a stand-in for it.
const ZK = '<script>window.zk = { Widget: { $: (element) => ({ getValue: () => element.value }) } };</script>';
const SIGN_IN = `${ZK}
  <form onsubmit="event.preventDefault(); location.href = '/backoffice/signed-in';">
    <input name="j_username"><input name="j_password" type="password"><button>Sign In</button>
  </form>`;
const ROLES = `
  <table><tr role="row" aria-selected="false" onclick="this.setAttribute('aria-selected', 'true')"><td>WTCSG Customer Support Manager Role</td></tr></table>
  <button onclick="location.href = '/backoffice/home'">PROCEED</button>`;
const HOME = '<table><tr role="row"><td>Orders</td></tr></table>';

/** The stand-in backoffice. `bounces`: how many sign-ins it sends back to the sign-in page. */
async function standInBackoffice(page: Page, bounces: number) {
  const seen = { signIns: 0, sessionsCleared: 0 };
  await page.route(`https://${STAGING_BACKOFFICE_HOST}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    const html = (body: string, headers: Record<string, string> = {}) => route.fulfill({ contentType: 'text/html', body, headers });
    if (pathname.endsWith('/login.zul')) {
      if (!(route.request().headers().cookie ?? '').includes('JSESSIONID')) seen.sessionsCleared++;
      return html(SIGN_IN, { 'Set-Cookie': 'JSESSIONID=stand-in; Path=/' });
    }
    if (pathname.endsWith('/signed-in')) {
      seen.signIns++;
      // As seen 2026-10-16: it leaves the sign-in page, then comes back to it.
      return seen.signIns <= bounces ? html("<p>Loading…</p><script>setTimeout(() => (location.href = '/backoffice/login.zul'), 500);</script>") : html(ROLES);
    }
    return html(HOME);
  });
  return seen;
}

test.describe('backoffice sign-in', () => {
  test('signs in and chooses the Customer Support Manager role', async ({ page }) => {
    const seen = await standInBackoffice(page, 0);
    await new BackofficeLoginPage(page).signIn(ACCOUNT);
    await expect(page.getByRole('row', { name: 'Orders', exact: true })).toBeVisible();
    expect(seen.signIns).toBe(1);
  });

  test('sent back to the sign-in page once: a fresh session signs in again', async ({ page }) => {
    const seen = await standInBackoffice(page, 1);
    await new BackofficeLoginPage(page).signIn(ACCOUNT);
    await expect(page.getByRole('row', { name: 'Orders', exact: true })).toBeVisible();
    expect(seen.signIns).toBe(2);
    expect(seen.sessionsCleared).toBe(2); // the first visit, and after the session was closed
  });

  test('sent back twice: stops, saying the account seems open in another browser', async ({ page }) => {
    await standInBackoffice(page, 2);
    const error = await new BackofficeLoginPage(page).signIn(ACCOUNT).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'BACKOFFICE_LOGIN_FAILED', step: 'Backoffice login' });
    expect(String((error as Error).message)).toContain('this backoffice account seems to be open in another browser');
  });
});
