import type { DeliveryMethod, OrderLine, PickupStoreChoice } from '../config/order';
import type { CheckoutPage } from '../pages/CheckoutPage';
import { defaultStore, hasEverything, type PickupStore, type ShellStationPickup } from '../pages/ShellStationPickup';
import { ask, decided, interactive, pluList, type Decision, type Question } from '../utils/ask';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';
import type { DeliveryNext } from './delivery-modes';
import { listOf, otherMethods, removalOptions, stopped } from './order-issues';

// Shell Station on the checkout summary page (user's request 2026-10-30). It has no Express or
// Standard: its one way is a pickup at a Shell station, so the run chooses the pickup store instead
// of a mode, as the person said:
// - "Choose for me": the store the checkout page already shows (the account's last one); with none
//   yet, the first store in staging's list that has every product (else the first one).
// - "Let me choose": the run reads staging's list of Shell stations and asks the person which one.
//   Only runs from the launcher or the hosted server can ask: a command-line run chooses for itself.
// Then the order goes on to Checkout as usual.

/** The step's name, instead of "<Mode> Delivery Selection" (launcher/launcher.cjs shows it). */
export const PICKUP_STORE_STEP = 'Pickup Store Selection';

/** "Let me choose": which Shell station, from staging's list; the one chosen now is chosen to begin with. */
export function pickupStoreQuestion(stores: PickupStore[], current: string | null): Question {
  return {
    kind: 'choose_store',
    step: PICKUP_STORE_STEP,
    plus: [],
    message: 'Which Shell Station should the order be picked up from?',
    ...(current ? { detail: `Chosen now: ${current}.` } : {}),
    choices: stores.map((store) => ({
      value: store.code,
      label: store.name,
      detail: [store.address, ...store.tags, store.availability].filter(Boolean).join(' · '),
      ...((current ? store.name === current : store.checked) ? { selected: true } : {}),
    })),
    options: [
      { action: 'choose', label: 'Use this store' },
      { action: 'stop', label: 'Stop automation' },
    ],
  };
}

/**
 * Products the chosen store can't supply ("Not available" in its "Available items" list): take
 * them out of the bag, or replace them; another delivery method; or stop.
 */
export function pickupStoreAvailabilityQuestion(input: { plus: string[]; store: string; othersLeft: number; triedMethods: DeliveryMethod[] }): Question {
  const { plus, store, othersLeft, triedMethods } = input;
  return {
    kind: 'not_eligible',
    step: PICKUP_STORE_STEP,
    plus,
    message: `${listOf(plus)} ${plus.length === 1 ? 'is' : 'are'} not available at ${store}.`,
    options: [...removalOptions(plus, othersLeft), ...otherMethods('shell_station', triedMethods), { action: 'stop', label: 'Stop automation' }],
  };
}

/**
 * On the checkout summary page of a Shell Station order: chooses the pickup store as the person
 * said (`choice`), then checks the products against it. Ends ready to check out, or with the
 * person's other choice (another method, products removed or replaced).
 */
export async function choosePickupStore(input: {
  checkout: CheckoutPage;
  pickup: ShellStationPickup;
  choice: PickupStoreChoice;
  lines: OrderLine[];
  namesByPlu: Record<string, string>;
  decisions: Decision[];
  triedMethods: DeliveryMethod[];
}): Promise<DeliveryNext> {
  const { checkout, pickup, choice, lines, namesByPlu, decisions, triedMethods } = input;
  const step = PICKUP_STORE_STEP;
  const current = await pickup.chosenStore(step);
  const personChooses = choice === 'ask' && interactive();
  let store = current;
  if (current && !personChooses) {
    log(`Pickup store: ${current} (already chosen on the checkout page)`);
  } else {
    await pickup.openFinder(step);
    const stores = await pickup.allStores(step);
    let picked: PickupStore;
    if (personChooses) {
      const answer = await ask(pickupStoreQuestion(stores, current), { action: 'stop' }, decisions);
      const chosen = answer.action === 'choose' ? stores.find((candidate) => candidate.code === answer.value) : undefined;
      if (!chosen) return stopped(step, answer);
      picked = chosen;
    } else {
      picked = defaultStore(stores)!;
      log(`No pickup store chosen yet: choosing ${picked.name} (${picked.code}), the first in staging's list${hasEverything(picked) ? ' with every product' : ''}`);
    }
    await pickup.select(picked, step);
    if (personChooses) decided(decisions, `Pickup store: ${picked.name}`);
    store = picked.name;
  }
  const at = store ?? 'the pickup store';

  // Shell Station's one delivery option: the products it can't supply, then on to Checkout.
  await checkout.expectReadyToCheckOut(step);
  const unavailable = await checkout.unavailableIn(checkout.itemsButtons.first(), at, namesByPlu, (reason, error) =>
    new StepError('PICKUP_STORE_NOT_SELECTED', step, reason, ['staging is slow', 'the checkout page changed'], error),
  );
  const excluded = lines.filter((line) => unavailable.includes(line.plu));
  const kept = lines.filter((line) => !unavailable.includes(line.plu));
  if (excluded.length === 0) {
    log(`All products are available at ${at}`);
    return { kind: 'ready', kept, excluded, store: store ?? undefined };
  }
  if (interactive()) {
    const answer = await ask(pickupStoreAvailabilityQuestion({ plus: unavailable, store: at, othersLeft: kept.length, triedMethods }), { action: 'stop' }, decisions);
    if (answer.action === 'switch_method' && answer.method) return { kind: 'method', method: answer.method };
    if (answer.action === 'replace' && answer.plu) return { kind: 'replace', plus: unavailable, replacements: pluList(answer.plu) };
    // Taken out of the bag, so the order is what the bag holds; then the bag and this page again.
    if (answer.action === 'skip') return { kind: 'remove', plus: unavailable };
    return stopped(step, answer);
  }
  // A command-line run, as with Express: on without them, and they are reported.
  if (kept.length === 0) throw new StepError('PICKUP_STORE_NOT_SELECTED', step, `None of the products are available at ${at}.`, ['choose another Shell station, or another delivery method']);
  // launcher/launcher.cjs reads this line.
  log(`Not available at ${at}, left out of this order: PLU ${excluded.map((line) => line.plu).join(', ')}`, 'WARN');
  return { kind: 'ready', kept, excluded, store: store ?? undefined };
}
