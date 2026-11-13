import { DecimalFormatError } from './kernel-error';
import { halfUpDivide } from './half-up';

/** Decimal strings the kernel reads: optional minus, digits, optional point and digits. No exponent, no plus, no grouping. */
const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Longest decimal string the kernel parses; anything longer is refused before BigInt sees it. */
const MAX_DECIMAL_LENGTH = 40;

type DecimalKind = DecimalFormatError['kind'];

interface Parts {
  readonly negative: boolean;
  readonly whole: string;
  readonly fraction: string;
}

function split(text: string, kind: DecimalKind, signed: boolean): Parts {
  const match = text.length <= MAX_DECIMAL_LENGTH ? DECIMAL_PATTERN.exec(text) : null;
  if (match === null || (match[1] === '-' && !signed)) {
    throw new DecimalFormatError(kind);
  }
  return { negative: match[1] === '-', whole: match[2] as string, fraction: match[3] ?? '' };
}

/** Reads a decimal exactly as an integer count of 10^-places, refusing more places than allowed. */
export function parseFixed(text: string, places: number, kind: DecimalKind, signed: boolean): bigint {
  const { negative, whole, fraction } = split(text, kind, signed);
  if (fraction.length > places) {
    throw new DecimalFormatError(kind);
  }
  const scaled = BigInt(whole + fraction.padEnd(places, '0'));
  return negative ? -scaled : scaled;
}

/** Reads a non-negative decimal of any precision and rounds it half-up, once, to 10^-places. */
export function parseRoundedHalfUp(text: string, places: number, kind: DecimalKind): bigint {
  const { whole, fraction } = split(text, kind, false);
  if (fraction.length <= places) {
    return BigInt(whole + fraction.padEnd(places, '0'));
  }
  const exact = BigInt(whole + fraction);
  return halfUpDivide(exact, 10n ** BigInt(fraction.length - places));
}

/** Writes an integer count of 10^-places as a decimal string with exactly that many places. */
export function formatFixed(value: bigint, places: number): string {
  const sign = value < 0n ? '-' : '';
  const digits = (value < 0n ? -value : value).toString().padStart(places + 1, '0');
  return `${sign}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}
