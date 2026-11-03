import type { DeliveryMethod, DeliveryMode, OrderLine } from '../config/order';
import { MODE_NAMES, type CheckoutPage } from '../pages/CheckoutPage';
import { ask, decided, interactive, pluList, type Decision } from '../utils/ask';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';
import { eligibilityQuestion, plusText, stopped } from './order-issues';

// What each delivery mode does on the checkout summary page. The order flow itself
// (tests/order.e2e.spec.ts) is the same for every mode.

export interface ModeResult {
  /** The products this mode delivers: they make up the order. */
  kept: OrderLine[];
  /** The products this mode can't deliver: left out of the order, and reported. */
  excluded: OrderLine[];
  /** Shell Station: the pickup store chosen (src/flows/shell-station.ts, 2026-10-30). */
  store?: string;
  /**
   * A partial order (user's request 2026-11-03): the products this mode can't deliver go in a
   * second order by `mode`, once this one is placed (staging keeps them in the bag). They are not
   * in `excluded` then.
   */
  followUp?: { mode: DeliveryMode; lines: OrderLine[] };
}

/** The other delivery mode. */
export const otherMode = (mode: DeliveryMode): DeliveryMode => (mode === 'express' ? 'standard' : 'express');

/** What the checkout page was already seen to offer, so it isn't looked up twice (2026-10-22). */
export interface KnownModes {
  offered: DeliveryMode[];
  /** The run's mode's "Not available" products, when its list was read. */
  unavailable?: string[];
}

export interface DeliveryModeSteps {
  /**
   * On the checkout summary page: select this mode. `lines` are the products in the bag and
   * `namesByPlu` their names on the bag page (the checkout page lists products by name only).
   * `followUp`: the mode of a second order for the products this one can't deliver (a partial
   * order, 2026-11-03), instead of leaving them out.
   */
  selectOnCheckout(checkout: CheckoutPage, lines: OrderLine[], namesByPlu: Record<string, string>, known?: KnownModes, followUp?: DeliveryMode): Promise<ModeResult>;
}

