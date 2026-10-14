import type { OrderLine } from '../config/order';
import type { Automation, OrderRunSnapshot } from './order-run';

// The structured result of one order test run (PRD §24, §35), written to
// reports/<run>/result.json. The launcher reads it to show PASS/FAIL and the order number.

export interface OrderTestResult {
  status: 'passed' | 'failed';
  /** "order" (the order flow) or "approve" (approving an existing order in the backoffice). */
  automation: Automation;
  /**
   * "order_placed" (and approved in the backoffice), "order_placed_unapproved" (placed, not
   * approved: the run had no backoffice account, 2026-10-14), "ready_to_check_out" (placing orders
   * was off), "approved" (Approve Order clicked by this run), "no_change" (the order to approve
   * was already extracted) or "failed".
   */
  outcome: 'order_placed' | 'order_placed_unapproved' | 'ready_to_check_out' | 'approved' | 'no_change' | 'failed';
  runId: string;
  orderNumber?: string;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  completedStep: string;
  /**
   * What failed (PRD §25), with the telemetry of 2026-10-07: when, the address of each open
   * browser tab then (without query strings) and the screenshots Playwright took of them.
   */
  error?: { code?: string; step: string; message: string; at: string; pages: string[]; screenshots: string[] };
  placeOrder: boolean;
  delivery: { method?: string; mode?: string };
  products: { ordered: OrderLine[]; soldOut: string[]; excludedNotEligible: string[]; freeGiftRemoved: string | null };
  /** The backoffice approval (runs that place or approve an order): approved here or not, and the statuses seen. */
  backoffice?: { approved: boolean; statuses: string[]; finalStatus?: string };
  consoleErrors: string[];
  artifacts: { folder: string; screenshots: string[]; trace?: string; log?: string; htmlReport?: string };
}

export interface ResultInput {
  runId: string;
  run: OrderRunSnapshot;
  passed: boolean;
  durationMs: number;
  errorMessage?: string;
  artifacts: OrderTestResult['artifacts'];
  /** The screenshots Playwright took because the test failed (a part of artifacts.screenshots). */
  failureScreenshots?: string[];
}

const stripColors = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

function outcomeOf(input: ResultInput, automation: Automation): OrderTestResult['outcome'] {
  if (!input.passed) return 'failed';
  if (automation === 'approve') return input.run.backoffice?.approved ? 'approved' : 'no_change';
  if (!input.run.orderNumber) return 'ready_to_check_out';
  return input.run.backoffice ? 'order_placed' : 'order_placed_unapproved';
}

export function buildOrderResult(input: ResultInput): OrderTestResult {
  const { run } = input;
  const automation = run.automation ?? 'order';
  const message = input.errorMessage ? stripColors(input.errorMessage).trim() : undefined;
  const finishedAt = new Date(Date.parse(run.startedAt) + input.durationMs).toISOString();
  return {
    status: input.passed ? 'passed' : 'failed',
    automation,
    outcome: outcomeOf(input, automation),
    runId: input.runId,
    orderNumber: run.orderNumber,
    durationMs: input.durationMs,
    startedAt: run.startedAt,
    finishedAt,
    completedStep: run.completedStep,
    error: message
      ? {
          // StepError messages start with "❌ <CODE>" and contain "Step: <name>" (src/utils/errors.ts).
          code: message.match(/❌ ([A-Z_]+)/)?.[1],
          step: message.match(/^Step: (.+)$/m)?.[1] ?? run.currentStep,
          message: message.split('\n').filter((line) => !/^\s+at /.test(line)).slice(0, 15).join('\n'),
          at: run.failure?.at ?? finishedAt,
          pages: run.failure?.pages ?? [],
          screenshots: input.failureScreenshots ?? [],
        }
      : undefined,
    placeOrder: run.placeOrder,
    delivery: { method: run.deliveryMethod, mode: run.deliveryMode },
    products: {
      ordered: run.ordered,
      soldOut: run.soldOut,
      excludedNotEligible: run.excluded,
      freeGiftRemoved: run.freeGiftRemoved,
    },
    backoffice: run.backoffice ? { ...run.backoffice, finalStatus: run.backoffice.statuses.at(-1) } : undefined,
    consoleErrors: run.consoleErrors,
    artifacts: input.artifacts,
  };
}

const minutes = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

const TITLES: Record<OrderTestResult['outcome'], string> = {
  order_placed: 'ORDER TEST PASSED',
  order_placed_unapproved: 'ORDER PLACED (NOT APPROVED YET)',
  ready_to_check_out: 'READY TO CHECK OUT (NO ORDER PLACED)',
  approved: 'ORDER APPROVED',
  no_change: 'NO CHANGE (ALREADY EXTRACTED)',
  failed: 'ORDER TEST FAILED',
};

/** The PRD's PASS/FAIL box (§23, §25), as plain text lines. */
export function formatResultBox(result: OrderTestResult): string {
  const width = 46;
  const line = (text: string) => `║ ${text.slice(0, width - 2).padEnd(width - 2)} ║`;
  const approving = result.automation === 'approve';
  const title = result.outcome === 'failed' && approving ? 'APPROVAL FAILED' : TITLES[result.outcome];
  const rows: string[] = [];
  if (result.status === 'passed') {
    if (result.orderNumber) rows.push(`Order Number: ${result.orderNumber}`);
    if (result.backoffice?.finalStatus) rows.push(`Backoffice: ${result.backoffice.finalStatus}`);
    if (result.outcome === 'order_placed_unapproved') rows.push('Backoffice: not approved yet');
    if (!approving) {
      rows.push(`Delivery: ${result.delivery.mode ?? '?'} (${result.delivery.method ?? '?'})`);
      rows.push(`Products: ${result.products.ordered.length}`);
      if (result.products.excludedNotEligible.length) rows.push(`Left out (not eligible): ${result.products.excludedNotEligible.join(', ')}`);
      if (result.products.soldOut.length) rows.push(`Skipped (sold out): ${result.products.soldOut.join(', ')}`);
    }
  } else {
    if (result.orderNumber) rows.push(`Order Number: ${result.orderNumber}`);
    rows.push(`Step: ${result.error?.step ?? result.completedStep}`);
    if (result.error?.code) rows.push(`Code: ${result.error.code}`);
    const reason = result.error?.message.match(/^Reason: (.+)$/m)?.[1] ?? result.error?.message.split('\n')[0] ?? '';
    // Wrap the reason at whole words.
    let current = '';
    const wrapped: string[] = [];
    for (const word of reason.split(' ')) {
      if (current && (current + ' ' + word).length > width - 10) {
        wrapped.push(current);
        current = word;
      } else current = current ? `${current} ${word}` : word;
    }
    if (current) wrapped.push(current);
    wrapped.slice(0, 5).forEach((part, i) => rows.push(`${i === 0 ? 'Reason: ' : '        '}${part}`));
  }
  rows.push(`Duration: ${minutes(result.durationMs)}`);
  const bar = '═'.repeat(width);
  return [`╔${bar}╗`, line(title.padStart(Math.floor((width - 2 + title.length) / 2))), `╠${bar}╣`, ...rows.map(line), `╚${bar}╝`].join('\n');
}
