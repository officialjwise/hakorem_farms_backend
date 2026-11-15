import { BusinessRuleError, type ErrorDetail } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';

/** INV's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'inv.insufficient_stock': 'There is not enough stock at this location for this line.',
  'inv.stock_unit_not_available': 'This animal or lot was already sold, is not at this location, or is not available.',
  'inv.stock_unit_on_hold': 'This animal or lot is under a hold and cannot be sold, consumed or transferred.',
  'inv.stock_unit_reserved': 'This stock is reserved for another order.',
  'inv.stock_movement_already_reversed': 'This movement has already been reversed.',
  'inv.goods_receipt_invalid': 'Some lines of this goods receipt are not valid.',
  'inv.goods_receipt_rule': 'This value is not valid on a goods receipt.',
  'inv.reference_not_found': 'Something this record refers to does not exist.',
  'inv.reference_unknown': 'There is no such record.',
  'inv.stock_transfer_invalid': 'Some lines of this transfer are not valid.',
  'inv.stock_transfer_rule': 'This value is not valid on a stock transfer.',
  'inv.transfer_variance': 'What was received and the variance must add up to what was dispatched, and a variance needs its reason.',
  'inv.transfer_variance_rule': 'This received quantity or reason is not valid.',
  'inv.stock_adjustment_invalid': 'Some lines of this adjustment are not valid.',
  'inv.stock_adjustment_rule': 'This value is not valid on a stock adjustment.',
  'inv.stock_reversal_not_possible': 'This movement cannot be reversed.',
  'inv.stock_reversal_rule': 'This reversal is not allowed.',
  'inv.stock_take_invalid': 'This stock take cannot be planned, started or counted like this.',
  'inv.stock_take_rule': 'This value is not valid on a stock take.',
  'inv.stock_take_not_counted': 'Some lines of this stock take are not counted yet, or need a recount.',
  'inv.stock_take_line_unfinished': 'This line is not counted yet, or needs a recount.',
  'inv.stock_hold_invalid': 'This hold cannot be placed or released like this.',
  'inv.stock_hold_rule': 'This value is not valid on a stock hold.',
  'inv.stock_exception_invalid': 'This stock exception cannot be resolved like this.',
  'inv.stock_exception_rule': 'This value is not valid for resolving this stock exception.',
  'inv.reorder_rule_invalid': 'This reorder rule is not valid.',
  'inv.reorder_rule_rule': 'This value is not valid on a reorder rule.',
  'inv.temperature_reading_invalid': 'This temperature reading cannot be recorded.',
  'inv.temperature_reading_rule': 'This value is not valid on a temperature reading.',
  'inv.stock_unit_expired': 'This lot is past its expiry date and cannot be sold. Write it off instead.',
  'inv.withdrawal_cannot_be_released': 'A veterinary withdrawal hold cannot be released early by anyone. It ends on its own date.',
});

function details(fields: ReadonlyArray<{ readonly field: string; readonly rule: string }>, messageKey: string): ErrorDetail[] {
  return fields.map((field) => ({ field: field.field, code: field.rule, message: translate(messageKey) }));
}

/**
 * 422 GOODS_RECEIPT_INVALID: a receipt breaks a receipt rule (FR-INV-005, FR-INV-009). Each `details[].code` names
 * the rule: `ONE_ANIMAL_PER_HEAD`, `TAG_REPEATED`, `TAG_IN_USE`, `BATCH_REQUIRED`, `BATCH_IN_USE`, `EXPIRY_REQUIRED`,
 * `EXPIRED_ON_ARRIVAL`, `NOT_A_RECEIVING_LOCATION`, `SUPPLIER_REQUIRED` and the others in docs/API.md.
 */
export class GoodsReceiptInvalidError extends BusinessRuleError {
  readonly code = 'GOODS_RECEIPT_INVALID';
  readonly messageKey = 'inv.goods_receipt_invalid';

  constructor(fields: ReadonlyArray<{ readonly field: string; readonly rule: string }>) {
    super('the goods receipt breaks a receipt rule', details(fields, 'inv.goods_receipt_rule'));
  }
}

/** 422 REFERENCE_NOT_FOUND: an id in the request names no record (a product, supplier, location or purchase order). */
export class InvReferenceNotFoundError extends BusinessRuleError {
  readonly code = 'REFERENCE_NOT_FOUND';
  readonly messageKey = 'inv.reference_not_found';

