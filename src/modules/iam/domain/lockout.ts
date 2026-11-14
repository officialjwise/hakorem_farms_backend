/** Consecutive failures allowed before the first lock (SA-01). */
export const LOCKOUT_FREE_FAILURES = 5;
const FIRST_LOCK_SECONDS = 60;
const MAX_LOCK_SECONDS = 3_600;

/**
 * How long an identifier is locked after this many consecutive failed logins (SA-01, FR-IAM-017): one minute at the
 * fifth, doubling for each further failure, capped at sixty minutes. The same schedule applies to identifiers that
 * match no account, so the lock itself does not reveal whether an account exists.
 */
export function lockSecondsAfter(consecutiveFailures: number): number {
  if (consecutiveFailures < LOCKOUT_FREE_FAILURES) {
    return 0;
  }
  const doublings = consecutiveFailures - LOCKOUT_FREE_FAILURES;
  return doublings >= 6 ? MAX_LOCK_SECONDS : Math.min(MAX_LOCK_SECONDS, FIRST_LOCK_SECONDS * 2 ** doublings);
}
