import { expect, type Locator, type Page, type Request } from '@playwright/test';
import type { OrderLine } from '../config/order';
import { ADD_DELAY_SECONDS } from '../config/settings';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';
import { bagButton, bagCount } from './header';
import { closeChatPanelIfShown, throwIfServerErrorShown } from './popups';

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

  constructor(private readonly page: Page) {
    this.searchBox = page.getByRole('searchbox', { name: 'Search here...' });
    this.bagButton = bagButton(page);
    this.resultsHeading = page.getByRole('heading', { name: /Search Results for/, level: 1 });
  }

  async bagCount(): Promise<number> {
    return bagCount(this.page);
  }

  /**
   * Searches all PLUs at once (staging accepts them separated by spaces). Typed straight
   * into the input: an animated placeholder layer on top of it catches clicks.
   */
  async searchAll(plus: string[]): Promise<void> {
    await this.searchBox.fill(plus.join(' '));
    await this.searchBox.press('Enter');
    try {
      await expect(this.resultsHeading).toBeVisible({ timeout: 60_000 });
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
   * Once a request has been sent, never clicks again (that could add the product twice).
   */
  private async clickAddUntilSent(plu: string): Promise<void> {
    const isAddRequest = (request: Request) =>
      request.method() === 'POST' && /\/carts\/[^/]+\/entries$/.test(new URL(request.url()).pathname);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const requestSent = this.page.waitForRequest(isAddRequest, { timeout: 10_000 }).then(
        () => true,
        () => false,
      );
      await this.addButtonFor(plu).click();
      if (await requestSent) return;
      log(`"add to bag" for PLU ${plu} did not reach the site (page still starting?); trying again`, 'WARN');
    }
    throw new Error(`"add to bag" for PLU ${plu} sent no request after 3 clicks`);
  }

  /** Adds `quantity` units, one click each, checking the bag count goes up after every click. */
  async add(line: OrderLine): Promise<void> {
    for (let unit = 1; unit <= line.quantity; unit++) {
      await closeChatPanelIfShown(this.page);
      const before = await this.bagCount();
      const clickedAt = Date.now();
      try {
        await this.clickAddUntilSent(line.plu);
        await expect.poll(() => this.bagCount(), { timeout: 30_000 }).toBeGreaterThan(before);
      } catch (error) {
        await throwIfServerErrorShown(this.page, `Add PLU ${line.plu} to bag`, error);
        throw new StepError(
          'PRODUCT_QUANTITY_MISMATCH',
          'Add to bag',
          `Adding unit ${unit} of ${line.quantity} for PLU ${line.plu} did not increase the bag count (still ${await this.bagCount().catch(() => '?')}).`,
          ['the product just sold out', 'a pop-up covered the button', 'staging is slow'],
          error,
        );
      }
      log(`Added PLU ${line.plu} (${unit}/${line.quantity}); bag now ${await this.bagCount()}`);
      const elapsed = Date.now() - clickedAt;
      // Documented wait (PRD §40): the time chosen between clicks (default 10 s, the user's requirement).
      if (elapsed < this.msBetweenAdds) await this.page.waitForTimeout(this.msBetweenAdds - elapsed);
    }
  }
}
