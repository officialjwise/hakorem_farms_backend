import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SalePosting, type SaleRequest } from '../../../src/modules/ord';
import { Payments, ProviderPayments } from '../../../src/modules/pay';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { paystackEnvironment, startFakePaystack, type FakePaystack } from '../../support/fake-paystack';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { initiateCharge } from '../../support/pay';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Every way cash is recorded goes through an open till shift of the till, the cashier's own (ADR-0077, the owner on
 * A-212 (a), A-273 (i) and (k)). For each path (a sale's tender through ORD, a direct PAY tender, a direct PAY write,
 * a mobile money charge taken at the till, a cash refund paid by hand, a payment reversed, a sale voided, a cash
 * movement) cash naming another cashier's shift, another till, a closed shift or a force-closed shift is refused and
 * nothing is recorded. The figures are read back by SQL over `pay.payment`, `pay.refund`, `pos.cash_movement` and the
 * journal lines, never from the code under test.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let fake: FakePaystack;
let nextId: () => string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const tills = new Map<string, { id: string; code: string }>();
const shifts = new Map<string, string>();
let branchId: string;
let shopId: string;
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const one = async <T>(sql: string, values: unknown[]): Promise<T> => (await admin().query(sql, values)).rows[0] as T;
const step = (who: string) => stepUp(api.server, as(who) as TotpSession, clock);
const actorOf = (who: string): Actor => ({ principalId: users.get(who)!.principalId, kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });
const counts = async () =>
  one<{ payments: number; orders: number; movements: number }>(
    'SELECT (SELECT count(*)::int FROM pay.payment) AS payments, (SELECT count(*)::int FROM ord.sales_order) AS orders, (SELECT count(*)::int FROM pos.cash_movement) AS movements',
    [],
  );

/** A counter sale posted through ORD's one sale path, its cash naming a shift and a till. */
function sell(who: string, shift: string, till: { id: string; code: string }, yams: number) {
  const posting = api.app.get(SalePosting);
  const request: SaleRequest = {
    orderId: nextId(),
    channel: 'POS',
    branchId,
    fulfilmentMode: 'COUNTER',
    taxInclusive: true,
    shiftDocumentId: shift,
    lines: [{ productId: idOf('yam'), fromLocationId: shopId, quantity: `${yams}.000` }],
    tenders: [{ methodCode: 'CASH', amountPesewas: BigInt(yams * 2_000), register: till }],
  };
  return runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'cash paths', actor: actorOf(who) }, () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable', seriesLocks: posting.locksFor(branchId) }, (tx) => posting.postIn(tx, actorOf(who), request)),
  );
}

/** A tender straight into PAY, as any module could call it. */
function payDirect(who: string, shift: string, till: { id: string; code: string }, amount: bigint) {
  return runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'cash paths', actor: actorOf(who) }, () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable' }, (tx) =>
      api.app.get(Payments).recordIn(tx, actorOf(who), { branchId, channel: 'WHOLESALE', methodCode: 'CASH', amountPesewas: amount, customerId: null, orderDocumentId: null, shiftDocumentId: shift, register: till, receivedAt: clock.now(), allocations: [] }),
    ),
  );
}

/** A payment written straight through PAY's lowest door, `writeIn`, bypassing `recordIn`'s own checks. */
async function writeDirect(who: string, shift: string, till: { id: string; code: string }, amount: bigint) {
  const methodId = (await one<{ id: string }>("SELECT id FROM mdm.payment_method WHERE code = 'CASH'", [])).id;
  return runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'cash paths', actor: actorOf(who) }, () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable' }, (tx) =>
      api.app.get(Payments).writeIn(tx, actorOf(who).principalId, {
        id: nextId(),
        paymentMethodId: methodId,
        methodKind: 'CASH',
        amountPesewas: amount,
        customerId: null,
        orderDocumentId: null,
        shiftDocumentId: shift,
        register: till,
        verification: 'NOT_REQUIRED',
        status: 'CLEARED',
        receivedAt: clock.now(),
        clearedAt: clock.now(),
        branchId,
        actorId: actorOf(who).principalId,
        allocations: [],
        postsAtReceipt: true,
      }),
    ),
  );
}

const ids = new Map<string, string>();
const idOf = (code: string) => ids.get(code)!;
const refusal = (rule: string) => ({ code: 'PAYMENT_INVALID', details: [expect.objectContaining({ code: rule })] });

