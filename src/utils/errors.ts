// Failures that name the step that failed and why (PRD §25), instead of a bare TimeoutError.

export type StepErrorCode =
  | 'LOGIN_FAILED'
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_QUANTITY_MISMATCH'
  | 'CART_VALIDATION_FAILED'
  | 'FREE_GIFT_REMOVAL_FAILED'
  | 'DELIVERY_METHOD_NOT_FOUND'
  | 'EXPRESS_OPTION_NOT_FOUND'
  | 'STANDARD_OPTION_NOT_FOUND'
  | 'DELIVERY_DATE_NOT_AVAILABLE'
  | 'CHECKOUT_FAILED'
  | 'PAYMENT_FAILED'
  | 'OTP_INPUT_NOT_FOUND'
  | 'PAYMENT_SUBMIT_FAILED'
  | 'PAYMENT_RESULT_UNKNOWN'
  | 'ORDER_CONFIRMATION_NOT_FOUND'
  | 'ORDER_NUMBER_NOT_FOUND'
  | 'STAGING_SERVER_ERROR'
  | 'UNEXPECTED_PAGE'
  // The backoffice approval after the order (Phase 13, user's request 2026-10-06).
  | 'BACKOFFICE_LOGIN_FAILED'
  | 'ORDER_NOT_FOUND_IN_BACKOFFICE'
  | 'ORDER_APPROVAL_FAILED'
  | 'ORDER_APPROVAL_UNKNOWN'
  | 'ORDER_NOT_EXTRACTED';

export class StepError extends Error {
  name = 'StepError';
  readonly code: StepErrorCode;
  readonly step: string;

  constructor(code: StepErrorCode, step: string, reason: string, possibleCauses: string[] = [], cause?: unknown) {
    const lines = [`❌ ${code}`, '', `Step: ${step}`, `Reason: ${reason}`];
    if (possibleCauses.length > 0) {
      lines.push('', 'Possible causes:', ...possibleCauses.map((possibleCause) => `- ${possibleCause}`));
    }
    if (cause instanceof Error) lines.push('', `Details: ${cause.message.split('\n')[0]}`);
    super(lines.join('\n'), { cause });
    this.code = code;
    this.step = step;
  }
}
