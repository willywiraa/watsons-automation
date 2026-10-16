import type { DeliveryMode, OrderLine } from '../config/order';
import { MODE_NAMES, type CheckoutPage } from '../pages/CheckoutPage';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';

// What each delivery mode does on the checkout summary page. The order flow itself
// (tests/order.e2e.spec.ts) is the same for every mode.

export interface ModeResult {
  /** The products this mode delivers: they make up the order. */
  kept: OrderLine[];
  /** The products this mode can't deliver: left out of the order, and reported. */
  excluded: OrderLine[];
}

export interface DeliveryModeSteps {
  /**
   * On the checkout summary page: select this mode. `lines` are the products in the bag and
   * `namesByPlu` their names on the bag page (the checkout page lists products by name only).
   */
  selectOnCheckout(checkout: CheckoutPage, lines: OrderLine[], namesByPlu: Record<string, string>): Promise<ModeResult>;
}

// Express (user's decision 2026-10-05) and Standard (user's request 2026-10-13: "the rest are the
// same"): continue with the products the mode can deliver, and report the others. Staging itself
// leaves "Not available" products out once the mode is chosen. Whichever the mode, a delivery date
// its option asks for is chosen before Checkout: the latest available (user's request 2026-10-16).
function modeSteps(mode: DeliveryMode, name: string, notFound: 'EXPRESS_OPTION_NOT_FOUND' | 'STANDARD_OPTION_NOT_FOUND'): DeliveryModeSteps {
  return {
    async selectOnCheckout(checkout, lines, namesByPlu) {
      // No options to choose from (user's request 2026-10-14): the products can only go one way,
      // which the page has already chosen. Nothing to select or leave out: on to Checkout.
      const offered = await checkout.offeredModes(mode);
      if (offered.length === 1) {
        const only = MODE_NAMES[offered[0]];
        if (offered[0] !== mode) {
          throw new StepError(notFound, `${name} Delivery Selection`, `The checkout page offers only ${only} for these products (no delivery options to choose from), so none of them can be delivered by ${name}. No order was placed.`, [
            `these products can only go ${only}: run them with ${only}`,
          ]);
        }
        log(`No delivery options to choose from: these products only go ${name}, already chosen. Going on to Checkout.`);
        await checkout.chooseDeliveryDateIfAsked(mode);
        await checkout.expectReadyToCheckOut(`${name} Delivery Selection`);
        // Options drawn late after all: then choose as usual, below.
        if (!(await checkout.showsChoice())) return { kept: lines, excluded: [] };
        log('Delivery options appeared after all: selecting the mode as usual', 'WARN');
      }

      const unavailable = await checkout.unavailableFor(mode, namesByPlu);
      const excluded = lines.filter((line) => unavailable.includes(line.plu));
      const kept = lines.filter((line) => !unavailable.includes(line.plu));
      if (kept.length === 0) {
        throw new StepError(notFound, `${name} Delivery Selection`, `None of the products can be delivered by ${name}.`);
      }
      if (excluded.length > 0) {
        log(`Not available for ${name}, left out of this order: PLU ${excluded.map((line) => line.plu).join(', ')}`, 'WARN');
      } else {
        log(`All products are available for ${name}`);
      }
      await checkout.select(mode);
      await checkout.chooseDeliveryDateIfAsked(mode);
      return { kept, excluded };
    },
  };
}

const MODE_STEPS: Record<DeliveryMode, DeliveryModeSteps> = {
  express: modeSteps('express', 'Express', 'EXPRESS_OPTION_NOT_FOUND'),
  standard: modeSteps('standard', 'Standard', 'STANDARD_OPTION_NOT_FOUND'),
};

export function deliveryModeSteps(mode: DeliveryMode): DeliveryModeSteps {
  return MODE_STEPS[mode];
}
