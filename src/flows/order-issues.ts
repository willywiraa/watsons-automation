import type { DeliveryMethod, DeliveryMode, OrderLine } from '../config/order';
import { MODE_NAMES } from '../pages/CheckoutPage';
import { ask, type Answer, type AskOption, type Decision, type Question } from '../utils/ask';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';

// The questions the order flow asks the person before Checkout (user's request 2026-10-22), each
// with only the actions that are valid then. After Checkout nothing is asked or retried: the order
// may exist by then (PRD §41–42), so a problem there ends the run as before.

export const METHOD_NAMES: Record<DeliveryMethod, string> = { home_delivery: 'Home Delivery', click_collect: 'Click & Collect', shell_station: 'Shell Station' };
const DELIVERY_METHODS = Object.keys(METHOD_NAMES) as DeliveryMethod[];

export const listOf = (plus: string[]) => (plus.length === 1 ? `Product ${plus[0]}` : `Products ${plus.slice(0, -1).join(', ')} and ${plus.at(-1)}`);
/** An error's reason in one line (a StepError's "Reason:", else its first line). */
export const reasonOf = (error: unknown) => {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\u001b\[[0-9;]*m/g, '');
  return (message.match(/^Reason: (.+)$/m)?.[1] ?? message.split('\n').find((line) => line.trim() && !line.startsWith('❌')) ?? message).trim().slice(0, 300);
};

const PRODUCT_MESSAGES = {
  out_of_stock: (plu: string) => `Product ${plu} is out of stock. What would you like to do?`,
  not_found: (plu: string) => `Product ${plu} was not found on staging. What would you like to do?`,
  not_available: (plu: string) => `Product ${plu} can't be added to the bag. What would you like to do?`,
};

/**
 * A product out of stock or not found (Product Search), or that staging won't add (Add to bag;
 * `detail` says why). Skip only when something else is left to order.
 */
export function productQuestion(kind: keyof typeof PRODUCT_MESSAGES, plu: string, othersLeft: number, detail?: string): Question {
  const options: AskOption[] = [];
  if (othersLeft > 0) options.push({ action: 'skip', label: 'Skip product and continue' });
  options.push({ action: 'replace', label: 'Replace with another PLU' }, { action: 'stop', label: 'Stop automation' });
  return { kind, step: kind === 'not_available' ? 'Add to bag' : 'Product Search', plus: [plu], message: PRODUCT_MESSAGES[kind](plu), ...(detail ? { detail } : {}), options };
}

/** The other delivery methods, as "Try …" choices (whether they take the products shows when tried). */
export function otherMethods(current: DeliveryMethod, tried: DeliveryMethod[]): AskOption[] {
  return DELIVERY_METHODS.filter((method) => method !== current && !tried.includes(method)).map((method) => ({
    action: 'switch_method',
    method,
    label: `Try ${METHOD_NAMES[method]}`,
  }));
}

/**
 * The choices for products a delivery can't take (user's request 2026-10-22): take them out of
 * the bag and go on with the others, or take them out and add other PLUs instead; then the other
 * mode or methods, which keep them.
 */
export function removalOptions(plus: string[], othersLeft: number): AskOption[] {
  const one = plus.length === 1;
  const options: AskOption[] = [];
  if (othersLeft > 0) options.push({ action: 'skip', label: one ? 'Remove it and continue' : 'Remove them and continue' });
  options.push({ action: 'replace', label: one ? 'Replace with another PLU' : 'Remove them and add other PLUs', many: true });
  return options;
}

/**
 * Products the chosen delivery can't take, on the checkout page. `otherMode`: the other mode,
 * when it is offered and takes some of them; `othersLeft`: products that would remain if they were
 * removed.
 */
export function eligibilityQuestion(input: {
  plus: string[];
  mode: DeliveryMode;
  method: DeliveryMethod;
  otherMode: DeliveryMode | null;
  othersLeft: number;
  triedMethods: DeliveryMethod[];
}): Question {
  const { plus, mode, method, otherMode, othersLeft, triedMethods } = input;
  const options = removalOptions(plus, othersLeft);
  if (otherMode) options.push({ action: 'switch_mode', mode: otherMode, label: `Use ${MODE_NAMES[otherMode]} instead` });
  options.push(...otherMethods(method, triedMethods));
  options.push({ action: 'stop', label: 'Stop automation' });
  const verb = plus.length === 1 ? 'is' : 'are';
  return {
    kind: 'not_eligible',
    step: `${MODE_NAMES[mode]} Delivery Selection`,
    plus,
    message: `${listOf(plus)} ${verb} not eligible for ${MODE_NAMES[mode]} delivery with ${METHOD_NAMES[method]}.`,
    options,
  };
}

