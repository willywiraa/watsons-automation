import { expect, type Locator, type Page } from '@playwright/test';
import type { DeliveryMode } from '../config/order';
import { STAGING_PAYMENT_HOST } from '../safety/staging-guard';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';
import { closeChatPanelIfShown, closeCookieNoticeIfShown, throwIfServerErrorShown } from './popups';

// The checkout summary page after the bag's "Next" (/checkout/single/summary): the delivery mode
// options (Express, Standard) and the Checkout button (PRD §18–19). See docs/staging-notes.md,
// "Checkout summary".
//
// "Checkout" starts creating the order, so checkout() only works when placing an order is
// switched on for the run (Settings.placeOrder; CLAUDE.md rule 3, approved 2026-10-05).

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
/** " Sat \n 17/10 " → "Sat 17/10" (a day in the delivery date list). */
const normalizeDay = (text: string) => text.replace(/\s+/g, ' ').trim();

/** How the tests name each mode: step names, messages, error codes. */
const MODE_NAMES: Record<DeliveryMode, string> = { express: 'Express', standard: 'Standard' };
const NOT_FOUND_CODES = { express: 'EXPRESS_OPTION_NOT_FOUND', standard: 'STANDARD_OPTION_NOT_FOUND' } as const;

/** One delivery mode's option on the page: its label, its radio and its "View N item(s)" button. */
interface ModeOption {
  label: Locator;
  radio: Locator;
  itemsButton: Locator;
}

export class CheckoutPage {
  // Verified 2026-10-05 (inspection/summary, express-*): two radios named "deliveryMethod" with
  // empty values; the Express one is in the label that shows "Fastest".
  readonly expressLabel: Locator;
  readonly expressOption: Locator;
  // Verified 2026-10-05: the Express option's "View N item(s)" button opens an "Available items"
  // list that marks each product "In Stock" or "Not available".
  readonly expressItemsButton: Locator;
  // Standard (the user's inspect of it, 2026-10-13): the other delivery option, the one without
  // "Fastest". Its ".support-product-container" shows the estimated date (".support-title", e.g.
  // "Estimated Pickup Date: 17/10 (Sat)"), the delivery fee, the products and the same
  // "View N item(s)" button.
  readonly standardLabel: Locator;
  readonly standardOption: Locator;
  readonly standardItemsButton: Locator;
  // Standard home delivery (inspected 2026-10-13): until a date is chosen, its title reads "Please
  // Select a delivery date" and its "Select delivery date" button (in #DELIVERY_TIMESLOT) opens a
  // dialog with the next days, each "Available" or "Not Available" (".time.unavailable"), and a
  // Confirm button that is enabled once one is picked. Click & Collect shows an estimated pickup
  // date instead, and needs no choice.
  readonly standardDateButton: Locator;
  readonly deliveryDateDialog: Locator;
  readonly availableItemsDialog: Locator;
  // Verified 2026-10-05: <button class="next-btn"> Checkout </button>, exactly one.
  readonly checkoutButton: Locator;

  constructor(private readonly page: Page) {
    const itemsButton = (label: Locator) => label.getByRole('button', { name: /^View \d+ item\(s\)$/ });
    this.expressLabel = page.locator('label').filter({ hasText: 'Fastest' });
    this.expressOption = this.expressLabel.getByRole('radio');
    this.expressItemsButton = itemsButton(this.expressLabel);
    this.standardLabel = page
      .locator('label')
      .filter({ has: page.locator('input[type="radio"][name="deliveryMethod"]') })
      .filter({ hasNotText: 'Fastest' });
    this.standardOption = this.standardLabel.getByRole('radio');
    this.standardItemsButton = itemsButton(this.standardLabel);
    this.standardDateButton = this.standardLabel.locator('#DELIVERY_TIMESLOT').getByRole('button', { name: /Select delivery date/i });
    this.deliveryDateDialog = page.getByRole('dialog').filter({ hasText: 'Please select your preferred delivery date' });
    this.availableItemsDialog = page.getByRole('dialog').filter({ hasText: 'Available items' });
    this.checkoutButton = page.getByRole('button', { name: 'Checkout', exact: true });
  }

