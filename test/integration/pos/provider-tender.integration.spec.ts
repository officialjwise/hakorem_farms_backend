import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { paystackEnvironment, startFakePaystack, type FakePaystack } from '../../support/fake-paystack';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { approveAndDeliver, initiateCharge, referenceFor } from '../../support/pay';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * A mobile money tender at the counter (FR-POS-006, ADR-0079, A-276): only a payment the provider already cleared at the
 * cashier's own open shift, named by `paymentId`, taken whole, linked to the sale once and allocated to its receipt;
 * never a second time, never another customer's, another shift's or another branch's, never one not yet cleared, and
 * never with change. ORD's reads and a void see it. Every figure is derived by SQL over `pay.payment`,
 * `pay.payment_allocation`, `bil.billing_document` and the journal lines, never from the code under test.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let fake: FakePaystack;
let nextId: () => string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const credentials = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const idOf = (who: string) => users.get(who)!.principalId;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const one = async <T>(sql: string, values: unknown[]): Promise<T> => (await admin().query(sql, values)).rows[0] as T;
const n = async (sql: string, values: unknown[]): Promise<number> => Number((await one<{ n: string | null }>(sql, values)).n ?? 0);
const step = (who: string) => stepUp(api.server, as(who) as TotpSession, clock);

/** A counter sale sent as a till sends it: its id is its idempotency key, with the device's credential. */
function sell(who: string, till: string, body: Record<string, unknown>) {
  const saleId = nextId();
  return consolePost(api.server, as(who), '/v1/pos/sales', saleId)
    .set('X-Device-Credential', credentials.get(till)!)
    .send({ id: saleId, occurredAt: clock.now().toISOString(), ...body });
}
const yams = (count: number) => ({ productId: id('yam'), quantity: `${count}.000`, agreedUnitPricePesewas: 2_000 });
const cash = (amount: number, tendered?: number) => ({ paymentMethodId: id('CASH'), amountPesewas: amount, ...(tendered === undefined ? {} : { tenderedPesewas: tendered }) });
const momo = (amount: number, paymentId?: string, extra: object = {}) => ({ paymentMethodId: id('MOMO'), amountPesewas: amount, ...(paymentId === undefined ? {} : { paymentId }), ...extra });

/** A mobile money charge the customer approves on the phone and the provider confirms by its signed webhook. */
async function cleared(who: string, amount: number, fields: Record<string, unknown> = {}): Promise<string> {
  const started = await initiateCharge(api.server, as(who), { amountPesewas: amount, ...fields });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  clock.advanceBy(5_000);
  expect((await approveAndDeliver(api.server, fake, referenceFor(started.body.id as string))).status).toBe(200);
  expect((await one<{ status: string }>('SELECT status FROM pay.payment WHERE id = $1', [started.body.id])).status).toBe('CLEARED');
  return started.body.id as string;
}

/** The yam's list price for the counter, read straight from the base list's entry. */
async function yamPrice(): Promise<number> {
  return n(
    `SELECT e.list_price_pesewas::text AS n FROM mdm.price_list_entry e JOIN mdm.price_list_version v ON v.id = e.version_id JOIN mdm.price_list l ON l.id = v.price_list_id
      WHERE l.code = 'BASE' AND e.product_id = $1 AND v.status = 'ACTIVE'`,
    [id('yam')],
  );
}

