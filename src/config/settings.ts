import { parseOrderNumber } from './order';

// Reads and checks the project's settings (loaded from the private .env file by
// playwright.config.ts).
//
// Error messages name the missing settings but never show any values, so a password
// can't end up in the terminal or in a test report.

export interface Settings {
  stagingUrl: string;
  username: string;
  password: string;
  /** The staging payment OTP: WATSONS_PAYMENT_OTP if set, else 1234 (what staging shows). */
  paymentOtp: string;
  /** Whether this run may click "Checkout" and pay, i.e. create a real staging order. */
  placeOrder: boolean;
  /** The order file to use instead of test-data/order.txt (the launcher sets this). */
  orderFile?: string;
  /**
   * Seconds from one "add to bag" click to the next: WATSONS_ADD_DELAY_SECONDS (the launcher's
   * "Seconds between adds" sets it for each run), else 10.
   */
  addDelaySeconds: number;
  /**
   * The existing order to approve in the backoffice (8 digits): WATSONS_APPROVE_ORDER, which the
   * launcher sets for "Approve existing order" runs (tests/approve.e2e.spec.ts).
   */
  approveOrder?: string;
  /**
   * The staging backoffice account (Customer Support role) that approves each new order.
   * Required when placeOrder is on or an order is to be approved; may be missing otherwise.
   */
  backoffice?: { username: string; password: string };
}

// The .env name each required setting is read from.
const ENV_NAMES = {
  stagingUrl: 'WATSONS_STAGING_URL',
  username: 'WATSONS_USERNAME',
  password: 'WATSONS_PASSWORD',
} as const satisfies Record<
  Exclude<keyof Settings, 'paymentOtp' | 'placeOrder' | 'orderFile' | 'addDelaySeconds' | 'approveOrder' | 'backoffice'>,
  string
>;

// Needed only for runs that place or approve an order (each new order is approved in the backoffice).
const BACKOFFICE_ENV_NAMES = { username: 'WATSONS_BACKOFFICE_USERNAME', password: 'WATSONS_BACKOFFICE_PASSWORD' } as const;

// Staging always shows 1234 for its test payments (user, 2026-10-05), so it needn't be set.
const DEFAULT_PAYMENT_OTP = '1234';

// The user's requirement (2026-10-04): at least 10 seconds between "add to bag" clicks. Since
// 2026-10-07 the person chooses it in the launcher (e.g. 5, 10 or 20); 10 stays the default.
export const DEFAULT_ADD_DELAY_SECONDS = 10;
export const MAX_ADD_DELAY_SECONDS = 120;

// The order switch (CLAUDE.md rule 3; PRD §38): OFF unless set to exactly "yes" for this run
// (`npm run order` does that). Not meant to be kept in .env.
const PLACE_ORDER = 'WATSONS_PLACE_ORDER';

export class SettingsError extends Error {
  name = 'SettingsError';
}

function readAddDelaySeconds(value: string | undefined): number {
  const text = value?.trim();
  if (!text) return DEFAULT_ADD_DELAY_SECONDS;
  if (!/^\d+$/.test(text) || Number(text) > MAX_ADD_DELAY_SECONDS) {
    throw new SettingsError(`WATSONS_ADD_DELAY_SECONDS must be a whole number of seconds from 0 to ${MAX_ADD_DELAY_SECONDS}.`);
  }
  return Number(text);
}

export function readSettings(env: Record<string, string | undefined> = process.env): Settings {
  const placeOrder = env[PLACE_ORDER]?.trim().toLowerCase() === 'yes';
  const approveText = env.WATSONS_APPROVE_ORDER?.trim();
  // Approving an existing order only uses the backoffice, so the shop test account isn't needed
  // then (on the hosted server, people enter a testing account only to place orders; 2026-10-08).
  const approvingOnly = Boolean(approveText) && !placeOrder;
  const shopAccount = approvingOnly ? [] : [ENV_NAMES.username, ENV_NAMES.password];
  const required = [ENV_NAMES.stagingUrl, ...shopAccount, ...(placeOrder || approveText ? Object.values(BACKOFFICE_ENV_NAMES) : [])];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new SettingsError(
      `Missing settings in .env: ${missing.join(', ')}. ` +
        'Open the .env file in the project folder, fill them in and save it (see README.md).',
    );
  }
  const approveOrder = approveText ? parseOrderNumber(approveText) : undefined;
  if (approveText && !approveOrder) {
    throw new SettingsError('WATSONS_APPROVE_ORDER must be an order number: 8 digits, optionally with WTCSG in front (e.g. 07091012).');
  }

  return {
    stagingUrl: env[ENV_NAMES.stagingUrl]!,
    // Empty only for approve-only runs, which never open the shop.
    username: env[ENV_NAMES.username] ?? '',
    password: env[ENV_NAMES.password] ?? '',
    paymentOtp: env.WATSONS_PAYMENT_OTP?.trim() || DEFAULT_PAYMENT_OTP,
    placeOrder,
    orderFile: env.WATSONS_ORDER_FILE?.trim() || undefined,
    addDelaySeconds: readAddDelaySeconds(env.WATSONS_ADD_DELAY_SECONDS),
    approveOrder,
    backoffice:
      env[BACKOFFICE_ENV_NAMES.username]?.trim() && env[BACKOFFICE_ENV_NAMES.password]?.trim()
        ? { username: env[BACKOFFICE_ENV_NAMES.username]!, password: env[BACKOFFICE_ENV_NAMES.password]! }
        : undefined,
  };
}
