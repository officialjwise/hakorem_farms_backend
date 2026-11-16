import { randomUUID } from 'node:crypto';
import { toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FinancialStatements, LedgerReconciliation, STOCK_POSTING_EVENTS } from '../../../src/modules/fin';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { SYSTEM_PRINCIPAL } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The B8 gate's first item (FR-FIN-011, FR-FIN-016, ADR-0003): on the seeded trading day, loaded through the services
 * so that every seeded movement and purchase posted its own journal through FIN's handlers (no journal is written by
 * hand), the trial balance sums to exactly zero pesewas, read straight from `fin.journal_line`; and the nightly
 * reconciliation finds no break between the stock subledger and the inventory control accounts.
 */
let database: TestDatabase;
let api: TestApp;

/** A posting event whose outbox message carries a value, with the journal entry it posted (null if none). */
interface PostedEvent {
  readonly id: string;
  readonly event_type: string;
  readonly value: string;
  readonly entry_id: string | null;
}

beforeAll(async () => {
  database = await createTestDatabase();
  api = await startTestApp(database);
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

async function postingEvents(): Promise<PostedEvent[]> {
  const { rows } = await database.pool('app').query<PostedEvent>(
    `SELECT m.id, m.event_type,
            COALESCE(m.payload->>'valuePesewas', m.payload->>'grossPesewas', m.payload->>'amountPesewas', m.payload->>'directCostPesewas') AS value,
            e.id AS entry_id
       FROM platform.outbox_message m
       JOIN fin.posting_event_type t ON t.code = m.event_type
       LEFT JOIN fin.journal_entry e ON e.event_id = m.id
      ORDER BY m.recorded_at, m.id`,
  );
  return rows;
}

describe('the seeded trading day posts a journal for every financial event (ADR-0003, A-186)', () => {
  it('has a journal entry for every seeded posting event that carries a value, and none for a zero-value one', async () => {
    const events = await postingEvents();
    expect(events.length).toBeGreaterThan(10);
    expect(events.filter((e) => BigInt(e.value) > 0n && e.entry_id === null)).toEqual([]);
    expect(events.filter((e) => BigInt(e.value) === 0n && e.entry_id !== null)).toEqual([]);
    expect(new Set(events.map((e) => e.event_type))).toEqual(new Set(['inv.GoodsReceived', 'inv.ProductionReceived', 'pur.ExpenseInvoiceApproved', 'pur.SupplierCreditNoteApproved']));
  });

  it('has one entry per seeded stock movement that posts, carrying the movement as its subject', async () => {
    const { rows } = await database.pool('app').query<{ movement_type: string; value: string; entries: number }>(
      `SELECT m.movement_type, m.value_pesewas AS value, (SELECT count(*)::int FROM fin.journal_entry e WHERE e.event_subject_id = m.id) AS entries
         FROM inv.stock_movement m JOIN inv.movement_type t ON t.code = m.movement_type
        WHERE t.posting_event = ANY($1::text[])`,
      [[...STOCK_POSTING_EVENTS]],
    );
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.filter((r) => r.entries !== (BigInt(r.value) > 0n ? 1 : 0))).toEqual([]);
  });
});

describe('the trial balance sums to zero on the seeded trading day (the B8 gate, FR-FIN-011)', () => {
  it('has total debits equal to total credits and a signed sum of exactly 0 pesewas, summed from the journal lines', async () => {
    const { rows } = await database.pool('app').query<{ debits: string; credits: string; signed: string; lines: number }>(
      `SELECT COALESCE(sum(amount_pesewas) FILTER (WHERE side = 'D'), 0) AS debits, COALESCE(sum(amount_pesewas) FILTER (WHERE side = 'C'), 0) AS credits,
              COALESCE(sum(CASE side WHEN 'D' THEN amount_pesewas ELSE -amount_pesewas END), 0) AS signed, count(*)::int AS lines
         FROM fin.journal_line`,
    );
    const totals = rows[0]!;
    // Independently of the ledger: each posted stock movement debits its value once, each purchase document its gross.
    const events = await postingEvents();
    const expected = events.filter((e) => e.entry_id !== null).reduce((sum, e) => sum + BigInt(e.value), 0n);
    expect(totals.lines).toBeGreaterThan(20);
    expect(BigInt(totals.debits)).toBe(expected);
    expect(BigInt(totals.credits)).toBe(expected);
    expect(BigInt(totals.signed)).toBe(0n);
  });

  it('answers the same from FinancialStatements for the seeded range, each account equal to the sum of its lines', async () => {
    const today = toBusinessDate(new Date());
    const uow = api.app.get(UnitOfWork);
    const tb = await uow.run({ isolation: 'read committed' }, (tx) => api.app.get(FinancialStatements).trialBalanceIn(tx, '2026-11-10', today));
    expect(tb.balanced).toBe(true);
    expect(tb.signedSum).toBe(0n);
    expect(tb.totals.debit).toBe(tb.totals.credit);
    expect(tb.totals.closingDebit).toBe(tb.totals.closingCredit);
    const { rows } = await database.pool('app').query<{ code: string; balance: string }>(
      `SELECT a.code, sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END) AS balance
         FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id GROUP BY a.code ORDER BY a.code`,
    );
    const closing = new Map(tb.lines.map((l) => [l.code, l.closingDebit - l.closingCredit]));
    for (const row of rows) {
      expect([row.code, closing.get(row.code)]).toEqual([row.code, BigInt(row.balance)]);
    }
    // The seeded purchases: Kpone's transport, 15,000 to administration, less its credit note, owed on 2000.
    expect(rows.find((r) => r.code === '6800')).toBeDefined();
    expect(rows.find((r) => r.code === '2010')).toBeDefined();
  });

  it('agrees with the stock subledger: every inventory account equals the cost pools of its GL groups, and nothing is reported', async () => {
    const reconciliation = api.app.get(LedgerReconciliation);
    const report = await reconciliation.run({ principalId: SYSTEM_PRINCIPAL, kind: 'SYSTEM', displayName: 'Scheduler', realm: null, sessionId: null, steppedUpAt: null });
    expect(report).toEqual({ signedSumPesewas: 0n, unbalancedEntries: [], sources: [{ source: 'inv.stock-value', breaks: [], unmapped: [] }], seriesGaps: [], clean: true });
    const { rows } = await database.pool('app').query<{ ledger: string; pools: string }>(
      `SELECT (SELECT sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END) FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id
                WHERE a.code IN ('1300', '1310', '1320', '1325', '1330', '1340', '1360')) AS ledger,
              (SELECT sum(value_pesewas) FROM inv.cost_pool) AS pools`,
    );
    expect(BigInt(rows[0]!.ledger)).toBe(BigInt(rows[0]!.pools));
    expect(BigInt(rows[0]!.pools)).toBeGreaterThan(0n);
    const drift = await database.pool('app').query("SELECT 1 FROM platform.outbox_message WHERE event_type = 'fin.TrialBalanceDriftDetected'");
    expect(drift.rows).toHaveLength(0);
  });
});

describe('the nightly reconciliation reports drift and never corrects it (FR-FIN-016)', () => {
  it('reports an unbalanced entry slipped in with the triggers disabled, and the inventory break it makes, and leaves the entry', async () => {
    const admin = database.pool('admin');
    const client = await admin.connect();
    const id = randomUUID();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      const { rows } = await client.query<{ branch_id: string; period_id: string; posting_date: string }>('SELECT branch_id, period_id, posting_date::text FROM fin.journal_entry ORDER BY entry_no LIMIT 1');
      const at = rows[0]!;
      await client.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'JOURNAL', 'fin', $2, $3)", [id, at.branch_id, SYSTEM_PRINCIPAL]);
      await client.query(
        `INSERT INTO fin.journal_entry (id, entry_no, posting_date, period_id, branch_id, kind, event_code, event_id, source_document_id, posting_group_id, description, occurred_at, actor_id)
         VALUES ($1, 'JNL-TAMPER-1', $2, $3, $4, 'MANUAL', 'fin.ManualJournalApproved', gen_random_uuid(), $1, $1, 'Slipped in by a superuser', now(), $5)`,
        [id, at.posting_date, at.period_id, at.branch_id, SYSTEM_PRINCIPAL],
      );
      await client.query(
        "INSERT INTO fin.journal_line (journal_entry_id, line_no, account_id, side, amount_pesewas, branch_id, posting_date) VALUES ($1, 1, '01900000-0000-7000-8100-000000001310', 'D', 100, $2, $3)",
        [id, at.branch_id, at.posting_date],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const report = await runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () =>
      api.app.get(LedgerReconciliation).run({ principalId: SYSTEM_PRINCIPAL, kind: 'SYSTEM', displayName: 'Scheduler', realm: null, sessionId: null, steppedUpAt: null }),
    );
    expect(report.clean).toBe(false);
    expect(report.signedSumPesewas).toBe(100n);
    expect(report.unbalancedEntries).toEqual([{ entryId: id, entryNo: 'JNL-TAMPER-1', lineCount: 1, debitPesewas: 100n, creditPesewas: 0n }]);
    expect(report.sources[0]!.breaks).toEqual([expect.objectContaining({ accountId: '01900000-0000-7000-8100-000000001310', differencePesewas: 100n })]);
    const { rows } = await database.pool('app').query<{ payload: { signedSumPesewas: number; controlBreaks: { accountCode: string; differencePesewas: number }[] } }>(
      "SELECT payload FROM platform.outbox_message WHERE event_type = 'fin.TrialBalanceDriftDetected'",
    );
    expect(rows.map((r) => [r.payload.signedSumPesewas, r.payload.controlBreaks.map((b) => [b.accountCode, b.differencePesewas])])).toEqual([[100, [['1310', 100]]]]);
    const still = await database.pool('app').query('SELECT 1 FROM fin.journal_line WHERE journal_entry_id = $1', [id]);
    expect(still.rows).toHaveLength(1);
  });
});