/** Cash the till should hold by the records: the shift's cleared cash payments less the cash refunds paid out of it. */
async function cashBySql(shift: string): Promise<number> {
  const row = await one<{ n: string }>(
    `SELECT ((SELECT COALESCE(sum(amount_pesewas), 0) FROM pay.payment WHERE shift_document_id = $1 AND method_kind = 'CASH' AND status = 'CLEARED')
           - (SELECT COALESCE(sum(amount_pesewas), 0) FROM pay.refund WHERE paid_from_shift_id = $1 AND status = 'PAID')
           + (SELECT COALESCE(sum(CASE WHEN kind IN ('FLOAT_IN', 'PAY_IN') THEN amount_pesewas ELSE -amount_pesewas END), 0) FROM pos.cash_movement WHERE shift_id = $1))::text AS n`,
    [shift],
  );
  return Number(row.n);
}

/** Debits less credits on 1000 against one till. */
async function tillLedger(registerId: string): Promise<number> {
  const row = await one<{ n: string }>(
    `SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS n
       FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id JOIN fin.subledger_party p ON p.id = l.subledger_party_id
      WHERE a.code = '1000' AND p.kind = 'REGISTER' AND p.ref_id = $1`,
    [registerId],
  );
  return Number(row.n);
}

async function openShift(who: string, till: string): Promise<string> {
  const id = nextId();
  const response = await post(who, '/shifts', { id, registerId: tills.get(till)!.id, openingFloatPesewas: 0, openedAt: clock.now().toISOString() }, id);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return id;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  fake = await startFakePaystack(() => clock.now());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { ...paystackEnvironment(fake), AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await one<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'", [])).id;
  shopId = (await one<{ id: string }>("SELECT l.id FROM mdm.location l WHERE l.branch_id = $1 AND l.code = 'SHOP'", [branchId])).id;
  ids.set('yam', (await one<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'PRD-0005'", [])).id);
  for (const [who, name, role, totp] of [
    ['owner', 'Esi Mensah', 'OWNER', true],
    ['manager', 'Kwabena Owusu', 'MANAGER', true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
    ['adwoa', 'Adwoa Darko', 'CASHIER', false],
    ['nana', 'Nana Yeboah', 'CASHIER', false],
    ['efua', 'Efua Sarpong', 'CASHIER', false],
    ['kofi', 'Kofi Boadu', 'CASHIER', false],
  ] as const) {
    const user = await createUser(database, { name, grants: [{ role, branchId, ...(role === 'CASHIER' ? { locationId: shopId } : {}) }] });
    users.set(who, user);
    sessions.set(who, totp ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  for (const code of ['T1', 'T2', 'T3', 'T4']) {
    const created = await post('manager', '/registers', { branchId, locationId: shopId, code, name: `Cash paths till ${code}` });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    tills.set(code, { id: created.body.id as string, code });
  }
  shifts.set('adwoa', await openShift('adwoa', 'T1'));
  shifts.set('nana', await openShift('nana', 'T2'));
  // Efua's shift on T3 takes a sale, then is counted and signed off: CLOSED.
  shifts.set('efua', await openShift('efua', 'T3'));
  await sell('efua', shifts.get('efua')!, tills.get('T3')!, 1);
  await sell('efua', shifts.get('efua')!, tills.get('T3')!, 1);
  expect((await post('efua', `/shifts/${shifts.get('efua')!}/close`, { declared: [{ paymentMethodId: (await one<{ id: string }>("SELECT id FROM mdm.payment_method WHERE code = 'CASH'", [])).id, declaredPesewas: 4_000 }] })).status).toBe(200);
  await step('manager');
  expect((await post('manager', `/shifts/${shifts.get('efua')!}/approve-close`, { reason: 'Counted with Efua' })).status).toBe(200);
  // Kofi's shift on T4 takes a sale, then is closed as the force close leaves it (forceCloseShift is the next part's):
  // CLOSED at its expected cash, flagged force-closed.
  shifts.set('kofi', await openShift('kofi', 'T4'));
  await sell('kofi', shifts.get('kofi')!, tills.get('T4')!, 1);
  await sell('kofi', shifts.get('kofi')!, tills.get('T4')!, 1);
  await admin().query("UPDATE pos.shift SET status = 'CLOSING', declared_at = $2, declared_cash_pesewas = 4000, updated_by = cashier_id, version = version + 1 WHERE id = $1", [shifts.get('kofi')!, clock.now()]);
  await admin().query(
    `UPDATE pos.shift SET status = 'CLOSED', expected_cash_pesewas = 4000, over_short_pesewas = 0, over_short_direction = 'EXACT', closed_at = $2, close_approved_by = $3,
            force_closed = true, posted_at = $2, posted_by = $3, updated_by = $3, version = version + 1 WHERE id = $1`,
    [shifts.get('kofi')!, clock.now(), users.get('manager')!.principalId],
  );
});

afterAll(async () => {
  await api?.close();
  await fake?.close();
  await database.drop();
});

describe('a sale tender through ORD (SalePosting.postIn)', () => {
  it('takes cash into the cashier own open shift on its till: 6,000 recorded and on T1', async () => {
    const sale = await sell('adwoa', shifts.get('adwoa')!, tills.get('T1')!, 3);
    expect(sale).toMatchObject({ status: 'COMPLETED', finalTotalPesewas: 6_000 });
    expect(await one('SELECT shift_document_id AS shift, register_ref AS till FROM pay.payment WHERE order_document_id = $1', [sale.id])).toEqual({ shift: shifts.get('adwoa'), till: tills.get('T1')!.id });
    expect(await cashBySql(shifts.get('adwoa')!)).toBe(6_000);
    expect(await tillLedger(tills.get('T1')!.id)).toBe(6_000);
  });

  it('refuses another cashier shift, another till, a closed shift and a force-closed shift, recording nothing', async () => {
    const before = await counts();
    await expect(sell('adwoa', shifts.get('nana')!, tills.get('T2')!, 1)).rejects.toMatchObject(refusal('SHIFT_NOT_OWN'));
    await expect(sell('adwoa', shifts.get('adwoa')!, tills.get('T2')!, 1)).rejects.toMatchObject(refusal('SHIFT_OTHER_REGISTER'));
    await expect(sell('efua', shifts.get('efua')!, tills.get('T3')!, 1)).rejects.toMatchObject(refusal('SHIFT_NOT_OPEN'));
    await expect(sell('kofi', shifts.get('kofi')!, tills.get('T4')!, 1)).rejects.toMatchObject(refusal('SHIFT_NOT_OPEN'));
    expect(await counts()).toEqual(before);
    expect(await tillLedger(tills.get('T2')!.id)).toBe(0);
  });
});

describe('a tender straight into PAY (Payments.recordIn and Payments.writeIn), as any module could call them', () => {
  it('refuses another cashier shift, a closed shift, a force-closed shift and a document that is no shift, recording nothing', async () => {
    const before = await counts();
    await expect(payDirect('adwoa', shifts.get('nana')!, tills.get('T2')!, 1_000n)).rejects.toMatchObject(refusal('SHIFT_NOT_OWN'));
    await expect(payDirect('efua', shifts.get('efua')!, tills.get('T3')!, 1_000n)).rejects.toMatchObject(refusal('SHIFT_NOT_OPEN'));
    await expect(payDirect('kofi', shifts.get('kofi')!, tills.get('T4')!, 1_000n)).rejects.toMatchObject(refusal('SHIFT_NOT_OPEN'));
    await expect(writeDirect('adwoa', shifts.get('nana')!, tills.get('T2')!, 1_000n)).rejects.toMatchObject(refusal('SHIFT_NOT_OWN'));
    await expect(writeDirect('efua', shifts.get('efua')!, tills.get('T3')!, 1_000n)).rejects.toMatchObject(refusal('SHIFT_NOT_OPEN'));
    await expect(writeDirect('kofi', shifts.get('kofi')!, tills.get('T4')!, 1_000n)).rejects.toMatchObject(refusal('SHIFT_NOT_OPEN'));
    // A business document that is not a till shift (a sales order) answers SHIFT_UNKNOWN.
    const order = (await one<{ id: string }>('SELECT id FROM ord.sales_order LIMIT 1', [])).id;
    await expect(writeDirect('adwoa', order, tills.get('T1')!, 1_000n)).rejects.toMatchObject(refusal('SHIFT_UNKNOWN'));
    expect(await counts()).toEqual(before);
  });

  it('lets a manager recovering the till put cash on the cashier shift, which the cashier counts', async () => {
    await payDirect('manager', shifts.get('adwoa')!, tills.get('T1')!, 1_000n);
    expect(await cashBySql(shifts.get('adwoa')!)).toBe(7_000);
  });
});

describe('a mobile money charge taken at the till (initiateMobileMoneyCharge with shiftId)', () => {
  it('names the cashier own open shift, and refuses another cashier shift, a closed or a force-closed shift', async () => {
    const taken = await initiateCharge(api.server, as('adwoa'), { amountPesewas: 5_000, shiftId: shifts.get('adwoa') });
    expect(taken.status, JSON.stringify(taken.body)).toBe(201);
    expect(taken.body).toMatchObject({ shiftId: shifts.get('adwoa'), status: 'PENDING' });
    const before = await counts();
    for (const [who, shift, rule] of [
      ['adwoa', shifts.get('nana')!, 'SHIFT_NOT_OWN'],
      ['efua', shifts.get('efua')!, 'SHIFT_NOT_OPEN'],
      ['kofi', shifts.get('kofi')!, 'SHIFT_NOT_OPEN'],
    ] as const) {
      const refused = await initiateCharge(api.server, as(who), { amountPesewas: 5_000, shiftId: shift });
      expect(refused.status, who).toBe(422);
      expect(refused.body.error).toMatchObject({ code: 'PAYMENT_INVALID', details: [expect.objectContaining({ field: '/shiftId', code: rule })] });
    }
    expect(await counts()).toEqual(before);
  });

  it('refuses the same in a charge another module writes in its own transaction (ProviderPayments.chargeIn): a closed, a force-closed and another cashier shift', async () => {
    const order = (await one<{ id: string }>('SELECT id FROM ord.sales_order WHERE shift_document_id = $1 LIMIT 1', [shifts.get('efua')])).id;
    const before = await counts();
    for (const [who, shift, rule] of [
      ['efua', shifts.get('efua')!, 'SHIFT_NOT_OPEN'],
      ['kofi', shifts.get('kofi')!, 'SHIFT_NOT_OPEN'],
      ['adwoa', shifts.get('nana')!, 'SHIFT_NOT_OWN'],
    ] as const) {
      await expect(
        runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'cash paths', actor: actorOf(who) }, () =>
          api.app.get(UnitOfWork).run({ isolation: 'serializable' }, (tx) =>
            api.app.get(ProviderPayments).chargeIn(tx, actorOf(who).principalId, { id: nextId(), amountPesewas: 2_000n, payerPhone: '+233244512876', network: 'MTN', orderId: order, shiftId: shift, customerId: null }),
          ),
        ),
      ).rejects.toMatchObject(refusal(rule));
    }
    expect(await counts()).toEqual(before);
  });
});

describe('a cash refund paid by hand (markRefundPaid, A-273 (i))', () => {
  let refundId: string;
  let paymentId: string;

  beforeAll(async () => {
    // Cash taken on deposit at the till (a sale's payment is refunded only against its credit note, ADR-0066).
    paymentId = (await payDirect('adwoa', shifts.get('adwoa')!, tills.get('T1')!, 4_000n)).id;
    const asked = await post('manager', '/refunds', { originalPaymentId: paymentId, amountPesewas: 1_500, destination: 'ORIGINAL_METHOD', reasonCode: 'WRONG_ITEM', note: 'One yam was soft' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    refundId = asked.body.subject.id as string;
    await step('owner');
    expect((await post('owner', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Seen the yam' })).status).toBe(200);
  });

  const markPaid = (who: string, body: object) => post(who, `/refunds/${refundId}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'TILL-T1-0007', ...body });

  it('refuses a payout with no shift, out of another till, by someone who may not reach the cashier shift, and out of a closed or force-closed shift', async () => {
    await step('owner');
    await step('accountant');
    for (const [who, body, rule] of [
      ['owner', {}, 'SHIFT_REQUIRED'],
      ['owner', { shiftId: shifts.get('nana') }, 'SHIFT_OTHER_REGISTER'],
      ['accountant', { shiftId: shifts.get('adwoa') }, 'SHIFT_NOT_OWN'],
      ['owner', { shiftId: shifts.get('efua') }, 'SHIFT_NOT_OPEN'],
      ['owner', { shiftId: shifts.get('kofi') }, 'SHIFT_NOT_OPEN'],
    ] as const) {
      const refused = await markPaid(who, body);
      expect(refused.status, `${who} ${JSON.stringify(body)}`).toBe(422);
      expect(refused.body.error).toMatchObject({ code: 'REFUND_INVALID', details: [expect.objectContaining({ field: '/shiftId', code: rule })] });
    }
    expect(await one('SELECT status, paid_from_shift_id FROM pay.refund WHERE id = $1', [refundId])).toEqual({ status: 'APPROVED', paid_from_shift_id: null });
  });

  it('pays it out of the open shift of the till that took the payment, counted against that shift: 1,500 out of T1', async () => {
    const before = await cashBySql(shifts.get('adwoa')!);
    const ledgerBefore = await tillLedger(tills.get('T1')!.id);
    const paid = await markPaid('owner', { shiftId: shifts.get('adwoa') });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(await one('SELECT status, paid_from_shift_id FROM pay.refund WHERE id = $1', [refundId])).toEqual({ status: 'PAID', paid_from_shift_id: shifts.get('adwoa') });
    expect(await cashBySql(shifts.get('adwoa')!)).toBe(before - 1_500);
    expect(await tillLedger(tills.get('T1')!.id)).toBe(ledgerBefore - 1_500);
  });

  it('the database refuses a till cash refund paid with no shift, and changing the shift a refund was paid out of', async () => {
    const second = await post('manager', '/refunds', { originalPaymentId: paymentId, amountPesewas: 500, destination: 'ORIGINAL_METHOD', reasonCode: 'WRONG_ITEM', note: 'Another soft yam' });
    expect(second.status).toBe(202);
    const id = second.body.subject.id as string;
    await step('owner');
    expect((await post('owner', `/iam/approvals/${second.body.approvalRequestId as string}/approve`, { reason: 'Seen it' })).status).toBe(200);
    await expect(
      admin().query("UPDATE pay.refund SET status = 'PAID', paid_at = $2, paid_by = $3, posted_at = $2, posted_by = $3, updated_by = $3 WHERE id = $1", [id, clock.now(), users.get('owner')!.principalId]),
    ).rejects.toMatchObject({ constraint: 'ck_refund_till_shift' });
    // A paid refund never changes, the shift it was paid out of included (pay.refund_guard).
    await expect(admin().query('UPDATE pay.refund SET paid_from_shift_id = $2 WHERE id = $1', [refundId, shifts.get('nana')])).rejects.toMatchObject({ constraint: 'ck_refund_transition' });
  });
});

describe('a payment reversed (reversePayment) and a sale voided (voidOrder)', () => {
  it('reverses cash out of the open shift it was taken in: T1 and its shift both down by exactly the payment', async () => {
    const sale = await sell('adwoa', shifts.get('adwoa')!, tills.get('T1')!, 1);
    const payment = (await one<{ id: string }>('SELECT id FROM pay.payment WHERE order_document_id = $1', [sale.id])).id;
    const before = await cashBySql(shifts.get('adwoa')!);
    const ledgerBefore = await tillLedger(tills.get('T1')!.id);
    const asked = await post('accountant', `/payments/${payment}/reverse`, { reasonCode: 'RECORDED_IN_ERROR', note: 'Keyed twice at the till' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    await step('manager');
    const approved = await post('manager', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Checked against the drawer' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await cashBySql(shifts.get('adwoa')!)).toBe(before - 2_000);
    expect(await tillLedger(tills.get('T1')!.id)).toBe(ledgerBefore - 2_000);
  });

  it('refuses to reverse cash taken in a closed or a force-closed shift: nothing leaves the till', async () => {
    for (const who of ['efua', 'kofi']) {
      const payment = (await one<{ id: string }>("SELECT id FROM pay.payment WHERE shift_document_id = $1 AND status = 'CLEARED' ORDER BY id LIMIT 1", [shifts.get(who)])).id;
      const asked = await post('accountant', `/payments/${payment}/reverse`, { reasonCode: 'RECORDED_IN_ERROR', note: 'Found after the close' });
      expect(asked.status, JSON.stringify(asked.body)).toBe(202);
      await step('manager');
      const refused = await post('manager', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Checked' });
      expect(refused.status, who).toBe(422);
      expect(refused.body.error).toMatchObject({ code: 'PAYMENT_INVALID', details: [expect.objectContaining({ code: 'SHIFT_NOT_OPEN' })] });
      expect(await one('SELECT status FROM pay.payment WHERE id = $1', [payment])).toEqual({ status: 'CLEARED' });
    }
    expect(await tillLedger(tills.get('T3')!.id)).toBe(0);
  });

  it('refuses to void a cash sale whose shift has closed or was force-closed: the order stays COMPLETED and no reversing payment exists', async () => {
    for (const who of ['efua', 'kofi']) {
      // The sale whose payment no reversal has been asked for.
      const sale = (await one<{ id: string }>("SELECT order_document_id AS id FROM pay.payment WHERE shift_document_id = $1 AND status = 'CLEARED' ORDER BY id DESC LIMIT 1", [shifts.get(who)])).id;
      const asked = await post('manager', `/orders/${sale}/void`, { reasonCode: 'CUSTOMER_CHANGED_MIND', note: 'Came back after the close' });
      expect(asked.status, JSON.stringify(asked.body)).toBe(202);
      await step('owner');
      const refused = await post('owner', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Seen the yams' });
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body.error).toMatchObject({ code: 'PAYMENT_INVALID', details: [expect.objectContaining({ code: 'SHIFT_NOT_OPEN' })] });
      expect(await one('SELECT status FROM ord.sales_order WHERE id = $1', [sale])).toEqual({ status: 'COMPLETED' });
      expect(await one<{ n: number }>('SELECT count(*)::int AS n FROM pay.payment WHERE reverses_payment_id IS NOT NULL AND order_document_id = $1', [sale])).toEqual({ n: 0 });
    }
  });
});

describe('a cash movement (recordCashMovement)', () => {
  it('refuses another cashier, a closed shift and a force-closed shift', async () => {
    const before = await counts();
    const move = (who: string, shift: string) => {
      const id = nextId();
      return post(who, `/shifts/${shift}/cash-movements`, { id, kind: 'PAY_IN', amountPesewas: 1_000, reasonCode: 'FLOAT_TOP_UP', occurredAt: clock.now().toISOString() }, id);
    };
    expect((await move('nana', shifts.get('adwoa')!)).status).toBe(403);
    const closed = await move('efua', shifts.get('efua')!);
    expect([closed.status, closed.body.error?.code]).toEqual([422, 'SHIFT_NOT_OPEN']);
    const forced = await move('kofi', shifts.get('kofi')!);
    expect([forced.status, forced.body.error?.code]).toEqual([422, 'SHIFT_NOT_OPEN']);
    expect(await counts()).toEqual(before);
  });
});

describe('the database refuses it too, by direct SQL that bypasses the application (ADR-0077 Amendments)', () => {
  const CASH_METHOD = '01900000-0000-7000-8001-000000000001';
  /** Runs one statement as the application role inside a transaction that is rolled back, so a statement the database accepts changes nothing; answers the refusal as code:constraint:detail, or 'ACCEPTED'. */
  async function attempt(statements: (client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }) => Promise<void>): Promise<string> {
    const client = await database.pool('app').connect();
    try {
      await client.query('BEGIN');
      await statements(client);
      return 'ACCEPTED';
    } catch (error) {
      const e = error as { code?: string; constraint?: string; detail?: string };
      return `${e.code}:${e.constraint ?? ''}:${e.detail ?? ''}`;
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  /** A payment written straight into pay.payment, as a tender, a charge or a reversing payment would be. */
  const payment = (who: string, shift: string, till: string | null, extra: { kind?: 'CASH' | 'MOBILE_MONEY'; status?: string; reverses?: string } = {}) =>
    attempt(async (c) => {
      const id = nextId();
      const methodId = extra.kind === 'MOBILE_MONEY' ? (await one<{ id: string }>("SELECT id FROM mdm.payment_method WHERE code = 'MOMO'", [])).id : CASH_METHOD;
      await c.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'PAYMENT', 'pay', $2, $3)", [id, branchId, users.get(who)!.principalId]);
      await c.query(
        `INSERT INTO pay.payment (id, payment_method_id, method_kind, amount_pesewas, verification, register_ref, register_code, shift_document_id, received_at, cleared_at, status, branch_id, created_by, updated_by, posted_at, posted_by, reverses_payment_id)
         VALUES ($1, $2, $3, 1000, 'NOT_REQUIRED', $4, $5, $6, $7, $7, $8, $9, $10, $10, $7, $10, $11)`,
        [id, methodId, extra.kind ?? 'CASH', till, till === null ? null : 'TX', shift, clock.now(), extra.status ?? 'CLEARED', branchId, users.get(who)!.principalId, extra.reverses ?? null],
      );
    });
  const refusedFor = (rule: string) => `HK010:ck_payment_till_shift:${rule}`;

  it('a cash tender (a sale through ORD, recordIn, writeIn): another cashier, another till, a closed and a force-closed shift', async () => {
    expect(await payment('adwoa', shifts.get('adwoa')!, tills.get('T1')!.id)).toBe('ACCEPTED');
    expect(await payment('adwoa', shifts.get('nana')!, tills.get('T2')!.id)).toBe(refusedFor('SHIFT_NOT_OWN'));
    expect(await payment('adwoa', shifts.get('adwoa')!, tills.get('T2')!.id)).toBe(refusedFor('SHIFT_OTHER_REGISTER'));
    expect(await payment('efua', shifts.get('efua')!, tills.get('T3')!.id)).toBe(refusedFor('SHIFT_NOT_OPEN'));
    expect(await payment('kofi', shifts.get('kofi')!, tills.get('T4')!.id)).toBe(refusedFor('SHIFT_NOT_OPEN'));
    expect(await payment('manager', shifts.get('adwoa')!, tills.get('T1')!.id)).toBe('ACCEPTED');
    const order = (await one<{ id: string }>('SELECT id FROM ord.sales_order LIMIT 1', [])).id;
    expect(await payment('adwoa', order, tills.get('T1')!.id)).toBe(refusedFor('SHIFT_UNKNOWN'));
  });

  it('a mobile money charge naming a shift (by HTTP or chargeIn): another cashier, a closed and a force-closed shift', async () => {
    const charge = (who: string, shift: string) => payment(who, shift, null, { kind: 'MOBILE_MONEY', status: 'PENDING' });
    const own = await charge('adwoa', shifts.get('adwoa')!);
    expect(own.startsWith('HK010:ck_payment_till_shift'), own).toBe(false);
    expect(await charge('adwoa', shifts.get('nana')!)).toBe(refusedFor('SHIFT_NOT_OWN'));
    expect(await charge('efua', shifts.get('efua')!)).toBe(refusedFor('SHIFT_NOT_OPEN'));
    expect(await charge('kofi', shifts.get('kofi')!)).toBe(refusedFor('SHIFT_NOT_OPEN'));
  });

  it('a reversing payment (an approved reversal or a void): a closed or force-closed shift, and a decider who cannot reach the shift', async () => {
    for (const who of ['efua', 'kofi']) {
      const original = (await one<{ id: string }>("SELECT id FROM pay.payment WHERE shift_document_id = $1 AND status = 'CLEARED' ORDER BY id LIMIT 1", [shifts.get(who)])).id;
      expect(await payment('manager', shifts.get(who)!, tills.get(who === 'efua' ? 'T3' : 'T4')!.id, { status: 'REVERSED', reverses: original }), who).toBe(refusedFor('SHIFT_NOT_OPEN'));
    }
    const open = (await one<{ id: string }>("SELECT id FROM pay.payment WHERE shift_document_id = $1 AND status = 'CLEARED' ORDER BY id LIMIT 1", [shifts.get('adwoa')])).id;
    expect(await payment('accountant', shifts.get('adwoa')!, tills.get('T1')!.id, { status: 'REVERSED', reverses: open })).toBe(refusedFor('SHIFT_NOT_OWN'));
  });

  it('a cash refund paid out of a till: another till, a closed and a force-closed shift, and a payer who cannot reach the shift', async () => {
    const deposit = (await payDirect('adwoa', shifts.get('adwoa')!, tills.get('T1')!, 900n)).id;
    const asked = await post('manager', '/refunds', { originalPaymentId: deposit, amountPesewas: 900, destination: 'ORIGINAL_METHOD', reasonCode: 'WRONG_ITEM', note: 'Paid twice' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    await step('owner');
    expect((await post('owner', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Seen it' })).status).toBe(200);
    const pay = (who: string, shift: string) =>
      attempt(async (c) => {
        await c.query("UPDATE pay.refund SET status = 'PAID', paid_at = $2, paid_by = $3, posted_at = $2, posted_by = $3, paid_from_shift_id = $4, updated_by = $3, version = version + 1 WHERE id = $1", [
          asked.body.subject.id,
          clock.now(),
          users.get(who)!.principalId,
          shift,
        ]);
      });
    const refused = (rule: string) => `HK010:ck_refund_till_shift:${rule}`;
    expect(await pay('owner', shifts.get('adwoa')!)).toBe('ACCEPTED');
    expect(await pay('owner', shifts.get('nana')!)).toBe(refused('SHIFT_OTHER_REGISTER'));
    expect(await pay('owner', shifts.get('efua')!)).toBe(refused('SHIFT_NOT_OPEN'));
    expect(await pay('owner', shifts.get('kofi')!)).toBe(refused('SHIFT_NOT_OPEN'));
    expect(await pay('accountant', shifts.get('adwoa')!)).toBe(refused('SHIFT_NOT_OWN'));
  });

  it('a cash movement: another cashier, a closed and a force-closed shift', async () => {
    const move = (who: string, shift: string) =>
      attempt(async (c) => {
        await c.query(
          "INSERT INTO pos.cash_movement (id, shift_id, kind, amount_pesewas, reason_code, occurred_at, recorded_at, actor_id) VALUES ($1, $2, 'PAY_IN', 100, 'FLOAT_TOP_UP', $3, $3, $4)",
          [nextId(), shift, clock.now(), users.get(who)!.principalId],
        );
      });
    expect(await move('adwoa', shifts.get('adwoa')!)).toBe('ACCEPTED');
    expect(await move('nana', shifts.get('adwoa')!)).toBe('HK010:ck_cash_movement_own_shift:');
    expect(await move('efua', shifts.get('efua')!)).toBe('HK010:ck_cash_movement_open_shift:');
    expect(await move('kofi', shifts.get('kofi')!)).toBe('HK010:ck_cash_movement_open_shift:');
  });

  it('the shift state PAY reads is the platform published fact, which the application cannot write and which never reopens', async () => {
    expect(await one('SELECT accepts_entries, holder_id, container_id FROM platform.document_entry_state WHERE document_id = $1', [shifts.get('kofi')])).toEqual({ accepts_entries: false, holder_id: users.get('kofi')!.principalId, container_id: tills.get('T4')!.id });
    expect(await attempt(async (c) => void (await c.query('SELECT platform.set_document_entry_state($1, true, $2, $3)', [shifts.get('kofi'), users.get('kofi')!.principalId, tills.get('T4')!.id])))).toMatch(/^42501:/);
    await expect(admin().query('SELECT platform.set_document_entry_state($1, true, $2, $3)', [shifts.get('kofi'), users.get('kofi')!.principalId, tills.get('T4')!.id])).rejects.toMatchObject({ code: 'HK004' });
  });
});

describe('the cashier counts exactly what the records say the till holds', () => {
  it('signs off EXACT at the figure derived by SQL, and the till account returns to 0', async () => {
    const expected = await cashBySql(shifts.get('adwoa')!);
    expect(expected).toBe(6_000 + 1_000 + 4_000 - 1_500 + 2_000 - 2_000 + 900);
    const cash = (await one<{ id: string }>("SELECT id FROM mdm.payment_method WHERE code = 'CASH'", [])).id;
    const mobile = (await one<{ id: string }>("SELECT id FROM mdm.payment_method WHERE code = 'MOMO'", [])).id;
    expect((await post('adwoa', `/shifts/${shifts.get('adwoa')!}/close`, { declared: [{ paymentMethodId: cash, declaredPesewas: expected }, { paymentMethodId: mobile, declaredPesewas: 0 }] })).status).toBe(200);
    await step('manager');
    const signed = await post('manager', `/shifts/${shifts.get('adwoa')!}/approve-close`, { reason: 'Counted together' });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body).toMatchObject({ status: 'CLOSED', expectedCashPesewas: expected, overShortPesewas: 0, overShortDirection: 'EXACT' });
    expect(await tillLedger(tills.get('T1')!.id)).toBe(0);
    const x = await get('manager', `/shifts/${shifts.get('adwoa')!}/z-report`);
    expect(x.body.refundsPesewas).toBe(1_500);
  });
});