/**
 * Products the chosen delivery method can't take, on the bag page (BagPage.methodProblem);
 * `message`: staging's own words, shown as the details.
 */
export function methodEligibilityQuestion(input: { plus: string[]; method: DeliveryMethod; message: string; othersLeft: number; triedMethods: DeliveryMethod[] }): Question {
  const { plus, method, message, othersLeft, triedMethods } = input;
  const options: AskOption[] = plus.length > 0 ? removalOptions(plus, othersLeft) : [];
  options.push(...otherMethods(method, triedMethods), { action: 'stop', label: 'Stop automation' });
  const which = plus.length === 0 ? 'Some products are' : `${listOf(plus)} ${plus.length === 1 ? 'is' : 'are'}`;
  return { kind: 'not_eligible', step: 'Cart validation', plus, message: `${which} not eligible for ${METHOD_NAMES[method]}.`, ...(message ? { detail: message } : {}), options };
}

/**
 * An unexpected error before Checkout: Retry (when safe), skip the product concerned, `extra`
 * choices (e.g. another delivery method), or Stop.
 */
export function errorQuestion(step: string, error: unknown, { retry = true, skipPlu, extra = [] }: { retry?: boolean; skipPlu?: string; extra?: AskOption[] } = {}): Question {
  const options: AskOption[] = [];
  if (retry) options.push({ action: 'retry', label: 'Retry' });
  if (skipPlu) options.push({ action: 'skip', label: `Skip product ${skipPlu}` });
  options.push(...extra, { action: 'stop', label: 'Stop automation' });
  return {
    kind: 'error',
    step,
    plus: skipPlu ? [skipPlu] : [],
    message: `Something went wrong at ${step}${skipPlu ? ` (PLU ${skipPlu})` : ''}. How would you like to proceed?`,
    detail: reasonOf(error),
    options,
  };
}

/** "Stop automation" never reaches the test (the launcher stops the run): anything else unexpected ends it. */
export function stopped(step: string, answer: Answer, error?: unknown): never {
  if (error) throw error;
  throw new StepError('UNEXPECTED_PAGE', step, `The run cannot go on with the answer "${answer.action}".`);
}

/**
 * Runs `action`, a step that is safe to repeat. On an error, asks the person: Retry (runs it
 * again, `beforeRetry` first), `extra` choices (returned to the caller), or Stop. A command-line
 * run fails with the error, as before.
 */
export async function retryOrAsk<T>(
  step: string,
  decisions: Decision[],
  action: () => Promise<T>,
  options: { beforeRetry?: () => Promise<void> } = {},
): Promise<T> {
  for (;;) {
    try {
      return await action();
    } catch (error) {
      const answer = await ask(errorQuestion(step, error), { action: 'stop' }, decisions);
      if (answer.action !== 'retry') stopped(step, answer, error);
      log(`Retrying: ${step}`, 'WARN');
      await options.beforeRetry?.();
    }
  }
}

/** The product lines after replacing `plu` with `replacement` (same quantity; merged if already there). */
export function replaceLine(lines: OrderLine[], plu: string, replacement: string): OrderLine[] {
  const old = lines.find((line) => line.plu === plu);
  const quantity = old?.quantity ?? 1;
  const at = lines.findIndex((line) => line.plu === plu);
  const rest = lines.filter((line) => line.plu !== plu);
  if (rest.some((line) => line.plu === replacement)) return rest.map((line) => (line.plu === replacement ? { ...line, quantity: line.quantity + quantity } : line));
  // In the old one's place, so the order stays as written.
  return [...rest.slice(0, Math.max(at, 0)), { plu: replacement, quantity }, ...rest.slice(Math.max(at, 0))];
}

/** Whether a StepError (or other error) is one of these codes. */
export const hasCode = (error: unknown, ...codes: string[]) => error instanceof StepError && codes.includes(error.code);