  private option(mode: DeliveryMode): ModeOption {
    return mode === 'express'
      ? { label: this.expressLabel, radio: this.expressOption, itemsButton: this.expressItemsButton }
      : { label: this.standardLabel, radio: this.standardOption, itemsButton: this.standardItemsButton };
  }

  async waitUntilLoaded(): Promise<void> {
    try {
      await this.page.waitForURL(/\/checkout\/single\/summary/, { timeout: 60_000 });
      await expect(this.checkoutButton).toBeVisible({ timeout: 60_000 });
      // The page first shows grey placeholders; wait for the real delivery options (seen 2026-10-05).
      await expect(this.page.locator('input[type="radio"][name="deliveryMethod"]').first()).toBeAttached({ timeout: 60_000 });
    } catch (error) {
      await throwIfServerErrorShown(this.page, 'Checkout summary', error);
      throw new StepError('CHECKOUT_FAILED', 'Checkout summary', 'The checkout summary page did not load.', [
        'staging is slow',
        'the bag could not move to checkout',
      ], error);
    }
  }

  private optionNotFound(mode: DeliveryMode, reason: string, error?: unknown): StepError {
    const name = MODE_NAMES[mode];
    return new StepError(NOT_FOUND_CODES[mode], `${name} Delivery Selection`, reason, [
      `${name} is not offered for these products or this delivery method`,
      'staging UI changed',
    ], error);
  }

  // A delivery option can appear a while after the rest of the page (seen 2026-10-05).
  private async expectOneOption(mode: DeliveryMode): Promise<void> {
    const { radio } = this.option(mode);
    try {
      await expect(radio).toHaveCount(1, { timeout: 60_000 });
    } catch (error) {
      const which = mode === 'express' ? '"Fastest" (Express)' : 'Standard (delivery options without "Fastest")';
      throw this.optionNotFound(mode, `Found ${await radio.count()} ${which} options; expected exactly one.`, error);
    }
  }

  /**
   * Which products a mode can deliver, from its option's "Available items" list. `namesByPlu` are
   * the product names from the bag page. Returns the PLUs marked "Not available".
   */
  async unavailableFor(mode: DeliveryMode, namesByPlu: Record<string, string>): Promise<string[]> {
    const name = MODE_NAMES[mode];
    await this.expectOneOption(mode);
    await closeChatPanelIfShown(this.page);
    await this.option(mode).itemsButton.click();
    try {
      await expect(this.availableItemsDialog).toBeVisible();
    } catch (error) {
      throw this.optionNotFound(mode, `The ${name} option's "View N item(s)" button did not open the "Available items" list.`, error);
    }
    const lines = (await this.availableItemsDialog.innerText()).split('\n').map(normalize).filter(Boolean);

    const unavailable: string[] = [];
    for (const [plu, productName] of Object.entries(namesByPlu)) {
      const at = lines.indexOf(normalize(productName));
      const status = at < 0 ? undefined : lines.slice(at + 1).find((line) => line === 'in stock' || line === 'not available');
      if (!status) {
        throw this.optionNotFound(mode, `PLU ${plu} ("${productName}") is not in the ${name} "Available items" list, so its ${name} availability is unknown.`);
      }
      if (status === 'not available') unavailable.push(plu);
    }

    // Close the list again (Escape; the dialog's close icon if Escape doesn't work).
    await this.page.keyboard.press('Escape');
    if (await this.availableItemsDialog.isVisible()) await this.availableItemsDialog.locator('.btn-close').first().click();
    await expect(this.availableItemsDialog).toBeHidden();
    return unavailable;
  }

  /**
   * Clicks "Checkout" and waits for the approved CyberSource test payment page (verified
   * 2026-10-05). Refuses unless placing an order is switched on for this run.
   */
  async checkout(placeOrderSwitchedOn: boolean): Promise<void> {
    if (!placeOrderSwitchedOn) {
      throw new StepError('CHECKOUT_FAILED', 'Checkout', 'Placing an order is switched off for this run (use npm run order).');
    }
    await expect(this.checkoutButton).toHaveCount(1);
    await closeChatPanelIfShown(this.page);
    await this.checkoutButton.click();
    try {
      await this.page.waitForURL((url) => url.host === STAGING_PAYMENT_HOST, { timeout: 90_000 });
    } catch (error) {
      await throwIfServerErrorShown(this.page, 'Checkout', error);
      throw new StepError('PAYMENT_FAILED', 'Checkout', 'Clicking Checkout did not open the payment page.', [
        'staging is slow',
        'the payment page moved to another address (the safety lock blocks unknown addresses)',
        'check the order history before running again (the order was probably not created)',
      ], error);
    }
    log('Checkout clicked; on the payment page');
  }

