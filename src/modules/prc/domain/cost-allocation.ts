import { allocate, err, ok, type Money, type Result, type Weight } from '@hakorem/kernel';

export const OUTPUT_KINDS = ['MEAT', 'OFFAL', 'BY_PRODUCT', 'WASTE'] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

/** A rule a processing order breaks, with the JSON pointer of the field that breaks it. */
export interface ProcessingRuleBroken {
  readonly field: string;
  readonly rule: string;
}

/** One output as the allocation sees it: its stable line number, kind, weight and reference sale price per kg. */
export interface AllocationOutput {
  readonly lineNo: number;
  readonly kind: OutputKind;
  readonly weight: Weight;
  readonly referencePricePerKg: Money;
}

export interface AllocatedOutput {
  readonly lineNo: number;
  /** Grams multiplied by the reference price per kilogram; zero for waste (FR-PRC-007, FR-PRC-008). */
  readonly allocationWeight: bigint;
  readonly allocated: Money;
}

/** The relative sales value of an output: its weight in grams times its reference price per kilogram. Waste is zero. */
export function allocationWeightOf(output: AllocationOutput): bigint {
  return output.kind === 'WASTE' ? 0n : output.weight.grams * output.referencePricePerKg.pesewas;
}

/**
 * Splits a processing order's total cost (input cost plus direct cost) across its outputs by relative sales value,
 * through the kernel's `allocate` only (ADR-0001, ADR-0018): floors of each exact share, the leftover pesewas to the
 * largest remainders, equal remainders to the lowest line number. The parts always sum to `total` exactly; waste
 * takes nothing, so the saleable outputs absorb all of it. Refused when a saleable output has no reference price,
 * waste carries one, a line number repeats, or nothing saleable is left to carry the cost.
 */
export function allocateProcessingCost(total: Money, outputs: readonly AllocationOutput[]): Result<AllocatedOutput[], ProcessingRuleBroken[]> {
  const broken: ProcessingRuleBroken[] = [];
  outputs.forEach((output, index) => {
    if (output.kind === 'WASTE' && !output.referencePricePerKg.isZero()) {
      broken.push({ field: `/outputs/${index}/referencePricePesewasPerKg`, rule: 'WASTE_CARRIES_NO_PRICE' });
    }
    if (output.kind !== 'WASTE' && output.referencePricePerKg.isZero()) {
      broken.push({ field: `/outputs/${index}/referencePricePesewasPerKg`, rule: 'REFERENCE_PRICE_MISSING' });
    }
  });
  if (broken.length > 0) return err(broken);
  const weights = outputs.map(allocationWeightOf);
  const parts = allocate(
    total,
    outputs.map((output, index) => ({ key: BigInt(output.lineNo), weight: weights[index]! })),
  );
  if (!parts.ok) {
    // Weights are never negative here, so the refusal is a repeated line number or nothing saleable to carry the cost.
    const repeated = outputs.findIndex((output, index) => outputs.findIndex((other) => other.lineNo === output.lineNo) !== index);
    return err([repeated >= 0 ? { field: `/outputs/${repeated}`, rule: 'LINE_NUMBER_REPEATED' } : { field: '/outputs', rule: 'NO_SALEABLE_OUTPUT' }]);
  }
  return ok(outputs.map((output, index) => ({ lineNo: output.lineNo, allocationWeight: weights[index]!, allocated: parts.value[index]! })));
}
