import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SalePosting, type SaleRequest } from '../../../src/modules/ord';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * BL-077 (a defect, scheduled into B09u): approving the void of a sale whose payment already has a reversal waiting
 * answered 500, because `Receipts.reverseApprovedIn` wrote a second open reversal for the payment and the database's
 * `uq_payment_reversal_open` refused it. The exact case `test/integration/pos/till-cash-paths` found: a cash sale at the
 * till, a reversal of its payment asked for, a void of the sale asked for, the void approved.
 * - The void's approval is refused with 422 `ORDER_INVALID` (`REVERSAL_PENDING`) while a reversal waits, and nothing
 *   changes; once the reversal is decided against, the same void is approved.
 * - A reversal is refused with 422 `PAYMENT_REVERSAL_INVALID` (`VOID_PENDING`) while a void of the payment's sale waits.
 * - The database never holds two open reversals of one payment (`uq_payment_reversal_open`), by direct SQL.
 * Figures are read back by SQL over PAY's and ORD's tables.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let nextId: () => string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
let till: { id: string; code: string };
let shift: string;
let branchId: string;
let shopId: string;
let yam: string;
const admin = () => database.pool('admin');
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, sessions.get(who)!, `/v1${path}`, key).send(body);
const one = async <T>(sql: string, values: unknown[]): Promise<T> => (await admin().query(sql, values)).rows[0] as T;
const step = (who: string) => stepUp(api.server, sessions.get(who)! as TotpSession, clock);
const actorOf = (who: string): Actor => ({ principalId: users.get(who)!.principalId, kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });

/** A counter sale of one yam (2,000) taken in cash at the cashier's open shift on T1, through ORD's one sale path. */
async function sale(): Promise<{ order: string; payment: string }> {
  const posting = api.app.get(SalePosting);
  const request: SaleRequest = {
    orderId: nextId(),
    channel: 'POS',
    branchId,
    fulfilmentMode: 'COUNTER',
    taxInclusive: true,
    shiftDocumentId: shift,
    lines: [{ productId: yam, fromLocationId: shopId, quantity: '1.000' }],
    tenders: [{ methodCode: 'CASH', amountPesewas: 2_000n, register: till }],
  };
  const posted = await runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'void pending reversal', actor: actorOf('adwoa') }, () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable', seriesLocks: posting.locksFor(branchId) }, (tx) => posting.postIn(tx, actorOf('adwoa'), request)),
  );
  const payment = (await one<{ id: string }>('SELECT id FROM pay.payment WHERE order_document_id = $1', [posted.id])).id;
  return { order: posted.id, payment };
}

