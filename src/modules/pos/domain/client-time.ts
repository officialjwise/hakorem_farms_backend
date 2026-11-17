/**
 * Times and ids a till sends (ADR-0013, ADR-0067, OFFLINE_SYNC 4.1). Pure: compared with the application clock's time,
 * which the caller passes in; never with the database's.
 */

/**
 * How far a time the till sends may be from the application clock, in seconds (OFFLINE_SYNC 4.1's default for
 * `sync.clock_tolerance_seconds`, A-273 (g)): an online shift opens, and cash moves, now.
 */
export const CLOCK_TOLERANCE_SECONDS = 300;
const MILLISECONDS_PER_SECOND = 1_000;

/** A client id of version 7 (ADR-0013): a till that makes its own ids makes them time-ordered. */
export function isUuidV7(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

/** Whether a time the till sends is within the tolerance of the application clock (ADR-0067). */
export function withinTolerance(at: Date, now: Date): boolean {
  return Math.abs(at.getTime() - now.getTime()) <= CLOCK_TOLERANCE_SECONDS * MILLISECONDS_PER_SECOND;
}

