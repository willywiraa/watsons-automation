import { expect, type Locator, type Page } from '@playwright/test';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';

// Optional pop-ups that can appear on any staging page (docs/staging-notes.md).

/**
 * Closes the cookie notice if it is showing. It can appear late and cover buttons near the
 * bottom of the window (e.g. Login). Verified on staging 2026-10-04.
 */
export async function closeCookieNoticeIfShown(page: Page): Promise<void> {
  const close = page
    .getByRole('region', { name: 'Cookie banner' })
    .getByRole('button', { name: 'Close', exact: true });
  if (await close.isVisible()) {
    await close.click();
    await expect(close).toBeHidden();
    log('Cookie notice closed');
  }
}

/**
 * The shop's promotion pop-up (".mp-popup-banners"): it can appear after login and cover the
 * header (seen 2026-10-13: it blocked the "MY Bag" button). Its close control is an
 * <i class="icon-close">. Called once per page: Playwright then closes the pop-up whenever it is
 * in the way of an action.
 */
export async function closePromoPopupWhenShown(page: Page): Promise<void> {
  const popup = page.locator('.mp-popup-banners.active');
  await page.addLocatorHandler(popup, async () => {
    await popup.locator('.icon-close').first().click();
    log('Promotion pop-up closed');
  });
}

/**
 * Staging sometimes answers with an "Internal Server Error" pop-up ("Confirm" button) that
 * blocks the page (seen 2026-10-05 while adding to the bag). The pop-up is marked hidden from
 * accessibility tools, so it is found by its visible text. Throws STAGING_SERVER_ERROR if shown.
 */
export async function throwIfServerErrorShown(page: Page, step: string, cause?: unknown): Promise<void> {
  const serverError = page.getByText('Internal Server Error', { exact: true }).filter({ visible: true });
  if ((await serverError.count()) > 0) {
    throw new StepError('STAGING_SERVER_ERROR', step, 'Staging showed an "Internal Server Error" pop-up.', [
      'staging is unstable right now: try again later',
    ], cause);
  }
}

/**
 * Staging's "Sorry the item(s) is not available for checkout. Sorry for the inconvenience."
 * pop-up: its answer when a product can't go into the bag, though the search showed it with "add
 * to bag" (seen 2026-10-22 adding PLU 57893). Its Confirm button is named "positiveButton". While
 * it shows, the rest of the page is hidden from accessibility tools: the header's "MY Bag" can't
 * be found.
 */
export function notAvailablePopup(page: Page): Locator {
  return page.getByRole('dialog').filter({ hasText: 'not available for checkout' }).filter({ visible: true });
}

/** Closes the "not available for checkout" pop-up (Confirm). Returns whether it was showing. */
export async function closeNotAvailablePopupIfShown(page: Page): Promise<boolean> {
  const popup = notAvailablePopup(page);
  if ((await popup.count()) === 0) return false;
  await popup.first().getByRole('button', { name: 'positiveButton' }).click();
  await expect(popup).toHaveCount(0);
  log('"Not available for checkout" pop-up closed');
  return true;
}

/**
 * Closes the "Wello" chat panel if it is open. It opens by itself on the right side and
 * covers buttons there (e.g. "add to bag" in the right-hand column). Its close control is an
 * image named "icon-close-chat". Verified on staging 2026-10-05.
 */
export async function closeChatPanelIfShown(page: Page): Promise<void> {
  const close = page.getByRole('img', { name: 'icon-close-chat' }).filter({ visible: true });
  if ((await close.count()) !== 1) return;
  // The panel slides in, and can hide again by itself (seen 2026-10-22: the icon was moving, then
  // hidden, and one long click failed an add): short clicks, done once it has gone.
  for (let attempt = 1; attempt <= 3 && (await close.count()) > 0; attempt++) await close.click({ timeout: 5_000 }).catch(() => {});
  await expect(close).toHaveCount(0);
  log('Chat panel closed');
}

/**
 * Clicks "Not Now" on the biometric pop-up that sometimes appears after login (PRD §11).
 * Waits only briefly, as the PRD asks. The locator comes from the user's snippet
 * (<button class="button secondary"><span>Not Now</span></button>); the pop-up has not
 * appeared in our runs yet, so it is only clicked when exactly one is visible.
 */
export async function dismissBiometricPromptIfShown(page: Page, waitMs = 5_000): Promise<boolean> {
  const notNow = page.getByRole('button', { name: 'Not Now', exact: true }).filter({ visible: true });
  try {
    await notNow.first().waitFor({ state: 'visible', timeout: waitMs });
  } catch {
    log('Biometric prompt not present');
    return false;
  }
  if ((await notNow.count()) !== 1) {
    log(`Found ${await notNow.count()} "Not Now" buttons; not clicking any`, 'WARN');
    return false;
  }
  await notNow.click();
  await expect(notNow).toHaveCount(0);
  log('Biometric prompt dismissed ("Not Now")');
  return true;
}
