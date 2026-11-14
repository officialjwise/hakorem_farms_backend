import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../../../src/platform/database/database-pool';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe('the database pool', () => {
  it('survives PostgreSQL dropping an idle connection: it logs the loss and serves the next query', async () => {
    const lines: string[] = [];
    const logger = pino({ level: 'warn' }, { write: (line: string) => lines.push(line) });
    const pool = createPool({ connectionString: database.url('app'), applicationName: 'hakorem-pool-probe', max: 2, statementTimeoutMs: 5_000 }, logger);
    try {
      await pool.query('SELECT 1');
      // As a database restart or an administrator would: end every idle connection of this pool from the server.
      await database
        .pool('admin')
        .query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'hakorem-pool-probe' AND pid <> pg_backend_pid()");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(lines.some((line) => line.includes('idle database connection lost'))).toBe(true);
      const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
      expect(rows[0]!.ok).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