async function state(order: string, payment: string) {
  return one<{ order: string; payment: string; open: number; reversing: number }>(
    `SELECT (SELECT status FROM ord.sales_order WHERE id = $1) AS order,
            (SELECT status FROM pay.payment WHERE id = $2) AS payment,
            (SELECT count(*)::int FROM pay.payment_reversal WHERE payment_id = $2 AND status <> 'REJECTED') AS open,
            (SELECT count(*)::int FROM pay.payment WHERE reverses_payment_id = $2) AS reversing`,
    [order, payment],
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await one<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'", [])).id;
  shopId = (await one<{ id: string }>("SELECT l.id FROM mdm.location l WHERE l.branch_id = $1 AND l.code = 'SHOP'", [branchId])).id;
  yam = (await one<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'PRD-0005'", [])).id;
  for (const [who, name, role, totp] of [
    ['owner', 'Esi Mensah', 'OWNER', true],
    ['manager', 'Kwabena Owusu', 'MANAGER', true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
    ['adwoa', 'Adwoa Darko', 'CASHIER', false],
  ] as const) {
    const user = await createUser(database, { name, grants: [{ role, branchId, ...(role === 'CASHIER' ? { locationId: shopId } : {}) }] });
    users.set(who, user);
    sessions.set(who, totp ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  const created = await post('manager', '/registers', { branchId, locationId: shopId, code: 'T1', name: 'Void and reversal till T1' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  till = { id: created.body.id as string, code: 'T1' };
  shift = nextId();
  const opened = await post('adwoa', '/shifts', { id: shift, registerId: till.id, openingFloatPesewas: 0, openedAt: clock.now().toISOString() }, shift);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('a void approved while a reversal of its payment waits (BL-077, the exact case)', () => {
  it('refuses the approval with 422 ORDER_INVALID REVERSAL_PENDING, changes nothing, and approves the same void once the reversal is rejected', async () => {
    const { order, payment } = await sale();
    const reversal = await post('accountant', `/payments/${payment}/reverse`, { reasonCode: 'RECORDED_IN_ERROR', note: 'Keyed twice at the till' });
    expect(reversal.status, JSON.stringify(reversal.body)).toBe(202);
    const voided = await post('manager', `/orders/${order}/void`, { reasonCode: 'CUSTOMER_CHANGED_MIND', note: 'Came back for the money' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(202);

    await step('owner');
    const refused = await post('owner', `/iam/approvals/${voided.body.approvalRequestId as string}/approve`, { reason: 'Seen the yam' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'ORDER_INVALID', details: [expect.objectContaining({ field: '/payments', code: 'REVERSAL_PENDING' })] });
    expect(refused.body.error.correlationId).toEqual(expect.any(String));
    expect(await state(order, payment)).toEqual({ order: 'COMPLETED', payment: 'CLEARED', open: 1, reversing: 0 });

    await step('manager');
    const rejected = await post('manager', `/iam/approvals/${reversal.body.approvalRequestId as string}/reject`, { reason: 'The void gives the money back' });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    await step('owner');
    const approved = await post('owner', `/iam/approvals/${voided.body.approvalRequestId as string}/approve`, { reason: 'Seen the yam' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await state(order, payment)).toEqual({ order: 'VOIDED', payment: 'REVERSED', open: 1, reversing: 1 });
  });
});

describe('a reversal asked for while a void of the sale waits', () => {
  it('refuses it with 422 PAYMENT_REVERSAL_INVALID VOID_PENDING and writes no reversal', async () => {
    const { order, payment } = await sale();
    const voided = await post('manager', `/orders/${order}/void`, { reasonCode: 'CUSTOMER_CHANGED_MIND', note: 'Came back for the money' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(202);
    const refused = await post('accountant', `/payments/${payment}/reverse`, { reasonCode: 'RECORDED_IN_ERROR', note: 'Keyed twice at the till' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'PAYMENT_REVERSAL_INVALID', details: [expect.objectContaining({ code: 'VOID_PENDING' })] });
    expect(await state(order, payment)).toEqual({ order: 'COMPLETED', payment: 'CLEARED', open: 0, reversing: 0 });
    // The void goes through as asked.
    await step('owner');
    expect((await post('owner', `/iam/approvals/${voided.body.approvalRequestId as string}/approve`, { reason: 'Seen the yam' })).status).toBe(200);
    expect(await state(order, payment)).toEqual({ order: 'VOIDED', payment: 'REVERSED', open: 1, reversing: 1 });
  });
});

describe('the database holds one open reversal per payment, by direct SQL that bypasses the application', () => {
  it('refuses a second open reversal of a payment whose reversal waits with 23505 uq_payment_reversal_open', async () => {
    const { payment } = await sale();
    const reversal = await post('accountant', `/payments/${payment}/reverse`, { reasonCode: 'RECORDED_IN_ERROR', note: 'Keyed twice at the till' });
    expect(reversal.status).toBe(202);
    const client = await database.pool('app').connect();
    try {
      await client.query('BEGIN');
      await expect(
        client.query(
          `INSERT INTO pay.payment_reversal (id, payment_id, reason_code, note, status, branch_id, created_by, updated_by)
           SELECT $1, payment_id, 'SALE_VOIDED', 'A void beside the waiting reversal', 'PENDING_APPROVAL', branch_id, created_by, created_by
             FROM pay.payment_reversal WHERE payment_id = $2`,
          [nextId(), payment],
        ),
      ).rejects.toMatchObject({ code: '23505', constraint: 'uq_payment_reversal_open' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
