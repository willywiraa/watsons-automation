import { expect, type Locator, type Page, type Request } from '@playwright/test';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';
import { bagCount } from './header';
import { closeChatPanelIfShown, closeNotAvailablePopupIfShown, notAvailablePopup, throwIfServerErrorShown } from './popups';

/** One of a product page's "Buy N" choices (staging calls them volume offers). */
export interface VolumeOffer {
  /** How many it buys: 1 for "Buy 1" (the normal price), 2 for "Buy 2". */
  quantity: number;
  /** The price for that many, as the page shows it, e.g. "S$ 11.90". */
  price: string;
  /** Its "Extra Savings", e.g. "S$ 5.10" (none for "Buy 1"). */
  saving?: string;
}

/** A product page's "Buy N" choices. */
export interface ProductOffers {
  plu: string;
  /** Brand and name, from the page's title, e.g. "TIGER BALM Mosquito Repellent Patch Spray 60ml". */
  name: string;
  /** Fewest first. */
  offers: VolumeOffer[];
}

/** The shop's add request: POST …/carts/<id>/entries?code=<PLU>&qty=<how many> (seen 2026-10-05 and 2026-11-02). */
export const isAddRequest = (request: Request) => request.method() === 'POST' && /\/carts\/[^/]+\/entries$/.test(new URL(request.url()).pathname);

// A product's own page (/<name>/p/BP_<PLU>), where products with "Buy 1" / "Buy 2" choices are added
// (user's request 2026-11-02). Seen on staging 2026-11-02 with PLU 23475 and 23317 ("Buy 2 Get
// Discount"; their search tile says "(Buy 2 - Offer price)"): "add to bag" in the search results
// opens this page instead of adding. Above QUANTITY and BUY NOW it offers "Buy 1" (the normal
// price, chosen to begin with) and "Buy 2" (with "Extra Savings"). Choosing one only sets the
// quantity box (Buy 2: 2). BUY NOW then sends the search results' add request with that quantity
// (…/entries?code=23475&qty=2) and the page stays; the bag shows one line of 2, "Applied 2ND BUY AT
// 60% OFF".
export class ProductPage {
  /**
   * The "Buy N" choices. On staging: <wtc-product-volume-offer> … <div class="volume-offer-option
   * save checked"><label><input type="radio" name="volume-offer-price"> <div class="quantity">
   * <span>Buy 2</span></div> <div class="price">S$ 11.90</div> <div class="reward"><span>Extra
   * Savings</span>S$ 5.10</div> …, one per slide of a carousel.
   */
  readonly offerOptions: Locator;
  /** QUANTITY's box (<e2-item-counter>, like the bag's). */
  readonly quantityBox: Locator;
  readonly buyNowButton: Locator;

  constructor(private readonly page: Page) {
    this.offerOptions = page.locator('wtc-product-volume-offer .volume-offer-option');
    this.quantityBox = page.locator('wtc-add-to-cart input[aria-label="input-val"]');
    this.buyNowButton = page.locator('wtc-add-to-cart button.btn-add-to-cart');
  }

  /** The choice that buys `quantity`. Found by its "Buy N" part: its whole text runs together ("Buy 2S$ 11.90"). */
  offer(quantity: number): Locator {
    return this.offerOptions.filter({ has: this.page.locator('.quantity', { hasText: new RegExp(`^\\s*Buy\\s*${quantity}\\s*$`, 'i') }) });
  }

  /** Whether the page open now is `plu`'s. */
  isOpenFor(plu: string): boolean {
    return new URL(this.page.url()).pathname.endsWith(`/p/BP_${plu}`);
  }

