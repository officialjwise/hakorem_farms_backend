import { BusinessRuleError, type ErrorDetail } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';

/** PRC's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'prc.processing_order_invalid': 'This processing order cannot be planned, started, recorded or completed like this.',
  'prc.processing_order_rule': 'This value is not valid on a processing order.',
  'prc.yield_standard_invalid': 'This yield standard is not valid.',
  'prc.yield_standard_rule': 'This value is not valid on a yield standard.',
  'prc.reference_not_found': 'Something this record refers to does not exist.',
  'prc.input_on_hold': 'This animal or lot is under a hold until the date shown and cannot be processed.',
});

function details(fields: ReadonlyArray<{ readonly field: string; readonly rule: string }>, messageKey: string): ErrorDetail[] {
  return fields.map((field) => ({ field: field.field, code: field.rule, message: translate(messageKey) }));
}

/**
 * 422 PROCESSING_ORDER_INVALID: an order breaks a processing rule (FR-PRC-001 to FR-PRC-008). Each `details[].code`
 * names it: `NO_INPUTS`, `INPUT_REPEATED`, `INPUT_NOT_AVAILABLE`, `INPUT_NOT_HERE`, `INPUT_NOT_AN_ANIMAL`,
 * `WRONG_BRANCH`, `NOT_A_PROCESSING_LOCATION`, `NOT_AN_OUTPUT_LOCATION`, `OUTPUT_WEIGHT_ABOVE_INPUT`,
 * `OUTPUT_NOT_A_LOT`, `OUTPUT_NOT_BY_WEIGHT`, `EXPIRY_BEFORE_PRODUCTION`, `NO_SALEABLE_OUTPUT`,
 * `REFERENCE_PRICE_MISSING` and the others in docs/API.md.
 */
export class ProcessingOrderInvalidError extends BusinessRuleError {
  readonly code = 'PROCESSING_ORDER_INVALID';
  readonly messageKey = 'prc.processing_order_invalid';

  constructor(fields: ReadonlyArray<{ readonly field: string; readonly rule: string }>) {
    super('the processing order breaks a processing rule', details(fields, 'prc.processing_order_rule'));
  }
}

/** 422 YIELD_STANDARD_INVALID: `SAME_PRODUCT`, `STANDARD_EXISTS`, `EXPECTED_ZERO` (FR-PRC-004). */
export class YieldStandardInvalidError extends BusinessRuleError {
  readonly code = 'YIELD_STANDARD_INVALID';
  readonly messageKey = 'prc.yield_standard_invalid';

  constructor(fields: ReadonlyArray<{ readonly field: string; readonly rule: string }>) {
    super('the yield standard breaks a rule', details(fields, 'prc.yield_standard_rule'));
  }
}

/** 422 REFERENCE_NOT_FOUND: an id in the request names no record (a location, stock unit or product). */
export class PrcReferenceNotFoundError extends BusinessRuleError {
  readonly code = 'REFERENCE_NOT_FOUND';
  readonly messageKey = 'prc.reference_not_found';

  constructor(fields: readonly string[]) {
    super('a referenced record does not exist', fields.map((field) => ({ field, code: 'REFERENCE_NOT_FOUND', message: translate('prc.reference_not_found') })));
  }
}

/**
 * 422 STOCK_UNIT_ON_HOLD (FR-PRC-001, FR-LIV-008): an input is under an unreleased hold. Each detail names the input,
 * the hold's kind as its code, and the date the hold ends in its message, or that it has no end.
 */
export class InputOnHoldError extends BusinessRuleError {
  readonly code = 'STOCK_UNIT_ON_HOLD';
  readonly messageKey = 'prc.input_on_hold';

  constructor(held: ReadonlyArray<{ readonly field: string; readonly identifier: string; readonly kind: string; readonly endsAt: Date | null }>) {
    super(
      'an input is under a hold',
      held.map((h) => ({ field: h.field, code: h.kind, message: `${translate('prc.input_on_hold')} ${h.identifier}: ${h.kind}, ${h.endsAt === null ? 'no end date' : `ends ${h.endsAt.toISOString()}`}` })),
    );
  }
}
