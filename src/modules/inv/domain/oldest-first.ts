/** What decides which stock is picked first: the lot's expiry and received dates, then where it stands. */
export interface PickKey {
  /** The lot's expiry date in Africa/Accra (`YYYY-MM-DD`), or null for stock that does not expire. */
  readonly expiresOn: string | null;
  /** When the lot was received from its delivery (`inv.stock_unit.received_at`), or null for a lot never received. */
  readonly receivedAt: Date | null;
  /** The lot or animal, or null for an untracked balance. */
  readonly stockUnitId: string | null;
  readonly locationId: string;
}

/**
 * Oldest first (B09e continued, the owner's decision 4 of 2026-11-17), wherever the server picks stock: the lot that
 * expires first, then the one received first, so of two lots that expire the same day the older delivery sells first.
 * A lot with no expiry comes after every dated one, and one with no received date (a processing output, a lot of the
 * farm's own) after every received one. A full tie keeps a stable order by unit (an untracked balance first), then by
 * location. A comparator for `Array.prototype.sort`.
 */
export function oldestFirst(a: PickKey, b: PickKey): number {
  return (
    nullsLast(a.expiresOn, b.expiresOn, (x, y) => (x < y ? -1 : x > y ? 1 : 0)) ||
    nullsLast(a.receivedAt, b.receivedAt, (x, y) => Math.sign(x.getTime() - y.getTime())) ||
    text(a.stockUnitId ?? '', b.stockUnitId ?? '') ||
    text(a.locationId, b.locationId)
  );
}

function nullsLast<T>(a: T | null, b: T | null, compare: (x: T, y: T) => number): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return compare(a, b);
}

function text(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
