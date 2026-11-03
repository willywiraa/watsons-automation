import type { Page } from '@playwright/test';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';
import { throwIfServerErrorShown } from './popups';

// After the OTP is submitted, staging returns to /checkout/orderConfirmation/<order number>
// ("Thank you for your order!!", "Order Number #<number>"; verified 2026-10-05 with test orders
// 07088015–07088018). PRD §23: a test passes only with that page and its order number. The run
// ends on this page (user's decision 2026-10-05); it no longer opens the order history.

const CONFIRMATION_PATH = /\/checkout\/orderConfirmation\/(\d+)$/;

export class OrderConfirmationPage {
  constructor(
    private readonly page: Page,
    private readonly stagingUrl: URL,
  ) {}

  /** Waits for the confirmation page and returns the order number from its address. */
  async orderNumber(): Promise<string> {
    try {
      await this.page.waitForURL((url) => url.host === this.stagingUrl.host && CONFIRMATION_PATH.test(url.pathname), {
        timeout: 120_000,
      });
    } catch (error) {
      await throwIfServerErrorShown(this.page, 'Order confirmation', error).catch((serverError: StepError) => {
        throw new StepError('PAYMENT_RESULT_UNKNOWN', 'Order confirmation', `The OTP was submitted, then staging showed a server error. ${UNKNOWN_HINT}`, [], serverError);
      });
      throw new StepError('PAYMENT_RESULT_UNKNOWN', 'Order confirmation', `The OTP was submitted, but the order confirmation page did not appear. ${UNKNOWN_HINT}`, [
        'staging or the payment service is slow',
      ], error);
    }
    const orderNumber = new URL(this.page.url()).pathname.match(CONFIRMATION_PATH)![1];
    // The page can take a while to draw; showing the number is a bonus, the address is the proof.
    const shown = await this.page
      .getByText(orderNumber)
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => true, () => false);
    log(`Order confirmation detected: order ${orderNumber}${shown ? '' : ' (number not drawn on the page yet)'}`);
    const delivery = await this.deliveryShown();
    if (delivery) log(`The confirmation page shows the delivery method: ${delivery}`);
    return orderNumber;
  }

  /** What the page shows next to "Delivery Method" (e.g. "Store Express Pickup Delivery"), or null. */
  async deliveryShown(): Promise<string | null> {
    return this.page
      .evaluate(() => {
        const label = [...document.querySelectorAll('body *')].find((element) => element.children.length === 0 && /^\s*Delivery Method\s*$/i.test(element.textContent ?? ''));
        const text = (label?.parentElement?.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/^Delivery Method\s*/i, '');
        return text && text.length <= 80 ? text : null;
      })
      .catch(() => null);
  }

  /**
   * A partial order (2026-11-03): staging's note that the products this order didn't take are back
   * in the bag ("The remaining 1 items have been added to your bag."), or null when it shows none.
   */
  async remainingNotice(timeoutMs = 15_000): Promise<string | null> {
    const notice = this.page.getByText(/The remaining \d+ items? (?:have|has) been added to your bag/i).first();
    const shown = await notice.waitFor({ state: 'visible', timeout: timeoutMs }).then(() => true, () => false);
    return shown ? (await notice.innerText()).replace(/\s+/g, ' ').trim() : null;
  }
}

const UNKNOWN_HINT =
  'The order may or may not have been created: check My Account → Order History before running again. Automatic retry is disabled to prevent duplicate orders.';
