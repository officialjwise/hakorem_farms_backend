import { allocate, Money } from '@hakorem/kernel';

/** The cost elements of ADR-0018, in the order a cost object shows them. */
export const COST_ELEMENTS = ['PURCHASE', 'FEED', 'VETERINARY', 'LABOUR', 'OVERHEAD', 'PROCESSING'] as const;
export type CostElement = (typeof COST_ELEMENTS)[number];

/** Pesewas by element, signed: what each element added less any reversal of it. */
export type ElementAmounts = Readonly<Record<CostElement, bigint>>;

const NONE: ElementAmounts = { PURCHASE: 0n, FEED: 0n, VETERINARY: 0n, LABOUR: 0n, OVERHEAD: 0n, PROCESSING: 0n };

/**
 * A cost object's view by element (FR-CST-001): every element in ADR-0018's order, and the total, which is their sum.
 * Purchase 60,000, feed 8,400 and veterinary 3,000 read 71,400.
 */
export function elementsOf(amounts: ElementAmounts): { readonly byElement: { readonly costElement: CostElement; readonly valuePesewas: bigint }[]; readonly total: bigint } {
  const shown = COST_ELEMENTS.filter((e) => amounts[e] !== 0n);
  const listed = shown.length === 0 ? COST_ELEMENTS : shown;
  return { byElement: listed.map((costElement) => ({ costElement, valuePesewas: amounts[costElement] })), total: COST_ELEMENTS.reduce((sum, e) => sum + amounts[e], 0n) };
}

/**
 * What a processing order took from one consumed unit, by element: the unit's own elements when it was consumed whole,
 * otherwise the consumed value split across the unit's positive elements through `allocate` (keyed in element order),
 * so the parts sum to the consumed value exactly. A reversal (negative) is taken back by the same split. A value from a
 * unit with no positive element is its purchase.
 */
export function splitConsumed(consumed: bigint, unit: ElementAmounts): ElementAmounts {
  if (consumed === 0n) return NONE;
  const magnitude = consumed < 0n ? -consumed : consumed;
  const positive = COST_ELEMENTS.filter((e) => unit[e] > 0n);
  if (positive.length === 0) return { ...NONE, PURCHASE: consumed };
  // The weights are positive and the keys distinct, so the kernel cannot refuse.
  const parts = allocate(
    Money.ofPesewas(magnitude),
    positive.map((e) => ({ key: BigInt(COST_ELEMENTS.indexOf(e)), weight: unit[e] })),
  ) as { readonly ok: true; readonly value: Money[] };
  const out: Record<CostElement, bigint> = { ...NONE };
  positive.forEach((e, i) => {
    out[e] = consumed < 0n ? -parts.value[i]!.pesewas : parts.value[i]!.pesewas;
  });
  return out;
}

/**
 * A processing order's cost by element (FR-CST-001, ADR-0018): each consumed unit's share of its elements, plus the
 * direct processing cost, which is what the outputs were received at less what the inputs carried (the outputs'
 * allocated values sum exactly to input plus direct cost, PRC's deferred rule).
 */
export function processingOrderCost(inputs: readonly { readonly consumed: bigint; readonly unit: ElementAmounts }[], outputValue: bigint): ElementAmounts {
  const out: Record<CostElement, bigint> = { ...NONE };
  let consumed = 0n;
  for (const input of inputs) {
    const split = splitConsumed(input.consumed, input.unit);
    for (const e of COST_ELEMENTS) out[e] += split[e];
    consumed += input.consumed;
  }
  out.PROCESSING += outputValue - consumed;
  return out;
}
