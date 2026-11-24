import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import { z } from 'zod';
import { AppModule } from '../app.module';
import { loadConfig, parseEnvironment, postgresUrl } from '../platform/config/app-config';
import { createLogger } from '../platform/logging/logger';
import { NestPinoLogger } from '../platform/logging/nest-logger';
import { runSeedUnits } from '../seed/run-seed';
import { seedUnits } from '../seed/seed-units';
import { runCli } from './run-cli';

const SEEDABLE_DATABASES: ReadonlySet<string> = new Set(['development', 'test', 'staging']);

const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']),
  SEED_ALLOWED: z.enum(['true', 'false']).default('false'),
  DATABASE_URL_APP: postgresUrl,
  SEED_STAFF_PASSWORD: z.string().min(12).optional(),
});

export class SeedRefusedError extends Error {
  constructor(reason: string) {
    super(`refused: ${reason}`);
    this.name = 'SeedRefusedError';
  }
}

/**
 * `pnpm db:seed`: loads the seeded farm. Refuses production three ways, so a wrong environment variable alone
 * cannot seed a live database: APP_ENV, SEED_ALLOWED, and the environment the database itself was marked with.
 * Only then does it start the application's module graph (no HTTP) on the real clock, so the service units write
 * through the same services the API runs, at the time they run: a seeded version asked to start at the seed instant
 * starts at its approval instead (ADR-0036, ADR-0039), as a late approval in production would.
 */
runCli('db:seed', async () => {
  const env = parseEnvironment(schema, process.env);
  if (env.APP_ENV === 'production') {
    throw new SeedRefusedError('APP_ENV is production');
  }
  if (env.SEED_ALLOWED !== 'true') {
    throw new SeedRefusedError('SEED_ALLOWED is not true');
  }
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL_APP, application_name: 'hakorem-seed', max: 1 });
  try {
    const marker = await pool.query<{ environment: string | null }>("SELECT current_setting('hk.environment', true) AS environment");
    const databaseEnvironment = marker.rows[0]?.environment ?? null;
    if (databaseEnvironment === null || !SEEDABLE_DATABASES.has(databaseEnvironment)) {
      throw new SeedRefusedError(`the database is marked ${databaseEnvironment ?? 'with no environment'}`);
    }
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    const config = loadConfig(process.env, manifest.version);
    const logger = createLogger({ level: 'warn', service: 'hakorem-seed', version: config.version });
    const app = await NestFactory.createApplicationContext(AppModule.forRoot(config, logger), {
      logger: new NestPinoLogger(logger),
      abortOnError: false,
    });
    try {
      const units = seedUnits(env, { tradingDay: true, investors: true });
      const records = await runSeedUnits(pool, app, units);
      process.stdout.write(`db:seed: database marked ${databaseEnvironment}; ran ${units.length} seed units, ${records} records\n`);
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
  }
});
