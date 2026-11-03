import type { Page, Response } from '@playwright/test';
import { StepError } from '../utils/errors';

/** What the shop says about one of the account's orders. */
export interface ShopOrderStatus {
  orderNumber: string;
  /** False when the order isn't this account's (the shop doesn't give it). */
  found: boolean;
  /** The order's status, e.g. "ORDER_EXTRACTED" (null when not found). */
  status: string | null;
  /** When it was extracted (ISO), once it has been; else null. */
  extractedAt: string | null;
}

/** Extracted: its status says so, or it has an extraction time (later statuses keep it). */
export const isExtractedOrder = (order: Pick<ShopOrderStatus, 'status' | 'extractedAt'>) => /EXTRACTED/i.test(order.status ?? '') || order.extractedAt !== null;

/** "2026-11-03T04:20:09+0000" (the shop's form) as ISO; null when there is none. */
function isoTime(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

// One of the signed-in account's orders, as My Account → Order History shows it
// (/my-account/order/<number>). Opening it makes the shop ask for the order
// (GET …/users/current/orders/<number>), and its answer has the order's own status and, once it is
// extracted, its extraction time: "status": "ORDER_EXTRACTED", "extractTime":
// "2026-11-03T04:20:09+0000" (seen 2026-11-03 with 07155003, 07155002 and 07151000; a delivered order
// keeps ORDER_EXTRACTED, its shipping has its own status). Only reads.
export class MyOrderPage {
  constructor(
    private readonly page: Page,
    private readonly stagingUrl: URL,
  ) {}

  async status(orderNumber: string): Promise<ShopOrderStatus> {
    const isOrder = (response: Response) =>
      response.request().method() === 'GET' && new URL(response.url()).pathname.endsWith(`/users/current/orders/${orderNumber}`);
    const answered = this.page.waitForResponse(isOrder, { timeout: 90_000 });
    await this.page.goto(new URL(`/my-account/order/${orderNumber}`, this.stagingUrl).href, { waitUntil: 'commit' });
    let response: Response;
    try {
      response = await answered;
    } catch (error) {
      throw new StepError('UNEXPECTED_PAGE', 'Order status', `The shop did not load order ${orderNumber} within 90 seconds.`, ['staging is slow', 'the order page changed'], error);
    }
    // Not this account's order (or no such order): the shop refuses it.
    if ([400, 403, 404].includes(response.status())) return { orderNumber, found: false, status: null, extractedAt: null };
    if (!response.ok()) throw new StepError('UNEXPECTED_PAGE', 'Order status', `The shop answered ${response.status()} for order ${orderNumber}.`, ['staging is having problems']);
    const order = (await response.json()) as { status?: unknown; extractTime?: unknown };
    return { orderNumber, found: true, status: typeof order.status === 'string' ? order.status : null, extractedAt: isoTime(order.extractTime) };
  }
}
