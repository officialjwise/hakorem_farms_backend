import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { LedgerPostings } from '../../../src/modules/fin';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { DomainEvents } from '../../../src/platform/events/domain-events';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { SQLSTATE } from '../../support/sql-state';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Posting rule and account determination changes over the API on the seeded farm (FR-FIN-005, ADR-0003, ADR-0017,
 * ADR-0020, A-191, the B08 continued 1b gate). A change asks with step-up and waits: nothing changes until a different
 * person approves it with step-up, and the maker can never approve their own. It then takes effect from the later of the
 * date asked for and the approval day: what posted before keeps its accounts, nothing is re-posted, and the boot
 * assertion still holds. Every rule operation refuses the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
type TotpSession = TestSession & { readonly secret: Buffer };
const sessions = new Map<string, TestSession>();
const ids = new Map<string, string>();

const id = (code: string) => ids.get(code)!;
const get = (who: string, path: string) => consoleGet(api.server, sessions.get(who)!, `/v1${path}`);
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, sessions.get(who)!, `/v1${path}`, key).send(body);
const admin = () => database.pool('admin');
const accountId = (code: string) => `01900000-0000-7000-8100-00000000${code}`;
const today = () => toBusinessDate(clock.now());
const tomorrow = () => toBusinessDate(new Date(clock.now().getTime() + 86_400_000));

