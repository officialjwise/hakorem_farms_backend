import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Clock } from '@hakorem/kernel';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { SubjectKeys } from '../../platform/crypto/subject-keys';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK, LOGGER, REDIS } from '../../platform/platform.module';
import { APPROVAL_STORE, Approvals, type ApprovalStore } from './application/approvals';
import { AuthenticationService, ScopeNamesRegistry } from './application/authentication.service';
import { Authoriser } from './application/authoriser';
import {
  ACCESS_TOKENS,
  BREACHED_PASSWORDS,
  IAM_STORE,
  LOGIN_THROTTLE,
  PASSWORD_HASHER,
  type AccessTokens,
  type BreachedPasswords,
  type IamStore,
  type LoginThrottle,
  type PasswordHasher,
} from './application/ports';
import { SessionsService } from './application/sessions.service';
import { Argon2PasswordHasher } from './infrastructure/argon2-password-hasher';
import { RangeQueryBreachedPasswords } from './infrastructure/breached-passwords';
import { JwtAccessTokens } from './infrastructure/jwt-access-tokens';
import { PgApprovalStore } from './infrastructure/pg-approval-store';
import { PgIamStore } from './infrastructure/pg-iam-store';
import { RedisLoginThrottle } from './infrastructure/redis-login-throttle';
import { AuthController } from './interface/auth.controller';
import { AuthenticationGuard } from './interface/authentication.guard';
import { SessionsController } from './interface/sessions.controller';

/** Milliseconds the breached-password range query may take before the bundled list is used. */
const BREACHED_LOOKUP_TIMEOUT_MS = 2_000;

/**
 * IAM, the lowest module (layer 2): accounts, sessions, TOTP, roles and grants, the policy engine every handler
 * calls, and the one maker-checker mechanism (ADR-0009, ADR-0016, ADR-0017). Its guard is global, so every route in
 * every module passes through it.
 */
@Module({
  controllers: [AuthController, SessionsController],
  providers: [
    { provide: IAM_STORE, useClass: PgIamStore },
    { provide: APPROVAL_STORE, useClass: PgApprovalStore },
    {
      provide: PASSWORD_HASHER,
      useFactory: (config: AppConfig) =>
        new Argon2PasswordHasher({ memoryKib: config.ARGON2_MEMORY_KIB, iterations: config.ARGON2_ITERATIONS, parallelism: config.ARGON2_PARALLELISM }),
      inject: [APP_CONFIG],
    },
    {
      provide: ACCESS_TOKENS,
      useFactory: (config: AppConfig) =>
        new JwtAccessTokens({
          activeKeyId: config.JWT_ACTIVE_KEY_ID ?? '',
          signingKeys: config.JWT_SIGNING_KEYS ?? '{}',
          publicKeys: config.JWT_PUBLIC_KEYS,
          ttlSeconds: config.AUTH_ACCESS_TTL_SECONDS,
        }),
      inject: [APP_CONFIG],
    },
    {
      provide: BREACHED_PASSWORDS,
      useFactory: (config: AppConfig, logger: Logger) =>
        new RangeQueryBreachedPasswords({ enabled: config.HIBP_ENABLED, baseUrl: config.HIBP_BASE_URL, timeoutMs: BREACHED_LOOKUP_TIMEOUT_MS }, logger),
      inject: [APP_CONFIG, LOGGER],
    },
    { provide: LOGIN_THROTTLE, useFactory: (redis: Redis) => new RedisLoginThrottle(redis), inject: [REDIS] },
    ScopeNamesRegistry,
    {
      provide: Authoriser,
      useFactory: (store: IamStore, audit: AuditTrail, clock: Clock, logger: Logger, config: AppConfig) =>
        new Authoriser(store, audit, clock, logger, config.AUTH_STEP_UP_TTL_SECONDS),
      inject: [IAM_STORE, AuditTrail, CLOCK, LOGGER, APP_CONFIG],
    },
    {
      provide: AuthenticationService,
      useFactory: (
        uow: UnitOfWork,
        store: IamStore,
        hasher: PasswordHasher,
        tokens: AccessTokens,
        breached: BreachedPasswords,
        throttle: LoginThrottle,
        scopeNames: ScopeNamesRegistry,
        subjectKeys: SubjectKeys,
        audit: AuditTrail,
        clock: Clock,
        logger: Logger,
        config: AppConfig,
      ) =>
        new AuthenticationService(uow, store, hasher, tokens, breached, throttle, scopeNames, subjectKeys, audit, clock, logger, {
          accessTtlSeconds: config.AUTH_ACCESS_TTL_SECONDS,
          challengeTtlSeconds: config.AUTH_CHALLENGE_TTL_SECONDS,
          totpIssuer: config.AUTH_TOTP_ISSUER,
          lookupKey: Buffer.from(config.LOOKUP_HMAC_KEY, 'base64'),
          lifetimes: {
            STAFF: { idleSeconds: config.AUTH_STAFF_REFRESH_IDLE_SECONDS, absoluteSeconds: config.AUTH_STAFF_REFRESH_ABSOLUTE_SECONDS },
            CUSTOMER: { idleSeconds: config.AUTH_CUSTOMER_REFRESH_IDLE_SECONDS, absoluteSeconds: config.AUTH_CUSTOMER_REFRESH_ABSOLUTE_SECONDS },
            INVESTOR: { idleSeconds: config.AUTH_CUSTOMER_REFRESH_IDLE_SECONDS, absoluteSeconds: config.AUTH_CUSTOMER_REFRESH_ABSOLUTE_SECONDS },
          },
        }),
      inject: [UnitOfWork, IAM_STORE, PASSWORD_HASHER, ACCESS_TOKENS, BREACHED_PASSWORDS, LOGIN_THROTTLE, ScopeNamesRegistry, SubjectKeys, AuditTrail, CLOCK, LOGGER, APP_CONFIG],
    },
    {
      provide: SessionsService,
      useFactory: (uow: UnitOfWork, store: IamStore, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, cursors: Cursors, clock: Clock) =>
        new SessionsService(uow, store, authoriser, idempotency, audit, cursors, clock),
      inject: [UnitOfWork, IAM_STORE, Authoriser, Idempotency, AuditTrail, Cursors, CLOCK],
    },
    {
      provide: Approvals,
      useFactory: (store: ApprovalStore, authoriser: Authoriser, events: DomainEvents, audit: AuditTrail, clock: Clock) =>
        new Approvals(store, authoriser, events, audit, clock),
      inject: [APPROVAL_STORE, Authoriser, DomainEvents, AuditTrail, CLOCK],
    },
    AuthenticationGuard,
    { provide: APP_GUARD, useExisting: AuthenticationGuard },
  ],
  exports: [Authoriser, Approvals, ScopeNamesRegistry],
})
export class IamModule {}
