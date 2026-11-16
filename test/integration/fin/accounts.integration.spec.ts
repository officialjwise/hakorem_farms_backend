import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The chart of accounts over the API (FR-FIN-001, FR-FIN-002, A-188): the seeded chart of ADR-0003 as the accountant
 * lists it, an account added in its type's class with its type's normal side, renamed at its version, and closed only
 * at a nil balance once nothing in force posts to it; every operation refused to the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
const sessions = new Map<string, TestSession>();

const get = (who: string, path: string) => consoleGet(api.server, sessions.get(who)!, `/v1${path}`);
const create = (who: string, body: object, key: string = randomUUID()) => consolePost(api.server, sessions.get(who)!, '/v1/finance/accounts', key).send(body);
const patch = (who: string, id: string, body: object, key: string = randomUUID()) =>
  request(api.server)
    .patch(`/v1/finance/accounts/${id}`)
    .set('Cookie', sessions.get(who)!.jar.header())
    .set('X-CSRF-Token', sessions.get(who)!.csrfToken)
    .set('Origin', TEST_ORIGIN)
    .set('Idempotency-Key', key)
    .send(body);
const seeded = (code: string) => `01900000-0000-7000-8100-00000000${code}`;

interface AccountBody {
  readonly id: string;
  readonly code: string;
  readonly type: string;
  readonly normalSide: string;
  readonly isPostable: boolean;
  readonly subledgerKind: string | null;
  readonly status: string;
  readonly version: number;
}

