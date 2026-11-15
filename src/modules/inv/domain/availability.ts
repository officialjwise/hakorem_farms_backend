import { Quantity } from '@hakorem/kernel';

/** SA-19: a product is shown as low at five or fewer available (the storefront's seed setting). */
export const LOW_STOCK_AT = Quantity.ofUnits(5n);

export type Availability = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';

/**
 * Available to promise (FR-INV-021, ADR-0019): on hand less reserved less held, signed, since offline sales may take
 * on hand below zero. Nothing available is out of stock; up to `LOW_STOCK_AT` is low.
 */
export function availabilityOf(line: { readonly onHand: Quantity; readonly reserved: Quantity; readonly held: Quantity }): { readonly available: Quantity; readonly availability: Availability } {
  const available = line.onHand.minus(line.reserved).minus(line.held);
  if (available.compareTo(Quantity.zero()) <= 0) return { available, availability: 'OUT_OF_STOCK' };
  return { available, availability: available.compareTo(LOW_STOCK_AT) <= 0 ? 'LOW_STOCK' : 'IN_STOCK' };
}
