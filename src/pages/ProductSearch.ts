import { expect, type Locator, type Page } from '@playwright/test';
import type { OrderLine } from '../config/order';
import { ADD_DELAY_SECONDS } from '../config/settings';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';
import { bagButton, bagCount } from './header';
import { closeChatPanelIfShown, closeNotAvailablePopupIfShown, notAvailablePopup, throwIfServerErrorShown } from './popups';
import { isAddRequest, ProductPage, type ProductOffers } from './ProductPage';

export type Availability = 'available' | 'sold_out' | 'not_found';

// Searching PLUs and adding them to the bag (PRD §12–13). See docs/staging-notes.md.
export class ProductSearch {
  // Verified on staging 2026-10-05 (inspection/search-results, flow-results).
  readonly searchBox: Locator;
  readonly bagButton: Locator;
  readonly resultsHeading: Locator;
  // The time from one "add to bag" click to the next: the user's requirement was at least 10
  // seconds (2026-10-04); fixed at 5 seconds since 2026-10-21 (ADD_DELAY_SECONDS).
  private readonly msBetweenAdds = ADD_DELAY_SECONDS * 1000;
  /** The PLUs of the last search (searched again when a click leaves the results). */
  private searched: string[] = [];
  /** Where products with "Buy 1" / "Buy 2" choices are added (2026-11-02). */
  private readonly productPage: ProductPage;

  constructor(private readonly page: Page) {
    this.searchBox = page.getByRole('searchbox', { name: 'Search here...' });
    this.bagButton = bagButton(page);
    this.resultsHeading = page.getByRole('heading', { name: /Search Results for/, level: 1 });
    this.productPage = new ProductPage(page);
  }

  async bagCount(): Promise<number> {
    return bagCount(this.page);
  }

  /**
   * Searches all PLUs at once (staging accepts them separated by spaces). Typed straight
   * into the input: an animated placeholder layer on top of it catches clicks.
   */
  async searchAll(plus: string[]): Promise<void> {
    this.searched = plus;
    // Searching again from a results page (e.g. a replacement, 2026-10-22): the last results show
    // until the new ones come, so wait for the heading ("5 Search Results for …") to change. The
    // same search again keeps the same heading: then on after 30 seconds.
    const previous = (await this.resultsHeading.isVisible()) ? await this.resultsHeading.innerText() : null;
    await this.searchBox.fill(plus.join(' '));
    await this.searchBox.press('Enter');
    try {
      await expect(this.resultsHeading).toBeVisible({ timeout: 60_000 });
      if (previous !== null) await expect(this.resultsHeading).not.toHaveText(previous, { timeout: 30_000 }).catch(() => {});
    } catch (error) {
      throw new StepError('PRODUCT_NOT_FOUND', 'Product Search', 'The search results page did not appear.', [
        'staging is down or very slow',
        'the search page changed',
      ], error);
    }
    log(`Searched ${plus.length} PLU(s): ${plus.join(', ')}`);
  }

  /** The search result tile for one PLU: its product link ends in /p/BP_<PLU>. */
  tileFor(plu: string): Locator {
    return this.page.locator('e2-product-tile').filter({ has: this.page.locator(`a[href$="/p/BP_${plu}"]`) });
  }

  addButtonFor(plu: string): Locator {
    return this.tileFor(plu).getByRole('button', { name: 'add to bag', exact: true });
  }

  async availabilityOf(plu: string): Promise<Availability> {
    const tiles = await this.tileFor(plu).count();
    if (tiles === 0) return 'not_found';
    if (tiles > 1) {
      throw new StepError('PRODUCT_NOT_FOUND', 'Product Search', `PLU ${plu} matched ${tiles} products; expected exactly one.`);
    }
    if ((await this.addButtonFor(plu).count()) === 1) return 'available';
    if ((await this.tileFor(plu).getByText('Sold Out', { exact: true }).count()) === 1) return 'sold_out';
    throw new StepError('PRODUCT_NOT_FOUND', 'Product Search', `PLU ${plu} has neither an "add to bag" button nor "Sold Out".`, [
      'the product tile changed',
    ]);
  }

