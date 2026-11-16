import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBranch, SYSTEM_PRINCIPAL } from '../../support/iam';
import { SQLSTATE } from '../../support/sql-state';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The journal rules the shared brief says the database enforces (FR-FIN-003, FR-FIN-004, FR-FIN-009, ADR-0003), each
 * attempted by raw SQL as hk_app, bypassing every TypeScript check, and refused by migration 0123 with a named error.
 */
let database: TestDatabase;
let app: pg.Pool;
let branchId: string;
let entryCounter = 0;

/** Ledger rules raised by FIN's triggers (migration 0123). */
const LEDGER_RULE = 'HK012';
const account = (code: string): string => `01900000-0000-7000-8100-00000000${code}`;
const period = (year: number, month: number): string => `01900000-0000-7000-8400-${String(year * 100 + month).padStart(12, '0')}`;

interface RawLine {
  readonly code: string;
  readonly side: string;
  readonly amount: number;
  readonly party?: string | null;
}

interface Refusal {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
}

async function refusalOf(promise: Promise<unknown>): Promise<Refusal | null> {
  return promise.then(
    () => null,
    (error: unknown) => ({ code: (error as { code?: string }).code, constraint: (error as { constraint?: string }).constraint }),
  );
}

async function party(kind: string, name: string): Promise<string> {
  const id = randomUUID();
  await app.query('INSERT INTO fin.subledger_party (id, kind, ref_id, display_name) VALUES ($1, $2, $3, $4)', [id, kind, randomUUID(), name]);
  return id;
}

