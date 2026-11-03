import { expect, type Locator, type Page } from '@playwright/test';
import type { DeliveryMode } from '../config/order';
import { STAGING_PAYMENT_HOST } from '../safety/staging-guard';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';
import { closeChatPanelIfShown, closeCookieNoticeIfShown, throwIfServerErrorShown } from './popups';

// The checkout summary page after the bag's "Next" (/checkout/single/summary): the delivery mode
// options (Express, Standard) and the Checkout button (PRD §18–19). See docs/staging-notes.md,
// "Checkout summary". When the products can only go one way, it shows that one mode, already
// chosen, and no options (2026-10-14).
//
// "Checkout" starts creating the order, so checkout() only works when placing an order is
// switched on for the run (Settings.placeOrder; CLAUDE.md rule 3, approved 2026-10-05).

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
/** A product's status in an "Available items" list: "In Stock", or "Not available" / "Sorry, this item is not available for Express mode.". */
const IN_STOCK = /^\s*in stock\s*$/i;
const NOT_AVAILABLE = /\bnot available\b/i;
/** " Sat \n 17/10 " → "Sat 17/10" (a day in the delivery date list). */
const normalizeDay = (text: string) => text.replace(/\s+/g, ' ').trim();

/** How the tests name each mode: step names, messages, error codes. */
export const MODE_NAMES: Record<DeliveryMode, string> = { express: 'Express', standard: 'Standard' };
const NOT_FOUND_CODES = { express: 'EXPRESS_OPTION_NOT_FOUND', standard: 'STANDARD_OPTION_NOT_FOUND' } as const;

/** One delivery mode's option on the page: its label, its radio and its "View N item(s)" button. */
interface ModeOption {
  label: Locator;
  radio: Locator;
  itemsButton: Locator;
}

export class CheckoutPage {
  // Every delivery option's radio, hidden or not. Verified 2026-10-05 (inspection/summary,
  // express-*): two radios named "deliveryMethod" with empty values when there is a choice.
  // Verified 2026-10-14 (the trace of the 2026-10-13 13:27 run, Standard-only PLUs 17562 and
  // 21841): when the products can only go one way, the page shows that one option, already chosen,
  // with its radio hidden (<e2-radio name="deliveryMethod" class="option standard checked">).
  readonly deliveryOptions: Locator;
  // The Express one is in the label that shows "Fastest".
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
  // A delivery date (inspected 2026-10-13, and the user's inspect of 2026-10-16): until one is
  // chosen, the option's title reads "Please Select a delivery date" and its "Select delivery date"
  // button opens a dialog listing the next days, each "Available" (a button) or "Not Available",
  // with a Confirm button. Click & Collect shows an estimated pickup date instead.
  readonly deliveryDateDialog: Locator;
  readonly availableItemsDialog: Locator;
  // Every option's "View N item(s)" button.
  readonly itemsButtons: Locator;
  // Verified 2026-10-05: <button class="next-btn"> Checkout </button>, exactly one.
  readonly checkoutButton: Locator;

  constructor(private readonly page: Page) {
    const itemsButton = (label: Locator) => label.getByRole('button', { name: /^View \d+ item\(s\)$/ });
    this.itemsButtons = page.getByRole('button', { name: /^View \d+ item\(s\)$/ });
    this.deliveryOptions = page.locator('input[type="radio"][name="deliveryMethod"]');
    this.expressLabel = page.locator('label').filter({ hasText: 'Fastest' });
    this.expressOption = this.expressLabel.getByRole('radio');
    this.expressItemsButton = itemsButton(this.expressLabel);
    this.standardLabel = page
      .locator('label')
      .filter({ has: page.locator('input[type="radio"][name="deliveryMethod"]') })
      .filter({ hasNotText: 'Fastest' });
    this.standardOption = this.standardLabel.getByRole('radio');
    this.standardItemsButton = itemsButton(this.standardLabel);
    this.deliveryDateDialog = page.getByRole('dialog').filter({ hasText: 'Please select your preferred delivery date' });
    this.availableItemsDialog = page.getByRole('dialog').filter({ hasText: 'Available items' });
    this.checkoutButton = page.getByRole('button', { name: 'Checkout', exact: true });
  }

