import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node' with { 'resolution-mode': 'import' };
import { bootstrapDatabase, type RoleCredentials } from '../../src/platform/database/database-bootstrap';
import { migrate } from '../../src/platform/database/migration-runner';
import { roleUrl, TEMPLATE_DATABASE, type ProvidedDatabase } from './database-settings';

/** The same images docker-compose.yml runs, so tests see the production engine versions. */
const POSTGRES_IMAGE = 'postgres:17.6-alpine';
const REDIS_IMAGE = 'redis:7.4.6-alpine';

function secret(): string {
  return randomBytes(18).toString('hex');
}

/**
 * Starts one PostgreSQL 17 and one Redis 7 container for the run, creates the roles, and applies every migration
 * once into a template database. Each test file then clones its own database from the template
 * (docs/TEST_STRATEGY.md section 3.2). Credentials are generated per run.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const adminPassword = secret();
  const [postgres, redis]: [StartedPostgreSqlContainer, StartedRedisContainer] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE)
      .withUsername('postgres')
      .withPassword(adminPassword)
      .withDatabase(TEMPLATE_DATABASE)
      .withCommand(['postgres', '-c', 'timezone=UTC', '-c', 'max_connections=300'])
      .start(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);
  const passwords: RoleCredentials = {
    migrator: secret(),
    app: secret(),
    worker: secret(),
    sealer: secret(),
    report: secret(),
    backup: secret(),
  };
  const database: ProvidedDatabase = {
    host: postgres.getHost(),
    port: postgres.getPort(),
    adminPassword,
    passwords,
  };
  await bootstrapDatabase({
    adminUrl: roleUrl(database, 'admin', 'postgres'),
    database: TEMPLATE_DATABASE,
    environment: 'test',
    passwords,
    reportStatementTimeoutMs: 30_000,
  });
  await migrate(roleUrl(database, 'migrator', TEMPLATE_DATABASE), resolve(__dirname, '../../migrations'));

  project.provide('database', database);
  project.provide('redisUrl', `redis://${redis.getHost()}:${redis.getPort()}/0`);

  return async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  };
}
