import { expect, type Locator, type Page } from '@playwright/test';
import type { DeliveryMethod, OrderLine } from '../config/order';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';
import { bagButton, bagCount } from './header';
import { closeChatPanelIfShown, throwIfServerErrorShown } from './popups';

// The delivery method buttons' visible names on staging (verified 2026-10-05). After the bag page
// is reloaded, some carry the place first: "Singapore - Home Delivery" (seen 2026-10-22).
const DELIVERY_BUTTON_NAMES: Record<DeliveryMethod, RegExp> = {
  home_delivery: /^\W*(?:[\w ]+ - )?Home Delivery/,
  click_collect: /^\W*(?:[\w ]+ - )?Click & Collect at Watsons/,
  shell_station: /^\W*(?:[\w ]+ - )?Pickup at Shell Station/,
};

// The bag ("MY Bag", /checkoutstepone): contents, emptying, delivery method, free gift, Next
// (PRD §14–17). See docs/staging-notes.md, "Bag page".
export class BagPage {
  // Verified on staging 2026-10-05 (inspection/bag, bagx-*): one <wtc-cart-item> per product.
  readonly items: Locator;
  readonly nextButton: Locator;
  // Verified on staging 2026-10-05 (2 runs): the trash button asks for confirmation in a dialog;
  // its "Remove" button is named "positiveButton" (a generic name, so the dialog is picked by its text).
  readonly confirmRemoveButton: Locator;

  constructor(private readonly page: Page) {
    this.items = page.locator('wtc-cart-item');
    // "Next" with a lock icon in front. Case-sensitive, so the carousels' "next" buttons don't match.
    this.nextButton = page.getByRole('button', { name: /^\W*Next$/ });
    this.confirmRemoveButton = page
      .getByRole('dialog')
      .filter({ hasText: 'Are you sure you want to remove this item?' })
      .getByRole('button', { name: 'positiveButton' });
  }

  /** A product's line (with its quantity box: not a free line staging added, see contents()). */
  itemFor(plu: string): Locator {
    return this.items.filter({ has: this.page.locator(`a[href$="/p/BP_${plu}"]`) }).filter({ has: this.page.locator('input[aria-label="input-val"]') });
  }

  /** Opens the bag from the header's "MY Bag" button and waits for its contents. */
  async open(): Promise<void> {
    await closeChatPanelIfShown(this.page);
    // A click before the shop's app has started does nothing (seen 2026-10-22 just after the home
    // page opened): clicked again, up to 3 times in the minute it always had. Opening the bag
    // twice does no harm.
    let opened = false;
    for (let attempt = 1; attempt <= 3 && !opened; attempt++) {
      if (attempt > 1) log('"MY Bag" did not open the bag (the page was probably still starting); clicking it again', 'WARN');
      await bagButton(this.page).click();
      opened = await this.page.waitForURL(/\/checkoutstepone/, { timeout: 20_000 }).then(() => true, () => false);
    }
    if (!opened) {
      await throwIfServerErrorShown(this.page, 'Open bag');
      throw new StepError('CART_VALIDATION_FAILED', 'Open bag', 'Clicking "MY Bag" did not open the bag page (3 tries).', ['staging is slow', 'a pop-up covers the page']);
    }
    await expect(this.page.getByRole('heading', { name: 'MY Bag', level: 1 })).toBeVisible({ timeout: 60_000 });
    // Loaded when it shows items, or the header says the bag is empty.
    const loaded = await expect
      .poll(async () => (await bagCount(this.page)) === 0 || (await this.items.count()) > 0, { timeout: 60_000 })
      .toBe(true)
      .then(() => true, () => false);
    if (!loaded) {
      // Seen 2026-10-05: header "11 MY Bag" but the item list never drew. A reload fixes it.
      log('The bag page did not show its items; reloading it', 'WARN');
      try {
        await this.reload();
      } catch (error) {
        await throwIfServerErrorShown(this.page, 'Open bag', error);
        throw new StepError('CART_VALIDATION_FAILED', 'Open bag', 'The bag page did not show its items, even after a reload.', [
          'staging is slow or having problems',
        ], error);
      }
    }
    await closeChatPanelIfShown(this.page);
  }