  private option(mode: DeliveryMode): ModeOption {
    return mode === 'express'
      ? { label: this.expressLabel, radio: this.expressOption, itemsButton: this.expressItemsButton }
      : { label: this.standardLabel, radio: this.standardOption, itemsButton: this.standardItemsButton };
  }

  /**
   * Waits for the page and its delivery options. `orShown`: what else counts as loaded, e.g. Shell
   * Station's "Add Shell Station Pick up location", shown instead of any option until a pickup
   * store is chosen (2026-10-30).
   */
  async waitUntilLoaded(orShown?: Locator): Promise<void> {
    try {
      await this.page.waitForURL(/\/checkout\/single\/summary/, { timeout: 60_000 });
      await expect(this.checkoutButton).toBeVisible({ timeout: 60_000 });
      // The page first shows grey placeholders; wait for the real delivery options (seen
      // 2026-10-05): a radio, hidden or not, or else an option's "View N item(s)". Not Express or
      // Standard in particular: the page may offer just one of them (2026-10-14).
      let optionShown = this.deliveryOptions.or(this.itemsButtons);
      if (orShown) optionShown = optionShown.or(orShown);
      await expect(optionShown.first()).toBeAttached({ timeout: 60_000 });
    } catch (error) {
      await throwIfServerErrorShown(this.page, 'Checkout summary', error);
      throw new StepError('CHECKOUT_FAILED', 'Checkout summary', 'The checkout summary page did not load.', [
        'staging is slow',
        'the bag could not move to checkout',
      ], error);
    }
  }

  /** Whether the page shows delivery options to choose from: a radio to click, or two options. */
  async showsChoice(): Promise<boolean> {
    const [drawn, express, standard] = await Promise.all([this.deliveryOptions.count(), this.expressOption.count(), this.standardOption.count()]);
    return drawn >= 2 || express + standard > 0;
  }

  /**
   * The delivery modes the page lets you choose from: Express and Standard when it shows options.
   * When the products can only go one way (user's request 2026-10-14, e.g. the Standard-only PLUs
   * 46700, 46465 and 46358), there is no choice: just that mode, already chosen, its radio hidden.
   * `wanted` is the run's mode. Call after waitUntilLoaded().
   *
   * A page can also draw one option a while before the other (seen 2026-10-14: "Fastest" alone,
   * its radio hidden, for over 3 seconds; the Standard option came later). So a lone option only
   * counts as "no choice" after 5 seconds when it is the Standard the run wants; any other lone
   * option only after `patienceMs` (a minute, as long as the page was always given for its
   * options).
   */
  async offeredModes(wanted: DeliveryMode, patienceMs = 60_000): Promise<DeliveryMode[]> {
    const started = Date.now();
    let lone: DeliveryMode | null = null;
    let since = started;
    for (;;) {
      if (await this.showsChoice()) return ['express', 'standard'];
      const now: DeliveryMode = (await this.expressLabel.count()) > 0 ? 'express' : 'standard';
      if (now !== lone) [lone, since] = [now, Date.now()];
      const needed = lone === 'standard' && wanted === 'standard' ? 5_000 : patienceMs;
      if (Date.now() - since >= needed || Date.now() - started >= patienceMs + 30_000) return [lone];
      await this.page.waitForTimeout(500);
    }
  }