async function stepUp(who: string): Promise<void> {
  clock.advanceBy(30_000);
  const session = sessions.get(who) as TotpSession;
  expect((await post(who, '/auth/step-up', { code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
}

/** A harvest of yam into the shop, valued 12,000, received now: inv.ProductionReceived posts Dr 1330, Cr the rule's account. */
async function harvest(): Promise<string> {
  const created = await post('manager', '/goods-receipts', {
    kind: 'HARVEST',
    locationId: id('location:SHOP'),
    receivedAt: new Date(clock.now().getTime() - 60_000).toISOString(),
    lines: [{ productId: id('product:PRD-YAM-TUBER'), qtyReceived: '10.000', valuePesewas: 12_000 }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await post('manager', `/goods-receipts/${created.body.id as string}/post`)).status).toBe(200);
  return created.body.id as string;
}

async function harvestLines(goodsReceiptId: string): Promise<[string, string, number][]> {
  const { rows } = await admin().query<{ code: string; side: string; amount: string }>(
    `SELECT a.code, l.side, l.amount_pesewas AS amount FROM fin.journal_entry e JOIN inv.stock_movement m ON m.id = e.event_subject_id
       JOIN fin.journal_line l ON l.journal_entry_id = e.id JOIN fin.account a ON a.id = l.account_id
      WHERE m.source_document_id = $1 ORDER BY l.line_no`,
    [goodsReceiptId],
  );
  return rows.map((r) => [r.code, r.side, Number(r.amount)]);
}

async function ruleInForce(eventCode: string, amountKey: string, side: string, on: string): Promise<{ id: string; account: { code: string } | null; validFrom: string; validTo: string | null; approvalRequestId: string | null }> {
  const page = await get('accountant', `/finance/posting-rules?eventCode=${eventCode}&at=${on}&limit=100`);
  expect(page.status).toBe(200);
  return (page.body.data as { id: string; amountKey: string; side: string; account: { code: string } | null; validFrom: string; validTo: string | null; approvalRequestId: string | null }[]).find(
    (r) => r.amountKey === amountKey && r.side === side,
  )!;
}

async function assertBootHolds(): Promise<void> {
  const postings = api.app.get(LedgerPostings);
  await api.app.get(UnitOfWork).run({ isolation: 'read committed' }, (tx) => postings.assertCatalogueIn(tx, api.app.get(DomainEvents).declaredLedgerEvents()));
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
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
    const user = await createUser(database, { name: displayName, grants: [{ role, branchId: id('branch:DDW') }] });
    sessions.set(name, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the posting catalogue as data (FR-FIN-005)', () => {
  it('lists every event the ledger posts from, each with a complete rule set, manual journals as entered', async () => {
    const page = await get('accountant', '/finance/posting-event-types?limit=100');
    expect(page.status).toBe(200);
    const types = page.body.data as { code: string; amountKeys: string[]; hasCompleteRules: boolean }[];
    expect(types.map((t) => t.code)).toEqual([...api.app.get(LedgerPostings).handledTypes()].sort());
    expect(types.every((t) => t.hasCompleteRules)).toBe(true);
    expect(types.find((t) => t.code === 'fin.ManualJournalApproved')).toMatchObject({ ownerModule: 'fin', amountKeys: ['debit', 'credit'] });
    const manual = await get('accountant', '/finance/posting-rules?eventCode=fin.ManualJournalApproved');
    expect(manual.body.data).toEqual([
      expect.objectContaining({ amountKey: 'debit', side: 'D', account: null, determinantType: 'ENTERED', determinantRole: 'AS_ENTERED', approvalRequestId: null }),
      expect.objectContaining({ amountKey: 'credit', side: 'C', account: null, determinantType: 'ENTERED', determinantRole: 'AS_ENTERED', approvalRequestId: null }),
    ]);
    const levies = await get('owner', '/finance/account-determinations?determinantType=TAX_LEVY');
    expect(levies.body.data.map((d: { determinantKey: string; role: string; account: { code: string } }) => [d.determinantKey, d.role, d.account.code])).toEqual([
      ['*', 'INPUT', '1400'],
      ['*', 'OUTPUT', '2100'],
    ]);
  });
});

describe('a posting rule change waits for a different approver, then takes effect from its approval day (A-191)', () => {
  it('changes how a harvest posts from today, after approval only, and leaves what posted before as it was', async () => {
    const before = await harvest();
    expect(await harvestLines(before)).toEqual([
      ['1330', 'D', 12_000],
      ['5210', 'C', 12_000],
    ]);
    const old = await ruleInForce('inv.ProductionReceived', 'value', 'C', today());
    expect(old.account!.code).toBe('5210');

    const change = { eventCode: 'inv.ProductionReceived', amountKey: 'value', side: 'C', accountId: accountId('4020'), validFrom: today() };
    await stepUp('accountant');
    const asked = await post('accountant', '/finance/posting-rules', change);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'POSTING_RULE_CHANGE', subject: { docType: 'POSTING_RULE_CHANGE', number: null } });
    expect((await ruleInForce('inv.ProductionReceived', 'value', 'C', today())).id).toBe(old.id);
    const pending = await harvest();
    expect((await harvestLines(pending))[1]).toEqual(['5210', 'C', 12_000]);
    const twice = await post('accountant', '/finance/posting-rules', { ...change, accountId: accountId('4030') });
    expect(twice.body.error).toMatchObject({ code: 'POSTING_RULE_INVALID', details: [{ code: 'CHANGE_PENDING' }] });

    const approvalId = asked.body.approvalRequestId as string;
    await stepUp('accountant');
    expect((await post('accountant', `/iam/approvals/${approvalId}/approve`, { reason: 'Mine' })).body.error.code).toBe('MAKER_CANNOT_CHECK');
    await stepUp('manager');
    expect((await post('manager', `/iam/approvals/${approvalId}/approve`, { reason: 'Not mine' })).status).toBe(403);
    await stepUp('owner');
    expect((await post('owner', `/iam/approvals/${approvalId}/approve`, { reason: 'Harvest sold to traders, agreed' })).status).toBe(200);

    const now = await ruleInForce('inv.ProductionReceived', 'value', 'C', today());
    expect(now).toMatchObject({ account: { code: '4020' }, validFrom: today(), validTo: null, approvalRequestId: approvalId });
    const ended = (await get('accountant', '/finance/posting-rules?eventCode=inv.ProductionReceived&limit=100')).body.data.find((r: { id: string }) => r.id === old.id);
    expect(ended).toMatchObject({ account: { code: '5210' }, validTo: today() });
    const after = await harvest();
    expect(await harvestLines(after)).toEqual([
      ['1330', 'D', 12_000],
      ['4020', 'C', 12_000],
    ]);
    expect(await harvestLines(before)).toEqual([
      ['1330', 'D', 12_000],
      ['5210', 'C', 12_000],
    ]);
    expect((await harvestLines(pending))[1]).toEqual(['5210', 'C', 12_000]);
    await assertBootHolds();
    const audit = await admin().query<{ action: string }>("SELECT action FROM platform.audit_event WHERE module = 'fin' AND entity_id = $1", [now.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['APPLY_RULE_CHANGE']);
  });

  it('a change dated tomorrow leaves today as it is; a single Owner cannot approve their own', async () => {
    await stepUp('owner');
    const asked = await post('owner', '/finance/posting-rules', { eventCode: 'inv.ProductionReceived', amountKey: 'value', side: 'C', accountId: accountId('5210'), validFrom: tomorrow() });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    await stepUp('owner');
    expect((await post('owner', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Mine' })).body.error.code).toBe('MAKER_CANNOT_CHECK');
    await stepUp('accountant');
    expect((await post('accountant', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Back to own production' })).status).toBe(200);
    expect((await ruleInForce('inv.ProductionReceived', 'value', 'C', today())).account!.code).toBe('4020');
    expect((await ruleInForce('inv.ProductionReceived', 'value', 'C', tomorrow())).account!.code).toBe('5210');
    expect((await harvestLines(await harvest()))[1]).toEqual(['4020', 'C', 12_000]);
    await assertBootHolds();
  });

  it('a rejected change is final and changes nothing', async () => {
    await stepUp('accountant');
    const asked = await post('accountant', '/finance/posting-rules', { eventCode: 'prc.DirectCostIncurred', amountKey: 'value', side: 'C', accountId: accountId('2000'), validFrom: tomorrow() });
    expect(asked.body.error).toMatchObject({ code: 'POSTING_RULE_INVALID', details: [{ field: '/accountId', code: 'SUBLEDGER_DIFFERS' }] });
    const fine = await post('accountant', '/finance/posting-rules', { eventCode: 'prc.DirectCostIncurred', amountKey: 'value', side: 'C', accountId: accountId('2010'), validFrom: tomorrow() });
    expect(fine.status).toBe(202);
    await stepUp('owner');
    expect((await post('owner', `/iam/approvals/${fine.body.approvalRequestId as string}/reject`, { reason: 'Keep accruals apart' })).status).toBe(200);
    expect((await ruleInForce('prc.DirectCostIncurred', 'value', 'C', tomorrow())).account!.code).toBe('2020');
    const { rows } = await admin().query<{ status: string }>('SELECT status FROM fin.posting_rule_change WHERE id = $1', [fine.body.subject.id]);
    expect(rows[0]!.status).toBe('REJECTED');
  });

  it('names what a change breaks: the past, an amount the event lacks, a manual journal rule, nothing to replace', async () => {
    await stepUp('accountant');
    const refuse = async (body: object) => (await post('accountant', '/finance/posting-rules', body)).body.error;
    const base = { eventCode: 'inv.GoodsReceived', amountKey: 'value', side: 'C', accountId: accountId('2020'), validFrom: tomorrow() };
    expect(await refuse({ ...base, validFrom: '2026-01-01' })).toMatchObject({ code: 'POSTING_RULE_INVALID', details: [{ code: 'VALID_FROM_PAST' }] });
    expect(await refuse({ ...base, amountKey: 'gross' })).toMatchObject({ details: [{ code: 'UNKNOWN_AMOUNT' }] });
    expect(await refuse({ ...base, eventCode: 'bil.InvoiceIssued' })).toMatchObject({ details: [{ code: 'UNKNOWN_EVENT' }] });
    expect(await refuse({ ...base, eventCode: 'fin.ManualJournalApproved', amountKey: 'debit', side: 'D' })).toMatchObject({ details: [{ code: 'POSTS_AS_ENTERED' }] });
    expect(await refuse({ ...base, accountId: undefined })).toMatchObject({ details: [{ code: 'TARGET_INVALID' }] });
    expect(await refuse({ ...base, accountId: accountId('2010') })).toMatchObject({ details: [{ code: 'UNCHANGED' }] });
    expect((await post('accountant', '/finance/posting-rules', { ...base, determinantRole: 'NOT_A_ROLE' })).status).toBe(400);
  });
});

describe('an account determination change posts one levy to its own account (ADR-0020, A-191)', () => {
  it('adds a TAX_LEVY row for NHIL after a different approver, from the date asked for', async () => {
    const created = await post('accountant', '/finance/accounts', { code: '2110', name: 'NHIL payable', type: 'LIABILITY', isPostable: true, subledgerKind: 'TAX_LEVY' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await stepUp('accountant');
    const wrong = await post('accountant', '/finance/account-determinations', { determinantType: 'TAX_LEVY', determinantKey: 'NHIL', role: 'OUTPUT', accountId: accountId('4100'), validFrom: tomorrow() });
    expect(wrong.body.error).toMatchObject({ code: 'POSTING_RULE_INVALID', details: [{ code: 'SUBLEDGER_DIFFERS' }] });
    const asked = await post('accountant', '/finance/account-determinations', { determinantType: 'TAX_LEVY', determinantKey: 'NHIL', role: 'OUTPUT', accountId: created.body.id, validFrom: tomorrow() });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const listed = async () => (await get('owner', '/finance/account-determinations?determinantType=TAX_LEVY')).body.data as { determinantKey: string; account: { code: string }; validFrom: string }[];
    expect((await listed()).some((d) => d.determinantKey === 'NHIL')).toBe(false);
    await stepUp('accountant');
    expect((await post('accountant', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Mine' })).body.error.code).toBe('MAKER_CANNOT_CHECK');
    await stepUp('owner');
    expect((await post('owner', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'NHIL apart from VAT' })).status).toBe(200);
    expect((await listed()).find((d) => d.determinantKey === 'NHIL')).toMatchObject({ account: { code: '2110' }, validFrom: tomorrow() });
    const { rows } = await admin().query<{ approval_request_id: string }>("SELECT approval_request_id FROM fin.account_determination WHERE determinant_key = 'NHIL'");
    expect(rows).toEqual([{ approval_request_id: asked.body.approvalRequestId }]);
    await assertBootHolds();
  });

  it('refuses a determination or rule written without an approval by anyone but the System seed (0130)', async () => {
    const app = database.pool('app');
    const someone = (await admin().query<{ id: string }>("SELECT id FROM iam.principal WHERE kind = 'USER' LIMIT 1")).rows[0]!.id;
    const determination = app.query(
      `INSERT INTO fin.account_determination (id, determinant_type, determinant_key, role, account_id, valid_from, created_by, updated_by)
       VALUES ($1, 'TAX_LEVY', 'GETFL', 'OUTPUT', $2, DATE '2099-01-01', $3, $3)`,
      [randomUUID(), accountId('2100'), someone],
    );
    await expect(determination).rejects.toMatchObject({ code: SQLSTATE.checkViolation, constraint: 'ck_account_determination_approved' });
    const rule = app.query(
      `INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, valid_from, created_by, updated_by)
       VALUES ($1, 'inv.GoodsReceived', 'value', 'C', $2, DATE '2099-01-01', $3, $3)`,
      [randomUUID(), accountId('2020'), someone],
    );
    await expect(rule).rejects.toMatchObject({ code: SQLSTATE.checkViolation, constraint: 'ck_posting_rule_approved' });
  });
});

describe('every posting rule operation refuses the wrong role (ADR-0017, ADR-0035)', () => {
  for (const who of ['manager', 'storekeeper', 'cashier', 'sales', 'farmHand', 'driver']) {
    it(`refuses the ${who} with 403`, async () => {
      expect((await get(who, '/finance/posting-event-types')).status).toBe(403);
      expect((await get(who, '/finance/posting-rules')).status).toBe(403);
      expect((await get(who, '/finance/account-determinations')).status).toBe(403);
      expect((await post(who, '/finance/posting-rules', { eventCode: 'inv.GoodsReceived', amountKey: 'value', side: 'C', accountId: accountId('2020'), validFrom: '2030-01-01' })).status).toBe(403);
      expect((await post(who, '/finance/account-determinations', { determinantType: 'TAX_LEVY', determinantKey: 'NHIL', role: 'OUTPUT', accountId: accountId('2100'), validFrom: '2030-01-01' })).status).toBe(403);
    });
  }
});

describe('asking for a rule or determination change needs a fresh step-up', () => {
  it('refuses STEP_UP_REQUIRED once the five minutes have passed', async () => {
    for (const [name, displayName] of [
      ['freshAccountant', 'Esi Quaye'],
      ['freshOwner', 'Nana Owusu'],
    ] as const) {
      sessions.set(name, await enrolAndLogin(api.server, await createUser(database, { name: displayName, grants: [{ role: name === 'freshOwner' ? 'OWNER' : 'ACCOUNTANT', branchId: id('branch:DDW') }] }), () => clock.now()));
    }
    clock.advanceBy(310_000); // past the five-minute step-up window, well within a fresh session
    const rule = { eventCode: 'inv.GoodsReceived', amountKey: 'value', side: 'C', accountId: accountId('2020'), validFrom: '2030-01-01' };
    expect((await post('freshAccountant', '/finance/posting-rules', rule)).body.error.code).toBe('STEP_UP_REQUIRED');
    expect((await post('freshOwner', '/finance/account-determinations', { determinantType: 'TAX_LEVY', determinantKey: 'GETFL', role: 'OUTPUT', accountId: accountId('2100'), validFrom: '2030-01-01' })).body.error.code).toBe(
      'STEP_UP_REQUIRED',
    );
  });
});
