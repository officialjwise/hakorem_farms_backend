import { halfUpDivide, Weight } from '@hakorem/kernel';
import type { OutputKind, ProcessingRuleBroken } from './cost-allocation';

/** A percentage held exactly in ten-thousandths of a percent: 100 percent is 1,000,000 (the contract's `Percent`). */
const WHOLE = 1_000_000n;
const PERCENT = /^(100|[0-9]{1,2})(?:\.([0-9]{1,4}))?$/;

/** Reads a contract `Percent` ("50", "10.5", up to four places, 0 to 100) into ten-thousandths of a percent. */
export function parsePercent(text: string): bigint {
  const match = PERCENT.exec(text);
  const value = match === null ? -1n : BigInt(match[1]!) * 10_000n + BigInt((match[2] ?? '').padEnd(4, '0'));
  if (value < 0n || value > WHOLE) throw new RangeError(`${JSON.stringify(text)} is not a percentage from 0 to 100 with at most four places`);
  return value;
}

function fixed3(thousandths: bigint): string {
  const sign = thousandths < 0n ? '-' : '';
  const size = thousandths < 0n ? -thousandths : thousandths;
  return `${sign}${size / 1000n}.${(size % 1000n).toString().padStart(3, '0')}`;
}

export interface YieldOutput {
  readonly productId: string;
  readonly kind: OutputKind;
  readonly weight: Weight;
}

export interface YieldStandardFacts {
  readonly expectedPercent: string;
  readonly tolerancePercent: string;
}

export interface YieldLine {
  readonly productId: string;
  readonly expectedKg: string;
  readonly actualKg: string;
  /** Actual minus expected, signed. */
  readonly varianceKg: string;
  readonly flagged: boolean;
}

export interface YieldJudgement {
  /** The sum of the standards of the output products that have one, to three places; null when none has. */
  readonly expectedPercent: string | null;
  /** Those products' output weight as a share of the input weight, half up to three places. */
  readonly actualPercent: string | null;
  /** Any product outside its tolerance: needs investigation, never blocks completion (FR-PRC-005, BL-007). */
  readonly flagged: boolean;
  readonly lines: readonly YieldLine[];
}

/** Total output weight cannot exceed total input weight (FR-PRC-002). */
export function checkOutputWeights(inputWeight: Weight, outputs: readonly YieldOutput[]): ProcessingRuleBroken[] {
  return Weight.sum(outputs.map((o) => o.weight)).compareTo(inputWeight) > 0 ? [{ field: '/outputs', rule: 'OUTPUT_WEIGHT_ABOVE_INPUT' }] : [];
}

/**
 * Expected against actual yield (FR-PRC-004, FR-PRC-005). For each output product with a standard, the expected
 * weight is the standard's percentage of the input weight, half up once to the gram, and the actual weight is the sum
 * of that product's outputs; it is flagged when actual and expected differ by more than the standard's tolerance as
 * a percentage of expected. Waste is never judged.
 */
export function judgeYield(inputWeight: Weight, outputs: readonly YieldOutput[], standards: ReadonlyMap<string, YieldStandardFacts>): YieldJudgement {
  const actual = new Map<string, bigint>();
  for (const output of outputs) {
    if (output.kind === 'WASTE' || !standards.has(output.productId)) continue;
    actual.set(output.productId, (actual.get(output.productId) ?? 0n) + output.weight.grams);
  }
  if (actual.size === 0) return { expectedPercent: null, actualPercent: null, flagged: false, lines: [] };
  let expectedSum = 0n;
  let actualGrams = 0n;
  const lines = [...actual].map(([productId, grams]): YieldLine => {
    const standard = standards.get(productId)!;
    const percent = parsePercent(standard.expectedPercent);
    expectedSum += percent;
    actualGrams += grams;
    const expected = halfUpDivide(inputWeight.grams * percent, WHOLE);
    const variance = grams - expected;
    const size = variance < 0n ? -variance : variance;
    return {
      productId,
      expectedKg: Weight.ofGrams(expected).toKgString(),
      actualKg: Weight.ofGrams(grams).toKgString(),
      varianceKg: fixed3(variance),
      flagged: size * WHOLE > expected * parsePercent(standard.tolerancePercent),
    };
  });
  return {
    expectedPercent: fixed3(halfUpDivide(expectedSum, 10n)),
    actualPercent: fixed3(halfUpDivide(actualGrams * 100_000n, inputWeight.grams)),
    flagged: lines.some((line) => line.flagged),
    lines,
  };
}
