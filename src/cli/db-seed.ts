import pg from 'pg';
import { z } from 'zod';
import { parseEnvironment, postgresUrl } from '../platform/config/app-config';
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
    let records = 0;
    const units = seedUnits(env);
    for (const unit of units) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        records += (await unit.run(client)).records;
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`seed unit ${unit.name} failed`, { cause: error });
      } finally {
        client.release();
      }
    }
    process.stdout.write(
      `db:seed: database marked ${databaseEnvironment}; ran ${units.length} seed units, ${records} records\n`,
    );
  } finally {
    await pool.end();
  }
});
