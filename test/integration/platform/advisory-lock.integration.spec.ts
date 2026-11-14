import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Assumption A-060 and ADR-0005: in PostgreSQL 17, a session-level advisory lock taken before BEGIN makes a second
 * serializable transaction wait and then succeed, whereas pg_advisory_xact_lock as the first statement inside the
 * transaction does not, because that statement takes the snapshot before it blocks.
 *
 * Two real sessions as hk_app contend for one row, as two sales on one register would contend for a number series.
 */
const POLL_INTERVAL_MS = 20;
const WAIT_LIMIT_MS = 10_000;

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  const admin = database.pool('admin');
  await admin.query('CREATE SCHEMA lock_probe AUTHORIZATION hk_owner');
  await admin.query('CREATE TABLE lock_probe.series (id integer PRIMARY KEY, next_value integer NOT NULL)');
  await admin.query('GRANT USAGE ON SCHEMA lock_probe TO hk_app');
  await admin.query('GRANT SELECT, UPDATE ON lock_probe.series TO hk_app');
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.pool('admin').query('TRUNCATE lock_probe.series');
  await database.pool('admin').query('INSERT INTO lock_probe.series (id, next_value) VALUES (1, 1)');
});

async function session(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: database.url('app') });
  await client.connect();
  return client;
}

async function pid(client: pg.Client): Promise<number> {
  return (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
}

/** Waits until the backend is blocked on an advisory lock, observed in pg_stat_activity rather than by sleeping. */
async function waitUntilBlockedOnAdvisoryLock(backendPid: number): Promise<void> {
  const observer = database.pool('admin');
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ wait_event: string | null }>(
      'SELECT wait_event FROM pg_stat_activity WHERE pid = $1',
      [backendPid],
    );
    if (rows[0]?.wait_event === 'advisory') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`backend ${backendPid} never blocked on the advisory lock`);
}

async function nextValue(client: pg.Client): Promise<number> {
  return (await client.query<{ next_value: number }>('SELECT next_value FROM lock_probe.series WHERE id = 1')).rows[0]!.next_value;
}

describe('advisory locks and serializable transactions (A-060)', () => {
  it('a session-level advisory lock taken before BEGIN makes the second serializable transaction wait and then succeed', async () => {
    const first = await session();
    const second = await session();
    try {
      await first.query("SELECT pg_advisory_lock(hashtextextended('series:receipt:2027:DODOWA:R1', 0))");
      await first.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await first.query('UPDATE lock_probe.series SET next_value = next_value + 1 WHERE id = 1');

      const secondPid = await pid(second);
      const secondLock = second.query("SELECT pg_advisory_lock(hashtextextended('series:receipt:2027:DODOWA:R1', 0))");
      await waitUntilBlockedOnAdvisoryLock(secondPid);

      await first.query('COMMIT');
      await first.query("SELECT pg_advisory_unlock(hashtextextended('series:receipt:2027:DODOWA:R1', 0))");
      await secondLock;

      // The second transaction begins after the first committed, so its snapshot sees the new value.
      await second.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await second.query('UPDATE lock_probe.series SET next_value = next_value + 1 WHERE id = 1');
      await second.query('COMMIT');
      await second.query("SELECT pg_advisory_unlock(hashtextextended('series:receipt:2027:DODOWA:R1', 0))");

      // Both allocations landed: 1 -> 2 -> 3, no serialization failure.
      expect(await nextValue(first)).toBe(3);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });

  it('pg_advisory_xact_lock as the first statement inside the transaction does not, because the snapshot is taken before it blocks', async () => {
    const first = await session();
    const second = await session();
    try {
      await first.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await first.query("SELECT pg_advisory_xact_lock(hashtextextended('series:receipt:2027:DODOWA:R1', 0))");
      await first.query('UPDATE lock_probe.series SET next_value = next_value + 1 WHERE id = 1');

      await second.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const secondPid = await pid(second);
      // This SELECT is the transaction's first statement: it takes the snapshot, then waits for the lock.
      const secondLock = second.query("SELECT pg_advisory_xact_lock(hashtextextended('series:receipt:2027:DODOWA:R1', 0))");
      await waitUntilBlockedOnAdvisoryLock(secondPid);

      await first.query('COMMIT');
      await secondLock;

      // The snapshot predates the first commit, so updating the row the first changed is a serialization failure.
      const failure = await second
        .query('UPDATE lock_probe.series SET next_value = next_value + 1 WHERE id = 1')
        .then(() => undefined, (error: unknown) => error as { code?: string });
      expect(failure?.code).toBe('40001');
      await second.query('ROLLBACK');

      // Only the first allocation landed.
      expect(await nextValue(first)).toBe(2);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });
});
