import { err, ok, Quantity, type Result } from '@hakorem/kernel';
import type { FieldRule, StockPolicy, UomKind } from './product';

/**
 * Exact conversions between a product's alternative unit and its base unit (FR-MDM-003, A-157, A-163). One alternative
 * unit is `numerator / denominator` base units, held as two integers and never as a stored decimal. Quantities carry
 * three decimal places, so a factor is exact when, in lowest terms, its denominator divides 1,000: a 50 kg bag is 50/1,
 * a bunch of 0.125 kg is 1/8, and a third (1/3, or 0.3333333) has no exact value and is refused. The database holds the
 * same rule (`ck_uom_conversion_exact`, migration 0090). A converted quantity that would need a fourth decimal place is
 * refused too, never rounded: a quantity is stock, and a quantity times a price is money.
 */

/** Thousandths in one unit: a `Quantity` carries three decimal places. */
const SCALE = 1000n;
/** The largest numerator the database holds (`ck_uom_conversion_numerator`): a billion base units per alternative unit. */
export const MAX_NUMERATOR = 1_000_000_000n;

/** One alternative unit is `numerator / denominator` base units, in lowest terms. */
export interface UomFactor {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export type FactorRefusal = 'NOT_POSITIVE' | 'INEXACT_FACTOR' | 'TOO_LARGE';

function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** The factor `numerator / denominator` in lowest terms, or why it cannot be a conversion. */
export function exactFactor(numerator: bigint, denominator: bigint): Result<UomFactor, FactorRefusal> {
  if (numerator <= 0n || denominator <= 0n) return err('NOT_POSITIVE');
  const divisor = gcd(numerator, denominator);
  const reduced = { numerator: numerator / divisor, denominator: denominator / divisor };
  if (SCALE % reduced.denominator !== 0n) return err('INEXACT_FACTOR');
  if (reduced.numerator > MAX_NUMERATOR) return err('TOO_LARGE');
  return ok(reduced);
}

/** The factor as a decimal string with three places ("50.000", "0.125"); exact, because the denominator divides 1,000. */
export function factorText(factor: UomFactor): string {
  return Quantity.ofThousandths((factor.numerator * SCALE) / factor.denominator).toDecimalString();
}

/** A quantity in the alternative unit, in base units: 4 bags of 50 kg are 200.000 kg. */
export function toBase(quantity: Quantity, factor: UomFactor): Result<Quantity, 'INEXACT_QUANTITY'> {
  return divideExactly(quantity.thousandths * factor.numerator, factor.denominator);
}

/** A quantity in base units, in the alternative unit: 45.000 kg is 0.900 of a 50 kg bag. */
export function fromBase(quantity: Quantity, factor: UomFactor): Result<Quantity, 'INEXACT_QUANTITY'> {
  return divideExactly(quantity.thousandths * factor.denominator, factor.numerator);
}

function divideExactly(thousandths: bigint, divisor: bigint): Result<Quantity, 'INEXACT_QUANTITY'> {
  if (thousandths % divisor !== 0n) return err('INEXACT_QUANTITY');
  return ok(Quantity.ofThousandths(thousandths / divisor));
}

/** What createUomConversion judges a new conversion against, as the application found it. */
export interface ConversionContext {
  readonly stockPolicy: StockPolicy;
  readonly baseUom: string;
  readonly fromUom: string;
  readonly fromKind: UomKind;
}

/**
 * The rules on which unit converts (A-163). Only a countable product has alternative units: a catch-weight line is
 * charged by its weighed kilograms, so a pack-to-kilogram factor is never a conversion (A-157); a serialised animal is
 * counted by the head; a service holds no stock. The alternative unit is a counted one (a bag, crate, bunch or pack)
 * other than the base unit: a weight or a volume of a counted thing has no fixed factor.
 */
export function judgeConversion(context: ConversionContext): FieldRule[] {
  const rules: FieldRule[] = [];
  if (context.stockPolicy !== 'COUNTABLE') rules.push({ field: '/productId', rule: 'NOT_COUNTABLE' });
  if (context.fromUom === context.baseUom) rules.push({ field: '/fromUom', rule: 'BASE_UNIT' });
  else if (context.fromKind !== 'COUNT') rules.push({ field: '/fromUom', rule: 'NOT_COUNTED' });
  return rules;
}
