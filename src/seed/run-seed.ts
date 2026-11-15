import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';
import type { SeedUnit } from './seed-unit';

/**
 * Runs the seed units in order: a SQL unit in one transaction of its own on `pool`, a service unit against `app`,
 * whose services open their own transactions. Used by `pnpm db:seed` and by the tests that load the seeded farm.
 */
export async function runSeedUnits(pool: pg.Pool, app: INestApplicationContext, units: readonly SeedUnit[]): Promise<number> {
  let records = 0;
  for (const unit of units) {
    try {
      records += unit.kind === 'SQL' ? await runSqlUnit(pool, unit.run.bind(unit)) : (await unit.run(app)).records;
    } catch (error) {
      throw new Error(`seed unit ${unit.name} failed`, { cause: error });
    }
  }
  return records;
}

async function runSqlUnit(pool: pg.Pool, run: (client: pg.PoolClient) => Promise<{ readonly records: number }>): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { records } = await run(client);
    await client.query('COMMIT');
    return records;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
