import { expect, test } from '@playwright/test';
import { BackofficeOrderPage } from '../src/pages/BackofficeOrderPage';
import { BackofficeSession } from '../src/pages/BackofficeSession';
import { STAND_IN_ACCOUNT, standInBackoffice } from './helpers/stand-in-backoffice';

// Offline checks (a stand-in backoffice, never the real one) of what happens when the backoffice
// signs the run out after it has signed in: its tab back on the sign-in page, because the same
// account is open in another tab or browser (seen 2026-10-24: the run then waited minutes for
// the Orders list and failed with "not in the backoffice's Orders list"). The tab is closed, a new
// one signs in again and the step goes on (user's request 2026-10-25). Approve Order is still
// clicked at most once.

const ORDER = '07134000';
const FAST = { pauseMs: 50 };
// 20 s instead of 10 minutes, 2 s instead of the minute after Order Split, 0.2 s between looks.
const FAST_EXTRACTION = { timeoutMs: 20_000, splitWaitMs: 2_000, intervalMs: 200 };

test.describe('backoffice: signed out by the backoffice during the run', () => {
  test('nothing goes wrong: one tab, approved once, extracted', async ({ page }) => {
    const seen = await standInBackoffice(page.context());
    const session = new BackofficeSession(page, STAND_IN_ACCOUNT, FAST);
    const orders = new BackofficeOrderPage(session);
    await session.signIn();
    const status = await orders.open(ORDER);
    expect(status).toBe('Waiting For Manual Validation');
    expect(await orders.approve(ORDER, status)).toBe(true);
    expect(await orders.waitUntilExtracted(ORDER, FAST_EXTRACTION)).toEqual({ statuses: ['Order Split', 'ORDER_EXTRACTED'], extracted: true });
    expect(seen.approveClicks).toBe(1);
    expect(session.freshSessions).toBe(0);
  });

  test('signed out right after choosing the role: the tab is closed and a new one signs in', async ({ page }) => {
    const seen = await standInBackoffice(page.context(), { signOut: (moment, count) => moment === 'after-role' && count === 1 });
    const session = new BackofficeSession(page, STAND_IN_ACCOUNT, FAST);
    await session.signIn();
    await expect(session.page.getByRole('row', { name: 'Orders', exact: true })).toBeVisible();
    expect(seen.signIns).toBe(2);
    expect(page.isClosed()).toBe(true);
    expect(session.freshSessions).toBe(1);
  });

  test('signed out while finding the order: finds it from a new tab, without waiting for the list to time out', async ({ page }) => {
    const seen = await standInBackoffice(page.context(), { signOut: (moment, count) => moment === 'search' && count === 1 });
    // As in the order flow: the shop's tab stays, the backoffice has a tab of its own.
    const shop = page;
    const backofficeTab = await page.context().newPage();
    const session = new BackofficeSession(backofficeTab, STAND_IN_ACCOUNT, FAST);
    const orders = new BackofficeOrderPage(session);
    await session.signIn();
    const started = Date.now();
    expect(await orders.open(ORDER)).toBe('Waiting For Manual Validation');
    expect(Date.now() - started).toBeLessThan(20_000); // the old wait was 3 minutes
    expect(seen.signedOut).toEqual(['search #1']);
    expect(session.freshSessions).toBe(1);
    expect(backofficeTab.isClosed()).toBe(true);
    expect(shop.isClosed()).toBe(false);
    expect(page.context().pages()).toEqual([shop, session.page]);
  });

  test('signed out just before Approve Order: opens the order again in a new tab and clicks it once', async ({ page }) => {
    const seen = await standInBackoffice(page.context(), { signOut: (moment, count) => moment === 'fraud-report' && count === 1 });
    const session = new BackofficeSession(page, STAND_IN_ACCOUNT, FAST);
    const orders = new BackofficeOrderPage(session);
    await session.signIn();
    const status = await orders.open(ORDER);
    expect(await orders.approve(ORDER, status)).toBe(true);
    expect(seen.approveClicks).toBe(1);
    expect(seen.signedOut).toEqual(['fraud-report #1']);
    expect(session.freshSessions).toBe(1);
  });

  test('signed out while waiting for extraction: reads on from a new tab', async ({ page }) => {
    const seen = await standInBackoffice(page.context(), {
      signOut: (moment, _count, state) => moment === 'search' && state.approveClicks === 1 && state.signedOut.length === 0,
    });
    const session = new BackofficeSession(page, STAND_IN_ACCOUNT, FAST);
    const orders = new BackofficeOrderPage(session);
    await session.signIn();
    expect(await orders.approve(ORDER, await orders.open(ORDER))).toBe(true);
    expect(await orders.waitUntilExtracted(ORDER, FAST_EXTRACTION)).toEqual({ statuses: ['Order Split', 'ORDER_EXTRACTED'], extracted: true });
    expect(seen.approveClicks).toBe(1);
    expect(session.freshSessions).toBe(1);
  });

  test('signed out for good after Approve Order: stops, saying the order was already approved', async ({ page }) => {
    const seen = await standInBackoffice(page.context(), {
      signOut: (moment, _count, state) => state.approveClicks > 0 && (moment === 'search' || moment === 'after-role'),
    });
    const session = new BackofficeSession(page, STAND_IN_ACCOUNT, FAST);
    const orders = new BackofficeOrderPage(session);
    await session.signIn();
    expect(await orders.approve(ORDER, await orders.open(ORDER))).toBe(true);
    const error = await orders.waitUntilExtracted(ORDER, FAST_EXTRACTION).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'BACKOFFICE_LOGIN_FAILED', step: 'Order extracted' });
    expect(String((error as Error).message)).toContain('seems to be open in another tab or browser');
    expect(String((error as Error).message)).toContain('Approve Order was already clicked for WTCSG07134000');
    expect(seen.approveClicks).toBe(1);
    expect(page.context().pages()).toHaveLength(1);
  });
});