// Express (user's decision 2026-10-05) and Standard (user's request 2026-10-13: "the rest are the
// same"): continue with the products the mode can deliver, and report the others. Staging itself
// leaves "Not available" products out once the mode is chosen (and keeps them in the bag for the
// next order). Whichever the mode, a delivery date its option asks for is chosen before Checkout:
// the latest available (user's request 2026-10-16).
function modeSteps(mode: DeliveryMode, name: string, notFound: 'EXPRESS_OPTION_NOT_FOUND' | 'STANDARD_OPTION_NOT_FOUND'): DeliveryModeSteps {
  return {
    async selectOnCheckout(checkout, lines, namesByPlu, known, followUp) {
      // No options to choose from (user's request 2026-10-14): the products can only go one way,
      // which the page has already chosen. Nothing to select or leave out: on to Checkout.
      const offered = known?.offered ?? (await checkout.offeredModes(mode));
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

      const unavailable = known?.unavailable ?? (await checkout.unavailableFor(mode, namesByPlu));
      const excluded = lines.filter((line) => unavailable.includes(line.plu));
      const kept = lines.filter((line) => !unavailable.includes(line.plu));
      if (kept.length === 0) {
        throw new StepError(notFound, `${name} Delivery Selection`, `None of the products can be delivered by ${name}.`);
      }
      const later = excluded.length > 0 && followUp ? followUp : null;
      if (later) {
        log(`Not available for ${name}: PLU ${plusText(excluded)} ${excluded.length === 1 ? 'goes' : 'go'} in order 2, by ${MODE_NAMES[later]}, once this order is placed`, 'WARN');
      } else if (excluded.length > 0) {
        log(`Not available for ${name}, left out of this order: PLU ${excluded.map((line) => line.plu).join(', ')}`, 'WARN');
      } else {
        log(`All products are available for ${name}`);
      }
      await checkout.select(mode);
      await checkout.chooseDeliveryDateIfAsked(mode);
      return later ? { kept, excluded: [], followUp: { mode: later, lines: excluded } } : { kept, excluded };
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
  | { kind: 'remove'; plus: string[] }
  | { kind: 'replace'; plus: string[]; replacements: string[] };

/**
 * The checkout page (user's request 2026-10-22): when some products can't go with this mode and
 * method, the person chooses first instead of the run leaving them out by itself: remove them from
 * the bag and go on, remove them and add other PLUs (the user's request 2026-10-22), the other
 * mode when it takes them, another method, or stop.
 *
 * A partial order (user's request 2026-11-03), first among those choices: when the other mode takes
 * every product this one can't, and some can go this way, the order is split in two. This one goes
 * without them; staging keeps them in the bag, and a second order takes them by the other mode
 * (`followUp`). Only for the first order of a run (`allowSplit`): a second order is never split.
 * A command-line run can't be asked: it splits when it can, else it leaves them out, as before.
 */
export async function chooseDelivery(input: {
  checkout: CheckoutPage;
  mode: DeliveryMode;
  method: DeliveryMethod;
  lines: OrderLine[];
  namesByPlu: Record<string, string>;
  decisions: Decision[];
  triedMethods: DeliveryMethod[];
  allowSplit?: boolean;
}): Promise<DeliveryNext> {
  const { checkout, mode, method, lines, namesByPlu, decisions, triedMethods, allowSplit = false } = input;
  const steps = deliveryModeSteps(mode);
  const other = otherMode(mode);
  const offered = await checkout.offeredModes(mode);
  // The page offers only the other mode: none of the products can go this way.
  const onlyOther = offered.length === 1 && offered[0] !== mode;
  let unavailable: string[] = onlyOther ? lines.map((line) => line.plu) : [];
  let otherUnavailable: string[] | null = null;
  if (offered.length === 2) {
    unavailable = await checkout.unavailableFor(mode, namesByPlu);
    // Whether the other mode takes them: for the question, or for a split.
    if (unavailable.length > 0 && (interactive() || allowSplit)) otherUnavailable = await checkout.unavailableFor(other, namesByPlu).catch(() => null);
  }
  const known: KnownModes = { offered, ...(offered.length === 2 ? { unavailable } : {}) };
  if (unavailable.length === 0) return { kind: 'ready', ...(await steps.selectOnCheckout(checkout, lines, namesByPlu, known)) };

  const kept = lines.filter((line) => !unavailable.includes(line.plu));
  const rest = lines.filter((line) => unavailable.includes(line.plu));
  const otherTakes = (plu: string) => otherUnavailable !== null && !otherUnavailable.includes(plu);
  const canSplit = allowSplit && kept.length > 0 && rest.length > 0 && unavailable.every(otherTakes);
  // A command-line run (nobody to ask): the second order when the other mode takes them all; else
  // they are left out, or a mode that takes none of them fails (selectOnCheckout), as before.
  if (!interactive()) return { kind: 'ready', ...(await steps.selectOnCheckout(checkout, lines, namesByPlu, known, canSplit ? other : undefined)) };

  const answer = await ask(
    eligibilityQuestion({
      plus: unavailable,
      mode,
      method,
      otherMode: onlyOther || unavailable.some(otherTakes) ? other : null,
      othersLeft: kept.length,
      triedMethods,
      split: canSplit ? { kept, rest } : null,
    }),
    { action: 'stop' },
    decisions,
  );
  if (answer.action === 'split' && canSplit) {
    const result = await steps.selectOnCheckout(checkout, lines, namesByPlu, known, other);
    decided(decisions, `Order 1 by ${MODE_NAMES[mode]}: PLU ${plusText(kept)}; then order 2 by ${MODE_NAMES[other]}: PLU ${plusText(rest)}`);
    return { kind: 'ready', ...result };
  }
  if (answer.action === 'switch_mode' && answer.mode) return { kind: 'mode', mode: answer.mode };
  if (answer.action === 'switch_method' && answer.method) return { kind: 'method', method: answer.method };
  if (answer.action === 'replace' && answer.plu) return { kind: 'replace', plus: unavailable, replacements: pluList(answer.plu) };
  // Taken out of the bag, so the order is what the bag holds; then the bag and this page again.
  if (answer.action === 'skip') return { kind: 'remove', plus: unavailable };
  return stopped(`${MODE_NAMES[mode]} Delivery Selection`, answer);
}
