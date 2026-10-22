import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@playwright/test';
import type { DeliveryMethod, DeliveryMode } from '../config/order';
import { evidenceFolder } from '../reporting/result-reporter';
import { StepError } from './errors';
import { log } from './log';

// Asking the person who started the run (user's request 2026-10-22). When something needs a
// decision before Checkout (a product out of stock or not found, a product the chosen delivery
// can't take, an unexpected error), the run pauses, the launcher's window (or the hosted server's
// page) shows the question with the actions that make sense, and the run goes on with the answer.
//
// Only runs started from the launcher or the hosted server ask (WATSONS_INTERACTIVE=yes, set by
// launcher/launcher.cjs): nobody would answer a command-line run, which decides as before (the
// fallback answer).
//
// The question and its answer are files in the run's evidence folder: ask.json, written here before
// the "[ASK]" log line (the launcher reads it when it sees that line), and answer-<id>.json, written
// by the launcher. "Stop automation" never comes here: the launcher stops the run, as Stop does.

export type AskAction = 'skip' | 'replace' | 'retry' | 'switch_mode' | 'switch_method' | 'stop';

export interface AskOption {
  action: AskAction;
  /** The button's text, e.g. "Skip product and continue". */
  label: string;
  /** For switch_mode / switch_method: which one. */
  mode?: DeliveryMode;
  method?: DeliveryMethod;
}

export interface Question {
  /** not_available: staging refused to add the product ("not available for checkout"). */
  kind: 'out_of_stock' | 'not_found' | 'not_available' | 'not_eligible' | 'error';
  /** The step it happened at, as the launcher shows it (e.g. "Product Search"). */
  step: string;
  /** The products concerned (none for a general error). */
  plus: string[];
  /** One short sentence for the person, e.g. "Product 45274 is out of stock. What would you like to do?" */
  message: string;
  /** More about it, e.g. the error's reason. */
  detail?: string;
  options: AskOption[];
}

export interface Answer {
  action: AskAction;
  /** replace: the PLU to use instead. */
  plu?: string;
  mode?: DeliveryMode;
  method?: DeliveryMethod;
}

/** A question, what was chosen and what came of it: kept in the run's result (result.json). */
export interface Decision {
  at: string;
  step: string;
  kind: Question['kind'];
  plus: string[];
  message: string;
  action: AskAction;
  label: string;
  plu?: string;
  outcome?: string;
}

/** How long a question waits for its answer: then the run stops there (nothing is guessed). */
export const ANSWER_WAIT_MS = 30 * 60_000;

export const interactive = (): boolean => process.env.WATSONS_INTERACTIVE?.trim().toLowerCase() === 'yes';

let questions = 0;

/**
 * Asks the person and waits for the answer. A command-line run (not interactive) gets `fallback`,
 * what it always did. Logs the decision; `decisions` collects it for the result.
 */
export async function ask(question: Question, fallback: Answer, decisions: Decision[]): Promise<Answer> {
  if (!interactive()) return fallback;
  const id = ++questions;
  const folder = evidenceFolder(process.env.WATSONS_RUN_ID ?? 'run');
  mkdirSync(folder, { recursive: true });
  const answerFile = join(folder, `answer-${id}.json`);
  writeFileSync(join(folder, 'ask.json'), JSON.stringify({ id, ...question, askedAt: new Date().toISOString() }, null, 2));
  log(question.message, 'ASK');
  // The time spent waiting doesn't count against the test.
  test.setTimeout(test.info().timeout + ANSWER_WAIT_MS);
  const started = Date.now();
  while (!existsSync(answerFile)) {
    if (Date.now() - started > ANSWER_WAIT_MS) {
      throw new StepError('NO_ANSWER', question.step, `No answer within ${ANSWER_WAIT_MS / 60_000} minutes to: ${question.message} The run stopped here; nothing was guessed.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const answer = JSON.parse(readFileSync(answerFile, 'utf8')) as Answer;
  const option = question.options.find((candidate) => candidate.action === answer.action && candidate.mode === answer.mode && candidate.method === answer.method);
  if (!option || (answer.action === 'replace' && !/^\d+$/.test(answer.plu ?? ''))) {
    throw new StepError('UNEXPECTED_PAGE', question.step, `The answer to "${question.message}" was not one of the choices offered.`);
  }
  decisions.push({
    at: new Date().toISOString(),
    step: question.step,
    kind: question.kind,
    plus: question.plus,
    message: question.message,
    action: answer.action,
    label: option.label,
    ...(answer.plu ? { plu: answer.plu } : {}),
  });
  log(`Decision: ${option.label}${answer.plu ? ` (PLU ${answer.plu})` : ''}`);
  return answer;
}

/** What came of the latest decision, e.g. "Replaced by PLU 45606": logged and kept with it. */
export function decided(decisions: Decision[], outcome: string): void {
  if (!interactive()) return;
  const latest = decisions.at(-1);
  if (latest) latest.outcome = outcome;
  log(`Outcome: ${outcome}`);
}