  /** The Checkout button is there and can be clicked; else a CHECKOUT_FAILED that says so. */
  async expectReadyToCheckOut(step: string): Promise<void> {
    try {
      await expect(this.checkoutButton).toHaveCount(1);
      await expect(this.checkoutButton).toBeEnabled({ timeout: 90_000 });
    } catch (error) {
      await throwIfServerErrorShown(this.page, step, error);
      throw new StepError('CHECKOUT_FAILED', step, 'The Checkout button is not available on the checkout page.', [
        'a message on the page is blocking (e.g. a delivery date or a pickup store is needed)',
        'staging is slow',
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
    await this.expectOneOption(mode);
    const fail = (reason: string, error?: unknown) => this.optionNotFound(mode, reason, error);
    return this.unavailableIn(this.option(mode).itemsButton, MODE_NAMES[mode], namesByPlu, fail);
  }

  /**
   * The products an option's "Available items" list (opened with `itemsButton`) marks "Not
   * available". `what` names the option in messages ("Express", "the pickup store"); `fail` makes
   * the error when the list doesn't open or lacks a product.
   */
  async unavailableIn(itemsButton: Locator, what: string, namesByPlu: Record<string, string>, fail: (reason: string, error?: unknown) => StepError): Promise<string[]> {
    await closeChatPanelIfShown(this.page);
    await itemsButton.click();
    try {
      await expect(this.availableItemsDialog).toBeVisible();
    } catch (error) {
      throw fail(`The "View N item(s)" button of ${what} did not open the "Available items" list.`, error);
    }
    // Each product in the list (verified 2026-11-03): <div class="product"> with its name (".name",
    // without the brand) and its status (".status"): "In Stock", or, when this option can't deliver
    // it, the class "disabled" and "Not available" (Home Delivery) or "Sorry, this item is not
    // available for Express mode." (Click & Collect; the user's error log of 2026-11-03). A free gift
    // has the class "freeGift" and "Free Gift" under its status.
    const items = await this.availableItemsDialog.locator('.product').evaluateAll((products) =>
      products.map((product) => ({
        name: (product.querySelector('.name-group .name') ?? product.querySelector('.name'))?.textContent ?? '',
        status: product.querySelector('.status')?.textContent ?? '',
        disabled: product.classList.contains('disabled'),
      })),
    );
    // Without those (the list as it was drawn before): its lines, each status after its product's name.
    const lines = items.length > 0 ? [] : (await this.availableItemsDialog.innerText()).split('\n').map(normalize).filter(Boolean);
    const names = new Set(Object.values(namesByPlu).map(normalize));
    const statusOf = (productName: string): 'in stock' | 'not available' | undefined => {
      const wanted = normalize(productName);
      const item = items.find((candidate) => normalize(candidate.name) === wanted);
      if (item) return item.disabled || NOT_AVAILABLE.test(item.status) ? 'not available' : IN_STOCK.test(item.status) ? 'in stock' : undefined;
      const at = lines.indexOf(wanted);
      // Only up to the next product's name: never another product's status.
      for (const line of at < 0 ? [] : lines.slice(at + 1)) {
        if (names.has(line)) break;
        if (NOT_AVAILABLE.test(line)) return 'not available';
        if (IN_STOCK.test(line)) return 'in stock';
      }
      return undefined;
    };

    const unavailable: string[] = [];
    for (const [plu, productName] of Object.entries(namesByPlu)) {
      const status = statusOf(productName);
      if (!status) {
        throw fail(`PLU ${plu} ("${productName}") is not in the "Available items" list of ${what}, so its availability is unknown.`);
      }
      if (status === 'not available') unavailable.push(plu);
    }

    // Close the list again: Escape, or its close icon if Escape didn't. Escape closes it with a short
    // animation, so it may still show for a moment (seen 2026-10-16).
    await this.page.keyboard.press('Escape');
    const closed = await expect(this.availableItemsDialog).toBeHidden({ timeout: 3_000 }).then(() => true, () => false);
    if (!closed) await this.availableItemsDialog.locator('.btn-close, .icon-close, [aria-label="Close"]').first().click();
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
   * When the chosen delivery option asks for a delivery date ("Please Select a delivery date", or
   * its "Select delivery date" button), picks the latest available date and confirms it. Only the
   * chosen mode's option is looked at: with Express chosen, the Standard option still says "Please
   * Select a delivery date", and clicking it would switch the order to Standard.
   * User's request 2026-10-16: for any delivery mode, and the latest date (before: Standard only,
   * the earliest date). Returns the date chosen (e.g. "Sat 24/10"), or null when none was asked
   * for (Click & Collect, Express without a date, or a date already chosen).
   */
  async chooseDeliveryDateIfAsked(mode: DeliveryMode): Promise<string | null> {
    const name = MODE_NAMES[mode];
    const { label } = this.option(mode);
    // <button class="btn btn-outline-primary enhance"><img alt="icon"> Select delivery date </button>
    const openButton = label.getByRole('button', { name: /Select delivery date/i });
    const title = label.locator('.support-title').first();
    const asksForDate = async () =>
      (await openButton.isVisible().catch(() => false)) || /please select a delivery date/i.test(await title.innerText({ timeout: 1_000 }).catch(() => ''));
    if (!(await asksForDate())) return null;

    const notChosen = (reason: string, error?: unknown) =>
      new StepError('DELIVERY_DATE_NOT_AVAILABLE', `${name} Delivery Selection`, reason, [
        'no delivery date is available for these products or this address',
        'staging UI changed',
      ], error);
    await closeCookieNoticeIfShown(this.page);
    await closeChatPanelIfShown(this.page);
    try {
      await openButton.click();
      await expect(this.deliveryDateDialog).toBeVisible();
    } catch (error) {
      throw notChosen('"Select delivery date" did not open the list of delivery dates.', error);
    }
    // <button class="btn btn-primary-outline"> Available </button>, one per free slot, in date
    // order; "Not Available" days have none. The last one is the latest date.
    const available = this.deliveryDateDialog.getByRole('button', { name: 'Available', exact: true });
    if ((await available.count()) === 0) {
      await this.deliveryDateDialog.locator('.icon-close, .btn-close, [aria-label="Close"]').first().click().catch(() => {});
      throw notChosen('Every date in the list is "Not Available".');
    }
    const latest = available.last();
    // The day it belongs to: the last date written before it in the list ("Sat 24/10"; the day and
    // the date can be separate pieces of text).
    const day = await latest.evaluate((button) => {
      const list = button.closest('[role="dialog"]') ?? document.body;
      const walker = document.createTreeWalker(list, NodeFilter.SHOW_TEXT);
      let before = '';
      for (let node = walker.nextNode(); node && !button.contains(node); node = walker.nextNode()) before += ` ${node.textContent ?? ''}`;
      return [...before.matchAll(/\b([A-Z][a-z]{2})\s+(\d{1,2}\/\d{1,2})\b/g)].at(-1)?.slice(1, 3).join(' ') ?? null;
    });
    const date = day ? normalizeDay(day) : 'the latest date';
    await latest.click();
    // <button class="btn btn-primary"> Confirm </button>
    const confirm = this.deliveryDateDialog.getByRole('button', { name: 'Confirm', exact: true });
    try {
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await expect(this.deliveryDateDialog).toBeHidden({ timeout: 30_000 });
      await expect.poll(asksForDate, { timeout: 60_000 }).toBe(false);
      await expect(this.checkoutButton).toBeVisible({ timeout: 90_000 });
    } catch (error) {
      await throwIfServerErrorShown(this.page, `${name} Delivery Selection`, error);
      throw notChosen(`Delivery date ${date} was picked, but the page did not take it.`, error);
    }
    // The option now says what was chosen ("Estimated Delivery Date: 24/10 (Sat) 07:00 - 21:00").
    const shown = (await title.innerText().catch(() => '')).replace(/\s+/g, ' ').match(/Estimated Delivery Date:\s*(.+)$/i)?.[1];
    log(`Delivery date chosen: ${date} (the latest available)${shown ? `; the page shows ${shown}` : ''}`);
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
