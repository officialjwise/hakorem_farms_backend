import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerReconciliation } from '../../../src/modules/fin';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { ledgerIds, postManualJournal, stepUp, type TotpSession } from '../../support/fin';
import { SYSTEM_PRINCIPAL, consoleGet, consolePost, createUser, enrolAndLogin, relaxRateLimits, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The year close (FR-FIN-010, ADR-0003 row fin.YearClosed, ADR-0058, the B08 continued 1c gate): closing the last
 * period of 2026 posts one CLOSING entry per branch through the ledger's balanced-entry path, dated 31 December, that
 * leaves every income, cost and expense account and 3200 at nil and moves 3100 by exactly the year's profit, computed
 * here from the journal lines in SQL; the event carries those exact amounts; the database admits the entry only with
 * the close and only once; and the closed year refuses postings afterwards.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let owner: TotpSession;
let accountant: TotpSession;
let branchId: string;
const YEAR_END = '2026-12-31';
const admin = () => database.pool('admin');
const post = (session: TestSession, path: string, body: object = {}) => consolePost(api.server, session, `/v1${path}`).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);

/** Debits less credits per account code (and party) for every line dated up to the day, straight from the journal. */
async function balancesTo(day: string): Promise<Map<string, bigint>> {
  const { rows } = await admin().query<{ code: string; balance: string }>(
    `SELECT a.code, sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS balance
       FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id WHERE l.posting_date <= $1::date GROUP BY a.code`,
    [day],
  );
  return new Map(rows.map((r) => [r.code, BigInt(r.balance)]));
}

/** The year's profit from the lines alone: every 4xxx, 5xxx and 6xxx line of 2026 not posted by a year close. */
async function profitOf2026(): Promise<bigint> {
  const { rows } = await admin().query<{ profit: string }>(
    `SELECT COALESCE(sum(CASE l.side WHEN 'C' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS profit
       FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id JOIN fin.journal_entry e ON e.id = l.journal_entry_id
      WHERE l.posting_date BETWEEN '2026-01-01' AND '2026-12-31' AND left(a.code, 1) IN ('4', '5', '6') AND e.kind <> 'CLOSING'`,
  );
  return BigInt(rows[0]!.profit);
}

async function periodsOf2026(): Promise<{ id: string; period_no: number; status: string }[]> {
  return (await admin().query<{ id: string; period_no: number; status: string }>('SELECT id, period_no, status FROM fin.accounting_period WHERE fiscal_year = 2026 ORDER BY period_no')).rows;
}