  /**
   * Trash button, then "Remove" in the confirmation; waits until the bag has one line of that
   * product fewer. Not one item fewer in all: a long list is still drawing more items for a while
   * (seen 2026-10-22 with 21 products: 10 items, then 16).
   */
  private async deleteItem(item: Locator): Promise<void> {
    const plu = (await item.locator('a[href*="/p/BP_"]').first().getAttribute('href'))?.match(/\/p\/BP_(\d+)$/)?.[1];
    const lines = plu ? this.items.filter({ has: this.page.locator(`a[href$="/p/BP_${plu}"]`) }) : this.items;
    const before = await lines.count();
    const countBefore = await bagCount(this.page, 5_000).catch(() => NaN);
    await closeChatPanelIfShown(this.page);
    await item.locator('button.delete-btn').click();
    await this.confirmRemoveButton.click();
    await expect.poll(() => lines.count(), { timeout: 30_000 }).toBeLessThan(before);
    // The line can go before staging has taken the removal (the "can't take" box redraws itself,
    // seen 2026-10-22): leaving the page then undid it. The header's count drops once it is done.
    if (Number.isFinite(countBefore)) {
      await expect.poll(() => bagCount(this.page, 2_000).catch(() => countBefore), { timeout: 30_000 }).toBeLessThan(countBefore);
    }
  }

