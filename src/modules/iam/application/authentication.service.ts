import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import { currentRequestContext, type Actor, type Realm } from '../../../platform/context/request-context';
import { openWithSubjectKey, sealWithSubjectKey, type SubjectKeys, type SubjectType } from '../../../platform/crypto/subject-keys';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { RateLimitedError, UnauthenticatedError, ValidationFailedError, type ApiError } from '../../../platform/errors/api-error';
import { translate } from '../../../platform/i18n/messages';
import { checkPasswordShape, normaliseIdentifier, refreshExpiry, type RealmLifetimes } from '../domain/credentials';
import { base32Decode, base32Encode, otpauthUri, verifyTotp } from '../domain/totp';
import {
  ChallengeExpiredError,
  InvalidCredentialsError,
  PasswordBreachedError,
  TotpAlreadyEnrolledError,
  TotpEnrolmentRequiredError,
  TotpInvalidError,
} from './errors';
import type {
  AccessTokens,
  AccountRecord,
  BreachedPasswords,
  ChallengePurpose,
  ChallengeRecord,
  IamStore,
  LoginThrottle,
  PasswordHasher,
  QrCodes,
  ScopeNames,
  SessionRecord,
} from './ports';
import type { ChallengeStatus, GrantSummaryView, IssuedSession, LoginOutcome, SessionInfoView } from './session-view';

export interface AuthenticationSettings {
  readonly accessTtlSeconds: number;
  readonly challengeTtlSeconds: number;
  readonly totpIssuer: string;
  readonly lifetimes: Readonly<Record<Realm, RealmLifetimes>>;
  /** The lookup hashing key (LOOKUP_HMAC_KEY); CSRF tokens and identifier hashes are derived from it. */
  readonly lookupKey: Buffer;
}

/** Attempts at a code on one challenge before it is spent (SA-20 applies the same cap to verification codes). */
const MAX_CHALLENGE_ATTEMPTS = 5;
const TOTP_SECRET_BYTES = 20;
const RECOVERY_CODE_COUNT = 8;
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SIX_DIGITS = /^\d{6}$/;
/** A session's last-seen time is written at most this often. */
const LAST_SEEN_RESOLUTION_MS = 60_000;
const MILLISECONDS_PER_SECOND = 1_000;

const SUBJECT_OF_REALM: Readonly<Record<Realm, SubjectType>> = { STAFF: 'STAFF', CUSTOMER: 'CUSTOMER', INVESTOR: 'INVESTOR' };
const CHALLENGE_STATUS: Readonly<Record<ChallengePurpose, ChallengeStatus>> = {
  LOGIN_TOTP: 'TOTP_REQUIRED',
  LOGIN_TOTP_ENROLMENT: 'TOTP_ENROLMENT_REQUIRED',
  LOGIN_PASSWORD_CHANGE: 'PASSWORD_CHANGE_REQUIRED',
};

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

function opaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

function recoveryCode(): string {
  const bytes = randomBytes(8);
  const characters = [...bytes].map((byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]).join('');
  return `${characters.slice(0, 4)}-${characters.slice(4)}`;
}

function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function totpPlace(principalId: string): string {
  return `iam.totp_credential:${principalId}`;
}

/** Either a value, or an error to throw after the transaction has committed what it must keep (attempt counts). */
type Committed<T> = { readonly value: T } | { readonly error: ApiError };

async function unwrap<T>(result: Promise<Committed<T>>): Promise<T> {
  const settled = await result;
  if ('error' in settled) {
    throw settled.error;
  }
  return settled.value;
}

/** Who a challenge-or-session operation acts for: a session's actor, or a login challenge between steps. */
export type AccountCaller = { readonly kind: 'SESSION'; readonly actor: Actor } | { readonly kind: 'CHALLENGE'; readonly token: string };

/** What the authentication guard learns from a valid access token. */
export interface AuthenticatedRequest {
  readonly actor: Actor;
  readonly session: SessionRecord;
  readonly accessExpiresAt: Date;
}

/** The B3 ScopeNames registration point: MDM registers its implementation at start-up (ADR-0033). */
export class ScopeNamesRegistry {
  private implementation: ScopeNames | undefined;

