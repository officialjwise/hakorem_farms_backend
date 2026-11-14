/**
 * Typed errors raised by the kernel. Each carries a stable code so callers and logs never match on message text.
 * A kernel error means the caller passed a value the kernel cannot represent exactly; it is never swallowed.
 */
export abstract class KernelError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A money amount is negative or above the largest `platform.pesewas` value. */
export class MoneyRangeError extends KernelError {
  readonly code = 'MONEY_OUT_OF_RANGE';

  constructor(readonly pesewas: bigint) {
    super(`amount of ${pesewas} pesewas is outside 0 to 9007199254740991`);
  }
}

/** A JSON number offered as pesewas is not a safe integer. */
export class MoneyNotIntegerError extends KernelError {
  readonly code = 'MONEY_NOT_AN_INTEGER';

  constructor() {
    super('an amount in pesewas must be a safe integer');
  }
}

/** A weight is negative or above `NUMERIC(10,3)` kilograms. */
export class WeightRangeError extends KernelError {
  readonly code = 'WEIGHT_OUT_OF_RANGE';

  constructor(readonly grams: bigint) {
    super(`weight of ${grams} g is outside 0 to 9999999.999 kg`);
  }
}

/** A quantity is beyond `NUMERIC(14,3)` in either direction. */
export class QuantityRangeError extends KernelError {
  readonly code = 'QUANTITY_OUT_OF_RANGE';

  constructor(readonly thousandths: bigint) {
    super(`quantity of ${thousandths} thousandths is outside the NUMERIC(14,3) range`);
  }
}

/** A percentage is above one hundred. */
export class RateRangeError extends KernelError {
  readonly code = 'RATE_OUT_OF_RANGE';

  constructor() {
    super('a rate must be between 0 and 100 percent');
  }
}

/** A decimal string does not match the pattern the kernel accepts for its kind. */
export class DecimalFormatError extends KernelError {
  readonly code = 'INVALID_DECIMAL';

  constructor(readonly kind: 'weight' | 'quantity' | 'rate') {
    super(`not a valid ${kind} decimal`);
  }
}

/** A division was asked with a negative numerator or a non-positive denominator. */
export class ArithmeticArgumentError extends KernelError {
  readonly code = 'INVALID_DIVISION';

  constructor() {
    super('half-up division needs a non-negative numerator and a positive denominator');
  }
}

export type AllocationErrorCode =
  | 'ALLOCATION_NO_PARTS'
  | 'ALLOCATION_NEGATIVE_WEIGHT'
  | 'ALLOCATION_ALL_WEIGHTS_ZERO'
  | 'ALLOCATION_DUPLICATE_KEY';

/** An allocation cannot be made. Returned inside a `Result`, never thrown (ADR-0001). */
export class AllocationError extends KernelError {
  constructor(readonly code: AllocationErrorCode) {
    super(`cannot allocate: ${code}`);
  }
}

/** A string is not a UUIDv7. */
export class InvalidUuidV7Error extends KernelError {
  readonly code = 'INVALID_UUID_V7';

  constructor() {
    super('not a version 7 UUID');
  }
}