  /** Reloads the bag page, e.g. when it seems stuck (seen once 2026-10-05: an item "came back"). */
  private async reload(): Promise<void> {
    await this.page.reload();
    await expect(this.page.getByRole('heading', { name: 'MY Bag', level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(async () => (await bagCount(this.page)) === 0 || (await this.items.count()) > 0, { timeout: 60_000 })
      .toBe(true);
  }

  /** Removes every item, one at a time. If staging seems stuck, reloads the page (twice at most). */
  async empty(): Promise<void> {
    const startCount = await this.items.count();
    let reloads = 0;
    for (;;) {
      // Done when the list shows no item and the header agrees: a list being redrawn after a
      // removal shows none for a moment (seen 2026-10-22, with one product still in the bag).
      if ((await this.items.count()) === 0) {
        await expect
          .poll(async () => (await this.items.count()) > 0 || (await bagCount(this.page)) === 0, { timeout: 30_000 })
          .toBe(true)
          .catch(() => {});
        if ((await this.items.count()) === 0) break;
      }
      try {
        await this.deleteItem(this.items.first());
      } catch (error) {
        await throwIfServerErrorShown(this.page, 'Empty bag', error);
        if (reloads < 2) {
          reloads++;
          log(`Removing an item seemed stuck; reloading the bag (${reloads}/2)`, 'WARN');
          await this.reload();
          continue;
        }
        throw new StepError('CART_VALIDATION_FAILED', 'Empty bag', `Could not remove an item from the bag (${await this.items.count()} left).`, [
          'the remove confirmation changed',
          'staging is slow',
        ], error);
      }
    }
    await expect.poll(() => bagCount(this.page), { timeout: 30_000 }).toBe(0);
    log(startCount > 0 ? `Bag emptied (${startCount} product(s) removed)` : 'Bag was already empty');
  }

  /**
   * The products the chosen delivery method can't take, with staging's message; null when there
   * are none. Seen 2026-10-22 with Click & Collect and Shell Station: a box above the other
   * products (<wtc-cart-error-entries>) says e.g. "Sorry, your order includes item(s) not
   * available for Click & Collect service. Please review your shopping bag or try another delivery
   * option." and holds those products, with "Buy Next Time". "Next" then takes no clicks (class
   * "disabled").
   *
   * The box is drawn a moment after the method is chosen, and can still show what was true before
   * (seen 2026-10-22: a product just removed). So the answer counts once it has settled: the same
   * twice, 1.5 seconds apart, with "Next" agreeing (greyed out with the box, ready without). At
   * most 20 seconds; "Next" greyed out without the box (e.g. no pickup store) is no box.
   */
  async methodProblem(): Promise<{ message: string; plus: string[] } | null> {
    const box = this.page.locator('wtc-cart-error-entries').filter({ has: this.page.locator('wtc-cart-item') });
    const nextReady = async () => !/\bdisabled\b/.test((await this.nextButton.getAttribute('class', { timeout: 1_000 }).catch(() => '')) ?? '');
    const read = async (): Promise<string | null> =>
      (await box.count()) === 0
        ? null
        : JSON.stringify(
            await box.first().evaluate((element) => ({
              message: (element.querySelector('.title')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
              plus: [
                ...new Set(
                  [...element.querySelectorAll('wtc-cart-item a[href*="/p/BP_"]')]
                    .map((link) => link.getAttribute('href')?.match(/\/p\/BP_(\d+)$/)?.[1])
                    .filter((plu): plu is string => Boolean(plu)),
                ),
              ],
            })),
          );
    const deadline = Date.now() + 20_000;
    let settled: string | null | undefined;
    for (;;) {
      const now = await read();
      const agrees = (now !== null) !== (await nextReady());
      if ((agrees && now === settled) || Date.now() > deadline) return now === null ? null : JSON.parse(now);
      settled = agrees ? now : undefined;
      await this.page.waitForTimeout(1_500);
    }
  }

  /**
   * Removes every line of a product (its free line too), e.g. one the delivery method can't take.
   * After each removal the bag page is loaded afresh: the "can't take" box can draw a removed
   * product again for a moment (seen 2026-10-22), and that line can't be removed twice.
   */
  async removeLines(plu: string): Promise<void> {
    const lines = this.items.filter({ has: this.page.locator(`a[href$="/p/BP_${plu}"]`) });
    try {
      for (let removals = 0; (await lines.count()) > 0; removals++) {
        if (removals === 3) throw new Error(`PLU ${plu} is still in the bag after 3 removals`);
        await this.deleteItem(lines.first());
        await this.reload();
      }
    } catch (error) {
      await throwIfServerErrorShown(this.page, `Remove PLU ${plu}`, error);
      throw new StepError('CART_VALIDATION_FAILED', 'Remove product', `Could not remove PLU ${plu} from the bag.`, ['staging is slow'], error);
    }
    log(`Removed PLU ${plu} from the bag`);
  }

  /** Removes one product from the bag. */
  async removeItem(plu: string): Promise<void> {
    const item = this.itemFor(plu);
    if ((await item.count()) !== 1) {
      throw new StepError('CART_VALIDATION_FAILED', 'Remove product', `PLU ${plu} is not in the bag (found ${await item.count()}).`);
    }
    try {
      await this.deleteItem(item);
    } catch (error) {
      await throwIfServerErrorShown(this.page, `Remove PLU ${plu}`, error);
      throw new StepError('CART_VALIDATION_FAILED', 'Remove product', `Could not remove PLU ${plu} from the bag.`, ['staging is slow'], error);
    }
    log(`Removed PLU ${plu} from the bag`);
  }

  /**
   * Each product's name as the bag shows it (the name link, without the brand), by PLU. The
   * checkout page lists products by name only, so this is how its lists are matched to PLUs.
   * (The delivery icons under each name do NOT show current Express availability: all 11 of
   * the user's products had the Express icon while 2 were "Not available", 2026-10-05.)
   */
  async productNames(): Promise<Record<string, string>> {
    return this.items.evaluateAll((items) =>
      Object.fromEntries(
        items.map((item) => {
          const nameLink = item.querySelector('a.name');
          const href = nameLink?.getAttribute('href') ?? '';
          const plu = href.match(/\/p\/BP_(\d+)$/)?.[1] ?? `unknown (${href})`;
          return [plu, (nameLink?.textContent ?? '').replace(/\s+/g, ' ').trim()];
        }),
      ),
    );
  }

  /**
   * What the bag holds: PLU (from each item's product link) and quantity. Without the free units
   * staging adds by itself, e.g. with "Buy 1 Get 1 Free" (seen 2026-10-22 with PLU 17971): their
   * own line, marked FREE, with no quantity box (freeItems()).
   */
  async contents(): Promise<OrderLine[]> {
    return this.items.evaluateAll((items) =>
      items
        .filter((item) => item.querySelector('input[aria-label="input-val"]') || !item.querySelector('.free'))
        .map((item) => {
          const href = item.querySelector('a[href*="/p/BP_"]')?.getAttribute('href') ?? '';
          const quantity = (item.querySelector('input[aria-label="input-val"]') as HTMLInputElement | null)?.value;
          return { plu: href.match(/\/p\/BP_(\d+)$/)?.[1] ?? `unknown (${href})`, quantity: Number(quantity) };
        }),
    );
  }

  /** The free lines staging added by itself (see contents()): PLU and quantity. */
  async freeItems(): Promise<OrderLine[]> {
    return this.items.evaluateAll((items) =>
      items
        .filter((item) => !item.querySelector('input[aria-label="input-val"]') && item.querySelector('.free'))
        .map((item) => {
          const href = item.querySelector('a[href*="/p/BP_"]')?.getAttribute('href') ?? '';
          const quantity = Number(item.querySelector('.counter')?.textContent?.trim()) || 1;
          return { plu: href.match(/\/p\/BP_(\d+)$/)?.[1] ?? `unknown (${href})`, quantity };
        }),
    );
  }

  /** Checks the bag holds exactly the expected PLUs and quantities (PRD §14). */
  async expectContents(expected: OrderLine[]): Promise<void> {
    const sort = (lines: OrderLine[]) => [...lines].sort((a, b) => a.plu.localeCompare(b.plu));
    const wanted = sort(expected);
    // The item list can still be redrawing after the delivery method changed (seen 2026-10-13 and
    // -14: the header said 2 items while the list showed 1 for a moment). Read it again for up to
    // 20 seconds before calling it wrong.
    let actual: OrderLine[] = [];
    const matches = await expect
      .poll(
        async () => {
          actual = sort(await this.contents());
          return JSON.stringify(actual);
        },
        { timeout: 20_000 },
      )
      .toBe(JSON.stringify(wanted))
      .then(() => true, () => false);
    if (!matches) {
      const show = (lines: OrderLine[]) => lines.map((line) => `${line.plu} x${line.quantity}`).join(', ') || '(empty)';
      throw new StepError('CART_VALIDATION_FAILED', 'Cart validation', `Expected ${show(wanted)} but the bag has ${show(actual)}.`, [
        'an item could not be added',
        'the bag had other items in it',
      ]);
    }
    log(`Bag verified: ${actual.length} product(s)`);
  }

  async selectDeliveryMethod(method: DeliveryMethod): Promise<void> {
    const button = this.page.getByRole('button', { name: DELIVERY_BUTTON_NAMES[method] });
    try {
      await closeChatPanelIfShown(this.page);
      await button.click();
      // The chosen method gets the "active" class (verified 2026-10-05; Home Delivery is the default).
      await expect(button).toHaveClass(/\bactive\b/);
    } catch (error) {
      await throwIfServerErrorShown(this.page, 'Delivery method', error);
      throw new StepError('DELIVERY_METHOD_NOT_FOUND', 'Delivery method', `Could not select "${method}".`, [
        'the option is not offered for these products',
        'the bag page changed',
      ], error);
    }
    log(`Delivery method selected: ${method}`);
  }

  /**
   * Removes an automatically added free gift, if there is one (PRD §15; user's instruction
   * 2026-10-05: remove it immediately and continue). Returns the counter text it removed, or null.
   *
   * NOT VERIFIED LIVE: no free gift appeared on staging in any run on 2026-10-05. The locators
   * come from the user's snippets (snippets/staging-elements.html):
   *   counter: <button class="free-gift-counter-container"><div class="free-gift-counter"> 1/1 selected </div>…
   *   remove:  <div class="remove"><svg class="icon-remove_off">…
   * Each step checks for exactly one match and that the gift is really gone afterwards; anything
   * else stops the test with FREE_GIFT_REMOVAL_FAILED instead of clicking blindly.
   */
  async removeFreeGiftIfPresent(): Promise<string | null> {
    const giftCounter = this.page.getByRole('button', { name: /\d+\/\d+ selected/ }).filter({ visible: true });
    const counters = await giftCounter.count();
    if (counters === 0) {
      log('No free gift detected');
      return null;
    }
    const counterText = (await giftCounter.first().innerText()).trim();
    log(`Free gift detected ("${counterText}"); removing it`);
    const fail = (reason: string, error?: unknown) =>
      new StepError('FREE_GIFT_REMOVAL_FAILED', 'Free gift', reason, [
        'the free gift area works differently from the snippet (not yet seen live)',
        'staging UI changed',
      ], error);
    if (counters > 1) throw fail(`Found ${counters} free gift counters; expected one.`);

    const removeIcon = this.page
      .locator('div.remove')
      .filter({ has: this.page.locator('svg.icon-remove_off') })
      .filter({ visible: true });
    try {
      await closeChatPanelIfShown(this.page);
      // Opens the list of gifts (the user's snippet: click the arrow on the counter).
      await giftCounter.click();
      await expect(removeIcon).toHaveCount(1, { timeout: 15_000 });
      await removeIcon.click();
      // Removed when the counter is gone or shows "0/… selected".
      await expect
        .poll(async () => (await giftCounter.count()) === 0 || /^\s*0\//.test(await giftCounter.innerText()), { timeout: 30_000 })
        .toBe(true);
    } catch (error) {
      await throwIfServerErrorShown(this.page, 'Free gift', error);
      throw fail(`Could not remove the free gift ("${counterText}").`, error);
    }
    log(`Free gift removed (was "${counterText}")`);
    return counterText;
  }

  /** Clicks "Next" and waits to leave the bag page. Does nothing on the page that follows. */
  async next(): Promise<void> {
    try {
      await closeChatPanelIfShown(this.page);
      await this.nextButton.click();
      await this.page.waitForURL((url) => !url.pathname.startsWith('/checkoutstepone'), { timeout: 60_000 });
    } catch (error) {
      await throwIfServerErrorShown(this.page, 'Next', error);
      throw new StepError('UNEXPECTED_PAGE', 'Next', 'Clicking "Next" did not leave the bag page.', [
        'a message on the bag page is blocking (e.g. a delivery slot is needed)',
        'staging is slow',
      ], error);
    }
    log(`Next clicked; now on ${new URL(this.page.url()).pathname}`);
  }
}
