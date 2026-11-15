import type { Clock } from '@hakorem/kernel';
import { systemClock } from '@hakorem/kernel';
import { NestFactory } from '@nestjs/core';
import type pg from 'pg';
import type { Logger } from 'pino';
import { AppModule } from './app.module';
import type { AppConfig } from './platform/config/app-config';
import { createPool } from './platform/database/database-pool';
import { UnitOfWork } from './platform/database/unit-of-work';
import { DomainEvents } from './platform/events/domain-events';
import { NestPinoLogger } from './platform/logging/nest-logger';
import { OtelMetrics } from './platform/observability/metrics';
import { LOGGER, PG_POOL } from './platform/platform.module';
import { AuditTrail } from './platform/audit/audit-trail';
import { FileScanner } from './platform/storage/file-scanner';
import { SharpImageRenderer } from './platform/storage/image-renderer';
import { ClamdScanner } from './platform/storage/malware-scanner';
import { OBJECT_STORAGE, type ObjectStorage } from './platform/storage/object-storage';
import { BullmqJobQueue } from './platform/queue/job-queue';
import { S3ObjectStorage } from './platform/storage/s3-object-storage';
import { WorkerRuntime } from './platform/worker/worker-runtime';

/** Milliseconds a storage call from the worker may take. */
const STORAGE_TIMEOUT_MS = 10_000;
const SEALER_POOL_MAX = 2;

/**
 * Builds and starts the worker: the application's module graph as a context (no HTTP), its own pools as hk_worker
 * and hk_sealer, the queue, the anchor store and the metrics exporter. Used by `src/worker.ts` and by the e2e stack.
 */
export async function startWorker(config: AppConfig, logger: Logger, clock: Clock = systemClock): Promise<{ close(): Promise<void> }> {
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config, logger, clock), { logger: new NestPinoLogger(logger), abortOnError: false });
  app.enableShutdownHooks();
  const sealerPool = createPool({
    connectionString: config.DATABASE_URL_SEALER!,
    applicationName: 'hakorem-sealer',
    max: SEALER_POOL_MAX,
    statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
  }, logger);
  const redis = new URL(config.REDIS_URL);
  const queue = new BullmqJobQueue(
    {
      host: redis.hostname,
      port: Number(redis.port === '' ? 6379 : redis.port),
      ...(redis.password === '' ? {} : { password: decodeURIComponent(redis.password) }),
      db: redis.pathname.length > 1 ? Number(redis.pathname.slice(1)) : 0,
    },
    `${config.REDIS_KEY_PREFIX}bull`,
    logger,
  );
  const storage = new S3ObjectStorage({
    endpoint: config.S3_ENDPOINT!,
    region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    accessKeyId: config.S3_ANCHOR_ACCESS_KEY_ID!,
    secretAccessKey: config.S3_ANCHOR_SECRET_ACCESS_KEY!,
    timeoutMs: STORAGE_TIMEOUT_MS,
  });
  const fileStorage = app.get<ObjectStorage | null>(OBJECT_STORAGE);
  const fileScanner =
    config.CLAMAV_HOST === undefined || fileStorage === null
      ? null
      : new FileScanner(
          app.get<pg.Pool>(PG_POOL),
          app.get(UnitOfWork),
          fileStorage,
          new ClamdScanner({ host: config.CLAMAV_HOST, port: config.CLAMAV_PORT, timeoutMs: config.CLAMAV_TIMEOUT_MS }),
          app.get(AuditTrail),
          clock,
          app.get<Logger>(LOGGER),
          {
            renderer: new SharpImageRenderer(),
            publicBucket: config.S3_BUCKET_PUBLIC_MEDIA ?? null,
            ensureBucket: config.APP_ENV === 'development' || config.APP_ENV === 'test',
          },
        );
  const metrics = new OtelMetrics({ enabled: config.METRICS_ENABLED, port: config.METRICS_PORT, serviceName: config.OTEL_SERVICE_NAME });
  const runtime = new WorkerRuntime(
    config,
    app.get(UnitOfWork),
    app.get<pg.Pool>(PG_POOL),
    sealerPool,
    app.get(DomainEvents),
    queue,
    storage,
    metrics,
    clock,
    logger,
    fileScanner,
  );
  await runtime.start();
  return {
    async close() {
      await runtime.stop();
      storage.close();
      await metrics.shutdown();
      await sealerPool.end();
      await app.close();
    },
  };
}
