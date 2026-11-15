import { BusinessRuleError } from '../../../platform/errors/api-error';
import { registerMessages } from '../../../platform/i18n/messages';

/** INV's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'inv.insufficient_stock': 'There is not enough stock at this location for this line.',
  'inv.stock_unit_not_available': 'This animal or lot was already sold, is not at this location, or is not available.',
  'inv.stock_unit_on_hold': 'This animal or lot is under a hold and cannot be sold, consumed or transferred.',
  'inv.stock_unit_reserved': 'This stock is reserved for another order.',
  'inv.stock_movement_already_reversed': 'This movement has already been reversed.',
});

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

/** The database rule a refusal names (SQLSTATE HK010, migration 0044), as the error the API answers with. */
const BY_RULE: Readonly<Record<string, new (message: string) => Error>> = {
  ck_stock_negative: InsufficientStockError,
  ck_stock_serial_location: StockUnitNotAvailableError,
  ck_stock_unit_inactive: StockUnitNotAvailableError,
  ck_stock_on_hold: StockUnitOnHoldError,
  ck_stock_reserved: StockUnitReservedError,
  ck_stock_reservation_use: StockUnitReservedError,
  ck_stock_reversal: StockMovementInvalidError,
  ck_stock_reversal_value: StockMovementInvalidError,
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
