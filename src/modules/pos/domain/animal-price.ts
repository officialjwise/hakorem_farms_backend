/**
 * An animal's own price in the offline pack (CR-052, B09b continued 4c, A-286). Pure. The price is exactly what the
 * pricing engine resolved for that animal from its own grade and latest weight (ADR-0004), never derived from another
 * animal's or a product's band; an animal the engine cannot price is priceless and says why; a lot carries no price of
 * its own, because it sells at its product's band and the scale gives its weight.
 */

/** Why the pack gives an animal no price: the engine's own reason, or that it cannot be sold now. */
export type UnpricedReason = 'MISSING_GRADE_OR_WEIGHT' | 'NO_RULE' | 'QUOTE_ONLY' | 'NOT_SELLABLE';

/** The engine's answer for one animal, as `PricingService.resolveIn` gives it. */
export interface AnimalResolution {
  readonly outcome: 'RESOLVED' | 'QUOTE_REQUIRED';
  readonly resolved: {
    readonly priceListEntryId: string;
    readonly basis: string;
    readonly listPricePesewas: number;
    readonly floorPricePesewas: number;
    readonly ceilingPricePesewas: number;
  } | null;
  readonly quoteRequiredReason: 'MISSING_GRADE_OR_WEIGHT' | 'NO_RULE' | 'QUOTE_ONLY' | null;
}

export interface AnimalPrice {
  readonly priceListEntryId: string | null;
  readonly priceBand: { readonly listPricePesewas: number; readonly floorPricePesewas: number; readonly ceilingPricePesewas: number; readonly basis: string } | null;
  readonly unpricedReason: UnpricedReason | null;
}

const NONE = { priceListEntryId: null, priceBand: null } as const;

/**
 * The price the pack gives a stock unit standing at the till. `resolution` is undefined when no list in force prices
 * the product at this till, so the engine was not asked.
 */
export function animalPrice(unit: { readonly tracking: 'SERIAL' | 'LOT'; readonly sellable: boolean }, resolution: AnimalResolution | undefined): AnimalPrice {
  if (unit.tracking === 'LOT') return { ...NONE, unpricedReason: null };
  if (!unit.sellable) return { ...NONE, unpricedReason: 'NOT_SELLABLE' };
  if (resolution === undefined) return { ...NONE, unpricedReason: 'NO_RULE' };
  const r = resolution.resolved;
  if (resolution.outcome !== 'RESOLVED' || r === null) return { ...NONE, unpricedReason: resolution.quoteRequiredReason ?? 'NO_RULE' };
  return {
    priceListEntryId: r.priceListEntryId,
    priceBand: { listPricePesewas: r.listPricePesewas, floorPricePesewas: r.floorPricePesewas, ceilingPricePesewas: r.ceilingPricePesewas, basis: r.basis },
    unpricedReason: null,
  };
}

/**
 * The reason a synced line's price difference is recorded under (A-286 (d)): the one the till gave, or, when it gave
 * none because it charged what its pack said, `OFFLINE_PACK_PRICE` (migration 0306). ORD keeps a reason only on a line
 * whose agreed price differs from the server's, so a line at the server's price carries none. The sale is recorded
 * either way, never refused for the missing reason (ADR-0027 point 2).
 */
export const OFFLINE_PACK_PRICE = 'OFFLINE_PACK_PRICE';

export function reasonAtSync(sent: string | undefined): string {
  return sent ?? OFFLINE_PACK_PRICE;
}
