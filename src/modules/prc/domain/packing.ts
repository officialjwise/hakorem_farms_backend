import { err, ok, Weight, type Result } from '@hakorem/kernel';
import type { ProcessingRuleBroken } from './cost-allocation';

/** The most packs one output is packed into in one call: a 15 kg pack of a lot no heavier than three tonnes. */
export const MAX_PACKS_PER_OUTPUT = 200;
/** The barcode carries the weight in six digits of grams, so a pack weighs less than this (FR-PRC-010). */
const MAX_LABEL_GRAMS = 999_999n;
const GRAM_DIGITS = 6;

/** The one symbology labels carry (A-151): Code 128 takes any ASCII. */
export const PACK_SYMBOLOGY = 'CODE_128';

export interface PackBarcode {
  readonly symbology: typeof PACK_SYMBOLOGY;
  /** What the bars encode: `<lot>/<grams, six digits>`. */
  readonly payload: string;
  /** What is printed under the bars: the payload itself. */
  readonly text: string;
}

/**
 * FR-PRC-009: the packs of an output are weighed pieces of its lot, so their weights sum exactly to the lot's weight
 * (a tolerance of 0.000 kg; the last pack is the remainder); when the output recorded how many packs it made, there are
 * that many; and each fits on a label.
 */
export function checkPacks(lotWeight: Weight, packs: readonly Weight[], expectedCount: number | null): Result<readonly Weight[], ProcessingRuleBroken[]> {
  const broken: ProcessingRuleBroken[] = [];
  if (packs.length === 0) broken.push({ field: '/packs', rule: 'NO_PACKS' });
  if (packs.length > MAX_PACKS_PER_OUTPUT) broken.push({ field: '/packs', rule: 'TOO_MANY_PACKS' });
  packs.forEach((pack, index) => {
    if (pack.grams <= 0n) broken.push({ field: `/packs/${index}/weightKg`, rule: 'PACK_WEIGHT_NOT_POSITIVE' });
    if (pack.grams > MAX_LABEL_GRAMS) broken.push({ field: `/packs/${index}/weightKg`, rule: 'PACK_TOO_HEAVY_FOR_LABEL' });
  });
  if (broken.some((b) => b.field !== '/packs')) return err(broken);
  if (expectedCount !== null && packs.length !== expectedCount && packs.length > 0) broken.push({ field: '/packs', rule: 'PACK_COUNT_NOT_OUTPUT_COUNT' });
  if (broken.some((b) => b.rule === 'TOO_MANY_PACKS')) return err(broken);
  if (!Weight.sum(packs).equals(lotWeight)) broken.push({ field: '/packs', rule: 'PACK_WEIGHTS_NOT_LOT_WEIGHT' });
  return broken.length === 0 ? ok(packs) : err(broken);
}

/**
 * FR-PRC-010: the barcode payload is the lot and the weight in grams, `LOT-BEEF-2026-1113/015200` for 15.200 kg, so the
 * counter sells the pack at its weighed quantity without a scale. It depends on nothing else, so a reprint gives the
 * same payload; two packs of one lot that weigh the same carry the same payload and are interchangeable.
 */
export function packBarcode(lotIdentifier: string, weight: Weight): PackBarcode {
  if (lotIdentifier.includes('/')) throw new Error(`lot ${lotIdentifier} holds a slash, which the payload uses to separate the weight`);
  if (weight.grams <= 0n || weight.grams > MAX_LABEL_GRAMS) throw new Error(`${weight.toKgString()} kg does not fit six digits of grams`);
  const payload = `${lotIdentifier}/${weight.grams.toString().padStart(GRAM_DIGITS, '0')}`;
  return { symbology: PACK_SYMBOLOGY, payload, text: payload };
}

/** The line a label prints beside the barcode: the lot and the weight in kilograms to three places. */
export function packLabelText(lotIdentifier: string, weight: Weight): string {
  return `${lotIdentifier} · ${weight.toKgString()} kg`;
}
