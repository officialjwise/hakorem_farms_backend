import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import type { Clock } from '@hakorem/kernel';
import type { DynamicModule, INestApplication, Type } from '@nestjs/common';
import type { Server } from 'node:http';
import type { Logger } from 'pino';
import { inject } from 'vitest';
import { createApp } from '../../src/create-app';
import { loadConfig } from '../../src/platform/config/app-config';
import { createLogger } from '../../src/platform/logging/logger';
import type { TestDatabase } from './test-database';

export interface TestApp {
  readonly app: INestApplication;
  readonly server: Server;
  readonly logger: Logger;
  /** Every JSON log line the application wrote, parsed. */
  logLines(): Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  readonly clock?: Clock;
  readonly imports?: ReadonlyArray<DynamicModule | Type>;
  readonly environment?: Readonly<Record<string, string>>;
}

/** The browser origin the tests call from; on the CORS allow-list of every test app. */
export const TEST_ORIGIN = 'http://localhost:5173';

/**
 * Secrets generated once per test process: never fixed in the repository (SEC-034). The signing key is Ed25519 as in
 * production; Argon2 runs at its minimum accepted cost so the suite stays fast.
 */
const signingKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
export const TEST_SECRETS: Readonly<Record<string, string>> = {
  LOOKUP_HMAC_KEY: randomBytes(32).toString('base64'),
  KEK_ACTIVE_VERSION: '1',
  KEK_V1: randomBytes(32).toString('base64'),
  JWT_ACTIVE_KEY_ID: 'test-1',
  JWT_SIGNING_KEYS: JSON.stringify({ 'test-1': signingKey }),
  CORS_ALLOWED_ORIGINS: `${TEST_ORIGIN},http://localhost:3001`,
  HIBP_ENABLED: 'false',
  ARGON2_MEMORY_KIB: '19456',
  ARGON2_ITERATIONS: '2',
};

/** The real application, built by the same `createApp` production uses, against the test file's database. */
export async function startTestApp(database: TestDatabase, options: TestAppOptions = {}): Promise<TestApp> {
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      APP_ENV: 'test',
      DATABASE_URL_APP: database.url('app'),
      REDIS_URL: inject('redisUrl'),
      LOG_LEVEL: 'info',
      HEALTH_CACHE_SECONDS: '0',
      ...TEST_SECRETS,
      REDIS_KEY_PREFIX: `t${randomBytes(4).toString('hex')}:`,
      ...options.environment,
    },
    '0.1.0',
  );
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(...chunk.toString('utf8').split('\n').filter((line) => line.length > 0));
      callback();
    },
  });
  const logger = createLogger({ level: 'info', service: 'hakorem-api-test', version: config.version }, sink);
  const app = await createApp(config, logger, { clock: options.clock, imports: options.imports });
  await app.init();
  return {
    app,
    server: app.getHttpServer() as Server,
    logger,
    logLines: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    close: () => app.close(),
  };
}
