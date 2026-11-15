/**
 * Counting that is not money (page sizes, line numbers, clock windows, calendar days), kept out of the files that
 * import `Money` so the lint rule against number arithmetic beside money (ADR-0001) holds there without exception.
 */
const MS_PER_DAY = 86_400_000;
/** How far ahead of the server's clock a receipt may be dated: a phone's clock running a little fast. */
const RECEIPT_CLOCK_SKEW_MS = 5 * 60_000;

/** Rows to fetch for a page: one more than the limit, to know whether another page follows. */
export function pageProbe(limit: number): number {
  return limit + 1;
}

/** The 1-based position of an item from its 0-based index. */
export function ordinal(index: number): number {
  return index + 1;
}

/** Whether an instant is later than the server's clock allows for something that has already happened. */
export function isInTheFuture(instant: Date, now: Date): boolean {
  return instant.getTime() > now.getTime() + RECEIPT_CLOCK_SKEW_MS;
}

/** Whole days from one calendar date (`YYYY-MM-DD`) to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

/** The calendar date `days` after `date`. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}
