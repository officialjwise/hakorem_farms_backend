import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { SQLSTATE } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Manual journals and the journal reads over the API (FR-FIN-003, FR-FIN-004, FR-FIN-008, A-005, A-190, the B08
 * continued 1b gate). A journal posts nothing until a different person approves it with step-up, and then exactly one
 * balanced entry, line for line as entered, on its own date. The smallest team that could collude, one Owner and one
 * Accountant, can each only approve the other's; a farm with a single Owner can never post its own. The opening balance
 * journal is taken once, against 3900. Every journal operation refuses the wrong role. The database holds the rules too.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
type TotpSession = TestSession & { readonly secret: Buffer };
const sessions = new Map<string, TestSession>();

const get = (who: string, path: string) => consoleGet(api.server, sessions.get(who)!, `/v1${path}`);
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, sessions.get(who)!, `/v1${path}`, key).send(body);
const patch = (who: string, path: string, body: object, key: string = randomUUID()) => {
  const session = sessions.get(who)!;
  return request(api.server).patch(`/v1${path}`).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).send(body);
};
const admin = () => database.pool('admin');
const accountId = (code: string) => `01900000-0000-7000-8100-00000000${code}`;
const today = () => toBusinessDate(clock.now());

async function stepUp(who: string): Promise<void> {
  clock.advanceBy(30_000);
  const session = sessions.get(who) as TotpSession;
  expect((await post(who, '/auth/step-up', { code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
}

const wages = (amountPesewas = 500_000) => ({
  kind: 'MANUAL',
  postingDate: today(),
  description: 'November wages, farm hands, paid from the safe',
  lines: [
    { accountId: accountId('6000'), side: 'D', amountPesewas, memo: 'Five farm hands' },
    { accountId: accountId('1010'), side: 'C', amountPesewas },
  ],
});

async function draft(who: string, body: object = wages()): Promise<{ id: string; version: number }> {
  const created = await post(who, '/finance/manual-journals', body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body as { id: string; version: number };
}

async function submitted(who: string, body: object = wages()): Promise<{ id: string; approvalRequestId: string }> {
  const { id } = await draft(who, body);
  const sent = await post(who, `/finance/manual-journals/${id}/submit`);
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  return { id, approvalRequestId: sent.body.approvalRequestId as string };
}

async function entriesOf(journalId: string): Promise<{ id: string; kind: string; entry_no: string; posting_date: string; lines: [string, string, number][] }[]> {
  const { rows } = await admin().query<{ id: string; kind: string; entry_no: string; posting_date: string }>(
    'SELECT id, kind, entry_no, posting_date::text FROM fin.journal_entry WHERE source_document_id = $1',
    [journalId],
  );
  const out = [];
  for (const row of rows) {
    const lines = await admin().query<{ code: string; side: string; amount: string }>(
      'SELECT a.code, l.side, l.amount_pesewas AS amount FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id WHERE l.journal_entry_id = $1 ORDER BY l.line_no',
      [row.id],
    );
    out.push({ ...row, lines: lines.rows.map((l) => [l.code, l.side, Number(l.amount)] as [string, string, number]) });
  }
  return out;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  branchId = (await createBranch(database)).branchId;
  const people: [string, string, RoleCode, boolean][] = [
    ['owner', 'Kwabena Owusu', 'OWNER', true],
    ['accountant', 'Efua Asante', 'ACCOUNTANT', true],
    ['manager', 'Akosua Boateng', 'MANAGER', true],
    ['storekeeper', 'Kofi Mensah', 'STOREKEEPER', false],
    ['cashier', 'Ama Darko', 'CASHIER', false],
    ['sales', 'Yaw Agyeman', 'SALES', false],
    ['farmHand', 'Kwame Asare', 'FARM_HAND', false],
    ['driver', 'Kojo Antwi', 'DRIVER', false],
  ];
  for (const [name, displayName, role, privileged] of people) {
    const user = await createUser(database, { name: displayName, grants: [{ role, branchId }] });
    sessions.set(name, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('a manual journal posts only after a different person approves it (FR-FIN-008, ADR-0017)', () => {
  it('posts nothing on submit, refuses the maker and the wrong role, then posts exactly one balanced entry of 500,000', async () => {
    const created = await post('accountant', '/finance/manual-journals', wages());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'DRAFT',
      kind: 'MANUAL',
      debitTotalPesewas: 500_000,
      creditTotalPesewas: 500_000,
      balanced: true,
      currency: 'GHS',
      approvalRequestId: null,
      journalEntryId: null,
      createdBy: { displayName: 'Efua Asante' },
      lines: [
        { lineNo: 1, account: { code: '6000', name: 'Wages' }, side: 'D', amountPesewas: 500_000, subledger: null, memo: 'Five farm hands' },
        { lineNo: 2, account: { code: '1010' }, side: 'C', amountPesewas: 500_000, subledger: null, memo: null },
      ],
    });
    const id = created.body.id as string;
    const key = randomUUID();
    const sent = await post('accountant', `/finance/manual-journals/${id}/submit`, {}, key);
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'MANUAL_JOURNAL', subject: { id, docType: 'MANUAL_JOURNAL', number: null } });
    expect((await post('accountant', `/finance/manual-journals/${id}/submit`, {}, key)).body).toEqual(sent.body);
    expect(await entriesOf(id)).toEqual([]);

    const approvalId = sent.body.approvalRequestId as string;
    await stepUp('accountant');
    const own = await post('accountant', `/iam/approvals/${approvalId}/approve`, { reason: 'My own' });
    expect(own.status).toBe(422);
    expect(own.body.error.code).toBe('MAKER_CANNOT_CHECK');
    await stepUp('manager');
    expect((await post('manager', `/iam/approvals/${approvalId}/approve`, { reason: 'Not mine' })).status).toBe(403);
    clock.advanceBy(310_000);
    const stale = await post('owner', `/iam/approvals/${approvalId}/approve`, { reason: 'No step-up' });
    expect(stale.body.error.code).toBe('STEP_UP_REQUIRED');
    expect(await entriesOf(id)).toEqual([]);
    expect((await get('owner', `/finance/manual-journals/${id}`)).body.status).toBe('PENDING_APPROVAL');

    await stepUp('owner');
    const approved = await post('owner', `/iam/approvals/${approvalId}/approve`, { reason: 'Wage sheet checked' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const entries = await entriesOf(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'MANUAL', posting_date: today(), lines: [['6000', 'D', 500_000], ['1010', 'C', 500_000]] });
    expect(entries[0]!.entry_no).toMatch(/^JNL-\d{4}-DDW-\d{6}$/);
    const after = await get('accountant', `/finance/manual-journals/${id}`);
    expect(after.body).toMatchObject({ status: 'POSTED', journalEntryId: entries[0]!.id, approvalRequestId: approvalId });
    const { rows } = await admin().query<{ type: string; n: number }>("SELECT event_type AS type, count(*)::int AS n FROM platform.outbox_message WHERE subject_id = $1 GROUP BY event_type", [id]);
    expect(rows).toEqual([{ type: 'fin.ManualJournalApproved', n: 1 }]);
    const audit = await admin().query<{ action: string }>("SELECT action FROM platform.audit_event WHERE module = 'fin' AND entity_id = $1 ORDER BY occurred_at", [id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['CREATE', 'SUBMIT', 'POST']);

    const entry = await get('accountant', `/finance/journal-entries/${entries[0]!.id}`);
    expect(entry.status).toBe(200);
    expect(entry.body).toMatchObject({
      entryNo: entries[0]!.entry_no,
      kind: 'MANUAL',
      eventCode: 'fin.ManualJournalApproved',
      sourceDocument: { id, docType: 'MANUAL_JOURNAL', number: null },
      description: 'November wages, farm hands, paid from the safe',
      actor: { displayName: 'Kwabena Owusu' },
      totalPesewas: 500_000,
      reversesEntryId: null,
      lines: [
        { lineNo: 1, account: { code: '6000' }, side: 'D', amountPesewas: 500_000, branchId, subledger: null, memo: 'Five farm hands' },
        { lineNo: 2, account: { code: '1010' }, side: 'C', amountPesewas: 500_000, branchId, subledger: null, memo: null },
      ],
    });
    const listed = await get('owner', '/finance/journal-entries?kind=MANUAL');
    expect(listed.body.data.map((e: { id: string }) => e.id)).toEqual([entries[0]!.id]);
    expect((await get('owner', `/finance/journal-entries?sourceDocumentId=${id}`)).body.data).toHaveLength(1);
    expect((await get('owner', `/finance/journal-entries?accountId=${accountId('6000')}&from=${today()}&to=${today()}`)).body.data).toHaveLength(1);
  });

  it('with one Owner and one Accountant, the Owner cannot approve their own either; the Accountant can', async () => {
    const { id, approvalRequestId } = await submitted('owner', wages(75_000));
    await stepUp('owner');
    const own = await post('owner', `/iam/approvals/${approvalRequestId}/approve`, { reason: 'My own' });
    expect(own.body.error.code).toBe('MAKER_CANNOT_CHECK');
    expect(await entriesOf(id)).toEqual([]);
    await stepUp('accountant');
    expect((await post('accountant', `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Checked' })).status).toBe(200);
    expect((await entriesOf(id))[0]!.lines).toEqual([
      ['6000', 'D', 75_000],
      ['1010', 'C', 75_000],
    ]);
  });

  it('a rejected journal never posts and is final', async () => {
    const { id, approvalRequestId } = await submitted('accountant', wages(12_345));
    await stepUp('owner');
    expect((await post('owner', `/iam/approvals/${approvalRequestId}/reject`, { reason: 'Wrong month' })).status).toBe(200);
    expect((await get('owner', `/finance/manual-journals/${id}`)).body.status).toBe('REJECTED');
    expect(await entriesOf(id)).toEqual([]);
    const again = await post('accountant', `/finance/manual-journals/${id}/submit`);
    expect(again.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [{ code: 'REJECTED' }] });
  });

  it('refuses an unbalanced journal on submit, and lets only its maker change or submit the draft', async () => {
    const { id, version } = await draft('accountant', { ...wages(), lines: [wages().lines[0], { ...wages().lines[1], amountPesewas: 499_999 }] });
    expect((await get('accountant', `/finance/manual-journals/${id}`)).body).toMatchObject({ debitTotalPesewas: 500_000, creditTotalPesewas: 499_999, balanced: false });
    const refused = await post('accountant', `/finance/manual-journals/${id}/submit`);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('JOURNAL_UNBALANCED');
    expect((await patch('owner', `/finance/manual-journals/${id}`, { version, description: 'Not mine' })).status).toBe(403);
    expect((await post('owner', `/finance/manual-journals/${id}/submit`)).status).toBe(403);
    expect((await patch('accountant', `/finance/manual-journals/${id}`, { version: version + 1, description: 'Stale' })).status).toBe(409);
    const fixed = await patch('accountant', `/finance/manual-journals/${id}`, { version, lines: wages(499_999).lines });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect(fixed.body).toMatchObject({ version: version + 1, balanced: true, debitTotalPesewas: 499_999, lines: [{ lineNo: 1 }, { lineNo: 2 }] });
    const { rows } = await admin().query<{ revision: number; n: number }>('SELECT revision, count(*)::int AS n FROM fin.manual_journal_line WHERE manual_journal_id = $1 GROUP BY revision ORDER BY revision', [id]);
    expect(rows).toEqual([
      { revision: 1, n: 2 },
      { revision: 2, n: 2 },
    ]);
    expect((await post('accountant', `/finance/manual-journals/${id}/submit`)).status).toBe(202);
    const pending = await patch('accountant', `/finance/manual-journals/${id}`, { version: version + 2, description: 'Too late' });
    expect(pending.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [{ code: 'PENDING_APPROVAL' }] });
  });

  it('names each broken line rule, a party exactly on a control account, and no date after today', async () => {
    const refused = await post('accountant', '/finance/manual-journals', {
      kind: 'MANUAL',
      postingDate: toBusinessDate(new Date(clock.now().getTime() + 2 * 86_400_000)),
      description: 'Pay a supplier',
      lines: [
        { accountId: accountId('2000'), side: 'D', amountPesewas: 10_000 },
        { accountId: accountId('1010'), side: 'C', amountPesewas: 10_000, subledgerPartyId: randomUUID() },
        { accountId: randomUUID(), side: 'C', amountPesewas: 1 },
      ],
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('MANUAL_JOURNAL_INVALID');
    expect(refused.body.error.details.map((d: { field: string; code: string }) => [d.field, d.code])).toEqual([
      ['/postingDate', 'FUTURE_DATE'],
      ['/lines/0/subledgerPartyId', 'SUBLEDGER_REQUIRED'],
      ['/lines/1/subledgerPartyId', 'SUBLEDGER_NOT_ALLOWED'],
      ['/lines/2/accountId', 'UNKNOWN_ACCOUNT'],
    ]);
    expect((await post('accountant', '/finance/manual-journals', { ...wages(), lines: [wages().lines[0]] })).status).toBe(400);
    expect((await post('accountant', '/finance/manual-journals', { ...wages(), lines: [{ ...wages().lines[0], amountPesewas: 0 }, wages().lines[1]] })).status).toBe(400);
  });
});

describe('the opening balance journal (A-005)', () => {
  it('is taken against 3900 once, pending or posted', async () => {
    const opening = {
      kind: 'OPENING',
      postingDate: today(),
      description: 'Opening balances on day one',
      lines: [
        { accountId: accountId('1010'), side: 'D', amountPesewas: 2_500_000 },
        { accountId: accountId('1300'), side: 'D', amountPesewas: 1_200_001 },
        { accountId: accountId('3900'), side: 'C', amountPesewas: 3_700_001 },
      ],
    };
    const without = await post('accountant', '/finance/manual-journals', { ...opening, lines: wages().lines });
    expect(without.body.error).toMatchObject({ code: 'MANUAL_JOURNAL_INVALID', details: [{ code: 'OPENING_WITHOUT_3900' }] });
    const { id, approvalRequestId } = await submitted('accountant', opening);
    const second = await post('accountant', '/finance/manual-journals', opening);
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('OPENING_ALREADY_POSTED');
    await stepUp('owner');
    expect((await post('owner', `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Bank and stock letters agree' })).status).toBe(200);
    expect(await entriesOf(id)).toEqual([
      expect.objectContaining({
        kind: 'OPENING',
        lines: [
          ['1010', 'D', 2_500_000],
          ['1300', 'D', 1_200_001],
          ['3900', 'C', 3_700_001],
        ],
      }),
    ]);
    expect((await post('accountant', '/finance/manual-journals', opening)).body.error.code).toBe('OPENING_ALREADY_POSTED');
  });
});

describe('a manual journal posts on its own date or not at all (FR-FIN-009, A-190)', () => {
  it('is refused PERIOD_NOT_OPEN when its period is locked, on submit and at approval, and never moved to today', async () => {
    const period = (await admin().query<{ id: string; start_date: string }>("SELECT id, start_date::text FROM fin.accounting_period WHERE $1::date BETWEEN start_date AND end_date", [today()])).rows[0]!;
    const early = await draft('accountant', { ...wages(4_000), postingDate: period.start_date });
    const pending = await submitted('accountant', { ...wages(3_000), postingDate: period.start_date });
    expect((await post('accountant', `/finance/periods/${period.id}/lock`)).status).toBe(200);
    const refused = await post('accountant', `/finance/manual-journals/${early.id}/submit`);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('PERIOD_NOT_OPEN');
    await stepUp('owner');
    const atApproval = await post('owner', `/iam/approvals/${pending.approvalRequestId}/approve`, { reason: 'Locked since' });
    expect(atApproval.status).toBe(422);
    expect(atApproval.body.error.code).toBe('PERIOD_NOT_OPEN');
    expect(await entriesOf(pending.id)).toEqual([]);
    expect((await get('owner', `/finance/manual-journals/${pending.id}`)).body.status).toBe('PENDING_APPROVAL');
    await admin().query("UPDATE fin.accounting_period SET status = 'OPEN', locked_at = NULL, locked_by = NULL, version = version + 1 WHERE id = $1", [period.id]);
    await stepUp('owner');
    expect((await post('owner', `/iam/approvals/${pending.approvalRequestId}/approve`, { reason: 'Reopened' })).status).toBe(200);
    expect((await entriesOf(pending.id))[0]!.posting_date).toBe(period.start_date);
  });
});

describe('account activity with a running balance (FR-FIN-004)', () => {
  it('answers the opening, each line with its running balance, and the closing balance over the whole range', async () => {
    const before = (await get('accountant', `/finance/accounts/${accountId('1010')}/activity?from=2026-01-01&to=${today()}&limit=100`)).body;
    const all = before.data as { amountPesewas: number; side: string; runningBalancePesewas: number; runningSide: string }[];
    expect(before).toMatchObject({ account: { code: '1010', name: 'Cash, safe' }, openingBalancePesewas: 0, openingSide: 'D', currency: 'GHS' });
    let running = 0;
    for (const line of all) {
      running += line.side === 'D' ? line.amountPesewas : -line.amountPesewas;
      expect([line.runningBalancePesewas, line.runningSide]).toEqual([Math.abs(running), running >= 0 ? 'D' : 'C']);
    }
    expect([before.closingBalancePesewas, before.closingSide]).toEqual([Math.abs(running), running >= 0 ? 'D' : 'C']);
    expect(running).toBe(2_500_000 - 500_000 - 75_000 - 3_000);

    const first = (await get('accountant', `/finance/accounts/${accountId('1010')}/activity?from=2026-01-01&to=${today()}&limit=2`)).body;
    const second = (await get('accountant', `/finance/accounts/${accountId('1010')}/activity?from=2026-01-01&to=${today()}&limit=2&cursor=${encodeURIComponent(first.page.nextCursor as string)}`)).body;
    expect([...first.data, ...second.data].map((l: { runningBalancePesewas: number }) => l.runningBalancePesewas)).toEqual(all.slice(0, 4).map((l) => l.runningBalancePesewas));
    expect(second.closingBalancePesewas).toBe(before.closingBalancePesewas);
    expect((await get('accountant', `/finance/accounts/${accountId('1010')}/activity?from=${today()}&to=2020-01-01`)).status).toBe(400);
    expect((await get('accountant', `/finance/accounts/${randomUUID()}/activity?from=2026-01-01&to=${today()}`)).status).toBe(404);
  });
});

describe('the database holds the manual journal rules (0130)', () => {
  const app = () => database.pool('app');

  it('refuses lines on a journal that is no longer a draft, or under an old revision', async () => {
    const { id } = await submitted('accountant', wages(1_000));
    const write = app().query(
      `INSERT INTO fin.manual_journal_line (id, manual_journal_id, revision, line_no, account_id, side, amount_pesewas, created_by)
       SELECT $1, $2, 1, 3, $3, 'D', 1, created_by FROM fin.manual_journal WHERE id = $2`,
      [randomUUID(), id, accountId('6000')],
    );
    await expect(write).rejects.toMatchObject({ code: 'HK012', constraint: 'ck_manual_journal_line_draft' });
    await expect(app().query('UPDATE fin.manual_journal_line SET amount_pesewas = 2 WHERE manual_journal_id = $1', [id])).rejects.toMatchObject({ code: SQLSTATE.ledgerImmutable });
    await expect(app().query("UPDATE fin.manual_journal SET description = 'Changed while pending' WHERE id = $1", [id])).rejects.toMatchObject({ code: SQLSTATE.documentFrozen });
  });

  it('refuses a journal posted with an entry that is not its own, and any change once posted', async () => {
    const { id } = await submitted('accountant', wages(2_000));
    const other = (await admin().query<{ id: string }>("SELECT id FROM fin.journal_entry WHERE kind = 'MANUAL' LIMIT 1")).rows[0]!.id;
    const forged = app().query("UPDATE fin.manual_journal SET status = 'POSTED', journal_entry_id = $2, decided_at = now(), decided_by = created_by, version = version + 1 WHERE id = $1", [id, other]);
    await expect(forged).rejects.toMatchObject({ code: 'HK012', constraint: 'ck_manual_journal_entry' });
    const posted = (await admin().query<{ id: string }>("SELECT id FROM fin.manual_journal WHERE status = 'POSTED' LIMIT 1")).rows[0]!.id;
    await expect(app().query("UPDATE fin.manual_journal SET description = 'Rewritten' WHERE id = $1", [posted])).rejects.toMatchObject({ code: SQLSTATE.documentFrozen });
  });

  it('refuses a MANUAL entry posted from anything but fin.ManualJournalApproved, an entered rule elsewhere, a second opening journal', async () => {
    const entry = (await admin().query<Record<string, unknown>>("SELECT * FROM fin.journal_entry WHERE kind = 'MANUAL' LIMIT 1")).rows[0]!;
    const bare = admin().query(
      `INSERT INTO fin.journal_entry (id, entry_no, posting_date, period_id, branch_id, kind, source_document_id, posting_group_id, description, occurred_at, actor_id)
       VALUES ($1, 'JNL-TEST-1', $2, $3, $4, 'MANUAL', $5, $6, 'Typed in by hand', now(), $7)`,
      [randomUUID(), entry['posting_date'], entry['period_id'], entry['branch_id'], entry['source_document_id'], randomUUID(), entry['actor_id']],
    );
    await expect(bare).rejects.toMatchObject({ code: SQLSTATE.checkViolation, constraint: 'ck_journal_entry_manual' });
    const entered = admin().query(
      `INSERT INTO fin.posting_rule (id, event_code, amount_key, side, determinant_type, determinant_role, valid_from, created_by, updated_by)
       VALUES ($1, 'inv.GoodsReceived', 'value', 'D', 'ENTERED', 'AS_ENTERED', DATE '2099-01-01', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001')`,
      [randomUUID()],
    );
    await expect(entered).rejects.toMatchObject({ code: SQLSTATE.checkViolation, constraint: 'ck_posting_rule_entered' });
    const opening = (await admin().query<Record<string, unknown>>("SELECT * FROM fin.manual_journal WHERE kind = 'OPENING'")).rows[0]!;
    const docId = randomUUID();
    await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'MANUAL_JOURNAL', 'fin', $2, $3)", [docId, branchId, opening['created_by']]);
    const twice = admin().query(
      `INSERT INTO fin.manual_journal (id, kind, posting_date, description, branch_id, status, approval_request_id, created_by, updated_by)
       VALUES ($1, 'OPENING', $2, 'A second opening', $3, 'PENDING_APPROVAL', $4, $5, $5)`,
      [docId, opening['posting_date'], branchId, opening['approval_request_id'], opening['created_by']],
    );
    await expect(twice).rejects.toMatchObject({ code: SQLSTATE.uniqueViolation, constraint: 'uq_manual_journal_opening' });
  });
});

describe('every journal and manual journal operation refuses the wrong role (ADR-0017, ADR-0035)', () => {
  for (const who of ['manager', 'storekeeper', 'cashier', 'sales', 'farmHand', 'driver']) {
    it(`refuses the ${who} with 403`, async () => {
      const id = randomUUID();
      expect((await get(who, '/finance/journal-entries')).status).toBe(403);
      expect((await get(who, `/finance/journal-entries/${id}`)).status).toBe(403);
      expect((await get(who, `/finance/accounts/${accountId('1010')}/activity?from=2026-01-01&to=2026-12-31`)).status).toBe(403);
      expect((await get(who, '/finance/manual-journals')).status).toBe(403);
      expect((await get(who, `/finance/manual-journals/${id}`)).status).toBe(403);
      expect((await post(who, '/finance/manual-journals', wages())).status).toBe(403);
      expect((await patch(who, `/finance/manual-journals/${id}`, { version: 1, description: 'Refused' })).status).toBe(403);
      expect((await post(who, `/finance/manual-journals/${id}/submit`)).status).toBe(403);
    });
  }
});