  constructor(fields: readonly string[]) {
    super('the request refers to records that do not exist', details(fields.map((field) => ({ field, rule: 'NOT_FOUND' })), 'inv.reference_unknown'));
  }
}

/** 422 STOCK_TRANSFER_INVALID: a transfer breaks a transfer rule (FR-INV-010); each `details[].code` names it. */
export class StockTransferInvalidError extends BusinessRuleError {
  readonly code = 'STOCK_TRANSFER_INVALID';
  readonly messageKey = 'inv.stock_transfer_invalid';

  constructor(fields: ReadonlyArray<{ readonly field: string; readonly rule: string }>) {
    super('the stock transfer breaks a transfer rule', details(fields, 'inv.stock_transfer_rule'));
  }
}

/**
 * 422 TRANSFER_VARIANCE: a receipt confirmation does not balance (FR-INV-011): received plus variance is not what was
 * dispatched, a variance has no reason, or a line is unanswered.
 */
export class TransferVarianceError extends BusinessRuleError {
  readonly code = 'TRANSFER_VARIANCE';
  readonly messageKey = 'inv.transfer_variance';

  constructor(fields: ReadonlyArray<{ readonly field: string; readonly rule: string }>) {
    super('the receipt confirmation does not balance to what was dispatched', details(fields, 'inv.transfer_variance_rule'));
  }
}

/** 422 STOCK_ADJUSTMENT_INVALID: an adjustment breaks an adjustment rule (FR-INV-012); each `details[].code` names it. */
export class StockAdjustmentInvalidError extends BusinessRuleError {
  readonly code = 'STOCK_ADJUSTMENT_INVALID';
  readonly messageKey = 'inv.stock_adjustment_invalid';

  constructor(fields: ReadonlyArray<{ readonly field: string; readonly rule: string }>) {
    super('the stock adjustment breaks an adjustment rule', details(fields, 'inv.stock_adjustment_rule'));
  }
}

/**
 * 422 STOCK_REVERSAL_NOT_POSSIBLE: the movement is of a kind that is never reversed by hand (a transfer's movement, a
 * value-only movement, a reversal), its reason is not one a reversal takes, or its cost pool no longer holds the value
 * it carried (A-134 (b)): the correction is then an adjustment.
 */
export class StockReversalNotPossibleError extends BusinessRuleError {
  readonly code = 'STOCK_REVERSAL_NOT_POSSIBLE';
  readonly messageKey = 'inv.stock_reversal_not_possible';

  constructor(fields: ReadonlyArray<{ readonly field: string; readonly rule: string }>) {
    super('the movement cannot be reversed', details(fields, 'inv.stock_reversal_rule'));
  }
}

/**
 * 422 STOCK_TAKE_INVALID: a stock take breaks a stock-take rule (FR-INV-013, FR-INV-014): its scope
 * (`NOT_A_STOCK_LOCATION`, `PRODUCTS_REQUIRED`, `NOT_FOR_FULL_SCOPE`, `PRODUCT_REPEATED`, `PRODUCT_NOT_STOCKED`,
 * `ANIMAL_NOT_COUNTED`), a scope that overlaps another take of the location (`SCOPE_OVERLAP`), or a batch of counts
 * (`NOT_COUNTING`, `NO_COUNTS`, `LINE_UNKNOWN`, `LINE_REPEATED`, `RECOUNT_IN_REVIEW_ONLY`, `COUNTING_CLOSED`,
 * `RECOUNT_NOT_NEEDED`).
 */
export class StockTakeInvalidError extends BusinessRuleError {
  readonly code = 'STOCK_TAKE_INVALID';
  readonly messageKey = 'inv.stock_take_invalid';
  constructor(fields: ReadonlyArray<{ readonly field: string; readonly rule: string }>) {
    super('the stock take breaks a stock-take rule', details(fields, 'inv.stock_take_rule'));
  }
}

/** 422 STOCK_TAKE_NOT_COUNTED: lines are uncounted (`NOT_COUNTED`) or await their recount (`RECOUNT_REQUIRED`). */
export class StockTakeNotCountedError extends BusinessRuleError {
  readonly code = 'STOCK_TAKE_NOT_COUNTED';
  readonly messageKey = 'inv.stock_take_not_counted';
  constructor(fields: ReadonlyArray<{ readonly field: string; readonly rule: string }>) {
    super('the stock take has lines not counted or awaiting a recount', details(fields, 'inv.stock_take_line_unfinished'));
  }
}

