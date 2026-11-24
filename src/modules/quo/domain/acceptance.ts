/**
 * An accepted quote's hold and its end (the owner, 2026-11-24, A-310 (b) amended; B11u continued, A-294), by the
 * application clock (ADR-0067). No money here: instants only.
 */
/** How long an accepted quote holds its stock for its order (the owner, 2026-11-24: "An accepted quote's hold ends 7 days after acceptance."). */
export const ACCEPTED_HOLD_DAYS = 7;
const DAY_MS = 86_400_000;

/** The instant an accepted quote's hold ends: the acceptance instant plus seven days, by the application clock (ADR-0067). */
export function acceptanceHoldEndsAt(acceptedAt: Date): Date {
  return new Date(acceptedAt.getTime() + ACCEPTED_HOLD_DAYS * DAY_MS);
}

/** Whether an accepted quote's hold has ended at `now`: at seven days exactly it has, a millisecond before it has not. */
export function acceptanceLapsed(acceptedAt: Date, now: Date): boolean {
  return now.getTime() >= acceptanceHoldEndsAt(acceptedAt).getTime();
}

/** The latest acceptance instant whose hold has ended by `now`: the quote-expiry job lapses every quote accepted at or before it. */
export function acceptedLapsingBy(now: Date): Date {
  return new Date(now.getTime() - ACCEPTED_HOLD_DAYS * DAY_MS);
}
