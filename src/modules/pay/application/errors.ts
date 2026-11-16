import { ApiError, BusinessRuleError } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';

/** PAY's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'pay.payment_invalid': 'This payment cannot be recorded like this.',
  'pay.requires_verification': 'Mobile money and card payments are confirmed by the payment provider, never entered by hand.',
});

export interface PaymentRule {
  readonly field: string;
  readonly rule: string;
}

/**
 * 422 PAYMENT_INVALID: every rule a tender breaks, each in `details[].code`: `METHOD_UNKNOWN`, `METHOD_DISABLED`,
 * `METHOD_NOT_FOR_CHANNEL`, `TENDER_NOT_AVAILABLE` (a method whose clearing is built in a later session, A-209),
 * `REGISTER_REQUIRED`, `AMOUNT_NOT_POSITIVE`, `ALLOCATION_NOT_POSITIVE`, `ALLOCATIONS_EXCEED_AMOUNT`.
 */
export class PaymentInvalidError extends BusinessRuleError {
  readonly code = 'PAYMENT_INVALID';
  readonly messageKey = 'pay.payment_invalid';
  constructor(rules: readonly PaymentRule[]) {
    super(`payment breaks ${rules.map((r) => r.rule).join(', ')}`, rules.map((r) => ({ field: r.field, code: r.rule, message: translate('pay.payment_invalid') })));
  }
}

/** 422 PAYMENT_METHOD_REQUIRES_VERIFICATION (FR-PAY-005): mobile money and card clear only from the provider. */
export class PaymentRequiresVerificationError extends BusinessRuleError {
  readonly code = 'PAYMENT_METHOD_REQUIRES_VERIFICATION';
  readonly messageKey = 'pay.requires_verification';
  constructor(field: string) {
    super('mobile money and card clear only from a verified provider callback or lookup', [{ field, code: 'PROVIDER_VERIFICATION_REQUIRED', message: translate('pay.requires_verification') }]);
  }
}

registerMessages({
  'pay.provider_unavailable': 'Mobile money cannot be taken right now. Cash still works; try mobile money again shortly.',
  'pay.allocation_exceeds_available': 'This allocation is more than the payment has left, or more than the document has outstanding.',
  'pay.refund_exceeds_payment': 'This refund is more than is left to refund on the payment.',
  'pay.refund_invalid': 'This refund cannot be made like this.',
  'pay.refund_maker': 'The person who asked for a refund cannot record it as paid.',
});

/** 503 PAYMENT_PROVIDER_UNAVAILABLE (FR-PAY-003): the provider cannot take a charge now; cash still works. */
export class PaymentProviderUnavailableError extends ApiError {
  readonly status = 503;
  readonly code = 'PAYMENT_PROVIDER_UNAVAILABLE';
  readonly messageKey = 'pay.provider_unavailable';
}

/** 422 ALLOCATION_EXCEEDS_AVAILABLE: beyond the payment's unallocated money (FR-PAY-009); BIL answers the document's side. */
export class AllocationExceedsAvailableError extends BusinessRuleError {
  readonly code = 'ALLOCATION_EXCEEDS_AVAILABLE';
  readonly messageKey = 'pay.allocation_exceeds_available';
  constructor(field: string) {
    super('the allocation exceeds what the payment has unallocated', [{ field, code: 'EXCEEDS_PAYMENT', message: translate('pay.allocation_exceeds_available') }]);
  }
}

/** 422 REFUND_EXCEEDS_PAYMENT (FR-PAY-012): more than the payment's unallocated, unrefunded money; the database holds it too. */
export class RefundExceedsPaymentError extends BusinessRuleError {
  readonly code = 'REFUND_EXCEEDS_PAYMENT';
  readonly messageKey = 'pay.refund_exceeds_payment';
  constructor(leftPesewas: bigint) {
    super(`the refund exceeds the ${leftPesewas} pesewas left to refund`, [{ field: '/amountPesewas', code: 'REFUND_EXCEEDS_PAYMENT', message: translate('pay.refund_exceeds_payment') }]);
  }
}

/**
 * 422 REFUND_INVALID: every rule a refund breaks, in `details[].code`: `AMOUNT_NOT_POSITIVE`, `PAYMENT_NOT_CLEARED`,
 * `DESTINATION_NOT_AVAILABLE`, `REASON_UNKNOWN`, `NOTE_REQUIRED`, `CREDIT_NOTE_NOT_AVAILABLE` (A-211), `NOT_RETRYABLE`,
 * `NOT_PAYABLE`, `PAID_BEFORE_APPROVAL`.
 */
export class RefundInvalidError extends BusinessRuleError {
  readonly code = 'REFUND_INVALID';
  readonly messageKey = 'pay.refund_invalid';
  constructor(rules: readonly PaymentRule[]) {
    super(`refund breaks ${rules.map((r) => r.rule).join(', ')}`, rules.map((r) => ({ field: r.field, code: r.rule, message: translate('pay.refund_invalid') })));
  }
}

/** 403 MAKER_CANNOT_CHECK: a refund's maker recording its payout (ADR-0017; the database refuses it too, `ck_refund_paid_by`). */
export class RefundMakerCannotPayError extends ApiError {
  readonly status = 403;
  readonly code = 'MAKER_CANNOT_CHECK';
  readonly messageKey = 'pay.refund_maker';
}
