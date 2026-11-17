import { ApiError, BusinessRuleError, type ErrorDetail } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';

/** POS's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'pos.register_invalid': 'This till cannot be set up or changed like this.',
  'pos.shift_not_open': 'This shift is closing or closed. Sales and cash movements need an open shift.',
  'pos.shift_already_open': 'This till or this cashier already has a shift open.',
  'pos.shift_close_same_person': 'You ran this shift, so another supervisor must sign off its count.',
  'pos.shift_invalid': 'This shift cannot be opened or closed like this.',
  'pos.cash_movement_invalid': 'This cash movement cannot be recorded like this.',
  'pos.counter_sale_invalid': 'This counter sale cannot be taken like this.',
  'pos.rule': 'This value breaks a till rule.',
  'pos.device_invalid': 'This device cannot be enrolled or revoked like this.',
  'pos.device_credential_invalid': 'This device is not enrolled. Ask a manager to enrol it.',
  'pos.device_revoked': 'This device was revoked by a manager. Ask a manager to enrol it again.',
  'pos.device_credential_shown_once': 'This device was enrolled and its credential was shown once. Revoke it and enrol it again.',
});

export interface TillRule {
  readonly field: string;
  readonly rule: string;
}

function details(rules: readonly TillRule[]): ErrorDetail[] {
  return rules.map((rule) => ({ field: rule.field, code: rule.rule, message: translate('pos.rule') }));
}

/** 422 REGISTER_INVALID: `LOCATION_NOT_IN_BRANCH`, `LOCATION_NOT_SELLABLE`, `REGISTER_CODE_TAKEN`, `SHIFT_OPEN` (retiring a till with a shift open). */
export class RegisterInvalidError extends BusinessRuleError {
  readonly code = 'REGISTER_INVALID';
  readonly messageKey = 'pos.register_invalid';
  constructor(rules: readonly TillRule[]) {
    super('the till breaks a rule', details(rules));
  }
}

/** 422 SHIFT_NOT_OPEN: the shift is closing or closed; sales, cash movements and a close need it open. */
export class ShiftNotOpenError extends BusinessRuleError {
  readonly code = 'SHIFT_NOT_OPEN';
  readonly messageKey = 'pos.shift_not_open';
  constructor(status: string) {
    super(`the shift is ${status}`);
  }
}

/** 422 SHIFT_ALREADY_OPEN: the register or the cashier already has a shift that is not closed (FR-POS-015). */
export class ShiftAlreadyOpenError extends BusinessRuleError {
  readonly code = 'SHIFT_ALREADY_OPEN';
  readonly messageKey = 'pos.shift_already_open';
  constructor(field: '/registerId' | '/cashier') {
    super('a shift is already open', [{ field, code: field === '/registerId' ? 'REGISTER_HAS_OPEN_SHIFT' : 'CASHIER_HAS_OPEN_SHIFT', message: translate('pos.shift_already_open') }]);
  }
}

/** 422 SHIFT_CLOSE_SAME_PERSON: the supervisor signing off a count is its cashier (FR-POS-018). */
export class ShiftCloseSamePersonError extends BusinessRuleError {
  readonly code = 'SHIFT_CLOSE_SAME_PERSON';
  readonly messageKey = 'pos.shift_close_same_person';
  constructor() {
    super('the cashier cannot sign off their own count');
  }
}

/**
 * 422 SHIFT_INVALID: `REGISTER_RETIRED`, `OPENED_AT_OUT_OF_WINDOW`, `ID_NOT_UUID_V7`, `CASH_NOT_DECLARED`,
 * `METHOD_DECLARED_TWICE`, `METHOD_UNKNOWN`, `DEVICE_SALES_NOT_SYNCED`, `SHIFT_NOT_CLOSING`.
 */
export class ShiftInvalidError extends BusinessRuleError {
  readonly code = 'SHIFT_INVALID';
  readonly messageKey = 'pos.shift_invalid';
  constructor(rules: readonly TillRule[]) {
    super('the shift breaks a rule', details(rules));
  }
}

/**
 * 422 CASH_MOVEMENT_INVALID (FR-POS-016): `AMOUNT_NOT_POSITIVE`, `REASON_REQUIRED`, `REASON_NOT_FOR_KIND`, `NOTE_REQUIRED`,
 * `WITNESS_REQUIRED`, `WITNESS_IS_MAKER`, `WITNESS_NOT_SUPERVISOR`, `WITNESS_ONLY_ON_DROP`, `TILL_OVERDRAWN`,
 * `OCCURRED_AT_OUT_OF_WINDOW`, `ID_NOT_UUID_V7`.
 */
export class CashMovementInvalidError extends BusinessRuleError {
  readonly code = 'CASH_MOVEMENT_INVALID';
  readonly messageKey = 'pos.cash_movement_invalid';
  constructor(rules: readonly TillRule[]) {
    super('the cash movement breaks a rule', details(rules));
  }
}

/**
 * 422 COUNTER_SALE_INVALID: `CHANGE_ONLY_FROM_CASH`, `TENDERED_BELOW_AMOUNT`, `METHOD_UNKNOWN`, `OFFLINE_TENDER_ONLY`,
 * `PROVIDER_PAYMENT_NOT_AVAILABLE`, `OCCURRED_AT_OUT_OF_WINDOW`, `ID_NOT_UUID_V7`, `ID_DIFFERS_FROM_KEY`.
 */
export class CounterSaleInvalidError extends BusinessRuleError {
  readonly code = 'COUNTER_SALE_INVALID';
  readonly messageKey = 'pos.counter_sale_invalid';
  constructor(rules: readonly TillRule[]) {
    super('the counter sale breaks a rule', details(rules));
  }
}

/** 422 DEVICE_INVALID (ADR-0016): `REGISTER_RETIRED`, `DEVICE_ALREADY_REVOKED`. */
export class DeviceInvalidError extends BusinessRuleError {
  readonly code = 'DEVICE_INVALID';
  readonly messageKey = 'pos.device_invalid';
  constructor(rules: readonly TillRule[]) {
    super('the device breaks a rule', details(rules));
  }
}

/** 401 DEVICE_CREDENTIAL_INVALID: the `X-Device-Credential` is missing or unknown (docs/API.md section 3.9). */
export class DeviceCredentialInvalidError extends ApiError {
  readonly status = 401;
  readonly code = 'DEVICE_CREDENTIAL_INVALID';
  readonly messageKey = 'pos.device_credential_invalid';
}

/** 403 DEVICE_REVOKED: the device was revoked by a manager; it sells and syncs nothing (OFFLINE_SYNC 6.4). */
export class DeviceRevokedError extends ApiError {
  readonly status = 403;
  readonly code = 'DEVICE_REVOKED';
  readonly messageKey = 'pos.device_revoked';
}

/**
 * 409 DEVICE_CREDENTIAL_SHOWN_ONCE: an `enrolDevice` replayed with its key. The credential is never stored in the clear,
 * not even in the idempotency store, so a lost answer is recovered by revoking the device and enrolling it again (A-274).
 */
export class DeviceCredentialShownOnceError extends ApiError {
  readonly status = 409;
  readonly code = 'DEVICE_CREDENTIAL_SHOWN_ONCE';
  readonly messageKey = 'pos.device_credential_shown_once';
}