/**
 * 422 STOCK_HOLD_INVALID: a hold breaks a hold rule (FR-INV-022, A-142): `STOCK_UNIT_NOT_ACTIVE`,
 * `ENDS_BEFORE_IT_STARTS`, `WITHDRAWAL_NEEDS_AN_END`, or on release `REASON_NOT_ALLOWED` and `RELEASED_BY_PLACER`.
 */
export class StockHoldInvalidError extends BusinessRuleError {
  readonly code = 'STOCK_HOLD_INVALID';
  readonly messageKey = 'inv.stock_hold_invalid';
  constructor(fields: ReadonlyArray<{ readonly field: string; readonly rule: string }>) {
    super('the stock hold breaks a hold rule', details(fields, 'inv.stock_hold_rule'));
  }
}

/**
 * 422 STOCK_EXCEPTION_INVALID: a resolution breaks a resolution rule (FR-INV-023, ADR-0048, A-144):
 * `RESOLUTION_KIND_REQUIRED`, `NOT_FOR_A_HELD_VARIANCE`, `ONLY_FOR_A_HELD_VARIANCE`, `WRITE_OFF_PENDING`,
 * `DOCUMENT_REQUIRED`, `NOT_FOR_NO_CORRECTION`, `NOT_A_SETTLING_ADJUSTMENT`, `FOUND_LOCATION_REQUIRED`, `ONLY_FOR_FOUND`,
 * `NOT_A_STOCK_LOCATION`, `NOT_IN_THE_TRANSFER_BRANCHES`, and the adjustment's own line rules for a write-off.
 */
export class StockExceptionInvalidError extends BusinessRuleError {
  readonly code = 'STOCK_EXCEPTION_INVALID';
  readonly messageKey = 'inv.stock_exception_invalid';
  constructor(fields: ReadonlyArray<{ readonly field: string; readonly rule: string }>) {
    super('the stock exception resolution breaks a rule', details(fields, 'inv.stock_exception_rule'));
  }
}

/**
 * 422 REORDER_RULE_INVALID: a reorder rule breaks a rule (FR-INV-015, A-147): `BELOW_MINIMUM`, `BELOW_REORDER_POINT`,
 * `MAXIMUM_REQUIRED`, `OUT_OF_RANGE`, `NOT_A_STOCK_PRODUCT`, `NOT_A_STOCK_LOCATION`, `NOT_IN_THE_BRANCH` and
 * `RULE_EXISTS`.
 */
export class ReorderRuleInvalidError extends BusinessRuleError {
  readonly code = 'REORDER_RULE_INVALID';
  readonly messageKey = 'inv.reorder_rule_invalid';
  constructor(fields: ReadonlyArray<{ readonly field: string; readonly rule: string }>) {
    super('the reorder rule breaks a rule', details(fields, 'inv.reorder_rule_rule'));
  }
}

/**
 * 422 TEMPERATURE_READING_INVALID: a reading cannot be recorded (FR-INV-007, A-147): `NO_TEMPERATURE_RANGE` (the
 * location has no permitted range), `NOT_A_STOCK_LOCATION`, `IN_THE_FUTURE`, or `ID_IN_USE` for a client id another
 * location's reading already holds.
 */
export class TemperatureReadingInvalidError extends BusinessRuleError {
  readonly code = 'TEMPERATURE_READING_INVALID';
  readonly messageKey = 'inv.temperature_reading_invalid';
  constructor(fields: ReadonlyArray<{ readonly field: string; readonly rule: string }>) {
    super('the temperature reading breaks a rule', details(fields, 'inv.temperature_reading_rule'));
  }
}

/** 422 STOCK_UNIT_EXPIRED: a sale of a lot after its expiry date (FR-INV-016, A-134 (j); migration 0064). */
export class StockUnitExpiredError extends BusinessRuleError {
  readonly code = 'STOCK_UNIT_EXPIRED';
  readonly messageKey = 'inv.stock_unit_expired';
}

/** 422 WITHDRAWAL_CANNOT_BE_RELEASED: a veterinary withdrawal hold only ends by time (FR-INV-022, ADR-0019). */
export class WithdrawalCannotBeReleasedError extends BusinessRuleError {
  readonly code = 'WITHDRAWAL_CANNOT_BE_RELEASED';
  readonly messageKey = 'inv.withdrawal_cannot_be_released';
}

