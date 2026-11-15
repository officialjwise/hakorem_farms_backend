import { Quantity } from '@hakorem/kernel';

/** Where stock is never promised from: the outside world, stock in transit, and a whole site (ADR-0019, ADR-0048). */
const NOT_PROMISED_AT: ReadonlySet<string> = new Set(['IN_TRANSIT', 'SITE']);
const ONE = Quantity.ofUnits(1n);

export interface ReservationRequestFacts {
  readonly qty: Quantity;
  readonly location: { readonly isLive: boolean; readonly isVirtual: boolean; readonly kind: string };
  /** The unit promised, if one is: a goat, or a lot. */
  readonly unit: { readonly tracking: 'SERIAL' | 'LOT'; readonly status: string; readonly currentLocationId: string | null } | null;
  readonly locationId: string;
  readonly expiresAt: Date | null;
  readonly at: Date;
}

/**
 * Whether stock can be promised as asked (FR-INV-021, ADR-0019, A-144). A request that is malformed is the caller's
 * bug (`INVALID_REQUEST`): a quantity that is not positive, an expiry already past, part of an animal. Stock that
 * cannot be promised is `NOT_AVAILABLE`: a place stock is not promised from, a unit no longer active, an animal
 * standing elsewhere. Whether enough is available is the database's (`ck_stock_reservation`), as is a hold.
 */
export function judgeReservation(r: ReservationRequestFacts): { readonly refusal: 'INVALID_REQUEST' | 'NOT_AVAILABLE' | null; readonly reason: string | null } {
  if (r.qty.compareTo(Quantity.zero()) <= 0) return { refusal: 'INVALID_REQUEST', reason: 'a reservation promises a positive quantity' };
  if (r.expiresAt !== null && r.expiresAt.getTime() <= r.at.getTime()) return { refusal: 'INVALID_REQUEST', reason: 'a reservation expires in the future' };
  if (r.unit?.tracking === 'SERIAL' && !r.qty.equals(ONE)) return { refusal: 'INVALID_REQUEST', reason: 'an animal is promised whole' };
  if (!r.location.isLive || r.location.isVirtual || NOT_PROMISED_AT.has(r.location.kind)) return { refusal: 'NOT_AVAILABLE', reason: 'stock is not promised from this location' };
  if (r.unit !== null && r.unit.status !== 'ACTIVE') return { refusal: 'NOT_AVAILABLE', reason: `the stock unit is ${r.unit.status}` };
  if (r.unit?.tracking === 'SERIAL' && r.unit.currentLocationId !== r.locationId) return { refusal: 'NOT_AVAILABLE', reason: 'the animal is not at this location' };
  return { refusal: null, reason: null };
}

/** A reservation the expiry job releases: still active, with an expiry at or before the job's instant. */
export function isDue(reservation: { readonly status: string; readonly expiresAt: Date | null }, at: Date): boolean {
  return reservation.status === 'ACTIVE' && reservation.expiresAt !== null && reservation.expiresAt.getTime() <= at.getTime();
}
