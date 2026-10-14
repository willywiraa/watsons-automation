import { expect, type Frame, type Page } from '@playwright/test';
import { STAGING_PAYMENT_HOST } from '../safety/staging-guard';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';

// The payment pages after "Checkout" (PRD §20–22), verified on staging 2026-10-05 with test
// order 07088015 (inspection/pay-*):
// 1. CyberSource TEST "Payment Acceptance - Review" (testsecureacceptance.cybersource.com/oneclick/review)
//    with the saved card: one <input type="submit" value="Pay">.
// 2. CyberSource "Payment" (/payer_authentication/hybrid): card verification. The OTP field
//    <input name="challengeDataEntry"> and <input type="submit" value="SUBMIT"> are inside a frame
//    from the verification service's test environment (OTP_FRAME_HOSTS). It takes ~15 s to appear.
// Each button is clicked at most once and nothing is ever retried (PRD §41–42).

// Cardinal Commerce's test card-verification servers; each run gets one of them. Seen
// 2026-10-05 (0…) and 2026-10-06 (1…); the user approved both on 2026-10-06. Any other server
// stops the test before the OTP is typed.
const OTP_FRAME_HOSTS: ReadonlySet<string> = new Set([
  '0merchantacsstag.cardinalcommerce.com',
  '1merchantacsstag.cardinalcommerce.com',
]);

const paymentFailed = (reason: string, error?: unknown) =>
  new StepError('PAYMENT_FAILED', 'Payment', reason, [
    'the payment page changed or is slow',
    'check the order history before running again (the order was probably not created)',
  ], error);

export class PaymentPage {
  constructor(private readonly page: Page) {}

  /** Clicks "Pay" once on the approved CyberSource test review page. */
  async pay(): Promise<void> {
    const host = new URL(this.page.url()).host;
    if (host !== STAGING_PAYMENT_HOST) {
      throw new StepError('UNEXPECTED_PAGE', 'Pay', `Not on the approved test payment page (on ${host}).`);
    }
    const payButton = this.page.locator('input[type="submit"][value="Pay"]');
    try {
      await expect(payButton).toHaveCount(1, { timeout: 60_000 });
      await payButton.click();
    } catch (error) {
      throw paymentFailed('The "Pay" button could not be clicked.', error);
    }
    log('Pay clicked');
  }

  /** Waits for the OTP field in the card-verification frame, enters the OTP and submits it once. */
  async submitOtp(otp: string): Promise<void> {
    let frame: Frame | undefined;
    const findOtpFrame = async () => {
      for (const candidate of this.page.frames()) {
        const fields = candidate.locator('input[name="challengeDataEntry"]').filter({ visible: true });
        if ((await fields.count().catch(() => 0)) === 1) return candidate;
      }
      return undefined;
    };
    try {
      await expect.poll(async () => (frame = await findOtpFrame()) !== undefined, { timeout: 90_000, intervals: [1_000] }).toBe(true);
    } catch (error) {
      throw new StepError('OTP_INPUT_NOT_FOUND', 'OTP', 'The OTP field did not appear within 90 seconds.', [
        'card verification is slow or changed',
        'check the order history before running again (the order was probably not created)',
      ], error);
    }
    const frameHost = new URL(frame!.url()).host;
    if (!OTP_FRAME_HOSTS.has(frameHost)) {
      throw new StepError('UNEXPECTED_PAGE', 'OTP', `The OTP field is on an unexpected address (${frameHost}), so it was not filled in.`);
    }

    // The OTP is the staging test code (published in the PRD and shown by staging), not a secret.
    const field = frame!.locator('input[name="challengeDataEntry"]');
    const submit = frame!.locator('input[type="submit"][value="SUBMIT"]');
    try {
      await field.fill(otp);
      await expect(field).toHaveValue(otp);
      await expect(submit).toHaveCount(1);
    } catch (error) {
      throw new StepError('PAYMENT_SUBMIT_FAILED', 'OTP', 'The OTP could not be entered, so it was not submitted.', [
        'card verification changed',
        'check the order history before running again (the order was probably not created)',
      ], error);
    }
    await submit.click();
    log('OTP submitted');
  }
}
