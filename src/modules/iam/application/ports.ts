import type { Realm } from '../../../platform/context/request-context';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { GrantScope } from '../domain/authorisation-policy';

/** Argon2id (ADR-0016). `verifyDummy` spends the same time on an unknown account, so timing reveals nothing. */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(encodedHash: string, password: string): Promise<boolean>;
  verifyDummy(password: string): Promise<void>;
}

export interface AccessTokenClaims {
  readonly principalId: string;
  readonly sessionId: string;
  readonly realm: Realm;
}

/** Short-lived signed access tokens (EdDSA JWT, ADR-0016). */
export interface AccessTokens {
  issue(claims: AccessTokenClaims, now: Date): Promise<{ readonly token: string; readonly expiresAt: Date }>;
  /** The claims of a valid, unexpired token signed by a known key, or null. */
  verify(token: string, now: Date): Promise<(AccessTokenClaims & { readonly expiresAt: Date }) | null>;
}

/** The breached-password check at set time: a range query, with a bundled list when the service is unreachable. */
export interface BreachedPasswords {
  isBreached(password: string): Promise<boolean>;
}

export type ThrottleState = { readonly locked: false } | { readonly locked: true; readonly retryAfterSeconds: number };

/**
 * Per-identifier failed-login counter with the SA-01 backoff, kept in Redis and applied alike to identifiers with and
 * without an account. Throws when Redis is unavailable: the login group fails closed.
 */
export interface LoginThrottle {
  state(realm: Realm, identifier: string): Promise<ThrottleState>;
  recordFailure(realm: Realm, identifier: string): Promise<{ readonly consecutiveFailures: number; readonly lockedForSeconds: number }>;
  reset(realm: Realm, identifier: string): Promise<void>;
}

/**
 * Branch and location codes for the grants a session shows (GrantSummary). IAM is below MDM, so it cannot read
 * them; MDM registers this port's implementation at start-up (ADR-0033, MODULE_BOUNDARIES section 6).
 */
export interface ScopeNames {
  codes(tx: Transaction, branchIds: readonly string[], locationIds: readonly string[]): Promise<{
    readonly branches: ReadonlyMap<string, string>;
    readonly locations: ReadonlyMap<string, string>;
  }>;
}

export interface AccountRecord {
  readonly principalId: string;
  readonly realm: Realm;
  readonly displayName: string;
  readonly principalStatus: 'ACTIVE' | 'DISABLED';
  readonly email: string | null;
  readonly phone: string | null;
  readonly passwordHash: string | null;
  readonly mustChangePassword: boolean;
  readonly totpRequired: boolean;
  readonly version: number;
}

export type ChallengePurpose = 'LOGIN_TOTP' | 'LOGIN_TOTP_ENROLMENT' | 'LOGIN_PASSWORD_CHANGE';

export interface ChallengeRecord {
  readonly id: string;
  readonly principalId: string;
  readonly purpose: ChallengePurpose;
  readonly deviceLabel: string | null;
  readonly expiresAt: Date;
  readonly attempts: number;
  readonly consumedAt: Date | null;
}

export interface SessionRecord {
  readonly id: string;
  readonly principalId: string;
  readonly realm: Realm;
  readonly displayName: string;
  readonly principalStatus: 'ACTIVE' | 'DISABLED';
  readonly mustChangePassword: boolean;
  readonly deviceLabel: string | null;
  readonly userAgent: string | null;
  readonly ipCreated: string | null;
  readonly csrfTokenHash: Buffer;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly steppedUpAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface RefreshTokenRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

export interface TotpRecord {
  readonly secretEnc: Buffer;
  readonly confirmedAt: Date | null;
  readonly lastUsedStep: number | null;
  readonly version: number;
}

export interface GrantRecord {
  readonly roleCode: string;
  readonly roleName: string;
  readonly branchId: string;
  readonly locationId: string | null;
}

export interface SessionListFilter {
  readonly principalId: string | null;
  readonly activeOnly: boolean | null;
  /** Exclusive upper bound on the id, for newest-first cursor paging. */
  readonly beforeId: string | null;
  readonly limit: number;
}

export interface NewSession {
  readonly id: string;
  readonly principalId: string;
  readonly realm: Realm;
  readonly deviceLabel: string | null;
  readonly userAgent: string | null;
  readonly ip: string | null;
  readonly csrfTokenHash: Buffer;
  readonly now: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly steppedUpAt: Date | null;
}

/** Everything IAM keeps in its own schema. Every method runs in the caller's transaction. */
export interface IamStore {
  accountByIdentifier(tx: Transaction, realm: Realm, column: 'email' | 'phone_e164', value: string): Promise<AccountRecord | null>;
  accountById(tx: Transaction, principalId: string): Promise<AccountRecord | null>;
  recordLoginFailure(tx: Transaction, account: AccountRecord, failedAttempts: number, lockedUntil: Date | null): Promise<void>;
  recordLoginSuccess(tx: Transaction, principalId: string, now: Date): Promise<void>;
  setPassword(tx: Transaction, principalId: string, passwordHash: string, now: Date, actorId: string): Promise<void>;
  holdsRoleRequiringTotp(tx: Transaction, principalId: string, now: Date): Promise<boolean>;

