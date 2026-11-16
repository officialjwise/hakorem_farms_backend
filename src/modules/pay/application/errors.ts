import { BusinessRuleError } from '../../../platform/errors/api-error';
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