  /**
   * Selects a mode (Express: "Fastest"; Standard: the other option) and waits for the page to
   * recalculate. Staging then leaves the products that the mode can't deliver out of the order,
   * and "Checkout" disappears for up to a minute (seen 2026-10-05 with Express).
   */
  async select(mode: DeliveryMode): Promise<void> {
    const name = MODE_NAMES[mode];
    const { label, radio } = this.option(mode);
    await this.expectOneOption(mode);
    await closeChatPanelIfShown(this.page);
    const wasSelected = await radio.isChecked();
    if (!wasSelected) {
      // The input itself may be visually replaced by a styled circle; click the option's title
      // then ("Fastest", or Standard's estimated date), else the input itself.
      const title = mode === 'express' ? label.getByText('Fastest', { exact: true }) : label.locator('.support-title').first();
      if (await radio.isVisible()) await radio.check();
      else if (await title.isVisible()) await title.click();
      else await radio.dispatchEvent('click');
    }
    try {
      await expect(radio).toBeChecked();
      await expect(this.checkoutButton).toBeVisible({ timeout: 90_000 });
    } catch (error) {
      await throwIfServerErrorShown(this.page, `${name} Delivery Selection`, error);
      throw this.optionNotFound(mode, `${name} was selected, but the page did not become ready to check out within 90 seconds.`, error);
    }
    log(`${name} delivery selected${wasSelected ? ' (it already was)' : ''}`);
  }

  /**
   * Standard home delivery: when the page asks for a delivery date, picks the earliest available
   * one and confirms it. Returns the date chosen (e.g. "Sat 17/10"), or null when none was asked
   * for (Click & Collect, or a date already chosen).
   */
  async chooseStandardDeliveryDateIfAsked(): Promise<string | null> {
    const title = this.standardLabel.locator('.support-title').first();
    const asksForDate = async () => /please select a delivery date/i.test(await title.innerText().catch(() => ''));
    if (!(await asksForDate())) return null;

    const notChosen = (reason: string, error?: unknown) =>
      new StepError('DELIVERY_DATE_NOT_AVAILABLE', 'Standard Delivery Selection', reason, [
        'no delivery date is available for these products or this address',
        'staging UI changed',
      ], error);
    await closeCookieNoticeIfShown(this.page);
    await closeChatPanelIfShown(this.page);
    await this.standardDateButton.click();
    try {
      await expect(this.deliveryDateDialog).toBeVisible();
    } catch (error) {
      throw notChosen('"Select delivery date" did not open the list of delivery dates.', error);
    }
    // The days are listed in date order: the first one with a slot that isn't "unavailable".
    const day = this.deliveryDateDialog.locator('.timeslot').filter({ has: this.page.locator('.time:not(.unavailable) button') }).first();
    if ((await day.count()) === 0) {
      await this.deliveryDateDialog.locator('.icon-close').first().click();
      throw notChosen('Every date in the list is "Not Available".');
    }
    const date = normalizeDay(await day.locator('.date').innerText());
    await day.locator('.time:not(.unavailable) button').first().click();
    const confirm = this.deliveryDateDialog.getByRole('button', { name: 'Confirm', exact: true });
    try {
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await expect(this.deliveryDateDialog).toBeHidden({ timeout: 30_000 });
      await expect.poll(asksForDate, { timeout: 60_000 }).toBe(false);
      await expect(this.checkoutButton).toBeVisible({ timeout: 90_000 });
    } catch (error) {
      await throwIfServerErrorShown(this.page, 'Standard Delivery Selection', error);
      throw notChosen(`Delivery date ${date} was picked, but the page did not take it.`, error);
    }
    log(`Delivery date chosen: ${date} (the earliest available)`);
    return date;
  }

  // The names from before Standard, for scripts that still use them.
  expressUnavailable(namesByPlu: Record<string, string>): Promise<string[]> {
    return this.unavailableFor('express', namesByPlu);
  }

  selectExpress(): Promise<void> {
    return this.select('express');
  }
}
