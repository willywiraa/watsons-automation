import type { Page } from '@playwright/test';
import { STAGING_BACKOFFICE_HOST } from '../safety/staging-guard';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';
import { BackofficeLoginPage } from './BackofficeLoginPage';

// The run's backoffice tab, signed in with the Customer Support account (WATSONS_BACKOFFICE_*).
//
// When the same backoffice account is open in another tab or browser (e.g. the tester's own, not
// signed out), the backoffice can send this run's tab back to its sign-in page: right after
// signing in (seen 2026-10-16), or later while the order is being found, approved or checked
// (seen 2026-10-24: the run then waited minutes for an Orders list that never came, and failed with
// "not in the backoffice's Orders list"). Then that tab is closed, its backoffice session ended
// (cookies cleared) and a new tab signs in again, and the run carries on from where it was (user's
// request 2026-10-25). At most MAX_FRESH_SESSIONS times; then the run stops and says why.

export const MAX_FRESH_SESSIONS = 3;
const BACKOFFICE_COOKIES = new RegExp(`(^|\\.)${STAGING_BACKOFFICE_HOST.replace(/\./g, '\\.')}$`);

export type BackofficeAccount = { username: string; password: string };

/** The backoffice sent the run's tab back to its sign-in page: sign in again, then go on. */
export class SignedOut extends Error {
  name = 'SignedOut';
  constructor() {
    super('The backoffice signed this run out (its sign-in page is shown).');
  }
}

export class BackofficeSession {
  /** The backoffice tab in use: a new one after each fresh session. */
  page: Page;
  /** Fresh sessions started so far, each in a new tab. */
  freshSessions = 0;
  /** Added to the error when signing in again gives up (e.g. that Approve Order was already clicked). */
  note = '';

  /** `pauseMs`: the wait between ending a session and signing in again (shorter in the offline tests). */
  constructor(page: Page, private readonly account: BackofficeAccount, private readonly options: { pauseMs?: number } = {}) {
    this.page = page;
  }

  /**
   * Signs in with the Customer Support Manager role. When the backoffice sends the sign-in back to
   * its sign-in page (the account is open somewhere else), a fresh session in a new tab tries again.
   */
  async signIn(step = 'Backoffice login'): Promise<void> {
    while ((await new BackofficeLoginPage(this.page).signInOnce(this.account, step)) === 'sign-in') {
      await this.freshTab(step, 'The backoffice went back to its sign-in page right after signing in');
    }
  }

  /** Whether the backoffice has sent this tab back to its sign-in page. */
  async signedOut(): Promise<boolean> {
    if (this.page.isClosed()) return true;
    let path = '';
    try {
      path = new URL(this.page.url()).pathname;
    } catch {
      // about:blank and the like: not the sign-in page
    }
    if (/\/login\.zul$/i.test(path)) return true;
    return new BackofficeLoginPage(this.page).userBox.isVisible().catch(() => false);
  }

  /** Signed out during `step`: closes this tab, ends its session, and signs in again in a new tab. */
  async signInAgain(step: string): Promise<void> {
    await this.freshTab(step, 'The backoffice signed this run out (its tab went back to the sign-in page)');
    await this.signIn(step);
  }

  /** Closes the backoffice tab and ends its session (cookies); the next sign-in is in a new tab. */
  private async freshTab(step: string, what: string): Promise<void> {
    if (this.freshSessions >= MAX_FRESH_SESSIONS) {
      throw new StepError(
        'BACKOFFICE_LOGIN_FAILED',
        step,
        `${what} again, after ${MAX_FRESH_SESSIONS} fresh sessions in new tabs: this backoffice account seems to be open in another tab or browser.${this.note ? ` ${this.note}` : ''}`,
        ['the same backoffice account is open in another browser tab (e.g. your own): sign out there or close that tab, then run again'],
      );
    }
    this.freshSessions += 1;
    log(
      `${what}: this backoffice account is probably open in another tab or browser. Closing this backoffice tab and signing in again in a new one (${this.freshSessions} of ${MAX_FRESH_SESSIONS}).`,
      'WARN',
    );
    const old = this.page;
    const context = old.context();
    // The new tab first, so the run's browser always has one open (Live browser follows it).
    this.page = await context.newPage();
    await old.close().catch(() => {});
    await context.clearCookies({ domain: BACKOFFICE_COOKIES });
    await this.page.waitForTimeout(this.options.pauseMs ?? 5_000);
  }
}