  register(implementation: ScopeNames): void {
    this.implementation = implementation;
  }

  get(): ScopeNames {
    if (this.implementation === undefined) {
      throw new Error('no ScopeNames implementation is registered; the MDM module registers one at start-up');
    }
    return this.implementation;
  }
}

/**
 * Authentication for the three realms (ADR-0016, docs/API.md section 3): password login with the SA-01 backoff and
 * no account enumeration, the login challenge for TOTP, TOTP enrolment and a temporary password, rotating refresh
 * tokens with reuse detection, logout, password change, and step-up. Every event is audited.
 */
/** The contract's `TotpEnrolment`: shown once. */
export interface TotpEnrolmentView {
  readonly otpauthUri: string;
  readonly secretBase32: string;
  readonly qrCodeDataUri: string;
}

export class AuthenticationService {
  private readonly nextId: () => string;
  private readonly csrfKey: Buffer;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: IamStore,
    private readonly hasher: PasswordHasher,
    private readonly tokens: AccessTokens,
    private readonly breached: BreachedPasswords,
    private readonly qrCodes: QrCodes,
    private readonly throttle: LoginThrottle,
    private readonly scopeNames: ScopeNamesRegistry,
    private readonly subjectKeys: SubjectKeys,
    private readonly audit: AuditTrail,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly settings: AuthenticationSettings,
  ) {
    this.nextId = createUuidV7Generator(clock);
    this.csrfKey = createHmac('sha256', settings.lookupKey).update('hk-csrf-v1').digest();
  }

  // ---------------------------------------------------------------- login

  async login(realm: Realm, input: { identifier: string; password: string; deviceLabel?: string | undefined }): Promise<LoginOutcome> {
    const identifier = normaliseIdentifier(input.identifier);
    const throttleKey = identifier?.value ?? input.identifier.trim().toLowerCase();
    const state = await this.throttle.state(realm, throttleKey);
    if (state.locked) {
      await this.auditDetachedFailure(realm, null, 'LOCKED', throttleKey);
      throw new RateLimitedError(state.retryAfterSeconds, 'login identifier is locked');
    }
    const account =
      identifier === null
        ? null
        : await this.uow.run({ isolation: 'read committed' }, (tx) =>
            this.store.accountByIdentifier(tx, realm, identifier.kind === 'EMAIL' ? 'email' : 'phone_e164', identifier.value),
          );
    const usable = account !== null && account.passwordHash !== null && account.principalStatus === 'ACTIVE';
    let verified = false;
    if (usable) {
      verified = await this.hasher.verify(account.passwordHash!, input.password);
    } else {
      await this.hasher.verifyDummy(input.password);
    }
    if (!verified) {
      const failure = await this.throttle.recordFailure(realm, throttleKey);
      const lockedUntil = failure.lockedForSeconds > 0 ? new Date(this.clock.now().getTime() + failure.lockedForSeconds * MILLISECONDS_PER_SECOND) : null;
      await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        if (account !== null) {
          await this.store.recordLoginFailure(tx, account, failure.consecutiveFailures, lockedUntil);
        }
        await this.audit.record(tx, {
          module: 'iam',
          action: 'LOGIN_FAILED',
          entityType: 'UserAccount',
          entityId: account?.principalId ?? null,
          actorId: account?.principalId ?? null,
          sessionId: null,
          metadata: {
            realm,
            reason: 'INVALID_CREDENTIALS',
            identifierHash: this.identifierHash(throttleKey),
            consecutiveFailures: failure.consecutiveFailures,
            lockedForSeconds: failure.lockedForSeconds,
          },
        });
      });
      throw new InvalidCredentialsError('wrong identifier or password');
    }
    await this.throttle.reset(realm, throttleKey);
    return this.uow.run({ isolation: 'serializable' }, (tx) => this.afterPassword(tx, account!, input.deviceLabel ?? null));
  }

  async verifyTotp(challengeToken: string, code: string): Promise<IssuedSession> {
    return unwrap(
      this.uow.run({ isolation: 'serializable' }, async (tx): Promise<Committed<IssuedSession>> => {
        const challenge = await this.liveChallenge(tx, challengeToken, ['LOGIN_TOTP']);
        if ('error' in challenge) {
          return challenge;
        }
        const ch = challenge.value;
        const account = await this.store.accountById(tx, ch.principalId);
        if (account === null || account.principalStatus !== 'ACTIVE') {
          await this.store.consumeChallenge(tx, ch.id, this.clock.now());
          return { error: new ChallengeExpiredError('the account is no longer active') };
        }
        const method = await this.checkSecondFactor(tx, account, code);
        if (method === null) {
          await this.audit.record(tx, {
            module: 'iam',
            action: 'LOGIN_FAILED',
            entityType: 'UserAccount',
            entityId: account.principalId,
            actorId: account.principalId,
            sessionId: null,
            metadata: { realm: account.realm, reason: 'TOTP_INVALID' },
          });
          return { error: new TotpInvalidError('wrong or reused second-factor code') };
        }
        await this.store.consumeChallenge(tx, ch.id, this.clock.now());
        return { value: await this.issueSession(tx, account, ch.deviceLabel, this.clock.now(), method) };
      }),
    );
  }

  // ---------------------------------------------------------------- sessions

  /** The guard's check of an access token: valid signature, the session live, the realm matching the cookie. */
  async authenticate(realm: Realm, accessToken: string): Promise<AuthenticatedRequest | null> {
    const now = this.clock.now();
    const claims = await this.tokens.verify(accessToken, now);
    if (claims === null || claims.realm !== realm) {
      return null;
    }
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const session = await this.store.sessionById(tx, claims.sessionId);
      if (session === null || !this.isLive(session, now) || session.principalId !== claims.principalId || session.realm !== realm) {
        return null;
      }
      if (now.getTime() - session.lastSeenAt.getTime() >= LAST_SEEN_RESOLUTION_MS) {
        await this.store.touchSession(tx, session.id, now, null);
      }
      return {
        actor: {
          principalId: session.principalId,
          kind: 'USER',
          displayName: session.displayName,
          realm: session.realm,
          sessionId: session.id,
          steppedUpAt: session.steppedUpAt,
        },
        session,
        accessExpiresAt: claims.expiresAt,
      };
    });
  }

  /** Whether the X-CSRF-Token header matches the token bound to the session (ADR-0016), in constant time. */
  csrfMatches(session: SessionRecord, header: string | undefined): boolean {
    if (header === undefined || header.length === 0 || header.length > 128) {
      return false;
    }
    return timingSafeEqual(sha256(header), session.csrfTokenHash);
  }

  async refresh(realm: Realm, refreshToken: string | undefined): Promise<IssuedSession> {
    if (refreshToken === undefined || refreshToken.length === 0) {
      throw new UnauthenticatedError('no refresh cookie');
    }
    return unwrap(
      this.uow.run({ isolation: 'serializable' }, async (tx): Promise<Committed<IssuedSession>> => {
        const now = this.clock.now();
        const token = await this.store.refreshTokenByHash(tx, sha256(refreshToken));
        if (token === null) {
          return { error: new UnauthenticatedError('unknown refresh token') };
        }
        const session = await this.store.sessionById(tx, token.sessionId);
        if (session === null || session.realm !== realm) {
          return { error: new UnauthenticatedError('refresh token of another realm') };
        }
        if (token.usedAt !== null) {
          await this.revokeForReuse(tx, session, now);
          return { error: new UnauthenticatedError('a rotated refresh token was presented again') };
        }
        if (!this.isLive(session, now) || now.getTime() >= session.idleExpiresAt.getTime() || now.getTime() >= token.expiresAt.getTime()) {
          return { error: new UnauthenticatedError('the session has ended') };
        }
        const successorId = this.nextId();
        if (!(await this.store.markRefreshTokenUsed(tx, token.id, now))) {
          await this.revokeForReuse(tx, session, now);
          return { error: new UnauthenticatedError('the refresh token was used concurrently') };
        }
        const { idleExpiresAt } = refreshExpiry(session.createdAt, now, this.settings.lifetimes[realm]);
        await this.store.touchSession(tx, session.id, now, idleExpiresAt);
        const successor = opaqueToken();
        await this.store.createRefreshToken(tx, {
          id: successorId,
          sessionId: session.id,
          tokenHash: sha256(successor),
          issuedAt: now,
          expiresAt: idleExpiresAt,
          replacesId: token.id,
        });
        const access = await this.tokens.issue({ principalId: session.principalId, sessionId: session.id, realm }, now);
        const refreshed: SessionRecord = { ...session, lastSeenAt: now, idleExpiresAt };
        return {
          value: {
            realm,
            info: await this.sessionInfo(tx, refreshed, access.expiresAt),
            accessToken: access.token,
            accessExpiresAt: access.expiresAt,
            refreshToken: successor,
            refreshExpiresAt: idleExpiresAt,
          },
        };
      }),
    );
  }

  async logout(actor: Actor): Promise<void> {
    await this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const now = this.clock.now();
      if (actor.sessionId !== null && (await this.store.revokeSession(tx, actor.sessionId, actor.principalId, 'LOGOUT', now))) {
        await this.audit.record(tx, { module: 'iam', action: 'LOGOUT', entityType: 'Session', entityId: actor.sessionId, metadata: { realm: actor.realm } });
      }
    });
  }

  async currentSession(authenticated: AuthenticatedRequest): Promise<SessionInfoView> {
    return this.uow.run({ isolation: 'read committed' }, (tx) => this.sessionInfo(tx, authenticated.session, authenticated.accessExpiresAt));
  }

  async stepUp(authenticated: AuthenticatedRequest, code: string): Promise<SessionInfoView> {
    return unwrap(
      this.uow.run({ isolation: 'serializable' }, async (tx): Promise<Committed<SessionInfoView>> => {
        const account = await this.store.accountById(tx, authenticated.actor.principalId);
        const totp = account === null ? null : await this.store.totp(tx, account.principalId);
        if (account === null || totp === null || totp.confirmedAt === null) {
          return { error: new TotpEnrolmentRequiredError('step-up needs an enrolled authenticator') };
        }
        const method = await this.checkSecondFactor(tx, account, code);
        if (method === null) {
          await this.audit.record(tx, { module: 'iam', action: 'STEP_UP_FAILED', entityType: 'Session', entityId: authenticated.session.id });
          return { error: new TotpInvalidError('wrong or reused step-up code') };
        }
        const now = this.clock.now();
        await this.store.stepUpSession(tx, authenticated.session.id, now);
        await this.audit.record(tx, { module: 'iam', action: 'STEP_UP', entityType: 'Session', entityId: authenticated.session.id, metadata: { method } });
        return { value: await this.sessionInfo(tx, { ...authenticated.session, steppedUpAt: now }, authenticated.accessExpiresAt) };
      }),
    );
  }

  // ---------------------------------------------------------------- own account

  async changePassword(caller: AccountCaller, currentPassword: string, newPassword: string): Promise<void> {
    const principalId = await this.callerPrincipal(caller, ['LOGIN_PASSWORD_CHANGE']);
    const account = await this.uow.run({ isolation: 'read committed' }, (tx) => this.store.accountById(tx, principalId));
    if (account === null || account.passwordHash === null || account.principalStatus !== 'ACTIVE') {
      throw new UnauthenticatedError('no active account for the caller');
    }
    const throttled = await this.throttle.state(account.realm, `principal:${account.principalId}`);
    if (throttled.locked) {
      throw new RateLimitedError(throttled.retryAfterSeconds, 'too many wrong current passwords');
    }
    if (!(await this.hasher.verify(account.passwordHash, currentPassword))) {
      await this.throttle.recordFailure(account.realm, `principal:${account.principalId}`);
      throw new InvalidCredentialsError('wrong current password');
    }
    const shape = checkPasswordShape(newPassword, account.email ?? account.phone ?? '');
    if (shape !== null) {
      const key = shape === 'TOO_SHORT' ? 'iam.password_too_short' : shape === 'TOO_LONG' ? 'iam.password_too_long' : 'iam.password_same_as_identifier';
      throw new ValidationFailedError(`new password is ${shape}`, [{ field: '/newPassword', code: shape, message: translate(key) }]);
    }
    if (await this.breached.isBreached(newPassword)) {
      throw new PasswordBreachedError('the new password is in a breached-password list');
    }
    const hash = await this.hasher.hash(newPassword);
    await unwrap(
      this.uow.run({ isolation: 'serializable' }, async (tx): Promise<Committed<void>> => {
        const now = this.clock.now();
        let keepSession: string | null = null;
        if (caller.kind === 'CHALLENGE') {
          const challenge = await this.liveChallenge(tx, caller.token, ['LOGIN_PASSWORD_CHANGE']);
          if ('error' in challenge) {
            return challenge;
          }
          await this.store.consumeChallenge(tx, challenge.value.id, now);
        } else {
          keepSession = caller.actor.sessionId;
        }
        await this.store.setPassword(tx, account.principalId, hash, now, account.principalId);
        const revoked = await this.store.revokeOtherSessions(tx, account.principalId, keepSession, account.principalId, 'PASSWORD_CHANGED', now);
        await this.audit.record(tx, {
          module: 'iam',
          action: 'PASSWORD_CHANGE',
          entityType: 'UserAccount',
          entityId: account.principalId,
          actorId: account.principalId,
          metadata: { otherSessionsRevoked: revoked.length, viaLoginChallenge: caller.kind === 'CHALLENGE' },
        });
        return { value: undefined };
      }),
    );
    await this.throttle.reset(account.realm, `principal:${account.principalId}`);
  }

  async startTotpEnrolment(caller: AccountCaller): Promise<TotpEnrolmentView> {
    return unwrap(
      this.uow.run({ isolation: 'serializable' }, async (tx): Promise<Committed<TotpEnrolmentView>> => {
        const resolved = await this.resolveCaller(tx, caller, ['LOGIN_TOTP_ENROLMENT']);
        if ('error' in resolved) {
          return resolved;
        }
        const account = resolved.value.account;
        const existing = await this.store.totp(tx, account.principalId);
        if (existing !== null && existing.confirmedAt !== null) {
          return { error: new TotpAlreadyEnrolledError('a confirmed authenticator exists') };
        }
        const secret = randomBytes(TOTP_SECRET_BYTES);
        const secretBase32 = base32Encode(secret);
        const key = await this.subjectKeys.keyFor(tx, { type: SUBJECT_OF_REALM[account.realm], id: account.principalId }, account.principalId);
        await this.store.savePendingTotp(tx, account.principalId, sealWithSubjectKey(key, secretBase32, totpPlace(account.principalId)), account.principalId);
        await this.audit.record(tx, { module: 'iam', action: 'TOTP_ENROLMENT_STARTED', entityType: 'UserAccount', entityId: account.principalId, actorId: account.principalId });
        const uri = otpauthUri(this.settings.totpIssuer, account.email ?? account.phone ?? account.displayName, secretBase32);
        // The QR code carries nothing the response does not already show: it is the same URI, drawn (ADR-0037).
        return { value: { otpauthUri: uri, secretBase32, qrCodeDataUri: this.qrCodes.svgDataUri(uri) } };
      }),
    );
  }

  /** Confirms enrolment with a first code. Through a login challenge it also completes the login. */
  async confirmTotpEnrolment(caller: AccountCaller, code: string): Promise<{ recoveryCodes: string[]; issued: IssuedSession | null }> {
    return unwrap(
      this.uow.run({ isolation: 'serializable' }, async (tx): Promise<Committed<{ recoveryCodes: string[]; issued: IssuedSession | null }>> => {
        const resolved = await this.resolveCaller(tx, caller, ['LOGIN_TOTP_ENROLMENT']);
        if ('error' in resolved) {
          return resolved;
        }
        const { account, challenge } = resolved.value;
        const pending = await this.store.totp(tx, account.principalId);
        if (pending === null) {
          return { error: new TotpEnrolmentRequiredError('start enrolment first') };
        }
        if (pending.confirmedAt !== null) {
          return { error: new TotpAlreadyEnrolledError('already confirmed') };
        }
        const now = this.clock.now();
        const secret = await this.totpSecret(tx, account, pending.secretEnc);
        const step = secret === null ? null : verifyTotp(secret, code, Math.floor(now.getTime() / MILLISECONDS_PER_SECOND), pending.lastUsedStep);
        if (step === null || !(await this.store.useTotpStep(tx, account.principalId, step, true, account.principalId))) {
          return { error: new TotpInvalidError('the first code does not match') };
        }
        const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
        await this.store.replaceRecoveryCodes(tx, account.principalId, recoveryCodes.map((c) => sha256(normaliseRecoveryCode(c))), now, this.nextId);
        await this.audit.record(tx, { module: 'iam', action: 'TOTP_ENROLLED', entityType: 'UserAccount', entityId: account.principalId, actorId: account.principalId });
        if (challenge === null) {
          return { value: { recoveryCodes, issued: null } };
        }
        await this.store.consumeChallenge(tx, challenge.id, now);
        return { value: { recoveryCodes, issued: await this.issueSession(tx, account, challenge.deviceLabel, now, 'TOTP') } };
      }),
    );
  }

  // ---------------------------------------------------------------- internals

  private async afterPassword(tx: Transaction, account: AccountRecord, deviceLabel: string | null): Promise<LoginOutcome> {
    if (account.mustChangePassword) {
      return this.challenge(tx, account, 'LOGIN_PASSWORD_CHANGE', deviceLabel);
    }
    const totp = await this.store.totp(tx, account.principalId);
    if (totp !== null && totp.confirmedAt !== null) {
      return this.challenge(tx, account, 'LOGIN_TOTP', deviceLabel);
    }
    const requiresTotp = account.totpRequired || (await this.store.holdsRoleRequiringTotp(tx, account.principalId, this.clock.now()));
    if (requiresTotp) {
      return this.challenge(tx, account, 'LOGIN_TOTP_ENROLMENT', deviceLabel);
    }
    return { kind: 'AUTHENTICATED', issued: await this.issueSession(tx, account, deviceLabel, null, 'PASSWORD') };
  }

  private async challenge(tx: Transaction, account: AccountRecord, purpose: ChallengePurpose, deviceLabel: string | null): Promise<LoginOutcome> {
    const token = `hk1.ch.${opaqueToken()}`;
    const now = this.clock.now();
    await this.store.createChallenge(tx, {
      id: this.nextId(),
      principalId: account.principalId,
      purpose,
      deviceLabel,
      expiresAt: new Date(now.getTime() + this.settings.challengeTtlSeconds * MILLISECONDS_PER_SECOND),
      attempts: 0,
      consumedAt: null,
      tokenHash: sha256(token),
    });
    return { kind: 'CHALLENGE', status: CHALLENGE_STATUS[purpose], challengeToken: token };
  }

  private async liveChallenge(tx: Transaction, token: string, purposes: readonly ChallengePurpose[]): Promise<Committed<ChallengeRecord>> {
    const challenge = await this.store.challengeByHash(tx, sha256(token));
    const now = this.clock.now();
    if (challenge === null || challenge.consumedAt !== null || now.getTime() >= challenge.expiresAt.getTime() || !purposes.includes(challenge.purpose)) {
      return { error: new ChallengeExpiredError('unknown, spent, expired or wrong-purpose challenge') };
    }
    const attempts = await this.store.countChallengeAttempt(tx, challenge.id);
    if (attempts > MAX_CHALLENGE_ATTEMPTS) {
      await this.store.consumeChallenge(tx, challenge.id, now);
      return { error: new ChallengeExpiredError('too many attempts on this challenge') };
    }
    return { value: challenge };
  }

  private async callerPrincipal(caller: AccountCaller, purposes: readonly ChallengePurpose[]): Promise<string> {
    if (caller.kind === 'SESSION') {
      return caller.actor.principalId;
    }
    return unwrap(
      this.uow.run({ isolation: 'read committed' }, async (tx): Promise<Committed<string>> => {
        const challenge = await this.store.challengeByHash(tx, sha256(caller.token));
        const now = this.clock.now();
        if (challenge === null || challenge.consumedAt !== null || now.getTime() >= challenge.expiresAt.getTime() || !purposes.includes(challenge.purpose)) {
          return { error: new ChallengeExpiredError('unknown, spent, expired or wrong-purpose challenge') };
        }
        return { value: challenge.principalId };
      }),
    );
  }

  private async resolveCaller(
    tx: Transaction,
    caller: AccountCaller,
    purposes: readonly ChallengePurpose[],
  ): Promise<Committed<{ account: AccountRecord; challenge: ChallengeRecord | null }>> {
    let principalId: string;
    let challenge: ChallengeRecord | null = null;
    if (caller.kind === 'SESSION') {
      principalId = caller.actor.principalId;
    } else {
      const live = await this.liveChallenge(tx, caller.token, purposes);
      if ('error' in live) {
        return live;
      }
      challenge = live.value;
      principalId = challenge.principalId;
    }
    const account = await this.store.accountById(tx, principalId);
    if (account === null || account.principalStatus !== 'ACTIVE') {
      return { error: new UnauthenticatedError('no active account for the caller') };
    }
    return { value: { account, challenge } };
  }

  /** A six-digit code or a single-use recovery code; returns how it was satisfied, or null. */
  private async checkSecondFactor(tx: Transaction, account: AccountRecord, code: string): Promise<'TOTP' | 'RECOVERY_CODE' | null> {
    const totp = await this.store.totp(tx, account.principalId);
    if (totp === null || totp.confirmedAt === null) {
      return null;
    }
    if (SIX_DIGITS.test(code)) {
      const secret = await this.totpSecret(tx, account, totp.secretEnc);
      const now = Math.floor(this.clock.now().getTime() / MILLISECONDS_PER_SECOND);
      const step = secret === null ? null : verifyTotp(secret, code, now, totp.lastUsedStep);
      return step !== null && (await this.store.useTotpStep(tx, account.principalId, step, false, account.principalId)) ? 'TOTP' : null;
    }
    const used = await this.store.useRecoveryCode(tx, account.principalId, sha256(normaliseRecoveryCode(code)), this.clock.now());
    return used ? 'RECOVERY_CODE' : null;
  }

  private async totpSecret(tx: Transaction, account: AccountRecord, secretEnc: Buffer): Promise<Buffer | null> {
    const key = await this.subjectKeys.keyFor(tx, { type: SUBJECT_OF_REALM[account.realm], id: account.principalId }, account.principalId);
    try {
      return base32Decode(openWithSubjectKey(key.key, secretEnc, totpPlace(account.principalId)));
    } catch (error) {
      this.logger.error({ principalId: account.principalId, err: error }, 'TOTP secret does not decrypt');
      return null;
    }
  }

  private async issueSession(
    tx: Transaction,
    account: AccountRecord,
    deviceLabel: string | null,
    steppedUpAt: Date | null,
    method: 'PASSWORD' | 'TOTP' | 'RECOVERY_CODE',
  ): Promise<IssuedSession> {
    const now = this.clock.now();
    const sessionId = this.nextId();
    const context = currentRequestContext();
    const { idleExpiresAt, absoluteExpiresAt } = refreshExpiry(now, now, this.settings.lifetimes[account.realm]);
    const csrfToken = this.csrfToken(sessionId);
    await this.store.createSession(tx, {
      id: sessionId,
      principalId: account.principalId,
      realm: account.realm,
      deviceLabel,
      userAgent: context?.userAgent ?? null,
      ip: context?.ip ?? null,
      csrfTokenHash: sha256(csrfToken),
      now,
      idleExpiresAt,
      absoluteExpiresAt,
      steppedUpAt,
    });
    const refreshToken = opaqueToken();
    await this.store.createRefreshToken(tx, { id: this.nextId(), sessionId, tokenHash: sha256(refreshToken), issuedAt: now, expiresAt: idleExpiresAt });
    await this.store.recordLoginSuccess(tx, account.principalId, now);
    await this.audit.record(tx, {
      module: 'iam',
      action: 'LOGIN',
      entityType: 'Session',
      entityId: sessionId,
      actorId: account.principalId,
      sessionId,
      metadata: { realm: account.realm, method, deviceLabel },
    });
    const access = await this.tokens.issue({ principalId: account.principalId, sessionId, realm: account.realm }, now);
    const session: SessionRecord = {
      id: sessionId,
      principalId: account.principalId,
      realm: account.realm,
      displayName: account.displayName,
      principalStatus: account.principalStatus,
      mustChangePassword: account.mustChangePassword,
      deviceLabel,
      userAgent: context?.userAgent ?? null,
      ipCreated: context?.ip ?? null,
      csrfTokenHash: sha256(csrfToken),
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt,
      absoluteExpiresAt,
      steppedUpAt,
      revokedAt: null,
    };
    return {
      realm: account.realm,
      info: await this.sessionInfo(tx, session, access.expiresAt),
      accessToken: access.token,
      accessExpiresAt: access.expiresAt,
      refreshToken,
      refreshExpiresAt: idleExpiresAt,
    };
  }

  private async sessionInfo(tx: Transaction, session: SessionRecord, accessExpiresAt: Date): Promise<SessionInfoView> {
    const now = this.clock.now();
    const grants = await this.store.currentGrants(tx, session.principalId, now);
    const codes = await this.scopeNames.get().codes(
      tx,
      [...new Set(grants.map((g) => g.branchId))],
      [...new Set(grants.map((g) => g.locationId).filter((id): id is string => id !== null))],
    );
    const totp = await this.store.totp(tx, session.principalId);
    const grantViews: GrantSummaryView[] = grants.map((grant) => ({
      roleCode: grant.roleCode,
      roleName: grant.roleName,
      branchId: grant.branchId,
      branchCode: codes.branches.get(grant.branchId) ?? '',
      locationId: grant.locationId,
      locationCode: grant.locationId === null ? null : (codes.locations.get(grant.locationId) ?? null),
    }));
    return {
      sessionId: session.id,
      realm: session.realm,
      principal: { id: session.principalId, displayName: session.displayName },
      csrfToken: this.csrfToken(session.id),
      accessExpiresAt: accessExpiresAt.toISOString(),
      refreshExpiresAt: session.idleExpiresAt.toISOString(),
      steppedUpAt: session.steppedUpAt === null ? null : session.steppedUpAt.toISOString(),
      mustChangePassword: session.mustChangePassword,
      totpEnrolled: totp !== null && totp.confirmedAt !== null,
      grants: grantViews,
      permissions: await this.store.currentPermissions(tx, session.principalId, now),
    };
  }

  private isLive(session: SessionRecord, now: Date): boolean {
    return session.revokedAt === null && session.principalStatus === 'ACTIVE' && now.getTime() < session.absoluteExpiresAt.getTime();
  }

  private async revokeForReuse(tx: Transaction, session: SessionRecord, now: Date): Promise<void> {
    const revoked = await this.store.revokeSession(tx, session.id, session.principalId, 'REFRESH_TOKEN_REUSE', now);
    this.logger.error({ sessionId: session.id, principalId: session.principalId, realm: session.realm }, 'refresh token reuse: session revoked');
    if (revoked) {
      await this.audit.record(tx, {
        module: 'iam',
        action: 'TOKEN_REUSE',
        entityType: 'Session',
        entityId: session.id,
        actorId: session.principalId,
        sessionId: session.id,
        metadata: { realm: session.realm },
      });
    }
  }

  private async auditDetachedFailure(realm: Realm, principalId: string | null, reason: string, identifier: string): Promise<void> {
    await this.audit.recordDetached({
      module: 'iam',
      action: 'LOGIN_FAILED',
      entityType: 'UserAccount',
      entityId: principalId,
      actorId: principalId,
      sessionId: null,
      metadata: { realm, reason, identifierHash: this.identifierHash(identifier) },
    });
  }

  /** Bound to the session for its whole life, so a page reload gets the same token (docs/API.md section 3.1). */
  private csrfToken(sessionId: string): string {
    return createHmac('sha256', this.csrfKey).update(`csrf|${sessionId}`).digest('base64url');
  }

  /** A keyed hash of a login identifier, so failed logins can be grouped without storing the identifier. */
  private identifierHash(identifier: string): string {
    return createHmac('sha256', this.settings.lookupKey).update(`login|${identifier}`).digest('hex');
  }
}

