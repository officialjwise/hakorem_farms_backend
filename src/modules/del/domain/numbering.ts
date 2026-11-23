/** A page read asks for one row more than it shows, to know whether another page follows. */
export function pageProbe(limit: number): number {
  return limit + 1;
}

/** Attempts are numbered from 1, in the order they happen (`uq_delivery_attempt_no`). */
export function nextAttemptNo(attempts: number): number {
  return attempts + 1;
}

const DAY_MS = 86_400_000;

/** The last millisecond of an Africa/Accra calendar date (UTC+0 the year round, no daylight saving). */
export function endOfBusinessDate(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS - 1);
}
