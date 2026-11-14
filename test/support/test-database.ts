import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { roleUrl, TEMPLATE_DATABASE, type DatabaseRole } from './database-settings';

const LOGIN_ROLES = 'hk_migrator, hk_app, hk_worker, hk_sealer, hk_report, hk_backup';

/** A database of the test file's own, cloned from the migrated template. */
export interface TestDatabase {
  readonly name: string;
  url(role: DatabaseRole): string;
  /** A pool connected as the role, closed by `drop()`. */
  pool(role: DatabaseRole): pg.Pool;
  drop(): Promise<void>;
}

async function asAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: roleUrl(inject('database'), 'admin', 'postgres') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Clones the template into a fresh database with the same grants as a bootstrapped one. Tests never clean up by
 * truncating: LEDGER tables reject TRUNCATE for every role, so isolation is one database per file.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const settings = inject('database');
  const name = `test_${randomBytes(6).toString('hex')}`;
  await asAdmin(async (client) => {
    await client.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE} OWNER hk_owner`);
    await client.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${name} TO ${LOGIN_ROLES}`);
    await client.query(`ALTER DATABASE ${name} SET hk.environment = 'test'`);
  });
  const pools = new Map<DatabaseRole, pg.Pool>();
  return {
    name,
    url: (role) => roleUrl(settings, role, name),
    pool(role) {
      let pool = pools.get(role);
      if (pool === undefined) {
        pool = new pg.Pool({ connectionString: roleUrl(settings, role, name), max: 10 });
        // Dropping the database WITH (FORCE) terminates connections still closing (57P01): expected at teardown. Any
        // other error on an idle connection is a real failure and is rethrown so the run reports it.
        pool.on('error', (error: Error & { code?: string }) => {
          if (error.code !== '57P01') {
            setImmediate(() => {
              throw error;
            });
          }
        });
        pools.set(role, pool);
      }
      return pool;
    },
    async drop() {
      await Promise.all([...pools.values()].map((pool) => pool.end()));
      await asAdmin((client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}
