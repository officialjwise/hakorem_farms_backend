import type { Realm } from '../../../platform/context/request-context';

/** The contract's `GrantSummary`. */
export interface GrantSummaryView {
  readonly roleCode: string;
  readonly roleName: string;
  readonly branchId: string;
  readonly branchCode: string;
  readonly locationId: string | null;
  readonly locationCode: string | null;
}

/** The contract's `SessionInfo`: what a client keeps after login and after every refresh. */
export interface SessionInfoView {
  readonly sessionId: string;
  readonly realm: Realm;
  readonly principal: { readonly id: string; readonly displayName: string };
  readonly csrfToken: string;
  readonly accessExpiresAt: string;
  readonly refreshExpiresAt: string;
  readonly steppedUpAt: string | null;
  readonly mustChangePassword: boolean;
  readonly totpEnrolled: boolean;
  readonly grants: readonly GrantSummaryView[];
  readonly permissions: readonly string[];
}

/** A session that was just created or refreshed, with the two tokens the controller sets as cookies. */
export interface IssuedSession {
  readonly realm: Realm;
  readonly info: SessionInfoView;
  readonly accessToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
}

export type ChallengeStatus = 'TOTP_REQUIRED' | 'TOTP_ENROLMENT_REQUIRED' | 'PASSWORD_CHANGE_REQUIRED';

export type LoginOutcome =
  | { readonly kind: 'AUTHENTICATED'; readonly issued: IssuedSession }
  | { readonly kind: 'CHALLENGE'; readonly status: ChallengeStatus; readonly challengeToken: string };

/** The contract's `SessionRecord`, one row of the device list. */
export interface SessionRecordView {
  readonly id: string;
  readonly principal: { readonly id: string; readonly displayName: string };
  readonly realm: Realm;
  readonly deviceLabel: string | null;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly current: boolean;
  readonly revokedAt: string | null;
}
