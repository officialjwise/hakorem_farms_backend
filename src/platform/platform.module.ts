import { Global, Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { systemClock, type Clock } from '@hakorem/kernel';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Logger } from 'pino';
import { AuditTrail } from './audit/audit-trail';
import { APP_CONFIG, databaseUrlOf, type AppConfig } from './config/app-config';
import { keyRingFromEnvironment, type KeyRing } from './crypto/key-ring';
import { SubjectKeys } from './crypto/subject-keys';
import { createPool } from './database/database-pool';
import { UnitOfWork } from './database/unit-of-work';
import { DomainEvents } from './events/domain-events';
import { auditSealingLagContributor, deadLettersContributor, HealthService, outboxBacklogContributor } from './health/health.service';
import { HealthController } from './health/health.controller';
import { Cursors } from './http/cursor';
import { RateLimiter } from './http/rate-limiter';
import { Idempotency } from './idempotency/idempotency';
import { createRedis } from './redis/redis-client';
import { Settings } from './settings/settings';

export const LOGGER = Symbol('LOGGER');
export const PG_POOL = Symbol('PG_POOL');
export const REDIS = Symbol('REDIS');
export const CLOCK = Symbol('CLOCK');
export const KEY_RING = Symbol('KEY_RING');

/** Closes the pool and Redis when the application stops, after in-flight requests finish. */
class ConnectionCloser implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.pool.end(), this.redis.quit()]);
  }
}

/**
 * Technical mechanisms every module uses: configuration, logging, the clock, the database pool and unit of work,
 * Redis, encryption keys, the audit trail, domain events and the outbox, idempotency, settings, rate limiting and
 * the health report. No business rules live here (ADR-0009).
 */
@Global()
@Module({})
export class PlatformModule {
  static forRoot(config: AppConfig, logger: Logger, clock: Clock = systemClock): DynamicModule {
    return {
      module: PlatformModule,
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
        { provide: CLOCK, useValue: clock },
        {
          provide: PG_POOL,
          useFactory: () =>
            createPool({
              connectionString: databaseUrlOf(config),
              applicationName: `hakorem-${config.APP_ROLE}`,
              max: config.DB_POOL_MAX,
              statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
            }, logger),
        },
        { provide: REDIS, useFactory: () => createRedis(config.REDIS_URL, `hakorem-${config.APP_ROLE}`, config.REDIS_KEY_PREFIX) },
        { provide: UnitOfWork, useFactory: (pool: pg.Pool) => new UnitOfWork(pool, logger), inject: [PG_POOL] },
        { provide: KEY_RING, useFactory: () => keyRingFromEnvironment(config.env, config.KEK_ACTIVE_VERSION) },
        { provide: SubjectKeys, useFactory: (keyRing: KeyRing) => new SubjectKeys(keyRing, clock), inject: [KEY_RING] },
        { provide: AuditTrail, useFactory: (keys: SubjectKeys, pool: pg.Pool) => new AuditTrail(keys, clock, pool), inject: [SubjectKeys, PG_POOL] },
        { provide: DomainEvents, useFactory: () => new DomainEvents(clock) },
        { provide: Idempotency, useFactory: () => new Idempotency(clock) },
        { provide: Settings, useFactory: (pool: pg.Pool) => new Settings(pool, clock, logger), inject: [PG_POOL] },
        { provide: RateLimiter, useFactory: (redis: Redis) => new RateLimiter(redis, logger), inject: [REDIS] },
        { provide: Cursors, useFactory: () => new Cursors(Buffer.from(config.LOOKUP_HMAC_KEY, 'base64'), clock) },
        {
          provide: HealthService,
          useFactory: (pool: pg.Pool, redis: Redis) =>
            new HealthService(pool, redis, clock, logger, config.version, config.HEALTH_CACHE_SECONDS, [
              outboxBacklogContributor(pool),
              deadLettersContributor(pool),
              auditSealingLagContributor(pool),
            ]),
          inject: [PG_POOL, REDIS],
        },
        ConnectionCloser,
      ],
      exports: [
        APP_CONFIG,
        LOGGER,
        CLOCK,
        PG_POOL,
        REDIS,
        KEY_RING,
        UnitOfWork,
        SubjectKeys,
        AuditTrail,
        DomainEvents,
        Idempotency,
        Settings,
        RateLimiter,
        Cursors,
        HealthService,
      ],
    };
  }
}
