import { expect, test } from '@playwright/test';
import { BackofficeSession, MAX_FRESH_SESSIONS } from '../src/pages/BackofficeSession';
import { STAND_IN_ACCOUNT, standInBackoffice } from './helpers/stand-in-backoffice';

// Offline checks of the backoffice sign-in against a stand-in backoffice (never the real one).
// When the same backoffice account is open in another tab or browser, the backoffice can send a
// new sign-in back to its sign-in page (seen 2026-10-16): the tab is then closed and a fresh
// session signs in again in a new tab (user's request 2026-10-25), at most MAX_FRESH_SESSIONS times.

const FAST = { pauseMs: 50 };

test.describe('backoffice sign-in', () => {
  test('signs in and chooses the Customer Support Manager role', async ({ page }) => {
    const seen = await standInBackoffice(page.context());
    const session = new BackofficeSession(page, STAND_IN_ACCOUNT, FAST);
    await session.signIn();
    await expect(session.page.getByRole('row', { name: 'Orders', exact: true })).toBeVisible();
    expect(seen.signIns).toBe(1);
    expect(session.page).toBe(page);
    expect(session.freshSessions).toBe(0);
  });

  test('sent back to the sign-in page once: the tab is closed and a new one signs in again', async ({ page }) => {
    const seen = await standInBackoffice(page.context(), { signOut: (moment, count) => moment === 'after-sign-in' && count === 1 });
    const session = new BackofficeSession(page, STAND_IN_ACCOUNT, FAST);
    await session.signIn();
    await expect(session.page.getByRole('row', { name: 'Orders', exact: true })).toBeVisible();
    expect(seen.signIns).toBe(2);
    expect(seen.sessionsCleared).toBe(2); // the first visit, and after the session was ended
    expect(page.isClosed()).toBe(true);
    expect(page.context().pages()).toEqual([session.page]);
    expect(session.freshSessions).toBe(1);
  });

  test('sent back every time: stops after the fresh sessions, saying the account seems open elsewhere', async ({ page }) => {
    const seen = await standInBackoffice(page.context(), { signOut: (moment) => moment === 'after-sign-in' });
    const session = new BackofficeSession(page, STAND_IN_ACCOUNT, FAST);
    const error = await session.signIn().catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'BACKOFFICE_LOGIN_FAILED', step: 'Backoffice login' });
    expect(String((error as Error).message)).toContain('this backoffice account seems to be open in another tab or browser');
    expect(seen.signIns).toBe(MAX_FRESH_SESSIONS + 1);
    expect(page.context().pages()).toHaveLength(1); // the old tabs are closed
  });
});
