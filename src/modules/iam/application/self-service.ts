import { createHmac } from 'node:crypto';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import { currentRequestContext, runWithRequestContext, type Realm } from '../../../platform/context/request-context';
import { sqlStateOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import { RateLimitedError, ValidationFailedError, type ApiError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { RateLimiter } from '../../../platform/http/rate-limiter';
import { translate } from '../../../platform/i18n/messages';
import type { OutgoingMessage } from '../../../platform/notifications/notification-channel';
import { checkPasswordShape, normaliseIdentifier } from '../domain/credentials';
import { isGhanaPhone, phoneCodeRefusal, RESET_TOKEN_TTL_SECONDS, resetTokenRefusal } from '../domain/self-service';
import type { PhoneVerified, UserCreated } from '../events';
import type { AuthenticationService } from './authentication.service';
import {
  ChallengeExpiredError,
  PasswordBreachedError,
  ResetTokenExpiredError,
  ResetTokenInvalidError,
  ResetTokenUsedError,
  VerificationCodeInvalidError,
} from './errors';
import { opaqueSecret, sha256, type PhoneCodes } from './phone-codes';
import type { BreachedPasswords, IamStore, LoginThrottle, PasswordHasher } from './ports';
import type { SelfServiceStore } from './self-service-store';
import type { LoginOutcome } from './session-view';

/** Requests per identifier per window, beside the per-address `auth` group (docs/API.md section 12): fail closed. */
const PER_IDENTIFIER_LIMIT = 5;
const PER_IDENTIFIER_WINDOW_SECONDS = 900;
const MILLISECONDS_PER_SECOND = 1_000;

export interface CustomerRegistrationRequest {
  readonly name: string;
  readonly phone: string;
  readonly email?: string | undefined;
  readonly password: string;
  readonly marketingConsent: boolean;
}

type Committed<T> = { readonly value: T } | { readonly error: ApiError };

async function unwrap<T>(pending: Promise<Committed<T>>): Promise<T> {
  const settled = await pending;
  if ('error' in settled) throw settled.error;
  return settled.value;
}

/**
 * The customer realm's registration and phone verification (FR-IAM-019) and password reset for every realm
 * (FR-IAM-020), A-123. Neither registration nor a reset request says whether an account exists: both answer the same
 * and do the same work, and a registration for a known phone gets a challenge that no code can pass while the phone's
 * owner gets a notice. Codes and tokens are stored hashed and sent by SMS after commit (PhoneCodes). A reset revokes
 * every session of the account.
 */
export class SelfService {
  private readonly nextId: () => string;
  private readonly limiterKey: Buffer;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: SelfServiceStore,
    private readonly iamStore: IamStore,
    private readonly authentication: AuthenticationService,
    private readonly phoneCodes: PhoneCodes,
    private readonly hasher: PasswordHasher,
    private readonly breached: BreachedPasswords,
    private readonly throttle: LoginThrottle,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly clock: Clock,
    lookupKey: Buffer,
  ) {
    this.nextId = createUuidV7Generator(clock);
    this.limiterKey = createHmac('sha256', lookupKey).update('hk-self-service-limit-v1').digest();
  }

  // ---------------------------------------------------------------- customer realm

  async registerCustomer(input: CustomerRegistrationRequest, deviceLabel: string | null = null): Promise<{ challengeToken: string }> {
    if (!isGhanaPhone(input.phone)) {
      throw new ValidationFailedError('not a Ghana phone number', [{ field: '/phone', code: 'NOT_GHANA_PHONE', message: translate('iam.phone_not_ghana') }]);
    }
    const email = input.email?.trim().toLowerCase();
    await this.checkNewPassword('/password', input.password, email ?? input.phone);
    await this.limit('register', `CUSTOMER|${input.phone}`);
    const passwordHash = await this.hasher.hash(input.password);
    let issued: { challengeToken: string; message: OutgoingMessage };
    try {
      issued = await this.registerInside(input, email ?? null, passwordHash, deviceLabel);
    } catch (error) {
      // Two registrations of one new phone at once: the loser finds the winner's account and is answered the same.
      if (sqlStateOf(error) !== '23505') throw error;
      issued = await this.registerInside(input, email ?? null, passwordHash, deviceLabel);
    }
    this.phoneCodes.deliver(issued.message);
    return { challengeToken: issued.challengeToken };
  }

  async verifyCustomerPhone(challengeToken: string, code: string): Promise<LoginOutcome> {
    const outcome = await unwrap(
      this.uow.run({ isolation: 'serializable' }, async (tx): Promise<Committed<LoginOutcome>> => {
        const now = this.clock.now();
        const token = await this.store.tokenByHash(tx, sha256(challengeToken), 'PHONE_VERIFY');
        if (token === null) return { error: new ChallengeExpiredError('unknown phone challenge') };
        const attempts = await this.iamStore.countChallengeAttempt(tx, token.id);
        const refusal = phoneCodeRefusal({ attempts, expiresAt: token.expiresAt, consumedAt: token.consumedAt, now });
        if (refusal !== null) {
          await this.iamStore.consumeChallenge(tx, token.id, now);
          return { error: new ChallengeExpiredError(`phone challenge ${refusal}`) };
        }
        if (!this.phoneCodes.matches(token.id, token.codeHash, code)) {
          await this.audit.record(tx, {
            module: 'iam',
            action: 'PHONE_VERIFICATION_FAILED',
            entityType: 'UserAccount',
            entityId: token.principalId,
            actorId: token.principalId,
            metadata: { attempts },
          });
          return { error: new VerificationCodeInvalidError('wrong phone code') };
        }
        await this.iamStore.consumeChallenge(tx, token.id, now);
        await this.store.markPhoneVerified(tx, token.principalId, now);
        await this.audit.record(tx, { module: 'iam', action: 'PHONE_VERIFIED', entityType: 'UserAccount', entityId: token.principalId, actorId: token.principalId });
        const payload: PhoneVerified = { principalId: token.principalId, realm: 'CUSTOMER' };
        await this.asCustomer(token.principalId, () => this.events.publish(tx, { type: 'iam.PhoneVerified', subjectType: 'UserAccount', subjectId: token.principalId, payload }));
        return { value: await this.authentication.continueLogin(tx, token.principalId, token.deviceLabel) };
      }),
    );
    if (outcome.kind === 'CHALLENGE' && outcome.message !== undefined) this.phoneCodes.deliver(outcome.message);
    return outcome;
  }

  // ---------------------------------------------------------------- password reset

  async requestPasswordReset(input: { identifier: string; realm: Realm }): Promise<void> {
    const identifier = normaliseIdentifier(input.identifier);
    const subject = identifier?.value ?? input.identifier.trim().toLowerCase();
    await this.limit('password_reset', `${input.realm}|${subject}`);
    const message = await this.uow.run({ isolation: 'serializable' }, async (tx): Promise<OutgoingMessage | null> => {
      const account =
        identifier === null ? null : await this.iamStore.accountByIdentifier(tx, input.realm, identifier.kind === 'EMAIL' ? 'email' : 'phone_e164', identifier.value);
      const outcome = account === null ? 'NO_ACCOUNT' : account.principalStatus !== 'ACTIVE' ? 'DISABLED' : account.phone === null ? 'NO_CHANNEL' : 'SENT';
      await this.audit.record(tx, {
        module: 'iam',
        action: 'PASSWORD_RESET_REQUESTED',
        entityType: 'UserAccount',
        entityId: account?.principalId ?? null,
        actorId: account?.principalId ?? null,
        // An email-only account waits for the email channel (B11): nothing is sent, and the answer is the same.
        metadata: { realm: input.realm, outcome, identifierHash: this.identifierHash(subject) },
      });
      if (outcome !== 'SENT') return null;
      const now = this.clock.now();
      await this.store.consumeOpenTokens(tx, account!.principalId, 'PASSWORD_RESET', now);
      const id = this.nextId();
      const token = `hk1.rs.${opaqueSecret()}`;
      await this.store.createToken(tx, {
        id,
        principalId: account!.principalId,
        purpose: 'PASSWORD_RESET',
        tokenHash: sha256(token),
        codeHash: null,
        deviceLabel: null,
        expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_SECONDS * MILLISECONDS_PER_SECOND),
        consumedAt: null,
      });
      return {
        to: account!.phone!,
        text: `HaKorem Farms: your password reset code is ${token} . It works once, for 30 minutes. If you did not ask for it, ignore this message.`,
        idempotencyKey: `iam.verification_token:${id}`,
      };
    });
    if (message !== null) this.phoneCodes.deliver(message);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const hash = sha256(token);
    const found = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const row = await this.store.tokenByHash(tx, hash, 'PASSWORD_RESET');
      return row === null ? null : { row, account: await this.iamStore.accountById(tx, row.principalId) };
    });
    if (found === null || found.account === null) throw new ResetTokenInvalidError('no reset token matches');
    this.refuseToken(found.row);
    await this.checkNewPassword('/newPassword', newPassword, found.account.email ?? found.account.phone ?? '');
    const passwordHash = await this.hasher.hash(newPassword);
    const account = found.account;
    await this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const now = this.clock.now();
      const row = await this.store.tokenByHash(tx, hash, 'PASSWORD_RESET');
      if (row === null) throw new ResetTokenInvalidError('no reset token matches');
      this.refuseToken(row);
      const current = await this.iamStore.accountById(tx, row.principalId);
      if (current === null || current.principalStatus !== 'ACTIVE') throw new ResetTokenInvalidError('the account is not active');
      await this.iamStore.consumeChallenge(tx, row.id, now);
      await this.iamStore.setPassword(tx, row.principalId, passwordHash, now, row.principalId);
      // The token reached the account's phone, so the phone is proved too.
      if (current.realm === 'CUSTOMER') await this.store.markPhoneVerified(tx, row.principalId, now);
      const revoked = await this.iamStore.revokeOtherSessions(tx, row.principalId, null, row.principalId, 'PASSWORD_RESET', now);
      await this.audit.record(tx, {
        module: 'iam',
        action: 'PASSWORD_RESET',
        entityType: 'UserAccount',
        entityId: row.principalId,
        actorId: row.principalId,
        metadata: { realm: current.realm, sessionsRevoked: revoked.length },
      });
    });
    for (const identifier of [account.email, account.phone, `principal:${account.principalId}`]) {
      if (identifier !== null) await this.throttle.reset(account.realm, identifier);
    }
  }

  // ---------------------------------------------------------------- internals

  private async registerInside(input: CustomerRegistrationRequest, email: string | null, passwordHash: string, deviceLabel: string | null) {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const known = await this.iamStore.accountByIdentifier(tx, 'CUSTOMER', 'phone_e164', input.phone);
      if (known !== null) {
        await this.audit.record(tx, {
          module: 'iam',
          action: 'REGISTRATION_FOR_KNOWN_PHONE',
          entityType: 'UserAccount',
          entityId: known.principalId,
          actorId: known.principalId,
        });
        return this.phoneCodes.issue(tx, known.principalId, input.phone, deviceLabel, false);
      }
      return this.createCustomer(tx, input, email, passwordHash, deviceLabel);
    });
  }

  private async createCustomer(tx: Transaction, input: CustomerRegistrationRequest, email: string | null, passwordHash: string, deviceLabel: string | null) {
    const id = this.nextId();
    // An email another customer already uses is left off, so the answer cannot tell anyone which emails are known.
    const keptEmail = email !== null && !(await this.store.emailTaken(tx, 'CUSTOMER', email)) ? email : null;
    const now = this.clock.now();
    await this.store.insertCustomer(tx, { id, displayName: input.name.trim(), phone: input.phone, email: keptEmail, passwordHash });
    await this.audit.record(tx, {
      module: 'iam',
      action: 'CREATE',
      entityType: 'UserAccount',
      entityId: id,
      actorId: id,
      after: { displayName: input.name.trim(), realm: 'CUSTOMER', phone: input.phone, email: keptEmail } as never,
      metadata: { selfRegistered: true, emailLeftOff: email !== null && keptEmail === null, marketingConsent: input.marketingConsent },
      subject: { type: 'CUSTOMER', id },
      personalFields: ['phone', 'email'],
    });
    const payload: UserCreated = { principalId: id, realm: 'CUSTOMER', marketingConsent: input.marketingConsent, consentRecordedAt: now.toISOString(), phoneVerified: false };
    await this.asCustomer(id, () => this.events.publish(tx, { type: 'iam.UserCreated', subjectType: 'UserAccount', subjectId: id, payload }));
    return this.phoneCodes.issue(tx, id, input.phone, deviceLabel, true);
  }

  /** Events carry their actor from the request: on these public routes the actor is the customer the request is about. */
  private asCustomer<T>(principalId: string, work: () => Promise<T>): Promise<T> {
    const context = currentRequestContext();
    if (context === undefined) throw new Error('self-service runs inside a request context');
    return runWithRequestContext(
      { ...context, actor: { principalId, kind: 'USER', displayName: 'Customer', realm: 'CUSTOMER', sessionId: null, steppedUpAt: null } },
      work,
    );
  }

  private refuseToken(row: { expiresAt: Date; consumedAt: Date | null }): void {
    const refusal = resetTokenRefusal({ expiresAt: row.expiresAt, consumedAt: row.consumedAt, now: this.clock.now() });
    if (refusal === 'RESET_TOKEN_USED') throw new ResetTokenUsedError('the reset token was already used');
    if (refusal === 'RESET_TOKEN_EXPIRED') throw new ResetTokenExpiredError('the reset token has expired');
  }

  private async checkNewPassword(field: string, password: string, identifier: string): Promise<void> {
    const shape = checkPasswordShape(password, identifier);
    if (shape !== null) {
      const key = shape === 'TOO_SHORT' ? 'iam.password_too_short' : shape === 'TOO_LONG' ? 'iam.password_too_long' : 'iam.password_same_as_identifier';
      throw new ValidationFailedError(`password is ${shape}`, [{ field, code: shape, message: translate(key) }]);
    }
    if (await this.breached.isBreached(password)) throw new PasswordBreachedError('the password is in a breached-password list');
  }

  private async limit(name: string, subject: string): Promise<void> {
    const decision = await this.limiter.consume(`iam:${name}`, this.identifierHash(subject), PER_IDENTIFIER_LIMIT, PER_IDENTIFIER_WINDOW_SECONDS, true);
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds, `${name} limit for one identifier`);
  }

  private identifierHash(identifier: string): string {
    return createHmac('sha256', this.limiterKey).update(identifier).digest('hex');
  }
}