async function allAccounts(who: string, query = ''): Promise<AccountBody[]> {
  const rows: AccountBody[] = [];
  let cursor: string | null = null;
  do {
    const page = await get(who, `/finance/accounts?limit=25${query}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
    expect(page.status).toBe(200);
    rows.push(...(page.body.data as AccountBody[]));
    cursor = page.body.page.nextCursor as string | null;
  } while (cursor !== null);
  return rows;
}

/** A balanced entry written as the System would post it, so an account carries a balance. */
async function postRaw(debitCode: string, creditCode: string, amount: number): Promise<void> {
  const client = await database.pool('app').connect();
  const id = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'JOURNAL', 'fin', $2, $3)", [id, branchId, SYSTEM_PRINCIPAL]);
    const { rows } = await client.query<{ id: string; day: string }>("SELECT id, (now() AT TIME ZONE 'Africa/Accra')::date::text AS day FROM fin.accounting_period WHERE (now() AT TIME ZONE 'Africa/Accra')::date BETWEEN start_date AND end_date");
    await client.query(
      `INSERT INTO fin.journal_entry (id, entry_no, posting_date, period_id, branch_id, kind, source_document_id, posting_group_id, description, occurred_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, 'MANUAL', $1, $6, 'Test balance', now(), $7)`,
      [id, `RAW-${id.slice(0, 8)}`, rows[0]!.day, rows[0]!.id, branchId, randomUUID(), SYSTEM_PRINCIPAL],
    );
    for (const [lineNo, code, side] of [
      [1, debitCode, 'D'],
      [2, creditCode, 'C'],
    ] as const) {
      await client.query('INSERT INTO fin.journal_line (journal_entry_id, line_no, account_id, side, amount_pesewas, branch_id, posting_date) VALUES ($1, $2, (SELECT id FROM fin.account WHERE code = $3), $4, $5, $6, $7)', [
        id,
        lineNo,
        code,
        side,
        amount,
        branchId,
        rows[0]!.day,
      ]);
    }
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  branchId = (await createBranch(database)).branchId;
  const people: [string, RoleCode, boolean][] = [
    ['owner', 'OWNER', true],
    ['accountant', 'ACCOUNTANT', true],
    ['manager', 'MANAGER', true],
    ['storekeeper', 'STOREKEEPER', false],
    ['cashier', 'CASHIER', false],
    ['sales', 'SALES', false],
    ['farmHand', 'FARM_HAND', false],
    ['driver', 'DRIVER', false],
  ];
  for (const [name, role, privileged] of people) {
    const user = await createUser(database, { name: `Test ${name}`, grants: [{ role, branchId }] });
    sessions.set(name, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the seeded chart of accounts (FR-FIN-001)', () => {
  it('lists every account of ADR-0003 in code order, each with its type, normal side and subledger', async () => {
    const accounts = await allAccounts('accountant');
    const codes = accounts.map((a) => a.code);
    expect(codes).toEqual([...codes].sort());
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    for (const code of ['1000', '1010', '1020', '1100', '1110', '1120', '1130', '1200', '1400', '2000', '2010', '2100', '2200', '2210', '2290', '2300', '2400', '3000', '3100', '3200', '3300', '3900', '4100', '4200', '4210', '4220', '6900']) {
      expect(byCode.has(code), code).toBe(true);
    }
    expect(byCode.get('1200')).toMatchObject({ type: 'ASSET', normalSide: 'D', subledgerKind: 'CUSTOMER', isPostable: true, status: 'ACTIVE' });
    expect(byCode.get('2000')).toMatchObject({ type: 'LIABILITY', normalSide: 'C', subledgerKind: 'SUPPLIER' });
    expect(byCode.get('3000')).toMatchObject({ type: 'EQUITY', normalSide: 'C', subledgerKind: 'INVESTOR' });
    // 4210 is income-type with a debit normal side, for variances (FR-FIN-001).
    expect(byCode.get('4210')).toMatchObject({ type: 'INCOME', normalSide: 'D', subledgerKind: null });
    expect(byCode.get('5000')).toMatchObject({ type: 'COST_OF_SALES', normalSide: 'D' });
    expect(byCode.get('6900')).toMatchObject({ type: 'EXPENSE', normalSide: 'D' });
  });

  it('filters by type and to postable accounts, and pages without skipping or repeating', async () => {
    const equity = await allAccounts('owner', '&type=EQUITY');
    expect(equity.map((a) => a.code)).toEqual(['3000', '3100', '3200', '3300', '3900']);
    const postable = await allAccounts('owner', '&postableOnly=true');
    expect(postable.every((a) => a.isPostable)).toBe(true);
    const all = await allAccounts('owner');
    expect(new Set(all.map((a) => a.id)).size).toBe(all.length);
  });
});

describe('adding an account (FR-FIN-002)', () => {
  it('adds 6110 Generator fuel as a postable expense with a debit normal side, once per key', async () => {
    const key = randomUUID();
    const body = { code: '6110', name: 'Generator fuel', type: 'EXPENSE', isPostable: true, cashFlowCategory: 'OPERATING' };
    const created = await create('accountant', body, key);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code: '6110', name: 'Generator fuel', type: 'EXPENSE', normalSide: 'D', parentId: null, isPostable: true, subledgerKind: null, cashFlowCategory: 'OPERATING', status: 'ACTIVE', version: 1 });
    const replay = await create('accountant', body, key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(created.body);
    const { rows } = await database.pool('admin').query("SELECT action, after FROM platform.audit_event WHERE module = 'fin' AND entity_type = 'Account' AND entity_id = $1", [created.body.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'CREATE' });
  });

  it('refuses a code already used, a code outside its class, a subledger on a header and a parent of another type', async () => {
    const taken = await create('accountant', { code: '1200', name: 'Receivables again', type: 'ASSET', isPostable: true });
    expect(taken.status).toBe(422);
    expect(taken.body.error).toMatchObject({ code: 'DUPLICATE_VALUE', details: [{ field: '/code', code: 'TAKEN' }] });
    const mismatch = await create('accountant', { code: '2150', name: 'Liability as an asset', type: 'ASSET', isPostable: false, subledgerKind: 'SUPPLIER', parentId: seeded('2000') });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe('ACCOUNT_INVALID');
    expect((mismatch.body.error.details as { field: string; code: string }[]).map((d) => [d.field, d.code])).toEqual([
      ['/code', 'CLASS_MISMATCH'],
      ['/subledgerKind', 'SUBLEDGER_ON_HEADER'],
      ['/parentId', 'PARENT_TYPE_MISMATCH'],
    ]);
    const unknownParent = await create('accountant', { code: '6120', name: 'Generator oil', type: 'EXPENSE', isPostable: true, parentId: randomUUID() });
    expect(unknownParent.body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/parentId' }] });
    const malformed = await create('accountant', { code: '7000', name: 'Not a class', type: 'EXPENSE', isPostable: true });
    expect(malformed.status).toBe(400);
    const sideGiven = await create('accountant', { code: '6130', name: 'Side given', type: 'EXPENSE', isPostable: true, normalSide: 'C' });
    expect(sideGiven.status).toBe(400);
  });
});

describe('renaming and closing an account (FR-FIN-002)', () => {
  it('renames at the version read, refuses a stale version, and closes and reopens an unused account', async () => {
    const created = await create('accountant', { code: '6140', name: 'Borehole pump', type: 'EXPENSE', isPostable: true });
    const renamed = await patch('accountant', created.body.id, { version: 1, name: 'Borehole pump and repairs' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Borehole pump and repairs', version: 2 });
    expect((await patch('accountant', created.body.id, { version: 1, name: 'Stale' })).status).toBe(409);
    const closed = await patch('owner', created.body.id, { version: 2, status: 'CLOSED' });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'CLOSED', version: 3 });
    const reopened = await patch('owner', created.body.id, { version: 3, status: 'ACTIVE' });
    expect(reopened.body).toMatchObject({ status: 'ACTIVE', version: 4 });
    expect((await patch('owner', randomUUID(), { version: 1, name: 'Nobody' })).status).toBe(404);
  });

  it('refuses to close an account with a balance, by its pesewa, and one a posting rule in force names', async () => {
    const created = await create('accountant', { code: '6150', name: 'Veterinary call-outs', type: 'EXPENSE', isPostable: true });
    await postRaw('6150', '1010', 1);
    const withBalance = await patch('accountant', created.body.id, { version: 1, status: 'CLOSED' });
    expect(withBalance.status).toBe(422);
    expect(withBalance.body.error).toMatchObject({ code: 'ACCOUNT_INVALID', details: [{ field: '/status', code: 'BALANCE_NOT_ZERO' }] });
    await postRaw('1010', '6150', 1);
    expect((await patch('accountant', created.body.id, { version: 1, status: 'CLOSED' })).status).toBe(200);
    const live = (await allAccounts('accountant', '&type=ASSET')).find((a) => a.code === '1310')!;
    const named = await patch('accountant', live.id, { version: live.version, status: 'CLOSED' });
    expect(named.status).toBe(422);
    expect((named.body.error.details as { code: string }[]).map((d) => d.code)).toContain('IN_USE_BY_RULE');
  });
});

describe('the chart refuses the wrong role (ADR-0017, ADR-0035)', () => {
  for (const who of ['manager', 'storekeeper', 'cashier', 'sales', 'farmHand', 'driver']) {
    it(`refuses the ${who} every account operation with 403`, async () => {
      expect((await get(who, '/finance/accounts')).status).toBe(403);
      expect((await create(who, { code: '6190', name: 'Refused', type: 'EXPENSE', isPostable: true })).status).toBe(403);
      expect((await patch(who, seeded('6900'), { version: 1, name: 'Refused' })).status).toBe(403);
    });
  }

  it('wrote nothing for a refused create', async () => {
    const { rows } = await database.pool('admin').query("SELECT 1 FROM fin.account WHERE code = '6190'");
    expect(rows).toHaveLength(0);
  });
});
