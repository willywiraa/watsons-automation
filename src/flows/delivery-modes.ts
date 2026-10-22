import type { DeliveryMethod, DeliveryMode, OrderLine } from '../config/order';
import { MODE_NAMES, type CheckoutPage } from '../pages/CheckoutPage';
import { ask, interactive, type Decision } from '../utils/ask';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';
import { eligibilityQuestion, stopped } from './order-issues';

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

/** After the checkout page's delivery mode: on to Checkout, or back to change something first. */
export type DeliveryNext =
  | ({ kind: 'ready' } & ModeResult)
  | { kind: 'mode'; mode: DeliveryMode }
  | { kind: 'method'; method: DeliveryMethod }
  | { kind: 'replace'; plu: string; replacement: string };

/**
 * The checkout page (user's request 2026-10-22): when some products can't go with this mode and
 * method, the person chooses first (the other mode when it takes them, another method, leave them
 * out, replace the product, or stop) instead of the run leaving them out by itself. A
 * command-line run: selectOnCheckout, as before.
 */
export async function chooseDelivery(input: {
  checkout: CheckoutPage;
  mode: DeliveryMode;
  method: DeliveryMethod;
  lines: OrderLine[];
  namesByPlu: Record<string, string>;
  decisions: Decision[];
  triedMethods: DeliveryMethod[];
}): Promise<DeliveryNext> {
  const { checkout, mode, method, lines, namesByPlu, decisions, triedMethods } = input;
  const steps = deliveryModeSteps(mode);
  if (!interactive()) return { kind: 'ready', ...(await steps.selectOnCheckout(checkout, lines, namesByPlu)) };

  const other: DeliveryMode = mode === 'express' ? 'standard' : 'express';
  const offered = await checkout.offeredModes(mode);
  let unavailable: string[] = [];
  let otherTakesThem = false;
  if (offered.length === 1 && offered[0] !== mode) {
    // The page offers only the other mode: none of the products can go this way.
    unavailable = lines.map((line) => line.plu);
    otherTakesThem = true;
  } else if (offered.length === 2) {
    unavailable = await checkout.unavailableFor(mode, namesByPlu);
    if (unavailable.length > 0) {
      const otherUnavailable = await checkout.unavailableFor(other, namesByPlu).catch(() => null);
      otherTakesThem = otherUnavailable !== null && unavailable.some((plu) => !otherUnavailable.includes(plu));
    }
  }
  if (unavailable.length === 0) return { kind: 'ready', ...(await steps.selectOnCheckout(checkout, lines, namesByPlu)) };

  const answer = await ask(
    eligibilityQuestion({
      plus: unavailable,
      mode,
      method,
      otherMode: otherTakesThem ? other : null,
      othersLeft: lines.filter((line) => !unavailable.includes(line.plu)).length,
      triedMethods,
    }),
    { action: 'stop' },
    decisions,
  );
  if (answer.action === 'switch_mode' && answer.mode) return { kind: 'mode', mode: answer.mode };
  if (answer.action === 'switch_method' && answer.method) return { kind: 'method', method: answer.method };
  if (answer.action === 'replace' && answer.plu) return { kind: 'replace', plu: unavailable[0], replacement: answer.plu };
  // Leave them out: staging does that once the mode is chosen, as before.
  if (answer.action === 'skip') return { kind: 'ready', ...(await steps.selectOnCheckout(checkout, lines, namesByPlu)) };
  return stopped(`${MODE_NAMES[mode]} Delivery Selection`, answer);
}
