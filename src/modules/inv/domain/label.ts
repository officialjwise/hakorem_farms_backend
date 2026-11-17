import { Weight } from '@hakorem/kernel';

export interface StockUnitLabelFacts {
  readonly tracking: 'SERIAL' | 'LOT';
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
}

/**
 * What a lot or an animal label prints (B05x, A-151): its batch or tag and its weight; the caller adds the product (its
 * SKU), the dates and the storage class. A lot prints the weight standing on hand, summed exactly; an animal its last
 * recorded weight. From contract 2.0.0 the label carries no barcode (owner 2026-11-17, ADR-0072).
 */
export function stockUnitLabel(facts: StockUnitLabelFacts): StockUnitLabelPrint {
  if (facts.tracking === 'SERIAL') {
    return { kind: 'ANIMAL', lotNo: null, tagNo: facts.identifier, weightKg: facts.lastWeightKg, weighedAt: facts.lastWeighedAt };
  }
  const weight = Weight.sum(facts.onHandWeightsKg.map((kg) => Weight.parseKg(kg)));
  return { kind: 'LOT', lotNo: facts.identifier, tagNo: null, weightKg: weight.isZero() ? null : weight.toKgString(), weighedAt: null };
}
