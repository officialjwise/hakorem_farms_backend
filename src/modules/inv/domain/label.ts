import { Weight } from '@hakorem/kernel';

/** The one barcode symbology labels carry until a printer or scanner needs another (A-151): Code 128 takes any ASCII. */
export const LABEL_SYMBOLOGY = 'CODE_128';

export interface LabelBarcode {
  readonly symbology: typeof LABEL_SYMBOLOGY;
  /** What the bars encode, exactly. */
  readonly payload: string;
  /** What is printed under the bars. */
  readonly text: string;
}

export interface StockUnitLabelFacts {
  readonly tracking: 'SERIAL' | 'LOT';
  readonly sku: string;
  readonly identifier: string;
  /** The weight of each balance line of the unit, as stored (`NUMERIC(10,3)` kilograms). */
  readonly onHandWeightsKg: readonly string[];
  readonly lastWeightKg: string | null;
  readonly lastWeighedAt: string | null;
}

export interface StockUnitLabelPrint {
  readonly kind: 'LOT' | 'ANIMAL';
  readonly lotNo: string | null;
  readonly tagNo: string | null;
  readonly weightKg: string | null;
  readonly weighedAt: string | null;
  readonly barcode: LabelBarcode;
}

/**
 * What a lot or an animal label prints (B05x, A-151). The barcode encodes the product's SKU and the unit's batch or tag
 * joined by `/`: a SKU never holds a `/`, so the first one splits them, and a batch or tag is unique per product while
 * the unit is active. A lot prints the weight standing on hand, summed exactly; an animal its last recorded weight.
 */
export function stockUnitLabel(facts: StockUnitLabelFacts): StockUnitLabelPrint {
  const payload = `${facts.sku}/${facts.identifier}`;
  const barcode: LabelBarcode = { symbology: LABEL_SYMBOLOGY, payload, text: payload };
  if (facts.tracking === 'SERIAL') {
    return { kind: 'ANIMAL', lotNo: null, tagNo: facts.identifier, weightKg: facts.lastWeightKg, weighedAt: facts.lastWeighedAt, barcode };
  }
  const weight = Weight.sum(facts.onHandWeightsKg.map((kg) => Weight.parseKg(kg)));
  return { kind: 'LOT', lotNo: facts.identifier, tagNo: null, weightKg: weight.isZero() ? null : weight.toKgString(), weighedAt: null, barcode };
}
