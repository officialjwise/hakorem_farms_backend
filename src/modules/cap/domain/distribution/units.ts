import { err, halfUpDivide, ok, type Money, type Result } from '@hakorem/kernel';

/** Units are held to four decimal places (`numeric(18,4)`): every figure here is a count of ten-thousandths of a unit. */
export const UNIT_SCALE = 10_000n;
const UNITS_PATTERN = /^(\d{1,14})(?:\.(\d{1,4}))?$/;

/** Reads a units string such as "1000" or "12.3456" exactly, as ten-thousandths. More than four places is refused. */
export function parseUnits(text: string): bigint {
  const match = UNITS_PATTERN.exec(text);
  if (match === null) throw new RangeError(`not a units figure with at most four places: ${text}`);
  return BigInt(match[1]! + (match[2] ?? '').padEnd(4, '0'));
}

/** Ten-thousandths of a unit as the contract's `Units`: "500.0000". */
export function formatUnits(unitsE4: bigint): string {
  return `${unitsE4 / UNIT_SCALE}.${(unitsE4 % UNIT_SCALE).toString().padStart(4, '0')}`;
}

/**
 * The units a contribution issues or a withdrawal redeems (FR-CAP-003): the amount over the unit price, to four places.
 * Units are never rounded: an amount that does not buy a whole number of ten-thousandths is refused (A-380).
 */
export function unitsFor(amount: Money, unitPrice: Money): Result<bigint, 'UNITS_NOT_EXACT'> {
  const scaled = amount.pesewas * UNIT_SCALE;
  if (scaled % unitPrice.pesewas !== 0n) return err('UNITS_NOT_EXACT');
  return ok(scaled / unitPrice.pesewas);
}

/**
 * An investor's share of the units in issue on one day (FR-CAP-005): units over total units, as a percentage to four
 * places, half-up once. Computed on request, never stored; nothing in issue is 0.
 */
export function sharePercent(unitsE4: bigint, totalE4: bigint): string {
  if (totalE4 === 0n) return '0.0000';
  const tenThousandths = halfUpDivide(unitsE4 * 100n * UNIT_SCALE, totalE4);
  return formatUnits(tenThousandths);
}