beforeAll(async () => {
  database = await createTestDatabase();
  // This file closes the year 2026, so it pins its own clock in that year's November and passes it to the application
  // and the seed (B09t2): on a real clock, December's trading and the close would fall in whatever year the suite ran.
  clock = new ManualClock(new Date('2026-11-16T10:00:00Z'));
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  // December's trading, while its period is open.
  clock.advanceBy(Date.parse('2026-12-28T10:00:00Z') - clock.now().getTime());
  const now = () => clock.now();
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), now);
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), now);
  const ledger = await ledgerIds(database);
  await postManualJournal(api.server, clock, { maker: accountant, checker: owner }, {
    postingDate: '2026-12-20',
    description: 'Christmas goat sales into the safe, and the cold room power bill paid from it',
    lines: [
      { accountId: ledger.account('1010'), side: 'D', amountPesewas: 500_000 },
      { accountId: ledger.account('4000'), side: 'C', amountPesewas: 500_000 },
      { accountId: ledger.account('6200'), side: 'D', amountPesewas: 120_001 },
      { accountId: ledger.account('1010'), side: 'C', amountPesewas: 120_001 },
    ],
  });
  // Into the new year, when 2026 has ended and can close.
  clock.advanceBy(Date.parse('2027-01-05T10:00:00Z') - clock.now().getTime());
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Abena Owusu', grants: [{ role: 'OWNER', branchId }] }), now);
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), now);
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('closing the last period of 2026 closes the year (FR-FIN-010)', () => {
  let profit: bigint;
  let before: Map<string, bigint>;

  it('locks and closes January to November and locks December, and nothing posts into a locked December', async () => {
    profit = await profitOf2026();
    before = await balancesTo(YEAR_END);
    expect(profit).toBeGreaterThan(379_999n);
    await stepUp(api.server, accountant, clock);
    for (const period of await periodsOf2026()) {
      expect((await post(accountant, `/finance/periods/${period.id}/lock`)).status, `lock ${period.period_no}`).toBe(200);
      if (period.period_no < 12) expect((await post(accountant, `/finance/periods/${period.id}/close`)).status, `close ${period.period_no}`).toBe(200);
    }
    expect((await periodsOf2026()).map((p) => p.status)).toEqual([...Array<string>(11).fill('CLOSED'), 'LOCKED']);
    const ledger = await ledgerIds(database);
    const created = await post(accountant, '/finance/manual-journals', {
      kind: 'MANUAL',
      postingDate: YEAR_END,
      description: 'A late accrual',
      lines: [
        { accountId: ledger.account('6800'), side: 'D', amountPesewas: 100 },
        { accountId: ledger.account('2020'), side: 'C', amountPesewas: 100 },
      ],
    });
    const refused = await post(accountant, `/finance/manual-journals/${created.body.id as string}/submit`);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('PERIOD_NOT_OPEN');
  });

  it('refuses, in the database, a CLOSING entry that is not the year close, or that commits without the close', async () => {
    const december = (await periodsOf2026())[11]!;
    const client = await database.pool('app').connect();
    const attempt = async (eventCode: string) => {
      const id = randomUUID();
      try {
        await client.query('BEGIN');
        await client.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'JOURNAL', 'fin', $2, $3)", [id, branchId, SYSTEM_PRINCIPAL]);
        await client.query(
          `INSERT INTO fin.journal_entry (id, entry_no, posting_date, period_id, branch_id, kind, event_code, event_id, source_document_id, posting_group_id, description, occurred_at, actor_id)
           VALUES ($1, $2, $3, $4, $5, 'CLOSING', $6, gen_random_uuid(), $1, $1, 'Not the year close', now(), $7)`,
          [id, `JNL-T-${id.slice(0, 8)}`, YEAR_END, december.id, branchId, eventCode, SYSTEM_PRINCIPAL],
        );
        await client.query(
          `INSERT INTO fin.journal_line (journal_entry_id, line_no, account_id, side, amount_pesewas, branch_id, posting_date)
           SELECT $1, n, (SELECT id FROM fin.account WHERE code = CASE n WHEN 1 THEN '3200' ELSE '3100' END), CASE n WHEN 1 THEN 'D' ELSE 'C' END, 1, $2, $3::date FROM generate_series(1, 2) n`,
          [id, branchId, YEAR_END],
        );
        await client.query('COMMIT');
        return null;
      } catch (error) {
        await client.query('ROLLBACK');
        return (error as { constraint?: string }).constraint ?? String(error);
      }
    };
    try {
      expect(await attempt('fin.ManualJournalApproved')).toBe('ck_journal_entry_closing');
      expect(await attempt('fin.YearClosed')).toBe('ck_journal_closing_period');
    } finally {
      client.release();
    }
  });

  it('posts one CLOSING entry dated 31 December that leaves every income, cost and expense account and 3200 at nil, and 3100 moved by the profit', async () => {
    await stepUp(api.server, accountant, clock);
    const december = (await periodsOf2026())[11]!;
    const closed = await post(accountant, `/finance/periods/${december.id}/close`);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.status).toBe('CLOSED');
    const after = await balancesTo(YEAR_END);
    const nonNil = [...after].filter(([code, b]) => ['4', '5', '6'].includes(code[0]!) && b !== 0n);
    expect(nonNil).toEqual([]);
    expect(after.get('3200')).toBe(0n);
    expect((after.get('3100') ?? 0n) - (before.get('3100') ?? 0n)).toBe(-profit);
    // Every balance sheet account is untouched by the close.
    for (const [code, balance] of before) if (['1', '2'].includes(code[0]!) || code === '3900') expect([code, after.get(code)]).toEqual([code, balance]);

    const { rows: entries } = await admin().query<{ id: string; kind: string; posting_date: string; event_code: string; branch_id: string; entry_no: string; source_document_id: string }>(
      "SELECT id, kind, posting_date::text, event_code, branch_id, entry_no, source_document_id FROM fin.journal_entry WHERE kind = 'CLOSING'",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ posting_date: YEAR_END, event_code: 'fin.YearClosed', branch_id: branchId });
    expect(entries[0]!.entry_no).toMatch(/^JNL-2026-DDW-/);
    const { rows: lines } = await admin().query<{ code: string; side: 'D' | 'C'; amount: string }>(
      'SELECT a.code, l.side, l.amount_pesewas::text AS amount FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id WHERE l.journal_entry_id = $1 ORDER BY l.line_no',
      [entries[0]!.id],
    );
    // Each income, cost and expense account closed at its exact balance against 3200, then 3200 to 3100 by the profit.
    const expected: [string, 'D' | 'C', bigint][] = [];
    for (const [code, balance] of [...before].filter(([code, b]) => ['4', '5', '6'].includes(code[0]!) && b !== 0n).sort(([a], [b]) => a.localeCompare(b))) {
      expected.push(balance > 0n ? [code, 'C', balance] : [code, 'D', -balance], balance > 0n ? ['3200', 'D', balance] : ['3200', 'C', -balance]);
    }
    expected.push(['3200', 'D', profit], ['3100', 'C', profit]);
    const sortKey = (l: [string, string, bigint]) => `${l[0]}:${l[1]}:${l[2]}`;
    expect(lines.map((l): [string, 'D' | 'C', bigint] => [l.code, l.side, BigInt(l.amount)]).sort((a, b) => sortKey(a).localeCompare(sortKey(b)))).toEqual(
      expected.sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
    );
    const debit = lines.filter((l) => l.side === 'D').reduce((s, l) => s + BigInt(l.amount), 0n);
    expect(debit).toBe(lines.filter((l) => l.side === 'C').reduce((s, l) => s + BigInt(l.amount), 0n));
  });

  it('publishes fin.YearClosed with the exact amounts the entry posts, and audits the close', async () => {
    const { rows } = await admin().query<{ payload: { fiscalYear: number; postingDate: string; yearCloseId: string; amounts: { key: string; accountId: string | null; amountPesewas: number }[] } }>(
      "SELECT payload FROM platform.outbox_message WHERE event_type = 'fin.YearClosed'",
    );
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload;
    expect(payload).toMatchObject({ fiscalYear: 2026, postingDate: YEAR_END });
    const codes = new Map((await admin().query<{ id: string; code: string }>('SELECT id, code FROM fin.account')).rows.map((r) => [r.id, r.code] as const));
    const expected = [...before]
      .filter(([code, b]) => ['4', '5', '6'].includes(code[0]!) && b !== 0n)
      .map(([code, b]) => [b > 0n ? 'closeDebitToCurrent' : 'closeCreditToCurrent', code, b > 0n ? b : -b] as const);
    expect(payload.amounts.map((a) => [a.key, a.accountId === null ? null : codes.get(a.accountId), BigInt(a.amountPesewas)]).sort()).toEqual(
      [...expected.map(([k, c, b]) => [k, c, b]), ['earningsToRetained', null, profit]].sort(),
    );
    const document = await admin().query<{ doc_type: string }>('SELECT doc_type FROM platform.business_document WHERE id = $1', [payload.yearCloseId]);
    expect(document.rows[0]!.doc_type).toBe('YEAR_CLOSE');
    const audit = await admin().query<{ after: { earningsToRetainedPesewas: number } }>(`SELECT convert_from("after", 'UTF8')::jsonb AS "after" FROM platform.audit_event WHERE module = 'fin' AND action = 'CLOSE_YEAR'`);
    expect(audit.rows.map((r) => BigInt(r.after.earningsToRetainedPesewas))).toEqual([profit]);
  });

  it('still shows the year\'s profit in its profit and loss, closes the trial balance at nil, and balances the balance sheet', async () => {
    const pl = await get(owner, '/finance/profit-and-loss?from=2026-01-01&to=2026-12-31');
    const net = pl.body.sections.find((s: { key: string }) => s.key === 'NET_PROFIT');
    expect([BigInt(net.totalPesewas), net.totalIsNegative]).toEqual([profit, false]);
    const tb = await get(accountant, '/finance/trial-balance?from=2026-01-01&to=2026-12-31&limit=100');
    expect(tb.body.balanced).toBe(true);
    for (const row of tb.body.data as { account: { code: string }; closingDebitPesewas: number; closingCreditPesewas: number }[]) {
      if (['4', '5', '6'].includes(row.account.code[0]!) || row.account.code === '3200') expect([row.account.code, row.closingDebitPesewas, row.closingCreditPesewas]).toEqual([row.account.code, 0, 0]);
    }
    const bs = await get(accountant, `/finance/balance-sheet?asOf=${YEAR_END}`);
    const equity = bs.body.sections.find((s: { key: string }) => s.key === 'EQUITY');
    expect(equity.rows.find((r: { account: unknown }) => r.account === null)).toBeUndefined();
    expect(bs.body.checks).toEqual([{ name: 'Assets equal liabilities plus equity', passed: true }]);
    // The new year starts with no earnings and reads the closed year from its period balances, which equal its lines.
    const opening = await get(accountant, '/finance/balance-sheet?asOf=2027-01-01');
    expect(opening.body.sections.find((s: { key: string }) => s.key === 'EQUITY').rows.find((r: { account: unknown }) => r.account === null)).toBeUndefined();
    const report = await runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () =>
      api.app.get(LedgerReconciliation).run({ principalId: SYSTEM_PRINCIPAL, kind: 'SYSTEM', displayName: 'Scheduler', realm: null, sessionId: null, steppedUpAt: null }),
    );
    expect(report.periodBalanceDrift).toEqual([]);
    expect(report.clean).toBe(true);
    const closing = await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM fin.period_balance WHERE is_closing');
    expect(closing.rows[0]!.n).toBeGreaterThan(2);
  });

  it('refuses every posting into the closed year afterwards, a second year close included', async () => {
    const december = (await periodsOf2026())[11]!;
    const client = await database.pool('app').connect();
    try {
      const id = randomUUID();
      await client.query('BEGIN');
      await client.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'JOURNAL', 'fin', $2, $3)", [id, branchId, SYSTEM_PRINCIPAL]);
      const refused = await client
        .query(
          `INSERT INTO fin.journal_entry (id, entry_no, posting_date, period_id, branch_id, kind, event_code, event_id, source_document_id, posting_group_id, description, occurred_at, actor_id)
           VALUES ($1, 'JNL-T-2', $2, $3, $4, 'CLOSING', 'fin.YearClosed', gen_random_uuid(), $1, $1, 'A second year close', now(), $5)`,
          [id, YEAR_END, december.id, branchId, SYSTEM_PRINCIPAL],
        )
        .catch((error: { constraint?: string }) => error.constraint);
      expect(['ck_journal_period_open', 'uq_journal_entry_closing']).toContain(refused);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await stepUp(api.server, accountant, clock);
    expect((await post(accountant, `/finance/periods/${december.id}/close`)).body.error.code).toBe('INVALID_STATE_TRANSITION');
    const entries = await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM fin.journal_entry WHERE kind = 'CLOSING'");
    expect(entries.rows[0]!.n).toBe(1);
    expect(toBusinessDate(clock.now()) > YEAR_END).toBe(true);
  });
});
