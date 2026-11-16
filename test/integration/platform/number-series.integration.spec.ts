import { randomUUID } from 'node:crypto';
import pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { NumberSeries } from '../../../src/platform/documents/number-series';
import { createBranch, SYSTEM_PRINCIPAL } from '../../support/iam';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Gap-free numbering under concurrent load (ADR-0015, ADR-0005, the B8 gate): many transactions allocate from one
 * series at once, some of them roll back after taking a number, and the series that remains is exactly 1 to n, each
 * number once, each committed document with its own number. The allocation is `platform.allocate_number`, inside the
 * caller's transaction (migration 0122).
 */
const CONCURRENT_SESSIONS = 40;
const ALLOCATIONS = 120;
const ROLLBACK_EVERY = 3;
const SERIALIZABLE_COMMANDS = 30;

let database: TestDatabase;
let branch: { branchId: string; code: string };
const numbers = new NumberSeries();

class RolledBack extends Error {}

async function registerDocument(client: pg.ClientBase): Promise<string> {
  const id = randomUUID();
  await client.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'JOURNAL', 'fin', $2, $3)", [id, branch.branchId, SYSTEM_PRINCIPAL]);
  return id;
}

async function allocations(fiscalYear: number): Promise<{ value: number; formatted: string; document_id: string }[]> {
  const { rows } = await database.pool('app').query<{ value: string; formatted: string; document_id: string }>(
    `SELECT a.value, a.formatted, a.document_id FROM platform.number_allocation a JOIN platform.number_series s ON s.id = a.series_id
      WHERE s.doc_type = 'JOURNAL' AND s.fiscal_year = $1 AND s.branch_id = $2 ORDER BY a.value`,
    [fiscalYear, branch.branchId],
  );
  return rows.map((r) => ({ value: Number(r.value), formatted: r.formatted, document_id: r.document_id }));
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

beforeAll(async () => {
  database = await createTestDatabase();
  branch = await createBranch(database);
});

afterAll(async () => {
  await database.drop();
});

describe('gap-free numbering under concurrent load (ADR-0015)', () => {
  it('leaves a contiguous series with no duplicate after 120 allocations from 40 sessions at once, a third of them rolled back', async () => {
    const sessions = await Promise.all(
      range(CONCURRENT_SESSIONS).map(async () => {
        const client = new pg.Client({ connectionString: database.url('app') });
        await client.connect();
        return client;
      }),
    );
    const committed: string[] = [];
    try {
      const work = range(ALLOCATIONS);
      await Promise.all(
        sessions.map(async (client) => {
          for (let task = work.shift(); task !== undefined; task = work.shift()) {
            await client.query('BEGIN');
            const documentId = await registerDocument(client);
            const tx = { isolation: 'read committed' as const, attempt: 1, query: client.query.bind(client) } as unknown as Parameters<NumberSeries['allocateIn']>[0];
            const formatted = await numbers.allocateIn(tx, { docType: 'JOURNAL', fiscalYear: 2027, branchId: branch.branchId, branchCode: branch.code, documentId });
            expect(formatted).toMatch(/^JNL-2027-DDW-\d{6}$/);
            if (task % ROLLBACK_EVERY === 0) {
              await client.query('ROLLBACK');
            } else {
              await client.query('COMMIT');
              committed.push(documentId);
            }
          }
        }),
      );
    } finally {
      await Promise.all(sessions.map((s) => s.end()));
    }
    const rows = await allocations(2027);
    const expected = ALLOCATIONS - ALLOCATIONS / ROLLBACK_EVERY;
    expect(rows.map((r) => r.value)).toEqual(range(expected));
    expect(new Set(rows.map((r) => r.formatted)).size).toBe(expected);
    expect(rows.map((r) => r.document_id).sort()).toEqual([...committed].sort());
    expect(rows[0]!.formatted).toBe('JNL-2027-DDW-000001');
    expect(await numbers.gapsIn(transactionOn(database.pool('app')))).toEqual([]);
  });

  it('leaves a contiguous series when 30 serializable commands declaring the series allocate at once and every fifth fails after', async () => {
    const uow = new UnitOfWork(database.pool('app'), pino({ level: 'silent' }));
    const results = await Promise.allSettled(
      range(SERIALIZABLE_COMMANDS).map((task) =>
        uow.run({ isolation: 'serializable', seriesLocks: [`JOURNAL:2028:${branch.branchId}`] }, async (tx) => {
          const documentId = randomUUID();
          await tx.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'JOURNAL', 'fin', $2, $3)", [documentId, branch.branchId, SYSTEM_PRINCIPAL]);
          const formatted = await numbers.allocateIn(tx, { docType: 'JOURNAL', fiscalYear: 2028, branchId: branch.branchId, branchCode: branch.code, documentId });
          if (task % 5 === 0) {
            throw new RolledBack(formatted);
          }
          return formatted;
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason)).toEqual(range(SERIALIZABLE_COMMANDS / 5).map(() => expect.any(RolledBack)));
    const rows = await allocations(2028);
    expect(rows.map((r) => r.value)).toEqual(range(SERIALIZABLE_COMMANDS - SERIALIZABLE_COMMANDS / 5));
    expect(results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<string>).value).sort()).toEqual(rows.map((r) => r.formatted));
  });

  it('refuses hk_app writing a number or moving a series by hand', async () => {
    const app = database.pool('app');
    const { rows } = await app.query<{ id: string }>("SELECT id FROM platform.number_series WHERE doc_type = 'JOURNAL' AND fiscal_year = 2027");
    const documentId = await registerDocument(app as unknown as pg.ClientBase);
    await expect(app.query("INSERT INTO platform.number_allocation (series_id, value, document_id, formatted) VALUES ($1, 999, $2, 'JNL-2027-DDW-000999')", [rows[0]!.id, documentId])).rejects.toMatchObject({
      code: 'HK011',
      constraint: 'ck_number_allocation_writer',
    });
    await expect(app.query('UPDATE platform.number_series SET next_value = 1 WHERE id = $1', [rows[0]!.id])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query("SELECT platform.open_number_series('CHECKOUT_SESSION', 2027, $1, 'DDW', '')", [branch.branchId])).rejects.toMatchObject({
      code: 'HK011',
      constraint: 'ck_number_series_unknown',
    });
  });

  it('starts each fiscal year at 1 and never truncates a number longer than its padding', async () => {
    const admin = database.pool('admin');
    const app = database.pool('app');
    const documentId = await registerDocument(app as unknown as pg.ClientBase);
    const tx = transactionOn(app);
    const series = await app.query<{ id: string }>("SELECT platform.open_number_series('JOURNAL', 2029, $1, 'DDW', '') AS id", [branch.branchId]);
    await admin.query('UPDATE platform.number_series SET next_value = 1234567 WHERE id = $1', [series.rows[0]!.id]);
    expect(await numbers.allocateIn(tx, { docType: 'JOURNAL', fiscalYear: 2029, branchId: branch.branchId, branchCode: branch.code, documentId })).toBe('JNL-2029-DDW-1234567');
    const gaps = await numbers.gapsIn(tx);
    expect(gaps.map((g) => [g.fiscalYear, g.issued, g.allocations, g.maxValue])).toEqual([[2029, 1234567, 1, 1234567]]);
  });
});

function transactionOn(pool: pg.Pool): Parameters<NumberSeries['allocateIn']>[0] {
  return { isolation: 'read committed', attempt: 1, query: pool.query.bind(pool) } as unknown as Parameters<NumberSeries['allocateIn']>[0];
}