async function footprint(): Promise<Record<string, string>> {
  const counts: Record<string, string> = {};
  for (const table of ['ord.sales_order', 'pay.payment', 'pay.payment_allocation', 'pay.payment_order_link', 'bil.billing_document', 'fin.journal_entry', 'inv.stock_movement']) {
    counts[table] = (await one<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`, [])).n;
  }
  return counts;
}

/** Debits less credits on an account over the journals of the given source documents. */
async function net(code: string, documents: readonly string[]): Promise<number> {
  return n(
    `SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS n
       FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
      WHERE a.code = $1 AND e.source_document_id = ANY($2::uuid[])`,
    [code, documents],
  );
}

/** Runs SQL as the application role in a transaction that is always rolled back, and answers what it broke. */
async function refusedAs(sql: string, values: unknown[]): Promise<{ constraint?: string; code?: string; detail?: string } | undefined> {
  const client = await database.pool('app').connect();
  try {
    await client.query('BEGIN');
    await client.query(sql, values);
    return undefined;
  } catch (error) {
    const e = error as { constraint?: string; code?: string; detail?: string };
    return { ...(e.constraint === undefined ? {} : { constraint: e.constraint }), ...(e.code === undefined ? {} : { code: e.code }), ...(e.detail === undefined ? {} : { detail: e.detail }) };
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const refusal = (rule: string, tender = 0) => ({ code: 'PAYMENT_INVALID', details: [expect.objectContaining({ field: `/tenders/${tender}/paymentId`, code: rule })] });

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  fake = await startFakePaystack(() => clock.now());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { ...paystackEnvironment(fake), AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch' AS code, id FROM mdm.branch WHERE code = 'DDW'
       UNION ALL SELECT 'shop', l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = 'SHOP'
       UNION ALL SELECT 'yam', id FROM mdm.product WHERE sku = 'PRD-0005'
       UNION ALL SELECT 'adjoa', id FROM mdm.customer WHERE customer_no = 'C-00001'
       UNION ALL SELECT 'madina', id FROM mdm.customer WHERE customer_no = 'C-00003'
       UNION ALL SELECT code, id FROM mdm.payment_method`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const ada = await createBranch(database, 'ADA');
  for (const [who, name, role, totp, branch, location] of [
    ['manager', 'Kwabena Owusu', 'MANAGER', true, id('branch'), null],
    ['kofi', 'Kofi Asante', 'CASHIER', false, id('branch'), id('shop')],
    ['ama', 'Ama Serwaa', 'CASHIER', false, id('branch'), id('shop')],
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', false, id('branch'), id('shop')],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true, id('branch'), null],
    ['esi', 'Esi Mensah', 'MANAGER', true, ada.branchId, null],
  ] as const) {
    const user = await createUser(database, { name, grants: [{ role, branchId: branch, ...(location === null ? {} : { locationId: location }) }] });
    users.set(who, user);
    sessions.set(who, totp ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  for (const code of ['M1', 'M2']) {
    const till = await post('manager', '/registers', { branchId: id('branch'), locationId: id('shop'), code, name: `Mobile money till ${code}` });
    expect(till.status, JSON.stringify(till.body)).toBe(201);
    ids.set(`till:${code}`, till.body.id as string);
    await step('manager');
    const enrolled = await post('manager', `/registers/${till.body.id as string}/devices`, { deviceLabel: `Tablet ${code}` });
    expect(enrolled.status).toBe(201);
    credentials.set(code, enrolled.body.deviceCredential as string);
  }
  for (const [who, till] of [
    ['kofi', 'M1'],
    ['ama', 'M2'],
  ] as const) {
    const shift = nextId();
    expect((await post(who, '/shifts', { id: shift, registerId: id(`till:${till}`), openingFloatPesewas: 10_000, openedAt: clock.now().toISOString() }, shift)).status).toBe(201);
    ids.set(`shift:${who}`, shift);
  }
});

afterAll(async () => {
  await api?.close();
  await fake?.close();
  await database?.drop();
});

describe('a cleared mobile money payment as a counter tender (FR-POS-006)', () => {
  it('takes Kofi customer 4,000 by mobile money and 2,000 in cash for 3 yams: one receipt of 6,000, the payment linked and allocated once', async () => {
    const payment = await cleared('kofi', 4_000, { shiftId: id('shift:kofi') });
    ids.set('payment:first', payment);
    const gross = 3 * (await yamPrice());
    expect(gross).toBe(6_000);
    const sold = await sell('kofi', 'M1', { shiftId: id('shift:kofi'), lines: [yams(3)], tenders: [momo(4_000, payment), cash(gross - 4_000, 5_000)] });
    expect(sold.status, JSON.stringify(sold.body)).toBe(201);
    const saleId = sold.body.order.id as string;
    ids.set('sale:first', saleId);
    // Change came from the cash alone: 5,000 handed over for 2,000.
    expect(sold.body.changeDuePesewas).toBe(5_000 - (gross - 4_000));
    // The sale reads the mobile money as paid: without the link it would show 2,000 paid and PART_PAID.
    expect(sold.body.order).toMatchObject({ paidPesewas: gross, outstandingPesewas: 0, paymentStatus: 'PAID' });

    const receipt = await one<{ id: string; gross: string }>("SELECT id, gross_pesewas::text AS gross FROM bil.billing_document WHERE order_document_id = $1 AND kind = 'RECEIPT'", [saleId]);
    expect(receipt.gross).toBe(String(gross));
    const link = await one<{ order_document_id: string; shift_document_id: string; actor_id: string }>('SELECT order_document_id, shift_document_id, actor_id FROM pay.payment_order_link WHERE payment_id = $1', [payment]);
    expect(link).toEqual({ order_document_id: saleId, shift_document_id: id('shift:kofi'), actor_id: idOf('kofi') });
    expect(await n('SELECT allocated_pesewas::text AS n FROM pay.payment WHERE id = $1', [payment])).toBe(4_000);
    expect(await n("SELECT sum(amount_pesewas)::text AS n FROM pay.payment_allocation WHERE billing_document_id = $1 AND direction = 'APPLY'", [receipt.id])).toBe(gross);
    expect(await n('SELECT count(*)::text AS n FROM pay.payment_allocation WHERE payment_id = $1', [payment])).toBe(1);
    // No new mobile money payment was written: the sale's cash is its only other payment.
    expect(await n("SELECT count(*)::text AS n FROM pay.payment WHERE order_document_id = $1 AND method_kind = 'CASH'", [saleId])).toBe(1);
    expect(await n("SELECT count(*)::text AS n FROM pay.payment WHERE order_document_id = $1 AND method_kind = 'MOBILE_MONEY'", [saleId])).toBe(0);

    // The ledger: the deposit the payment cleared into (2200) is applied to the receipt's receivable (Dr 2200 Cr 1200),
    // so the sale's receivable and the payment's deposit both come back to exactly nothing.
    const cashPayment = (await one<{ id: string }>("SELECT id FROM pay.payment WHERE order_document_id = $1 AND method_kind = 'CASH'", [saleId])).id;
    expect(await net('2200', [payment])).toBe(0);
    expect(await net('1200', [receipt.id, payment, cashPayment])).toBe(0);
    const allocated = await one<{ lines: { code: string; side: string; amount: number }[] }>(
      `SELECT json_agg(json_build_object('code', a.code, 'side', l.side, 'amount', l.amount_pesewas) ORDER BY a.code) AS lines
         FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
        WHERE e.event_code = 'pay.DepositAllocated' AND e.source_document_id = $1`,
      [payment],
    );
    expect(allocated.lines).toEqual([
      { code: '1200', side: 'C', amount: 4_000 },
      { code: '2200', side: 'D', amount: 4_000 },
    ]);
    expect(await n("SELECT count(*)::text AS n FROM platform.audit_event WHERE action = 'TAKE_AS_TENDER' AND entity_id = $1 AND actor_id = $2", [payment, idOf('kofi')])).toBe(1);
  });

  it('shows ORD the payment: the order reads it paid in full, and the payment names its sale', async () => {
    const order = await get('manager', `/orders/${id('sale:first')}`);
    expect(order.status, JSON.stringify(order.body)).toBe(200);
    expect(order.body).toMatchObject({ paymentStatus: 'PAID', paidPesewas: 6_000, outstandingPesewas: 0 });
    const payment = await get('manager', `/payments/${id('payment:first')}`);
    expect(payment.status).toBe(200);
    expect(payment.body).toMatchObject({ order: { id: id('sale:first') }, allocatedPesewas: 4_000, unallocatedPesewas: 0 });
  });

  it('refuses a void of the sale: a mobile money tender is refunded through a return, never reversed into the till', async () => {
    const asked = await post('manager', `/orders/${id('sale:first')}/void`, { reasonCode: 'CUSTOMER_CHANGED_MIND', note: 'Changed her mind at the door' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(422);
    expect(asked.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TENDER_NOT_VOIDABLE' })]));
  });

  it('refuses a second allocation of the same payment, recording nothing; the database refuses a second link', async () => {
    const before = await footprint();
    const again = await sell('kofi', 'M1', { shiftId: id('shift:kofi'), lines: [yams(2)], tenders: [momo(4_000, id('payment:first'))] });
    expect(again.status, JSON.stringify(again.body)).toBe(422);
    expect(again.body.error).toMatchObject(refusal('PAYMENT_ALREADY_USED'));
    const twice = await sell('kofi', 'M1', { shiftId: id('shift:kofi'), lines: [yams(4)], tenders: [momo(4_000, id('payment:first')), momo(4_000, id('payment:first'))] });
    expect(twice.body.error).toMatchObject({ code: 'COUNTER_SALE_INVALID', details: [expect.objectContaining({ field: '/tenders/1/paymentId', code: 'PAYMENT_NAMED_TWICE' })] });
    expect(await footprint()).toEqual(before);
    expect(
      await refusedAs('INSERT INTO pay.payment_order_link (payment_id, order_document_id, shift_document_id, branch_id, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, $6)', [
        id('payment:first'),
        id('sale:first'),
        id('shift:kofi'),
        id('branch'),
        clock.now(),
        idOf('kofi'),
      ]),
    ).toMatchObject({ constraint: 'ck_payment_order_link', detail: 'PAYMENT_ALREADY_USED' });
  });

  it('refuses another customer payment and a named customer payment on a walk-in sale, and takes it for its own customer', async () => {
    const payment = await cleared('kofi', 2_000, { shiftId: id('shift:kofi'), customerId: id('adjoa') });
    const before = await footprint();
    const other = await sell('kofi', 'M1', { shiftId: id('shift:kofi'), customerId: id('madina'), lines: [yams(1)], tenders: [momo(2_000, payment)] });
    expect(other.status, JSON.stringify(other.body)).toBe(422);
    expect(other.body.error).toMatchObject(refusal('OTHER_CUSTOMER'));
    const walkIn = await sell('kofi', 'M1', { shiftId: id('shift:kofi'), lines: [yams(1)], tenders: [momo(2_000, payment)] });
    expect(walkIn.body.error).toMatchObject(refusal('OTHER_CUSTOMER'));
    expect(await footprint()).toEqual(before);
    const own = await sell('kofi', 'M1', { shiftId: id('shift:kofi'), customerId: id('adjoa'), lines: [yams(1)], tenders: [momo(2_000, payment)] });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect((await one<{ order_document_id: string }>('SELECT order_document_id FROM pay.payment_order_link WHERE payment_id = $1', [payment])).order_document_id).toBe(own.body.order.id);
  });

  it('refuses a payment not yet cleared, in the handler and in the database', async () => {
    const pending = await initiateCharge(api.server, as('kofi'), { amountPesewas: 2_000, shiftId: id('shift:kofi') });
    expect(pending.status).toBe(201);
    const before = await footprint();
    const refused = await sell('kofi', 'M1', { shiftId: id('shift:kofi'), lines: [yams(1)], tenders: [momo(2_000, pending.body.id as string)] });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error).toMatchObject(refusal('PAYMENT_NOT_CLEARED'));
    expect(await footprint()).toEqual(before);
    expect(
      await refusedAs('INSERT INTO pay.payment_order_link (payment_id, order_document_id, shift_document_id, branch_id, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, $6)', [
        pending.body.id,
        id('sale:first'),
        id('shift:kofi'),
        id('branch'),
        clock.now(),
        idOf('kofi'),
      ]),
    ).toMatchObject({ constraint: 'ck_payment_order_link', detail: 'PAYMENT_NOT_CLEARED' });
  });

  it('refuses a payment taken on another cashier shift or on no shift at all, in the handler and in the database', async () => {
    const amas = await cleared('ama', 2_000, { shiftId: id('shift:ama') });
    const unattached = await cleared('manager', 2_000, {});
    const before = await footprint();
    for (const payment of [amas, unattached]) {
      const refused = await sell('kofi', 'M1', { shiftId: id('shift:kofi'), lines: [yams(1)], tenders: [momo(2_000, payment)] });
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body.error).toMatchObject(refusal('OTHER_SHIFT'));
    }
    expect(await footprint()).toEqual(before);
    expect(
      await refusedAs('INSERT INTO pay.payment_order_link (payment_id, order_document_id, shift_document_id, branch_id, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, $6)', [
        amas,
        id('sale:first'),
        id('shift:kofi'),
        id('branch'),
        clock.now(),
        idOf('kofi'),
      ]),
    ).toMatchObject({ constraint: 'ck_payment_order_link', detail: 'OTHER_SHIFT' });
    // Ama cannot sell on Kofi's shift either, whatever payment she names (ADR-0077).
    expect((await sell('ama', 'M1', { shiftId: id('shift:kofi'), lines: [yams(1)], tenders: [momo(2_000, amas)] })).status).toBe(403);
  });

  it('refuses a payment taken on another branch exactly as an id that names no payment', async () => {
    const elsewhere = await cleared('esi', 2_000, {});
    expect((await one<{ branch_id: string }>('SELECT branch_id FROM pay.payment WHERE id = $1', [elsewhere])).branch_id).not.toBe(id('branch'));
    const before = await footprint();
    const refused = await sell('kofi', 'M1', { shiftId: id('shift:kofi'), lines: [yams(1)], tenders: [momo(2_000, elsewhere)] });
    const unknown = await sell('kofi', 'M1', { shiftId: id('shift:kofi'), lines: [yams(1)], tenders: [momo(2_000, nextId())] });
    for (const answer of [refused, unknown]) {
      expect(answer.status).toBe(422);
      expect(answer.body.error).toMatchObject(refusal('PAYMENT_UNKNOWN'));
      expect(answer.body.error.details).toHaveLength(1);
    }
    expect(await footprint()).toEqual(before);
  });

  it('never gives change from it: a part or more of the payment, cash handed over on it, and a tender with no payment are refused', async () => {
    const payment = await cleared('kofi', 5_000, { shiftId: id('shift:kofi') });
    const before = await footprint();
    const part = await sell('kofi', 'M1', { shiftId: id('shift:kofi'), lines: [yams(2)], tenders: [momo(4_000, payment)] });
    expect(part.body.error).toMatchObject(refusal('AMOUNT_DIFFERS'));
    const more = await sell('kofi', 'M1', { shiftId: id('shift:kofi'), lines: [yams(2)], tenders: [momo(5_000, payment)] });
    expect(more.status).toBe(422);
    const handed = await sell('kofi', 'M1', { shiftId: id('shift:kofi'), lines: [yams(2)], tenders: [momo(4_000, payment, { tenderedPesewas: 5_000 })] });
    expect(handed.body.error).toMatchObject({ code: 'COUNTER_SALE_INVALID', details: [expect.objectContaining({ code: 'CHANGE_ONLY_FROM_CASH' })] });
    const word = await sell('kofi', 'M1', { shiftId: id('shift:kofi'), lines: [yams(2)], tenders: [momo(4_000)] });
    expect(word.body.error.code).toBe('PAYMENT_METHOD_REQUIRES_VERIFICATION');
    const onCash = await sell('kofi', 'M1', { shiftId: id('shift:kofi'), lines: [yams(2)], tenders: [{ ...cash(4_000), paymentId: payment }] });
    expect(onCash.body.error).toMatchObject({ code: 'COUNTER_SALE_INVALID', details: [expect.objectContaining({ field: '/tenders/0/paymentId', code: 'PAYMENT_ID_NOT_FOR_METHOD' })] });
    expect(await footprint()).toEqual(before);
    // The whole 5,000 for 2 yams and a cabbage-free 1,000 more of yam: 5 yams at 2,000 less nothing is 10,000, so 5,000 in cash.
    const whole = await sell('kofi', 'M1', { shiftId: id('shift:kofi'), lines: [yams(5)], tenders: [momo(5_000, payment), cash(5_000)] });
    expect(whole.status, JSON.stringify(whole.body)).toBe(201);
    expect(whole.body.changeDuePesewas).toBe(0);
  });

  it('refuses the wrong role, recording nothing', async () => {
    const payment = await cleared('kofi', 2_000, { shiftId: id('shift:kofi') });
    const before = await footprint();
    for (const who of ['storekeeper', 'accountant']) {
      expect((await consolePost(api.server, as(who), '/v1/pos/sales', nextId()).send({ id: nextId(), shiftId: id('shift:kofi'), occurredAt: clock.now().toISOString(), lines: [yams(1)], tenders: [momo(2_000, payment)] })).status, who).toBe(403);
    }
    expect(await footprint()).toEqual(before);
  });
});

describe('the shift counts the mobile money it took once', () => {
  it('reads the X report: mobile money is every cleared charge at the shift, the cash is the float and the cash kept', async () => {
    const report = await get('manager', `/shifts/${id('shift:kofi')}/x-report`);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const momoBySql = await n("SELECT sum(amount_pesewas)::text AS n FROM pay.payment WHERE shift_document_id = $1 AND method_kind = 'MOBILE_MONEY' AND status = 'CLEARED'", [id('shift:kofi')]);
    const byMethod = report.body.byMethod.find((m: { paymentMethod: { id: string } }) => m.paymentMethod.id === id('MOMO'));
    expect(byMethod.amountPesewas).toBe(momoBySql);
    // Each sale's mobile money is the payment the provider cleared, counted once: the shift's cleared charges add up to it.
    // 4,000, Adjoa's 2,000, the 5,000 and the 2,000 of the wrong-role test; the pending 2,000 never cleared.
    expect(momoBySql).toBe(4_000 + 2_000 + 5_000 + 2_000);
  });
});
