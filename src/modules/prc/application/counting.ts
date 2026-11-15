/** Counting helpers kept apart from money code, so no number arithmetic sits beside a `Money` (ADR-0001). */

/** One more than a page, to learn whether another page follows. */
export function pageProbe(limit: number): number {
  return limit + 1;
}

/** The 1-based line number of an item from its 0-based index. */
export function ordinal(index: number): number {
  return index + 1;
}

/** A calendar date (`YYYY-MM-DD`) a number of whole days later. */
export function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}