  totp(tx: Transaction, principalId: string): Promise<TotpRecord | null>;
  savePendingTotp(tx: Transaction, principalId: string, secretEnc: Buffer, actorId: string): Promise<void>;
  /** Records a matched step only if it is later than the last used one; false means a replay lost the race. */
  useTotpStep(tx: Transaction, principalId: string, step: number, confirm: boolean, actorId: string): Promise<boolean>;
  replaceRecoveryCodes(tx: Transaction, principalId: string, codeHashes: readonly Buffer[], now: Date, nextId: () => string): Promise<void>;
  useRecoveryCode(tx: Transaction, principalId: string, codeHash: Buffer, now: Date): Promise<boolean>;

  createChallenge(tx: Transaction, challenge: ChallengeRecord & { readonly tokenHash: Buffer }): Promise<void>;
  challengeByHash(tx: Transaction, tokenHash: Buffer): Promise<ChallengeRecord | null>;
  countChallengeAttempt(tx: Transaction, id: string): Promise<number>;
  consumeChallenge(tx: Transaction, id: string, now: Date): Promise<void>;

  createSession(tx: Transaction, session: NewSession): Promise<void>;
  sessionById(tx: Transaction, id: string): Promise<SessionRecord | null>;
  touchSession(tx: Transaction, id: string, now: Date, idleExpiresAt: Date | null): Promise<void>;
  stepUpSession(tx: Transaction, id: string, now: Date): Promise<void>;
  revokeSession(tx: Transaction, id: string, by: string, reason: string, now: Date): Promise<boolean>;
  revokeOtherSessions(tx: Transaction, principalId: string, exceptSessionId: string | null, by: string, reason: string, now: Date): Promise<string[]>;
  listSessions(tx: Transaction, filter: SessionListFilter): Promise<SessionRecord[]>;

  /** Inserts a refresh token; with `replacesId`, also links the rotated predecessor to it. */
  createRefreshToken(
    tx: Transaction,
    token: { id: string; sessionId: string; tokenHash: Buffer; issuedAt: Date; expiresAt: Date; replacesId?: string },
  ): Promise<void>;
  refreshTokenByHash(tx: Transaction, tokenHash: Buffer): Promise<RefreshTokenRecord | null>;
  /** Marks a token used, once; false means it was already used (a reuse or a race). */
  markRefreshTokenUsed(tx: Transaction, id: string, now: Date): Promise<boolean>;

  currentGrants(tx: Transaction, principalId: string, now: Date): Promise<GrantRecord[]>;
  currentPermissions(tx: Transaction, principalId: string, now: Date): Promise<string[]>;
  grantsWithPermission(tx: Transaction, principalId: string, permission: string, now: Date): Promise<GrantScope[]>;
  permissionRequiresStepUp(tx: Transaction, permission: string): Promise<boolean | null>;
}

export const IAM_STORE = Symbol('IAM_STORE');
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
export const ACCESS_TOKENS = Symbol('ACCESS_TOKENS');
export const BREACHED_PASSWORDS = Symbol('BREACHED_PASSWORDS');
export const LOGIN_THROTTLE = Symbol('LOGIN_THROTTLE');
