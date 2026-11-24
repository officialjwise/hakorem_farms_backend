import { Quantity } from '@hakorem/kernel';

/** One active reservation of the first order at its dispatch or hand-over: a whole animal, or part of a lot at a location. */
export interface HeldPiece {
  readonly reservationId: string;
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly locationId: string;
  readonly qty: Quantity;
  /** An animal: a pick of that animal takes it wherever it was picked. */
  readonly serial: boolean;
}

/** One pick going on the dispatch or hand-over, in the base unit, from its pick location. */
export interface PickedPiece {
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly locationId: string;
  readonly qty: Quantity;
}

/** What one line of the backorder still needs, in the base unit. */
export interface BackorderNeed {
  readonly productId: string;
  readonly qty: Quantity;
}

/** Stock the backorder keeps from one of its first order's reservations, for its line `lineIndex`. */
export interface KeptPiece {
  readonly reservationId: string;
  readonly lineIndex: number;
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly locationId: string;
  readonly qty: Quantity;
}

const least = (a: Quantity, b: Quantity) => (a.compareTo(b) <= 0 ? a : b);

/**
 * What a backorder keeps of the stock its first order held (the owner, 2026-11-24, BL-123; A-366 (a) amended): each
 * reservation less what the picks going now take from its own stock (an animal picked is taken whole wherever it was
 * picked; a lot is taken at its pick location), then, line by line of the backorder in order, up to what the line still
 * needs, from the reservations of its product in the order given (oldest held first). Never more than a reservation
 * still holds, so nothing is promised twice and nothing below zero; what is not kept is released with the rest of the
 * order's promises.
 */
export function keptForBackorder(held: readonly HeldPiece[], picked: readonly PickedPiece[], needs: readonly BackorderNeed[]): KeptPiece[] {
  const left = held.map((h) => ({ h, qty: h.qty }));
  for (const p of picked) {
    let rest = p.qty;
    for (const l of left) {
      if (rest.isZero()) break;
      if (l.qty.isZero() || l.h.productId !== p.productId || l.h.stockUnitId !== p.stockUnitId || (!l.h.serial && l.h.locationId !== p.locationId)) continue;
      const take = least(l.qty, rest);
      l.qty = l.qty.minus(take);
      rest = rest.minus(take);
    }
  }
  const kept: KeptPiece[] = [];
  for (const [lineIndex, need] of needs.entries()) {
    let wanted = need.qty;
    for (const l of left) {
      if (wanted.isZero()) break;
      if (l.qty.isZero() || l.h.productId !== need.productId) continue;
      const take = least(l.qty, wanted);
      kept.push({ reservationId: l.h.reservationId, lineIndex, productId: l.h.productId, stockUnitId: l.h.stockUnitId, locationId: l.h.locationId, qty: take });
      l.qty = l.qty.minus(take);
      wanted = wanted.minus(take);
    }
  }
  return kept;
}

/**
 * Whether an animal's weighing falls in a weight band, half-open [min, max) as the engine maps a weight to its band
 * (FR-MDM-005): an order line converted from a quote line of a band reserves and is picked only from animals of it (the
 * owner, 2026-11-24, BL-124; A-351 (g) amended). An animal never weighed is not of the band; a line with no band takes any.
 */
export function inWeightBand(weightKg: string | null, band: { readonly minKg: string; readonly maxKg: string } | null): boolean {
  if (band === null) return true;
  if (weightKg === null) return false;
  const w = Quantity.parse(weightKg);
  return w.compareTo(Quantity.parse(band.minKg)) >= 0 && w.compareTo(Quantity.parse(band.maxKg)) < 0;
}
