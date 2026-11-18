const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * When an unverified offline mobile money tender still unmatched becomes urgent (OFFLINE_SYNC 9.9,
 * `pay.unverified_window_days`, B09b continued 2c): that many whole days after the customer paid.
 */
export function unverifiedUrgentFrom(receivedAt: Date, windowDays: number): Date {
  return new Date(receivedAt.getTime() + windowDays * MILLISECONDS_PER_DAY);
}
