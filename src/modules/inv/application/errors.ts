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
  if (failure.code === '23505' && failure.constraint === 'uq_stock_movement_reverses') {
    throw new StockMovementAlreadyReversedError(failure.message ?? 'already reversed');
  }
  throw error;
}