  /**
   * Clicks "add to bag" until the click actually reaches the site, i.e. the add request
   * (POST .../carts/<id>/entries, seen 2026-10-05) is sent. Staging shows pages before its app
   * has started; a click that early does nothing (seen 2026-10-05), so it is safe to repeat.
   * Once a request has been sent, never clicks again (that could add the product twice); nor once
   * staging has answered with its "not available for checkout" pop-up. Returns null then.
   * When the click opens the product's page with "Buy 1" / "Buy 2" choices instead (2026-11-02),
   * returns those: nothing was added, and the page stays open (buyOnProductPage).
   */
  private async clickAddUntilSent(plu: string): Promise<ProductOffers | null> {
    let productPages = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.waitBetweenAdds();
      const requestSent = this.page.waitForRequest(isAddRequest, { timeout: 10_000 }).then(
        () => true,
        () => false,
      );
      this.lastClickAt = Date.now();
      await this.addButtonFor(plu).click();
      if (await requestSent) return null;
      if ((await notAvailablePopup(this.page).count()) > 0) return null;
      // A product with "Buy 1" / "Buy 2" (seen 2026-11-02 with PLU 23475 and 23317): its "add to
      // bag" always opens its page, where the choice is made.
      const offers = this.productPage.isOpenFor(plu) ? await this.productPage.volumeOffers(plu) : null;
      if (offers) {
        log(`"add to bag" for PLU ${plu} opened its page, which offers ${offers.offers.map((offer) => `Buy ${offer.quantity} (${offer.price})`).join(' or ')}`);
        return offers;
      }
      // The click can open the product's page instead (seen 2026-10-22 with PLU 21707). Nothing
      // was added (no request was sent): back to the search results, and click again.
      if (!(await this.resultsHeading.isVisible())) {
        log(`"add to bag" for PLU ${plu} opened ${new URL(this.page.url()).pathname} instead; searching again`, 'WARN');
        productPages++;
        await this.searchAll(this.searched);
        continue;
      }
      log(`"add to bag" for PLU ${plu} did not reach the site (page still starting?); trying again`, 'WARN');
    }
    // Every click opened the product's page, which has no "add to bag" (PLU 21707, 2026-10-22).
    if (productPages === 3) {
      throw new StepError('PRODUCT_NOT_AVAILABLE', 'Add to bag', `Staging did not add PLU ${plu}: its "add to bag" opens the product's page instead (3 tries).`, [
        'the product is not sold online',
        'the product needs a choice on its page',
      ]);
    }
    throw new Error(`"add to bag" for PLU ${plu} sent no request after 3 clicks`);
  }

  // Documented wait (PRD §40): at least the time between adds from one "add to bag" click to the
  // next, also when the one before failed and the person chose to go on.
  private lastClickAt = 0;
  private async waitBetweenAdds(): Promise<void> {
    const wait = this.lastClickAt + this.msBetweenAdds - Date.now();
    if (wait > 0) await this.page.waitForTimeout(wait);
  }

  /**
   * Adds `quantity` units, one click each, checking the bag count goes up after every click.
   * Staging can refuse a product with its "not available for checkout" pop-up (2026-10-22): the
   * pop-up is closed and PRODUCT_NOT_AVAILABLE thrown. `onAdded` is told of each unit added.
   * Returns null once they are added; or, for a product whose "add to bag" opens its page with
   * "Buy 1" / "Buy 2" choices (2026-11-02), those choices: then nothing was added, and that page
   * stays open for buyOnProductPage.
   */
  async add(line: OrderLine, onAdded?: () => void): Promise<ProductOffers | null> {
    for (let unit = 1; unit <= line.quantity; unit++) {
      await closeChatPanelIfShown(this.page);
      const before = await this.bagCount();
      let refused = false;
      try {
        const offers = await this.clickAddUntilSent(line.plu);
        if (offers) return offers;
        // Added when the bag count goes up; refused when the pop-up shows. The count is read
        // briefly each time: the pop-up hides the header's bag button.
        await expect
          .poll(
            async () => {
              refused = (await notAvailablePopup(this.page).count()) > 0;
              return refused || (await bagCount(this.page, 2_000).catch(() => before)) > before;
            },
            { timeout: 30_000 },
          )
          .toBe(true);
      } catch (error) {
        if (error instanceof StepError && error.code === 'PRODUCT_NOT_AVAILABLE') throw error;
        await throwIfServerErrorShown(this.page, `Add PLU ${line.plu} to bag`, error);
        throw new StepError(
          'PRODUCT_QUANTITY_MISMATCH',
          'Add to bag',
          `Adding unit ${unit} of ${line.quantity} for PLU ${line.plu} did not increase the bag count (still ${await bagCount(this.page, 5_000).catch(() => '?')}).`,
          ['the product just sold out', 'a pop-up covered the button', 'staging is slow'],
          error,
        );
      }
      if (refused) {
        await closeNotAvailablePopupIfShown(this.page);
        throw new StepError(
          'PRODUCT_NOT_AVAILABLE',
          'Add to bag',
          `Staging did not add PLU ${line.plu}: "Sorry the item(s) is not available for checkout."${unit > 1 ? ` (${unit - 1} of ${line.quantity} were added before that.)` : ''}`,
          ['the product is out of stock for online orders', 'the product is not sold online'],
        );
      }
      onAdded?.();
      log(`Added PLU ${line.plu} (${unit}/${line.quantity}); bag now ${await this.bagCount()}`);
    }
    return null;
  }

  /**
   * Adds `units` of `plu` on its page, open since add() returned its "Buy N" choices: the one for
   * that many, then BUY NOW (ProductPage.buy), at least the time between adds after the last click.
   */
  async buyOnProductPage(plu: string, units: number, onAdded?: () => void): Promise<void> {
    await this.waitBetweenAdds();
    try {
      await this.productPage.buy(plu, units, onAdded);
    } finally {
      this.lastClickAt = Date.now();
    }
  }
}
