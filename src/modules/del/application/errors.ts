import { BusinessRuleError, type ErrorDetail } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';

/** DEL's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'del.slot_request_invalid': 'These delivery slots cannot be made like this.',
  'del.capacity_below_booked': 'A slot cannot hold fewer deliveries than are already booked into it.',
  'del.reference_not_found': 'Something this request refers to does not exist.',
  'del.delivery_invalid': 'This delivery cannot be recorded like this.',
  'del.driver_cash_invalid': "This driver's cash cannot be handed in like this.",
  'del.route_invalid': "This driver's run cannot be planned, started or closed like this.",
});

function details(rules: readonly { readonly field: string; readonly rule: string }[], messageKey: string): ErrorDetail[] {
  return rules.map((rule) => ({ field: rule.field, code: rule.rule, message: translate(messageKey) }));
}

/** 422 SLOT_REQUEST_INVALID: a generation or capacity breaks a slot rule; `details[].code` names it (FR-DEL-001). */
export class SlotRequestInvalidError extends BusinessRuleError {
  readonly code = 'SLOT_REQUEST_INVALID';
  readonly messageKey = 'del.slot_request_invalid';
  constructor(rules: readonly { readonly field: string; readonly rule: string }[]) {
    super('slot request breaks a rule', details(rules, 'del.slot_request_invalid'));
  }
}

/** 422 CAPACITY_BELOW_BOOKED: a capacity below the slot's bookings (FR-DEL-001). */
export class CapacityBelowBookedError extends BusinessRuleError {
  readonly code = 'CAPACITY_BELOW_BOOKED';
  readonly messageKey = 'del.capacity_below_booked';
  constructor(booked: number) {
    super(`capacity below the ${booked} booked`, [{ field: '/capacity', code: 'BELOW_BOOKED', message: translate('del.capacity_below_booked') }]);
  }
}

/** 422 REFERENCE_NOT_FOUND: an id in the request names no live record. */
export class DelReferenceNotFoundError extends BusinessRuleError {
  readonly code = 'REFERENCE_NOT_FOUND';
  readonly messageKey = 'del.reference_not_found';
  constructor(fields: readonly string[]) {
    super(`unknown ${fields.join(', ')}`, details(fields.map((field) => ({ field, rule: 'UNKNOWN' })), 'del.reference_not_found'));
  }
}

/** 422 DELIVERY_INVALID: a delivery, its proof or its cash breaks a rule; `details[].code` names it (FR-DEL-003 to FR-DEL-009). */
export class DeliveryInvalidError extends BusinessRuleError {
  readonly code = 'DELIVERY_INVALID';
  readonly messageKey = 'del.delivery_invalid';
  constructor(rules: readonly { readonly field: string; readonly rule: string }[]) {
    super(`delivery breaks ${rules.map((r) => r.rule).join(', ')}`, details(rules, 'del.delivery_invalid'));
  }
}

/** 422 DRIVER_CASH_INVALID: a driver's hand-in breaks a rule; `details[].code` names it (FR-DEL-010, CR-057). */
export class DriverCashInvalidError extends BusinessRuleError {
  readonly code = 'DRIVER_CASH_INVALID';
  readonly messageKey = 'del.driver_cash_invalid';
  constructor(rules: readonly { readonly field: string; readonly rule: string }[]) {
    super(`hand-in breaks ${rules.map((r) => r.rule).join(', ')}`, details(rules, 'del.driver_cash_invalid'));
  }
}

/** 422 ROUTE_INVALID: a driver's run breaks a rule; `details[].code` names it (FR-DEL-005, the owner's close rule, 2026-11-23). */
export class RouteInvalidError extends BusinessRuleError {
  readonly code = 'ROUTE_INVALID';
  readonly messageKey = 'del.route_invalid';
  constructor(rules: readonly { readonly field: string; readonly rule: string }[]) {
    super(`route breaks ${rules.map((r) => r.rule).join(', ')}`, details(rules, 'del.route_invalid'));
  }
}
