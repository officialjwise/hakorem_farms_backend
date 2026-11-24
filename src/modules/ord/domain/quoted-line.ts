import { Money, type Quantity } from '@hakorem/kernel';

/**
 * The reason a converted quote's line records its variance under (migration 0348): the price the buyer agreed on an
 * accepted quote, against the list price its quote line recorded at issue. The server's alone: it is in its own domain
 * `QUOTED_PRICE`, so no seller's list of price override reasons offers it and no sale may name it.
 */
export const QUOTED_PRICE_REASON = 'QUOTED_PRICE';

export interface QuotedLineInput {
  /** What the buyer agreed on the accepted quote: what they pay. */
  readonly quotedUnitPricePesewas: bigint;
  /** The list price the quote line recorded at issue for its unit; null where the engine did not price it. */
  readonly listUnitPricePesewas: bigint | null;
  /** The engine's floor the quote line recorded at issue; null with no list price. */
  readonly engineFloorUnitPricePesewas: bigint | null;
  readonly quantity: Quantity;
}

export interface QuotedLinePricing {
  readonly resolvedUnitPricePesewas: bigint;
  readonly floorUnitPricePesewas: bigint;
  readonly ceilingUnitPricePesewas: bigint;
  readonly agreedUnitPricePesewas: bigint;
  readonly variancePesewas: bigint;
  readonly varianceDirection: 'BELOW' | 'ABOVE' | null;
  readonly varianceReasonCode: string | null;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/**
 * The pricing record of an order line converted from an accepted quote (FR-ORD-003, FR-QUO-011; the owner,
 * 2026-11-23: "post list price to sales (4000) and the difference to price variance (4210), above or below list ...
 * the customer still pays the quoted price"). The list is the one the quote line recorded at issue, so a price list
 * changed afterwards never moves the booking; a line the engine did not price takes its quoted price as list, with no
 * variance (A-310 (a) as before). The agreed price is the quoted one. The variance is the difference of the two prices
 * each extended once over the quantity, half-up (ADR-0001), as BIL's `priceVariance` takes it. The band recorded holds
 * both prices (the quoted one was approved at the quote's margin step where it had to be, FR-QUO-005), so the line
 * needs no second approval: floor the lowest of the engine's floor, the list and the quoted price; ceiling the higher
 * of the list and the quoted price.
 */
export function quotedLinePricing(input: QuotedLineInput): QuotedLinePricing {
  const agreed = input.quotedUnitPricePesewas;
  const list = input.listUnitPricePesewas ?? agreed;
  const engineFloor = input.engineFloorUnitPricePesewas ?? list;
  const extendedList = Money.ofPesewas(list).timesQuantity(input.quantity).pesewas;
  const extendedAgreed = Money.ofPesewas(agreed).timesQuantity(input.quantity).pesewas;
  const direction = agreed === list ? null : agreed < list ? 'BELOW' : 'ABOVE';
  return {
    resolvedUnitPricePesewas: list,
    floorUnitPricePesewas: min(min(engineFloor, list), agreed),
    ceilingUnitPricePesewas: max(list, agreed),
    agreedUnitPricePesewas: agreed,
    variancePesewas: direction === null ? 0n : extendedList > extendedAgreed ? extendedList - extendedAgreed : extendedAgreed - extendedList,
    varianceDirection: direction,
    varianceReasonCode: direction === null ? null : QUOTED_PRICE_REASON,
  };
}
