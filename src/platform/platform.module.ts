import { Global, Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { systemClock, type Clock } from '@hakorem/kernel';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig } from './config/app-config';
import { createPool } from './database/database-pool';
import { UnitOfWork } from './database/unit-of-work';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { createRedis } from './redis/redis-client';

export const LOGGER = Symbol('LOGGER');
export const PG_POOL = Symbol('PG_POOL');
export const REDIS = Symbol('REDIS');
export const CLOCK = Symbol('CLOCK');

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
 * Technical mechanisms every module uses: configuration, logging, the clock, the database pool and unit of
 * work, Redis and the health report. No business rules live here (ADR-0009).
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
              connectionString: config.DATABASE_URL_APP,
              applicationName: `hakorem-${config.APP_ROLE}`,
              max: config.DB_POOL_MAX,
              statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
            }),
        },
        { provide: REDIS, useFactory: () => createRedis(config.REDIS_URL, `hakorem-${config.APP_ROLE}`) },
        { provide: UnitOfWork, useFactory: (pool: pg.Pool) => new UnitOfWork(pool, logger), inject: [PG_POOL] },
        {
          provide: HealthService,
          useFactory: (pool: pg.Pool, redis: Redis) =>
            new HealthService(pool, redis, clock, logger, config.version, config.HEALTH_CACHE_SECONDS),
          inject: [PG_POOL, REDIS],
        },
        ConnectionCloser,
      ],
      exports: [APP_CONFIG, LOGGER, CLOCK, PG_POOL, REDIS, UnitOfWork],
    };
  }
}