/** 422 INSUFFICIENT_STOCK: the movement would take a physical location below zero (FR-INV-019). */
export class InsufficientStockError extends BusinessRuleError {
  readonly code = 'INSUFFICIENT_STOCK';
  readonly messageKey = 'inv.insufficient_stock';
}

/** 422 STOCK_UNIT_NOT_AVAILABLE: a serial unit not where the movement starts, or a unit no longer active (FR-INV-020). */
export class StockUnitNotAvailableError extends BusinessRuleError {
  readonly code = 'STOCK_UNIT_NOT_AVAILABLE';
  readonly messageKey = 'inv.stock_unit_not_available';
}

/** 422 STOCK_UNIT_ON_HOLD: a movement type blocked by an unreleased hold (FR-INV-022). */
export class StockUnitOnHoldError extends BusinessRuleError {
  readonly code = 'STOCK_UNIT_ON_HOLD';
  readonly messageKey = 'inv.stock_unit_on_hold';
}

/** 422 STOCK_UNIT_RESERVED: the movement would dip below reserved, or names another's reservation (FR-INV-021). */
export class StockUnitReservedError extends BusinessRuleError {
  readonly code = 'STOCK_UNIT_RESERVED';
  readonly messageKey = 'inv.stock_unit_reserved';
}

/** 422 STOCK_MOVEMENT_ALREADY_REVERSED: a movement is reversed once (FR-INV-004). */
export class StockMovementAlreadyReversedError extends BusinessRuleError {
  readonly code = 'STOCK_MOVEMENT_ALREADY_REVERSED';
  readonly messageKey = 'inv.stock_movement_already_reversed';
}

/**
 * A movement that breaks its type's rule or is not the exact opposite of what it reverses. Commands build movements
 * from validated documents, so this is a bug in the caller, never a user's input: it answers 500 with a correlation id.
 */
export class StockMovementInvalidError extends Error {
  readonly code = 'STOCK_MOVEMENT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'StockMovementInvalidError';
  }
}

/**
 * The cost pool no longer holds the value a reversal must give back (`ck_stock_reversal_value`, A-134 (b)): a bug in
 * a caller that never checks, so a 500 like its parent, except where a person asked for the reversal and is told.
 */
export class StockPoolValueGoneError extends StockMovementInvalidError {}

/** The database rule a refusal names (SQLSTATE HK010, migration 0044), as the error the API answers with. */
const BY_RULE: Readonly<Record<string, new (message: string) => Error>> = {
  ck_stock_negative: InsufficientStockError,
  ck_stock_serial_location: StockUnitNotAvailableError,
  ck_stock_unit_inactive: StockUnitNotAvailableError,
  ck_stock_on_hold: StockUnitOnHoldError,
  ck_stock_reserved: StockUnitReservedError,
  ck_stock_reservation_use: StockUnitReservedError,
  ck_stock_reversal: StockMovementInvalidError,
  ck_stock_reversal_value: StockPoolValueGoneError,
  ck_stock_movement_type: StockMovementInvalidError,
  // Migration 0060 (ADR-0048): in-transit stock is not sellable, and what a held variance holds stays.
  ck_stock_in_transit: StockUnitNotAvailableError,
  ck_stock_held: InsufficientStockError,
  // Reservations (ADR-0019): above what is available, at a place stock is not promised from, or under a hold.
  ck_stock_reservation: InsufficientStockError,
  ck_stock_reservation_place: StockUnitNotAvailableError,
  ck_stock_reservation_held: StockUnitOnHoldError,
  // Migration 0064 (FR-INV-016): an expired lot is never sold.
  ck_stock_expired: StockUnitExpiredError,
};

/** Translates a stock trigger's refusal into its API error; anything else is rethrown unchanged. */
export function translateStockRefusal(error: unknown): never {
  const failure = error as { code?: string; constraint?: string; message?: string };
  if (failure.code === 'HK010' && failure.constraint !== undefined) {
    const type = BY_RULE[failure.constraint];
    if (type !== undefined) {
      throw new type(failure.message ?? failure.constraint);
    }
  }
  if (failure.code === '23505' && failure.constraint === 'uq_stock_reservation_exclusive') {
    throw new StockUnitReservedError(failure.message ?? 'already reserved');
  }
  if (failure.code === '23505' && failure.constraint === 'uq_stock_movement_reverses') {
    throw new StockMovementAlreadyReversedError(failure.message ?? 'already reversed');
  }
  throw error;
}