/** One journal entry and its lines written in one transaction of its own, committed: the commit is what may fail. */
async function postRaw(lines: readonly RawLine[], options: { date?: string; periodId?: string } = {}): Promise<string> {
  const date = options.date ?? '2026-11-16';
  const [year, month] = date.split('-').map(Number) as [number, number];
  const id = randomUUID();
  entryCounter += 1;
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'JOURNAL', 'fin', $2, $3)", [id, branchId, SYSTEM_PRINCIPAL]);
    await client.query(
      `INSERT INTO fin.journal_entry (id, entry_no, posting_date, period_id, branch_id, kind, source_document_id, posting_group_id, description, occurred_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, 'MANUAL', $1, $6, 'Raw SQL test entry', now(), $7)`,
      [id, `RAW-${entryCounter}-${id.slice(0, 8)}`, date, options.periodId ?? period(year, month), branchId, randomUUID(), SYSTEM_PRINCIPAL],
    );
    let lineNo = 0;
    for (const line of lines) {
      lineNo += 1;
      await client.query(
        `INSERT INTO fin.journal_line (journal_entry_id, line_no, account_id, side, amount_pesewas, branch_id, subledger_party_id, posting_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, lineNo, account(line.code), line.side, line.amount, branchId, line.party ?? null, date],
      );
    }
    await client.query('COMMIT');
    return id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function entriesNamed(id: string): Promise<number> {
  const { rows } = await app.query<{ n: number }>('SELECT (SELECT count(*) FROM fin.journal_entry WHERE id = $1)::int + (SELECT count(*) FROM fin.journal_line WHERE journal_entry_id = $1)::int AS n', [id]);
  return rows[0]!.n;
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = database.pool('app');
  branchId = (await createBranch(database)).branchId;
});

afterAll(async () => {
  await database.drop();
});

describe('a journal must balance, enforced by the database (FR-FIN-003)', () => {
  it('commits an entry whose debits equal its credits, 10,000 each', async () => {
    const id = await postRaw([
      { code: '1310', side: 'D', amount: 10_000 },
      { code: '2010', side: 'C', amount: 10_000 },
    ]);
    expect(await entriesNamed(id)).toBe(3);
  });

  it('refuses at commit an entry with debits 10,000 and credits 9,999, as ck_journal_balanced, and leaves no rows', async () => {
    const before = await app.query<{ n: number }>('SELECT count(*)::int AS n FROM fin.journal_entry');
    expect(
      await refusalOf(
        postRaw([
          { code: '1310', side: 'D', amount: 10_000 },
          { code: '2010', side: 'C', amount: 9_999 },
        ]),
      ),
    ).toEqual({ code: LEDGER_RULE, constraint: 'ck_journal_balanced' });
    const after = await app.query<{ n: number }>('SELECT count(*)::int AS n FROM fin.journal_entry');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('refuses an entry of a single line, as ck_journal_lines', async () => {
    expect(await refusalOf(postRaw([{ code: '1310', side: 'D', amount: 10_000 }]))).toEqual({ code: LEDGER_RULE, constraint: 'ck_journal_lines' });
  });

  it('refuses an entry with no lines at all, as ck_journal_lines', async () => {
    expect(await refusalOf(postRaw([]))).toEqual({ code: LEDGER_RULE, constraint: 'ck_journal_lines' });
  });

  it('refuses a zero line even inside a balanced entry, by the amount check', async () => {
    expect(
      await refusalOf(
        postRaw([
          { code: '1310', side: 'D', amount: 10_000 },
          { code: '2010', side: 'C', amount: 10_000 },
          { code: '1320', side: 'D', amount: 0 },
        ]),
      ),
    ).toEqual({ code: SQLSTATE.checkViolation, constraint: 'ck_journal_line_amount' });
  });

  it('refuses a line that is both debit and credit, or neither, by the side check', async () => {
    for (const side of ['B', 'DC', 'X']) {
      expect(
        await refusalOf(
          postRaw([
            { code: '1310', side: 'D', amount: 10_000 },
            { code: '2010', side: 'C', amount: 10_000 },
            { code: '1320', side, amount: 500 },
          ]),
        ),
      ).toEqual({ code: side.length > 1 ? '22001' : SQLSTATE.checkViolation, constraint: side.length > 1 ? undefined : 'ck_journal_line_side' });
    }
  });

  it('refuses a balanced pair of lines added later to an entry another transaction wrote, as ck_journal_line_entry', async () => {
    const id = await postRaw([
      { code: '1310', side: 'D', amount: 1_000 },
      { code: '2010', side: 'C', amount: 1_000 },
    ]);
    const add = async () => {
      const client = await app.connect();
      try {
        await client.query('BEGIN');
        for (const [lineNo, side] of [
          [3, 'D'],
          [4, 'C'],
        ] as const) {
          await client.query(
            "INSERT INTO fin.journal_line (journal_entry_id, line_no, account_id, side, amount_pesewas, branch_id, posting_date) VALUES ($1, $2, $3, $4, 500, $5, '2026-11-16')",
            [id, lineNo, account('1320'), side, branchId],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    expect(await refusalOf(add())).toEqual({ code: LEDGER_RULE, constraint: 'ck_journal_line_entry' });
    expect(await entriesNamed(id)).toBe(3);
  });
});

describe('journals are insert-only (FR-FIN-004)', () => {
  it('refuses hk_app an update, a delete and a truncate of a posted entry or line', async () => {
    const id = await postRaw([
      { code: '1310', side: 'D', amount: 2_000 },
      { code: '2010', side: 'C', amount: 2_000 },
    ]);
    for (const sql of [
      'UPDATE fin.journal_line SET amount_pesewas = 1 WHERE journal_entry_id = $1',
      'DELETE FROM fin.journal_line WHERE journal_entry_id = $1',
      "UPDATE fin.journal_entry SET description = 'edited' WHERE id = $1",
      'DELETE FROM fin.journal_entry WHERE id = $1',
    ]) {
      expect((await refusalOf(app.query(sql, [id])))?.code).toBe(SQLSTATE.insufficientPrivilege);
    }
    expect((await refusalOf(app.query('TRUNCATE fin.journal_line')))?.code).toBe(SQLSTATE.insufficientPrivilege);
  });

  it('refuses even the owner an update, a delete or a truncate, because the trigger rejects it for every role', async () => {
    const id = await postRaw([
      { code: '1310', side: 'D', amount: 3_000 },
      { code: '2010', side: 'C', amount: 3_000 },
    ]);
    const admin = database.pool('admin');
    for (const sql of [
      "UPDATE fin.journal_line SET side = 'C' WHERE journal_entry_id = $1 AND line_no = 1",
      'DELETE FROM fin.journal_line WHERE journal_entry_id = $1',
      "UPDATE fin.journal_entry SET description = 'edited' WHERE id = $1",
      'DELETE FROM fin.journal_entry WHERE id = $1',
    ]) {
      expect((await refusalOf(admin.query(sql, [id])))?.code).toBe(SQLSTATE.ledgerImmutable);
    }
    expect((await refusalOf(admin.query('TRUNCATE fin.journal_line, fin.journal_entry CASCADE')))?.code).toBe(SQLSTATE.ledgerImmutable);
    expect(await entriesNamed(id)).toBe(3);
  });
});

describe('the subledger rule and postable accounts (FR-FIN-004, FR-FIN-002)', () => {
  it('refuses a 1200 line with no customer and a 4000 line with a customer, as ck_journal_line_subledger', async () => {
    expect(
      await refusalOf(
        postRaw([
          { code: '1200', side: 'D', amount: 5_000 },
          { code: '4000', side: 'C', amount: 5_000 },
        ]),
      ),
    ).toEqual({ code: LEDGER_RULE, constraint: 'ck_journal_line_subledger' });
    const customer = await party('CUSTOMER', 'Ama Mensah Chop Bar');
    expect(
      await refusalOf(
        postRaw([
          { code: '1200', side: 'D', amount: 5_000, party: customer },
          { code: '4000', side: 'C', amount: 5_000, party: customer },
        ]),
      ),
    ).toEqual({ code: LEDGER_RULE, constraint: 'ck_journal_line_subledger' });
  });

  it('refuses a party of the wrong kind on a control account, and accepts the right one', async () => {
    const supplier = await party('SUPPLIER', 'Awutu Poultry Farm');
    expect(
      await refusalOf(
        postRaw([
          { code: '1200', side: 'D', amount: 5_000, party: supplier },
          { code: '4000', side: 'C', amount: 5_000 },
        ]),
      ),
    ).toEqual({ code: LEDGER_RULE, constraint: 'ck_journal_line_subledger' });
    const id = await postRaw([
      { code: '2010', side: 'D', amount: 5_000 },
      { code: '2000', side: 'C', amount: 5_000, party: supplier },
    ]);
    expect(await entriesNamed(id)).toBe(3);
  });

  it('refuses a line on a header account and on a closed account, as ck_journal_line_account', async () => {
    const admin = database.pool('admin');
    await admin.query(
      `INSERT INTO fin.account (id, code, name, type, normal_side, is_postable, status, created_by, updated_by)
       VALUES ('01900000-0000-7000-8100-000000001999', '1999', 'Assets (header)', 'ASSET', 'D', false, 'ACTIVE', $1, $1)`,
      [SYSTEM_PRINCIPAL],
    );
    expect(
      await refusalOf(
        postRaw([
          { code: '1999', side: 'D', amount: 100 },
          { code: '2010', side: 'C', amount: 100 },
        ]),
      ),
    ).toEqual({ code: LEDGER_RULE, constraint: 'ck_journal_line_account' });
    await admin.query("UPDATE fin.account SET status = 'CLOSED', version = version + 1 WHERE code = '6400'");
    expect(
      await refusalOf(
        postRaw([
          { code: '6400', side: 'D', amount: 100 },
          { code: '1010', side: 'C', amount: 100 },
        ]),
      ),
    ).toEqual({ code: LEDGER_RULE, constraint: 'ck_journal_line_account' });
  });

  it('refuses to change the type of an account with lines, and to archive it, as ck_account_change', async () => {
    expect(await refusalOf(app.query("UPDATE fin.account SET type = 'LIABILITY', code = '2999', version = version + 1 WHERE code = '1310'"))).toEqual({
      code: LEDGER_RULE,
      constraint: 'ck_account_change',
    });
    expect(
      await refusalOf(app.query("UPDATE fin.account SET deleted_at = now(), deleted_by = $1, delete_reason = 'tidy', version = version + 1 WHERE code = '1310'", [SYSTEM_PRINCIPAL])),
    ).toEqual({ code: LEDGER_RULE, constraint: 'ck_account_change' });
  });
});

describe('nothing posts into a period that is not open (FR-FIN-009)', () => {
  it('refuses an entry dated in a LOCKED period and in a CLOSED period, as ck_journal_period_open', async () => {
    await app.query("UPDATE fin.accounting_period SET status = 'LOCKED', locked_at = now(), locked_by = $1, version = version + 1 WHERE id = $2", [SYSTEM_PRINCIPAL, period(2030, 11)]);
    await app.query("UPDATE fin.accounting_period SET status = 'CLOSED', closed_at = now(), closed_by = $1, version = version + 1 WHERE id = $2", [SYSTEM_PRINCIPAL, period(2030, 12)]);
    for (const date of ['2030-11-15', '2030-12-15']) {
      expect(
        await refusalOf(
          postRaw(
            [
              { code: '1310', side: 'D', amount: 10_000 },
              { code: '2010', side: 'C', amount: 10_000 },
            ],
            { date },
          ),
        ),
      ).toEqual({ code: LEDGER_RULE, constraint: 'ck_journal_period_open' });
    }
  });

  it('refuses an entry whose date is outside the period it names, as ck_journal_period', async () => {
    expect(
      await refusalOf(
        postRaw(
          [
            { code: '1310', side: 'D', amount: 10_000 },
            { code: '2010', side: 'C', amount: 10_000 },
          ],
          { date: '2026-11-16', periodId: period(2026, 10) },
        ),
      ),
    ).toEqual({ code: LEDGER_RULE, constraint: 'ck_journal_period' });
  });

  it('refuses any change to a CLOSED period and a change of dates to any period, as ck_period_change', async () => {
    expect(await refusalOf(app.query("UPDATE fin.accounting_period SET status = 'OPEN', closed_at = NULL, closed_by = NULL, version = version + 1 WHERE id = $1", [period(2030, 12)]))).toEqual({
      code: LEDGER_RULE,
      constraint: 'ck_period_change',
    });
    expect(await refusalOf(app.query("UPDATE fin.accounting_period SET end_date = '2026-11-29', version = version + 1 WHERE id = $1", [period(2026, 11)]))).toEqual({
      code: LEDGER_RULE,
      constraint: 'ck_period_change',
    });
  });

  it('refuses a period that overlaps another', async () => {
    expect(
      (
        await refusalOf(
          app.query(
            "INSERT INTO fin.accounting_period (id, fiscal_year, period_no, start_date, end_date, status, created_by, updated_by) VALUES ($1, 2031, 1, '2030-12-20', '2031-01-31', 'FUTURE', $2, $2)",
            [randomUUID(), SYSTEM_PRINCIPAL],
          ),
        )
      )?.constraint,
    ).toBe('ex_accounting_period_no_overlap');
  });
});
