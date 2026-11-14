import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSerializable,
  IsolationLevelError,
  NestedTransactionError,
  NoUnitOfWorkError,
  SerializationRetriesExhaustedError,
  SERIALIZATION_RETRY_LIMIT,
  UnitOfWork,
} from '../../../src/platform/database/unit-of-work';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

let database: TestDatabase;
let uow: UnitOfWork;
const noWait = () => Promise.resolve();

beforeAll(async () => {
  database = await createTestDatabase();
  const admin = database.pool('admin');
  await admin.query(`
    CREATE SCHEMA uow_probe AUTHORIZATION hk_owner;
    GRANT USAGE ON SCHEMA uow_probe TO hk_app;
    CREATE TABLE uow_probe.on_call (vet text PRIMARY KEY, on_duty boolean NOT NULL);
    GRANT SELECT, INSERT, UPDATE, DELETE ON uow_probe.on_call TO hk_app;
    CREATE TABLE uow_probe.note (id serial PRIMARY KEY, body text NOT NULL);
    GRANT SELECT, INSERT ON uow_probe.note TO hk_app;
    GRANT USAGE ON SEQUENCE uow_probe.note_id_seq TO hk_app;`);
  uow = new UnitOfWork(database.pool('app'), pino({ level: 'silent' }), noWait);
});

afterAll(async () => {
  await database.drop();
});

/** Raises a genuine SQLSTATE from PostgreSQL itself, not a fake error object. */
const raise = (sqlState: string) => `DO $$ BEGIN RAISE EXCEPTION 'probe' USING ERRCODE = '${sqlState}'; END $$`;

describe('the unit of work (ADR-0005)', () => {
  it('the unit of work retries 40001 and 40P01 and gives up after five attempts with a typed error', async () => {
    // Two serialization failures, then success: three attempts.
    let serializationAttempts = 0;
    const afterSerialization = await uow.run({ isolation: 'serializable' }, async (tx) => {
      serializationAttempts += 1;
      if (serializationAttempts <= 2) {
        await tx.query(raise('40001'));
      }
      return tx.attempt;
    });
    expect(afterSerialization).toBe(3);
    expect(serializationAttempts).toBe(3);

    // A deadlock is retried the same way.
    let deadlockAttempts = 0;
    await uow.run({ isolation: 'serializable' }, async (tx) => {
      deadlockAttempts += 1;
      if (deadlockAttempts === 1) {
        await tx.query(raise('40P01'));
      }
    });
    expect(deadlockAttempts).toBe(2);

    // Always failing: exactly five attempts, then the typed error carrying the SQLSTATE.
    let hopelessAttempts = 0;
    const failure = await uow
      .run({ isolation: 'serializable' }, async (tx) => {
        hopelessAttempts += 1;
        await tx.query(raise('40001'));
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SerializationRetriesExhaustedError);
    expect((failure as SerializationRetriesExhaustedError).attempts).toBe(SERIALIZATION_RETRY_LIMIT);
    expect((failure as SerializationRetriesExhaustedError).sqlState).toBe('40001');
    expect((failure as SerializationRetriesExhaustedError).code).toBe('SERIALIZATION_RETRIES_EXHAUSTED');
    expect(hopelessAttempts).toBe(5);
  });

  it('re-runs the whole command on a real write-skew conflict, so the retry sees the committed state', async () => {
    // Two vets on duty; each command lets its vet go off duty only if someone else stays on. Run concurrently at
    // serializable, both read "two on duty", both write: PostgreSQL aborts one with 40001. Its retry re-reads,
    // sees only one vet left, and refuses. Exactly one vet goes off duty.
    const admin = database.pool('admin');
    await admin.query("INSERT INTO uow_probe.on_call (vet, on_duty) VALUES ('Yaw Darko', true), ('Akosua Ofori', true)");
    let release!: () => void;
    const bothHaveRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    let readers = 0;
    const attempts: Record<string, number> = {};
    const goOffDuty = (vet: string) =>
      uow.run({ isolation: 'serializable' }, async (tx) => {
        attempts[vet] = (attempts[vet] ?? 0) + 1;
        const { rows } = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM uow_probe.on_call WHERE on_duty');
        if (tx.attempt === 1) {
          readers += 1;
          if (readers === 2) {
            release();
          }
          await bothHaveRead;
        }
        if (rows[0]!.n < 2) {
          return 'REFUSED';
        }
        await tx.query('UPDATE uow_probe.on_call SET on_duty = false WHERE vet = $1', [vet]);
        return 'OFF_DUTY';
      });

    const outcomes = await Promise.all([goOffDuty('Yaw Darko'), goOffDuty('Akosua Ofori')]);
    expect([...outcomes].sort()).toEqual(['OFF_DUTY', 'REFUSED']);
    expect(Object.values(attempts).sort()).toEqual([1, 2]);
    const { rows } = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM uow_probe.on_call WHERE on_duty');
    expect(rows[0]!.n).toBe(1);
  });

  it('holds each declared series lock for the transaction and releases it afterwards', async () => {
    const observer = database.pool('admin');
    const countAdvisoryLocks = async () =>
      (
        await observer.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
        )
      ).rows[0]!.n;

    const during = await uow.run(
      { isolation: 'serializable', seriesLocks: ['series:invoice:2027:DODOWA', 'series:receipt:2027:DODOWA:R1', 'series:invoice:2027:DODOWA'] },
      async () => countAdvisoryLocks(),
    );
    expect(during).toBe(2);
    expect(await countAdvisoryLocks()).toBe(0);
  });

  it('rolls back everything when the work fails for another reason, and rethrows that error unchanged', async () => {
    const original = new Error('price did not resolve');
    const failure = await uow
      .run({ isolation: 'read committed' }, async (tx) => {
        await tx.query("INSERT INTO uow_probe.note (body) VALUES ('should not survive')");
        throw original;
      })
      .catch((error: unknown) => error);
    expect(failure).toBe(original);
    const { rows } = await database.pool('admin').query<{ n: number }>('SELECT count(*)::int AS n FROM uow_probe.note');
    expect(rows[0]!.n).toBe(0);
  });

  it('commits the work and exposes the transaction as ambient context', async () => {
    await uow.run({ isolation: 'read committed' }, async () => {
      await uow.current().query("INSERT INTO uow_probe.note (body) VALUES ('Goat G-0142 weighed 31.250 kg')");
    });
    const { rows } = await database.pool('admin').query<{ body: string }>('SELECT body FROM uow_probe.note');
    expect(rows.map((row) => row.body)).toEqual(['Goat G-0142 weighed 31.250 kg']);
  });

  it('refuses to open a transaction inside another', async () => {
    const failure = await uow
      .run({ isolation: 'read committed' }, () => uow.run({ isolation: 'read committed' }, () => Promise.resolve()))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NestedTransactionError);
  });

  it('has no ambient transaction outside a unit of work', () => {
    expect(() => uow.current()).toThrow(NoUnitOfWorkError);
  });

  it('lets a stock or ledger entry point refuse anything below serializable', async () => {
    await uow.run({ isolation: 'serializable' }, (tx) => assertSerializable(tx));
    const failure = await uow.run({ isolation: 'read committed' }, (tx) => assertSerializable(tx)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IsolationLevelError);
    expect((failure as IsolationLevelError).actual).toBe('read committed');
  });
});
