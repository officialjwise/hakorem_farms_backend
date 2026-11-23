import type { Transaction } from '../../../platform/database/unit-of-work';

/** A staff session as another module may see it for an address: who, which session, its browser and when seen. */
export interface StaffSessionSeen {
  readonly principalId: string;
  readonly sessionId: string;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
}

/**
 * The staff sessions seen from one address in a window (the owner, 2026-11-23, decision 5; A-343; abuse case 40): QUO
 * asks it which staff were signed in from the address a quote was decided from through the buyer's link, to flag a
 * possible staff acceptance, never reading a staff cookie. The address is the one IAM recorded when the session was
 * created (`iam.session.ip_created`); a session counts when it was last seen inside the window and created before its
 * end, revoked or not. Only the staff realm; never a token, a CSRF hash or anything that authenticates.
 */
export interface StaffSessionsSeen {
  fromAddressIn(tx: Transaction, ip: string, window: { readonly from: Date; readonly until: Date }): Promise<readonly StaffSessionSeen[]>;
}

export const STAFF_SESSIONS_SEEN = Symbol('STAFF_SESSIONS_SEEN');
