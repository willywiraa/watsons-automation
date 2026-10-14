import { test } from '@playwright/test';
import type { DeliveryMethod, DeliveryMode, OrderLine } from '../config/order';
import { log } from '../utils/log';

// What an order test run did, step by step (PRD §24–27). Collected by the `orderRun` fixture
// (src/fixtures/staging.ts), attached to the test as "order-run", and turned into
// reports/<run>/result.json by src/reporting/result-reporter.ts.

/** What ran: the order flow (tests/order.e2e.spec.ts) or approving an existing order (tests/approve.e2e.spec.ts). */
export type Automation = 'order' | 'approve';

/** When a run failed, and the address of each open browser tab then (telemetry, user's request 2026-10-07). */
export interface RunFailure {
  at: string;
  pages: string[];
}

export interface OrderRunSnapshot {
  startedAt: string;
  completedStep: string;
  currentStep: string;
  /** Older runs have none: they were all order runs. */
  automation?: Automation;
  placeOrder: boolean;
  deliveryMethod?: DeliveryMethod;
  deliveryMode?: DeliveryMode;
  ordered: OrderLine[];
  soldOut: string[];
  excluded: string[];
  freeGiftRemoved: string | null;
  orderNumber?: string;
  /** The backoffice approval: whether this run clicked Approve Order, and the statuses seen after. */
  backoffice?: { approved: boolean; statuses: string[] };
  consoleErrors: string[];
  failure?: RunFailure;
}

/**
 * A page's address for the evidence: without query string or "#" part, which can hold login
 * details (the login page sends the browser through addresses carrying them).
 */
export function pageAddress(url: string): string {
  try {
    const { protocol, origin, pathname } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? `${origin}${pathname}` : url.split(/[?#]/)[0];
  } catch {
    return url.split(/[?#]/)[0];
  }
}

export class OrderRun {
  private readonly startedAt = new Date().toISOString();
  private completedStep = 'none';
  private currentStep = 'none';
  private failure?: RunFailure;
  readonly consoleErrors: string[] = [];
  readonly data: Omit<OrderRunSnapshot, 'startedAt' | 'completedStep' | 'currentStep' | 'consoleErrors' | 'failure'> & { automation: Automation } = {
    automation: 'order',
    placeOrder: false,
    ordered: [],
    soldOut: [],
    excluded: [],
    freeGiftRemoved: null,
  };

  /**
   * Runs one named step (shown in the report), remembering which steps finished. Logs
   * "Step: <name>" first; the launcher reads that line to show progress.
   */
  async step<T>(name: string, action: () => Promise<T>): Promise<T> {
    this.currentStep = name;
    log(`Step: ${name}`);
    try {
      const result = await test.step(name, action);
      this.completedStep = name;
      return result;
    } catch (error) {
      // The moment the step failed (the evidence's error time).
      this.failure ??= { at: new Date().toISOString(), pages: [] };
      throw error;
    }
  }

  /** Notes that the run failed (if no step noted it already) and the addresses of the open pages then. */
  recordFailure(pageUrls: string[]): void {
    this.failure ??= { at: new Date().toISOString(), pages: [] };
    this.failure.pages = pageUrls.map(pageAddress);
  }

  snapshot(): OrderRunSnapshot {
    return {
      startedAt: this.startedAt,
      completedStep: this.completedStep,
      currentStep: this.currentStep,
      consoleErrors: this.consoleErrors,
      ...this.data,
      ...(this.failure ? { failure: this.failure } : {}),
    };
  }
}
