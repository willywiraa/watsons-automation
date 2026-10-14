import { expect, type Frame, type Locator, type Page } from '@playwright/test';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';
import { enterPrivateText, withRecordingPaused } from '../utils/secrets';
import { closeCookieNoticeIfShown, dismissBiometricPromptIfShown } from './popups';

// Logging in (PRD §10–11). See docs/staging-notes.md, "Logging in".
export class LoginPage {
  // Verified on staging 2026-10-04 (inspection/login/proof.png, 3 runs out of 3).
  readonly emailBox: Locator;
  readonly passwordBox: Locator;
  readonly loginButton: Locator;
  // Verified on staging 2026-10-04: once logged in, the header's "LOGIN" text reads
  // "Account". (The hidden account pop-up has another "Account" title, so visible only.)
  readonly loggedInSign: Locator;

  constructor(
    private readonly page: Page,
    private readonly stagingUrl: URL,
  ) {
    this.emailBox = page.getByRole('textbox', { name: 'Watsons Club Card/Email', exact: true });
    this.passwordBox = page.getByRole('textbox', { name: 'Password', exact: true });
    this.loginButton = page.getByRole('button', { name: 'Login', exact: true });
    this.loggedInSign = page
      .getByRole('banner')
      .getByText('Account', { exact: true })
      .filter({ visible: true });
  }

  async open(): Promise<void> {
    const loginUrl = new URL('/login', this.stagingUrl).href;
    // Staging can take 10+ seconds to show a page, sometimes stays blank, and sometimes never
    // finishes loading it (seen 2026-10-05). Then load the page once more. Opening the login page
    // changes nothing, so loading it again is safe. The page must finish loading before typing:
    // starting earlier (as soon as the form showed) left Login doing nothing in 2 of 7 runs.
    const openAndWait = async () => {
      await this.page.goto(loginUrl);
      await expect(this.emailBox).toBeVisible({ timeout: 45_000 });
    };
    try {
      try {
        await openAndWait();
      } catch {
        log('Login page not shown after 45 s; loading it once more', 'WARN');
        await openAndWait();
      }
    } catch (error) {
      throw new StepError('LOGIN_FAILED', 'Open login page', 'The login form did not appear.', [
        'staging is down or very slow',
        'the login page changed',
      ], error);
    }
  }

  /** Logs in and checks it worked. Username and password never appear in reports or recordings. */
  async login(username: string, password: string): Promise<void> {
    await closeCookieNoticeIfShown(this.page);
    // Pages the browser goes through after clicking Login (address paths only: no query
    // strings or form contents), to explain a failed login.
    const pagesVisited: string[] = [];
    const recordPage = (frame: Frame) => {
      if (frame === this.page.mainFrame()) {
        const { host, pathname } = new URL(frame.url());
        pagesVisited.push(`${host.split('.')[0]}${pathname}`);
      }
    };
    this.page.on('framenavigated', recordPage);
    try {
      await withRecordingPaused(
        this.page.context(),
        async () => {
          // Keep recording off until the login is finished, i.e. we have left /login.
          const leftLoginPage = (timeout: number) =>
            this.page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout }).then(() => true, () => false);
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              await enterPrivateText(this.emailBox, username);
              await enterPrivateText(this.passwordBox, password);
              await closeCookieNoticeIfShown(this.page);
              await this.loginButton.click();
            } catch (error) {
              // A slow earlier attempt may have just finished logging in (seen 2026-10-05).
              if (await leftLoginPage(1_000)) return;
              throw error;
            }
            if (await leftLoginPage(45_000)) return;
            // Staging sometimes resets the form instead of logging in, when the click came before
            // its app had started (seen 2026-10-05). Only then is trying again safe: with the
            // details still filled in, it is a real login problem (no retry, to avoid a lockout).
            const formWasReset = (await this.passwordBox.inputValue().catch(() => '')) === '';
            if (!formWasReset) throw new Error('Still on the login page with the details filled in.');
            // An empty form can also mean the login is still going on: give it a little longer.
            if (await leftLoginPage(15_000)) return;
            if (attempt === 2) throw new Error('The login form was reset twice.');
            log('The login form was reset (page still starting up); trying again', 'WARN');
          }
        },
        // Emptied if anything above fails, so the failure evidence can't contain them.
        [this.emailBox, this.passwordBox],
      );
    } catch (error) {
      const trail = pagesVisited.length > 0 ? pagesVisited.join(' → ') : 'none';
      throw new StepError(
        'LOGIN_FAILED',
        'Login',
        `Still on the login page after clicking Login. Pages visited: ${trail}`,
        [
          'wrong username or password (in .env, or the testing account entered on the hosted server)',
          'the account is locked or needs verification',
          'staging is down or very slow',
        ],
        error,
      );
    } finally {
      this.page.off('framenavigated', recordPage);
    }

    await dismissBiometricPromptIfShown(this.page);

    try {
      await expect(this.loggedInSign).toHaveCount(1, { timeout: 30_000 });
    } catch (error) {
      throw new StepError('LOGIN_FAILED', 'Confirm login', 'The header does not show "Account" after logging in.', [
        'the login did not complete',
        'an unexpected pop-up is covering the page',
        'the header changed',
      ], error);
    }
    log('Login successful');
  }
}
