/**
 * Times and ids a till sends (ADR-0013, ADR-0067, OFFLINE_SYNC 4.1). Pure: compared with the application clock's time,
 * which the caller passes in; never with the database's.
 */

/**
 * How far a time the till sends may be from the application clock, in seconds: the default of the setting
 * `sync.clock_tolerance_seconds` (OFFLINE_SYNC 4.1, the owner on A-273 (g)), seeded in B09b continued 2 and read where
 * a till's time is judged, so the owner can tighten it without a deployment.
 */
export const CLOCK_TOLERANCE_SECONDS = 300;
/** The setting the tolerance is read from. */
export const CLOCK_TOLERANCE_SETTING = 'sync.clock_tolerance_seconds';
const MILLISECONDS_PER_SECOND = 1_000;
const MILLISECONDS_PER_HOUR = 3_600_000;

/** A client id of version 7 (ADR-0013): a till that makes its own ids makes them time-ordered. */
export function isUuidV7(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

/** Whether a time the till sends is within the tolerance of the application clock (ADR-0067). */
export function withinTolerance(at: Date, now: Date, toleranceSeconds: number = CLOCK_TOLERANCE_SECONDS): boolean {
  return Math.abs(at.getTime() - now.getTime()) <= toleranceSeconds * MILLISECONDS_PER_SECOND;
}


/** How many whole seconds the till's time is ahead of the application clock (behind is negative), rounded. */
export function secondsAhead(at: Date, now: Date): number {
  return Math.round((at.getTime() - now.getTime()) / MILLISECONDS_PER_SECOND);
}

/** When an offline pack issued at `generatedAt` stops being sold from: `maxOfflineHours` later (OFFLINE_SYNC 5.1). */
export function packValidUntil(generatedAt: Date, maxOfflineHours: number): Date {
  return new Date(generatedAt.getTime() + maxOfflineHours * MILLISECONDS_PER_HOUR);
}
