import { Global, Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { systemClock, type Clock } from '@hakorem/kernel';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Logger } from 'pino';
import { AuditTrail } from './audit/audit-trail';
import { APP_CONFIG, databaseUrlOf, publicMediaBaseUrl, type AppConfig } from './config/app-config';
import { keyRingFromEnvironment, type KeyRing } from './crypto/key-ring';
import { SubjectKeys } from './crypto/subject-keys';
import { createPool } from './database/database-pool';
import { UnitOfWork } from './database/unit-of-work';
import { DomainEvents } from './events/domain-events';
import { auditSealingLagContributor, deadLettersContributor, HealthService, outboxBacklogContributor } from './health/health.service';
import { HealthController } from './health/health.controller';
import { Cursors } from './http/cursor';
import { RateLimiter } from './http/rate-limiter';
import { DocumentRegistry } from './documents/document-registry';
import { NumberSeries } from './documents/number-series';
import { Idempotency } from './idempotency/idempotency';
import { createRedis } from './redis/redis-client';
import { Settings } from './settings/settings';
import { GenericHttpSms, SMS_CHANNEL } from './notifications/notification-channel';
import { PAYMENT_PROVIDER, PaystackPaymentProvider } from './payments/payment-provider';
import { ResilientPaymentProvider } from './payments/resilient-provider';
import { FileStore } from './storage/file-store';
import { OBJECT_STORAGE, type ObjectStorage } from './storage/object-storage';
import { S3ObjectStorage } from './storage/s3-object-storage';

export const LOGGER = Symbol('LOGGER');
export const PG_POOL = Symbol('PG_POOL');
export const REDIS = Symbol('REDIS');
export const CLOCK = Symbol('CLOCK');
export const KEY_RING = Symbol('KEY_RING');
/** Milliseconds an object storage call may take; uploads and scans are made outside any business transaction. */
const FILE_STORAGE_TIMEOUT_MS = 30_000;

/** The file store's object storage (ADR-0044): the files credential, not the anchor writer's. Null when not configured. */
function fileObjectStorage(config: AppConfig): S3ObjectStorage | null {
  if (config.S3_ENDPOINT === undefined || config.S3_ACCESS_KEY_ID === undefined || config.S3_SECRET_ACCESS_KEY === undefined) {
    return null;
  }
  return new S3ObjectStorage({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    timeoutMs: FILE_STORAGE_TIMEOUT_MS,
  });
}

/** Closes the pool and Redis when the application stops, after in-flight requests finish. */
class ConnectionCloser implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage | null,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.storage instanceof S3ObjectStorage) {
      this.storage.close();
    }
    await Promise.allSettled([this.pool.end(), this.redis.quit()]);
  }
}

/**
 * Technical mechanisms every module uses: configuration, logging, the clock, the database pool and unit of work,
 * Redis, encryption keys, the audit trail, domain events and the outbox, idempotency, settings, rate limiting, the
 * file store and the health report. No business rules live here (ADR-0009).
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
        { provide: UnitOfWork, useFactory: (pool: pg.Pool) => new UnitOfWork(pool, logger, undefined, clock), inject: [PG_POOL] },
        { provide: KEY_RING, useFactory: () => keyRingFromEnvironment(config.env, config.KEK_ACTIVE_VERSION) },
        { provide: SubjectKeys, useFactory: (keyRing: KeyRing) => new SubjectKeys(keyRing, clock), inject: [KEY_RING] },
        { provide: AuditTrail, useFactory: (keys: SubjectKeys, pool: pg.Pool) => new AuditTrail(keys, clock, pool), inject: [SubjectKeys, PG_POOL] },
        { provide: DomainEvents, useFactory: () => new DomainEvents(clock) },
        { provide: Idempotency, useFactory: () => new Idempotency(clock) },
        DocumentRegistry,
        NumberSeries,
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
        {
          provide: SMS_CHANNEL,
          useFactory: () =>
            new GenericHttpSms(
              { mode: config.MESSAGING_MODE, baseUrl: config.SMS_BASE_URL, apiKey: config.SMS_API_KEY, senderId: config.SMS_SENDER_ID, timeoutMs: config.SMS_TIMEOUT_MS },
              logger,
            ),
        },
        {
          // The payment provider port (ADR-0009, A-210): Paystack behind a timeout, a bounded retry and a circuit breaker;
          // unconfigured, every provider call is unavailable and cash still works.
          provide: PAYMENT_PROVIDER,
          useFactory: () =>
            new ResilientPaymentProvider(
              config.PAYSTACK_SECRET_KEY === undefined || config.PAYSTACK_BASE_URL === undefined
                ? null
                : new PaystackPaymentProvider({ baseUrl: config.PAYSTACK_BASE_URL, secretKey: config.PAYSTACK_SECRET_KEY, timeoutMs: config.PAYSTACK_TIMEOUT_MS }),
              clock,
            ),
        },
        { provide: OBJECT_STORAGE, useFactory: () => fileObjectStorage(config) },
        {
          provide: FileStore,
          useFactory: (storage: ObjectStorage | null, audit: AuditTrail) =>
            new FileStore(
              storage,
              { privateBucket: config.S3_BUCKET_PRIVATE ?? null, ensureBucket: config.APP_ENV === 'development' || config.APP_ENV === 'test', publicBaseUrl: publicMediaBaseUrl(config) },
              audit,
              clock,
            ),
          inject: [OBJECT_STORAGE, AuditTrail],
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
        DocumentRegistry,
        NumberSeries,
        Settings,
        RateLimiter,
        Cursors,
        HealthService,
        SMS_CHANNEL,
        PAYMENT_PROVIDER,
        OBJECT_STORAGE,
        FileStore,
      ],
    };
  }
}
