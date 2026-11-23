/**
 * A possible staff acceptance (the owner, 2026-11-23, decision 5; A-343; abuse case 40): a quote decided through the
 * buyer's link from the address of a staff session active in the 24 hours before the decision, by the application
 * clock (ADR-0067). It is found by the address and the browser, never by reading a staff cookie; it flags and never
 * blocks. A match from another browser is still flagged, marked not the same browser (A-343 (c)).
 */
export const STAFF_MATCH_WINDOW_HOURS = 24;
const WINDOW_MS = STAFF_MATCH_WINDOW_HOURS * 3_600_000;
/** The decision keeps its user agent to 500 characters (0282's check); a session's is compared on the same length. */
const USER_AGENT_LENGTH = 500;

/** A staff session as IAM reports it for the decision's address. */
export interface SeenStaffSession {
  readonly principalId: string;
  readonly sessionId: string;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
}

export interface StaffMatch {
  readonly principalId: string;
  readonly sessionId: string;
  readonly sameBrowser: boolean;
  readonly lastSeenAt: Date;
}

/** The earliest last-seen time that counts: exactly 24 hours before the decision, inclusive. */
export function staffWindowStart(at: Date): Date {
  return new Date(at.getTime() - WINDOW_MS);
}

/**
 * The staff sessions a decision made at `at` from `ip` with `userAgent` matches: each session seen from that address
 * (IAM filters by it) no earlier than 24 hours before and created no later than the decision, once, by staff member
 * then session. No address, no match; two unknown browsers are never the same browser.
 */
export function matchStaff(
  decision: { readonly ip: string | null; readonly userAgent: string | null; readonly at: Date },
  seen: readonly SeenStaffSession[],
): StaffMatch[] {
  if (decision.ip === null) return [];
  const from = staffWindowStart(decision.at).getTime();
  const until = decision.at.getTime();
  const matches = new Map<string, StaffMatch>();
  for (const s of seen) {
    if (s.lastSeenAt.getTime() < from || s.createdAt.getTime() > until || matches.has(s.sessionId)) continue;
    const sameBrowser = decision.userAgent !== null && s.userAgent !== null && s.userAgent.slice(0, USER_AGENT_LENGTH) === decision.userAgent;
    matches.set(s.sessionId, { principalId: s.principalId, sessionId: s.sessionId, sameBrowser, lastSeenAt: s.lastSeenAt });
  }
  const key = (m: StaffMatch) => `${m.principalId}\u0000${m.sessionId}`;
  return [...matches.values()].sort((a, b) => (key(a) < key(b) ? -1 : 1));
}