  /**
   * The page's "Buy N" choices once they are drawn (a few seconds after the page opens); null when
   * there are none within `timeout`, e.g. PLU 21707's page, which has no add button (2026-10-22).
   */
  async volumeOffers(plu: string, timeout = 15_000): Promise<ProductOffers | null> {
    if (!(await this.offerOptions.first().waitFor({ state: 'attached', timeout }).then(() => true, () => false))) return null;
    const read = await this.offerOptions.evaluateAll((options) =>
      options.map((option) => {
        const text = (selector: string) => (option.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
        return { quantity: Number(text('.quantity').match(/Buy\s*(\d+)/i)?.[1]), price: text('.price'), saving: text('.reward').replace(/^Extra Savings\s*/i, '') };
      }),
    );
    const offers: VolumeOffer[] = [];
    for (const { quantity, price, saving } of read) {
      if (!Number.isInteger(quantity) || quantity < 1 || offers.some((offer) => offer.quantity === quantity)) continue;
      offers.push(saving ? { quantity, price, saving } : { quantity, price });
    }
    if (offers.length === 0) return null;
    // The title is "<brand> <name> | <category> | Watsons Singapore".
    const name = (await this.page.title()).split(' | ')[0].trim();
    return { plu, name, offers: offers.sort((a, b) => a.quantity - b.quantity) };
  }

  /**
   * Adds `units` from this page: their "Buy N" when there is one (else "Buy 1", then that many typed
   * into QUANTITY), then BUY NOW. Staging must take exactly that many: its add request asks for
   * them, and the bag's count goes up by them. Refused ("not available for checkout" pop-up):
   * PRODUCT_NOT_AVAILABLE, as in the search results. `onAdded` is told of each unit added.
   */
  async buy(plu: string, units: number, onAdded?: () => void): Promise<void> {
    await closeChatPanelIfShown(this.page);
    const before = await bagCount(this.page);
    try {
      const offer = this.offer(units);
      if ((await offer.count()) === 1) {
        await offer.locator('label').click();
        await expect(offer).toHaveClass(/\bchecked\b/);
      } else {
        if ((await this.offer(1).count()) === 1) await this.offer(1).locator('label').click();
        await this.quantityBox.fill(String(units));
      }
      await expect(this.quantityBox).toHaveValue(String(units));
    } catch (error) {
      await throwIfServerErrorShown(this.page, `Choose ${units} of PLU ${plu}`, error);
      throw new StepError('UNEXPECTED_PAGE', 'Add to bag', `Could not choose ${units} of PLU ${plu} on its page.`, ['the product page changed', 'a pop-up covered it'], error);
    }

    // As in the search results: a click before the page's app has started does nothing, so it is
    // clicked again only while no add request was sent (never twice once one was).
    let request: Request | null = null;
    for (let attempt = 1; attempt <= 3 && !request; attempt++) {
      if (attempt > 1) log(`BUY NOW for PLU ${plu} did not reach the site (page still starting?); clicking it again`, 'WARN');
      await closeChatPanelIfShown(this.page);
      const sent = this.page.waitForRequest(isAddRequest, { timeout: 10_000 }).catch(() => null);
      await this.buyNowButton.click();
      request = await sent;
      if (!request && (await notAvailablePopup(this.page).count()) > 0) break;
    }
    // The amount asked for is in the request (qty). Another amount is reported, never made up for
    // here: Retry reads the bag first.
    const qty = request ? new URL(request.url()).searchParams.get('qty') : null;
    const wrongAmount = qty !== null && Number(qty) !== units;
    // Added when the bag's count is up by that many; refused when the pop-up shows (the count is
    // read briefly each time: the pop-up hides the header's bag button).
    let refused = (await notAvailablePopup(this.page).count()) > 0;
    let added = false;
    if (request && !wrongAmount && !refused) {
      added = await expect
        .poll(
          async () => {
            refused = (await notAvailablePopup(this.page).count()) > 0;
            return refused || (await bagCount(this.page, 2_000).catch(() => before)) >= before + units;
          },
          { timeout: 30_000 },
        )
        .toBe(true)
        .then(() => !refused, () => false);
    }
    if (refused) {
      await closeNotAvailablePopupIfShown(this.page);
      throw new StepError('PRODUCT_NOT_AVAILABLE', 'Add to bag', `Staging did not add PLU ${plu}: "Sorry the item(s) is not available for checkout."`, [
        'the product is out of stock for online orders',
        'the product is not sold online',
      ]);
    }
    if (!added) {
      await throwIfServerErrorShown(this.page, `Add PLU ${plu} to bag`);
      const now = await bagCount(this.page, 5_000).catch(() => '?');
      const reason = !request
        ? `BUY NOW on PLU ${plu}'s page sent nothing to the shop (3 clicks).`
        : wrongAmount
          ? `BUY NOW on PLU ${plu}'s page asked staging for ${qty} instead of ${units}.`
          : `Adding ${units} of PLU ${plu} on its page did not raise the bag count by ${units}.`;
      throw new StepError('PRODUCT_QUANTITY_MISMATCH', 'Add to bag', `${reason} (Bag count before: ${before}; now: ${now}.)`, [
        'the product just sold out',
        'a pop-up covered the button',
        'staging is slow',
      ]);
    }
    for (let unit = 1; unit <= units; unit++) onAdded?.();
    log(`Added PLU ${plu} x${units} on its page (BUY NOW); bag now ${await bagCount(this.page)}`);
  }
}
