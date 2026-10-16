import { expect, type Locator, type Page } from '@playwright/test';
import { STAGING_BACKOFFICE_HOST } from '../safety/staging-guard';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';
import { enterPrivateTextZk, withRecordingPaused } from '../utils/secrets';

// Signing in to the staging backoffice with the Customer Support account (WATSONS_BACKOFFICE_*),
// to approve the new order (Phase 13). The backoffice is built with ZK: element ids change on
// every visit, so none are used. See docs/staging-notes.md, "Backoffice".

const LOGIN_URL = `https://${STAGING_BACKOFFICE_HOST}/backoffice/login.zul`;

export class BackofficeLoginPage {
  // Verified on staging 2026-10-06 (inspection/backoffice-login): the form's field names.
  readonly userBox: Locator;
  readonly passwordBox: Locator;
  readonly signInButton: Locator;
  // Verified 2026-10-06 (inspection/backoffice-after-signin): after Sign In, "Authority Groups"
  // lists three role rows (the first one selected) and a PROCEED button.
  readonly customerSupportRole: Locator;
  readonly proceedButton: Locator;
  // Verified 2026-10-06 (inspection/backoffice-home): the left menu row of the main screen.
  readonly ordersMenu: Locator;

  constructor(private readonly page: Page) {
    this.userBox = page.locator('input[name="j_username"]');
    this.passwordBox = page.locator('input[name="j_password"]');
    this.signInButton = page.getByRole('button', { name: 'Sign In', exact: true });
    this.customerSupportRole = page.getByRole('row', { name: /WTCSG Customer Support Manager Role/ });
    this.proceedButton = page.getByRole('button', { name: 'PROCEED', exact: true });
    this.ordersMenu = page.getByRole('row', { name: 'Orders', exact: true });
  }

  /**
   * Signs in with the Customer Support Manager role. The account never appears in reports or recordings.
   *
   * When the same backoffice account is open in another browser (e.g. the tester's own), the
   * backoffice can send this sign-in back to its sign-in page instead of the role choice (seen
   * 2026-10-16). Then this backoffice session is closed (its cookies cleared) and a fresh one signs
   * in once more (user's request 2026-10-16); if that is sent back too, the run stops and says why.
   */
  async signIn(account: { username: string; password: string }): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      if ((await this.signInOnce(account)) === 'roles') break;
      if (attempt === 2) {
        throw new StepError(
          'BACKOFFICE_LOGIN_FAILED',
          'Backoffice login',
          'The backoffice went back to its sign-in page after signing in, twice: this backoffice account seems to be open in another browser.',
          ['the same backoffice account is open in another browser (e.g. your own): close that backoffice tab or sign out there, then run again'],
        );
      }
      log('The backoffice went back to its sign-in page after signing in (the account may be open in another browser). Closing this backoffice session and signing in again.', 'WARN');
      await this.page.context().clearCookies({ domain: new RegExp(`(^|\\.)${STAGING_BACKOFFICE_HOST.replace(/\./g, '\\.')}$`) });
      await this.page.waitForTimeout(5_000);
    }
    await this.chooseRole();
  }

  /** Opens the sign-in page and signs in. Returns where the backoffice went: the role choice, or its sign-in page again. */
  private async signInOnce(account: { username: string; password: string }): Promise<'roles' | 'sign-in'> {
    const failed = (reason: string, error: unknown, causes: string[] = []) =>
      new StepError('BACKOFFICE_LOGIN_FAILED', 'Backoffice login', reason, causes, error);

    try {
      await this.page.goto(LOGIN_URL);
      await expect(this.userBox).toBeVisible({ timeout: 60_000 });
    } catch (error) {
      throw failed('The backoffice sign-in page did not appear.', error, ['the backoffice is down or very slow']);
    }

    try {
      await withRecordingPaused(
        this.page.context(),
        async () => {
          await enterPrivateTextZk(this.userBox, account.username);
          await enterPrivateTextZk(this.passwordBox, account.password);
          await this.signInButton.click();
          // Recording restarts only once the password field is gone.
          await expect(this.passwordBox).toBeHidden({ timeout: 60_000 });
        },
        [this.userBox, this.passwordBox],
      );
    } catch (error) {
      throw failed('Still on the sign-in page after clicking Sign In.', error, [
        'wrong backoffice user name or password (in .env, or the backoffice account entered on the hosted server)',
        'the backoffice account is locked',
        'the same backoffice account is open in another browser (e.g. your own): close that backoffice tab or sign out there',
        'the backoffice is slow',
      ]);
    }

    // The role choice, or the sign-in page again.
    try {
      await expect(this.customerSupportRole.or(this.userBox)).toBeVisible({ timeout: 60_000 });
    } catch (error) {
      throw failed('Could not choose the "WTCSG Customer Support Manager Role".', error, [
        'the backoffice account does not have that role',
        'the backoffice is slow',
      ]);
    }
    if (await this.customerSupportRole.isVisible()) return 'roles';
    // The sign-in form for good, not just the old page on its way out.
    const roles = await this.customerSupportRole.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false);
    return roles ? 'roles' : 'sign-in';
  }

  private async chooseRole(): Promise<void> {
    const failed = (reason: string, error: unknown, causes: string[] = []) =>
      new StepError('BACKOFFICE_LOGIN_FAILED', 'Backoffice login', reason, causes, error);
    try {
      await expect(this.customerSupportRole).toBeVisible({ timeout: 60_000 });
      await this.customerSupportRole.click();
      await expect(this.customerSupportRole).toHaveAttribute('aria-selected', 'true');
      await this.proceedButton.click();
      await expect(this.proceedButton).toBeHidden({ timeout: 60_000 });
      await expect(this.ordersMenu).toBeVisible({ timeout: 60_000 });
    } catch (error) {
      throw failed('Could not choose the "WTCSG Customer Support Manager Role".', error, [
        'the backoffice account does not have that role',
        'the backoffice is slow',
      ]);
    }
    log('Backoffice: signed in as Customer Support Manager');
  }
}
