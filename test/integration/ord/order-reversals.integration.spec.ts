import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SalePosting, type SaleRequest } from '../../../src/modules/ord';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { paystackEnvironment, startFakePaystack, type FakePaystack } from '../../support/fake-paystack';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { approveAndDeliver, balanceOf, initiateCharge, journalOf, referenceFor, trialBalanceSum } from '../../support/pay';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The order's reversals (FR-ORD-002, FR-ORD-014, ADR-0010, ADR-0035, abuse case 1, A-226). A cancellation releases the
 * order's reservations and pending charges and asks for the refund of what it was paid, in one transaction, or does
 * none of it. A void of a completed sale waits for a supervisor who is neither the person asking nor the cashier, and on
 * approval leaves a credit note and reversing entries for the payment and the stock, the trial balance at zero. Every
 * write refuses the wrong role and the wrong branch.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let fake: FakePaystack;
let branchId: string;
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const sessions = new Map<string, TestSession>();
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const step = (who: string) => stepUp(api.server, as(who) as TotpSession, clock);

const order = (body: Record<string, unknown> = {}) => ({
  channel: 'WHOLESALE',
  customerId: id('tema'),
  fulfilmentMode: 'COLLECTION',
  paymentTerms: 'COD',
  lines: [{ productId: id('eggs'), quantity: '4.000' }],
  ...body,
});
const placeOrder = async (body: Record<string, unknown> = {}) => {
  const created = await post('sales', '/orders', order(body));
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body as { id: string; orderNo: string };
};
const confirmOrder = async (orderId: string) => {
  const confirmed = await post('sales', `/orders/${orderId}/confirm`);
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
};
const cancel = (who: string, orderId: string, body: object = { reasonCode: 'CUSTOMER_CANCELLED', note: 'Customer called' }, key = randomUUID()) => post(who, `/orders/${orderId}/cancel`, body, key);
const askVoid = (who: string, orderId: string, body: object = { reasonCode: 'CUSTOMER_CHANGED_MIND', note: 'Returned the yams before leaving' }, key = randomUUID()) => post(who, `/orders/${orderId}/void`, body, key);
const decide = (who: string, approvalId: string, verb: 'approve' | 'reject') => post(who, `/iam/approvals/${approvalId}/${verb}`, { reason: 'Seen at the counter' });

const reservations = async (orderId: string) =>
  (await admin().query<{ qty: string; status: string }>('SELECT qty::text AS qty, status FROM inv.stock_reservation WHERE holder_document_id = $1 ORDER BY id', [orderId])).rows;
const available = async (productId: string) =>
  (await admin().query<{ qty: string }>('SELECT sum(on_hand_qty - reserved_qty)::numeric(14,3)::text AS qty FROM inv.stock_balance WHERE product_id = $1 AND location_id = $2', [productId, id('SHOP')])).rows[0]!.qty;
const onHand = async (productId: string) =>
  (await admin().query<{ qty: string }>('SELECT sum(on_hand_qty)::numeric(14,3)::text AS qty FROM inv.stock_balance WHERE product_id = $1 AND location_id = $2', [productId, id('SHOP')])).rows[0]!.qty;
const events = async (type: string, subjectId: string) =>
  (await admin().query<{ payload: Record<string, unknown> }>('SELECT payload FROM platform.outbox_message WHERE event_type = $1 AND subject_id = $2 ORDER BY id', [type, subjectId])).rows.map((r) => r.payload);
const refundsOf = async (paymentId: string) =>
  (
    await admin().query<{ amount: string; status: string; reason_code: string; created_by: string; approval_request_id: string | null }>(
      'SELECT amount_pesewas::text AS amount, status, reason_code, created_by, approval_request_id FROM pay.refund WHERE original_payment_id = $1',
      [paymentId],
    )
  ).rows.map((r) => ({ amount: Number(r.amount), status: r.status, reasonCode: r.reason_code, createdBy: r.created_by, approval: r.approval_request_id }));
const releasedAt = async (paymentId: string) => (await admin().query<{ released_at: Date | null }>("SELECT released_at FROM pay.provider_transaction WHERE payment_id = $1 AND kind = 'CHARGE'", [paymentId])).rows[0]!.released_at;
const statusOf = async (orderId: string) => (await admin().query<{ status: string }>('SELECT status FROM ord.sales_order WHERE id = $1', [orderId])).rows[0]!.status;

async function receiveCabbage(qty: string): Promise<void> {
  const documentId = randomUUID();
  const app = database.pool('app');
  await app.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'GOODS_RECEIPT', 'inv', $2, $3)", [documentId, branchId, SYSTEM_PRINCIPAL]);
  await app.query(
    `INSERT INTO inv.stock_movement (id, movement_type, product_id, branch_id, from_location_id, to_location_id, qty_base, value_pesewas, cost_element, source_document_id, occurred_at, actor_id)
     VALUES ($1, 'RECEIPT_PURCHASE', $2, $3, $4, $5, $6, 500, 'PURCHASE', $7, $8, $9)`,
    [randomUUID(), id('cabbage'), branchId, id('SUPPLIER'), id('SHOP'), qty, documentId, clock.now(), SYSTEM_PRINCIPAL],
  );
}

/** A counter sale of yams for cash, posted through `SalePosting.postIn` as the person named (the cashier). */
async function counterSale(who: string, yams: number, till: { id: string; code: string }): Promise<{ id: string; receiptId: string }> {
  const uow = api.app.get(UnitOfWork);
  const sales = api.app.get(SalePosting);
  const actor: Actor = { principalId: id(`user:${who}`), kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null };
  const request: SaleRequest = {
    orderId: createUuidV7Generator(clock)(),
    channel: 'WHOLESALE',
    branchId,
    fulfilmentMode: 'COUNTER',
    taxInclusive: true,
    lines: [{ productId: id('yam'), fromLocationId: id('SHOP'), quantity: `${yams}.000` }],
    tenders: [{ methodCode: 'CASH', amountPesewas: BigInt(yams * 2_000), register: till }],
  };
  const sold = await runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'reversals test', actor }, () =>
    uow.run({ isolation: 'serializable', seriesLocks: sales.locksFor(branchId) }, (tx) => sales.postIn(tx, actor, request)),
  );
  const { rows } = await admin().query<{ billing_document_id: string }>('SELECT billing_document_id FROM ord.sales_order WHERE id = $1', [sold.id]);
  return { id: sold.id, receiptId: rows[0]!.billing_document_id };
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  fake = await startFakePaystack(() => clock.now());
  api = await startTestApp(database, { clock, environment: { ...paystackEnvironment(fake), AUTH_ACCESS_TTL_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const code of ['SHOP']) ids.set(code, (await admin().query<{ id: string }>('SELECT id FROM mdm.location WHERE branch_id = $1 AND code = $2', [branchId, code])).rows[0]!.id);
  ids.set('SUPPLIER', (await admin().query<{ id: string }>("SELECT id FROM mdm.location WHERE branch_id = $1 AND kind = 'SUPPLIER'", [branchId])).rows[0]!.id);
  for (const [name, sku] of [
    ['eggs', 'EGG-CRATE-BIG'],
    ['cabbage', 'PRD-CABBAGE-HEAD'],
    ['yam', 'PRD-YAM-TUBER'],
  ] as const) {
    ids.set(name, (await admin().query<{ id: string }>('SELECT id FROM mdm.product WHERE sku = $1', [sku])).rows[0]!.id);
  }
  ids.set('tema', (await admin().query<{ id: string }>("SELECT id FROM mdm.customer WHERE name = 'Tema Cold Store Ltd (SEED)'")).rows[0]!.id);
  const other = await createBranch(database, 'KSI');
  const people: [string, string, RoleCode, string, boolean][] = [
    ['owner', 'Kwabena Owusu', 'OWNER', branchId, true],
    ['manager', 'Ama Owusu', 'MANAGER', branchId, true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', branchId, true],
    ['sales', 'Kojo Antwi', 'SALES', branchId, false],
    ['cashier', 'Adwoa Darko', 'CASHIER', branchId, false],
    ['storekeeper', 'Yaw Asante', 'STOREKEEPER', branchId, false],
    ['investor', 'Nana Ofori', 'INVESTOR', branchId, false],
    ['elsewhere', 'Kwesi Appiah', 'SALES', other.branchId, false],
  ];
  for (const [key, name, role, at, privileged] of people) {
    const user = await createUser(database, { name, grants: [{ role, branchId: at }] });
    ids.set(`user:${key}`, user.principalId);
    sessions.set(key, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api?.close();
  await fake?.close();
  await database?.drop();
});

describe('cancelOrder (FR-ORD-014)', () => {
  it('refuses the Cashier, the Storekeeper, the Investor and a salesperson of another branch, and releases nothing (ADR-0035)', async () => {
    const placed = await placeOrder();
    await confirmOrder(placed.id);
    for (const who of ['cashier', 'storekeeper', 'investor', 'elsewhere']) {
      const refused = await cancel(who, placed.id);
      expect(refused.status, who).toBe(403);
    }
    expect(await statusOf(placed.id)).toBe('CONFIRMED');
    expect(await reservations(placed.id)).toEqual([{ qty: '4.000', status: 'ACTIVE' }]);
    expect((await cancel('sales', randomUUID())).status).toBe(404);
  });

  it('cancels a placed order once with its reason: every line cancelled, the history recorded, the event published, a replay answering the same', async () => {
    const placed = await placeOrder();
    const key = randomUUID();
    const cancelled = await cancel('sales', placed.id, { reasonCode: 'CUSTOMER_CANCELLED', note: 'Customer called' }, key);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body).toMatchObject({ id: placed.id, status: 'CANCELLED', paymentStatus: 'UNPAID', paidPesewas: 0 });
    expect(cancelled.body.lines.map((l: { lineStatus: string }) => l.lineStatus)).toEqual(['CANCELLED']);
    const replay = await cancel('sales', placed.id, { reasonCode: 'CUSTOMER_CANCELLED', note: 'Customer called' }, key);
    expect(replay.status).toBe(200);
    expect(replay.body.version).toBe(cancelled.body.version);
    const history = await get('sales', `/orders/${placed.id}/history`);
    expect(history.body.data.map((c: { toStatus: string; reason: string | null }) => [c.toStatus, c.reason])).toEqual([
      ['PLACED', null],
      ['CANCELLED', 'CUSTOMER_CANCELLED: Customer called'],
    ]);
    expect(await events('ord.OrderCancelled', placed.id)).toEqual([
      expect.objectContaining({ orderId: placed.id, orderNo: placed.orderNo, fromStatus: 'PLACED', reasonCode: 'CUSTOMER_CANCELLED', releasedReservationIds: [], refundIds: [], refundRequestedPesewas: 0 }),
    ]);
    const again = await cancel('sales', placed.id);
    expect(again.status).toBe(422);
    expect(again.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [expect.objectContaining({ code: 'CANCELLED' })] });
  });

  it('refuses a reason that is not a cancellation reason, and changes nothing', async () => {
    const placed = await placeOrder();
    const refused = await cancel('sales', placed.id, { reasonCode: 'CUSTOMER_CHANGED_MIND' });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'ORDER_INVALID', details: [expect.objectContaining({ field: '/reasonCode', code: 'REASON_NOT_ALLOWED' })] });
    expect(await statusOf(placed.id)).toBe('PLACED');
  });

  it('gives a confirmed order’s 4 crates back: its reservation released and available again to the crate', async () => {
    const before = await available(id('eggs'));
    const placed = await placeOrder();
    await confirmOrder(placed.id);
    const held = await available(id('eggs'));
    expect(Number(before) - Number(held)).toBe(4);
    const cancelled = await cancel('manager', placed.id, { reasonCode: 'OUT_OF_STOCK' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(await reservations(placed.id)).toEqual([{ qty: '4.000', status: 'RELEASED' }]);
    expect(await available(id('eggs'))).toBe(before);
    const [event] = await events('ord.OrderCancelled', placed.id);
    expect(event).toMatchObject({ fromStatus: 'CONFIRMED', reasonCode: 'OUT_OF_STOCK' });
    expect(event!['releasedReservationIds']).toHaveLength(1);
  });

  it('asks back exactly the 2,000 a prepaid order was paid, releases its pending charge, and clears money arriving later as unmatched (A-210)', async () => {
    await receiveCabbage('2.000');
    const placed = await placeOrder({ paymentTerms: 'PREPAID', lines: [{ productId: id('cabbage'), quantity: '2.000' }] });
    const paid = await initiateCharge(api.server, as('sales'), { amountPesewas: 2_000, orderId: placed.id, customerId: id('tema') });
    await approveAndDeliver(api.server, fake, referenceFor(paid.body.id));
    await confirmOrder(placed.id);
    const pending = await initiateCharge(api.server, as('sales'), { amountPesewas: 500, orderId: placed.id, customerId: id('tema') });
    expect(pending.status).toBe(201);

    const cancelled = await cancel('sales', placed.id, { reasonCode: 'CUSTOMER_CANCELLED' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(await reservations(placed.id)).toEqual([{ qty: '2.000', status: 'RELEASED' }]);
    const refunds = await refundsOf(paid.body.id);
    expect(refunds).toEqual([{ amount: 2_000, status: 'PENDING_APPROVAL', reasonCode: 'ORDER_CANCELLED', createdBy: id('user:sales'), approval: expect.any(String) }]);
    const approval = await admin().query<{ kind: string; status: string }>('SELECT kind, status FROM iam.approval_request WHERE id = $1', [refunds[0]!.approval]);
    expect(approval.rows[0]).toEqual({ kind: 'REFUND', status: 'PENDING' });
    expect(await releasedAt(pending.body.id)).toEqual(clock.now());
    expect(await events('ord.OrderCancelled', placed.id)).toEqual([expect.objectContaining({ refundRequestedPesewas: 2_000, releasedChargePaymentIds: [pending.body.id] })]);

    // The customer approves the released charge afterwards: it clears as an unmatched deposit, never the order's.
    expect((await approveAndDeliver(api.server, fake, referenceFor(pending.body.id))).status).toBe(200);
    const breaks = await admin().query<{ kind: string }>('SELECT kind FROM pay.reconciliation_break WHERE payment_id = $1', [pending.body.id]);
    expect(breaks.rows.map((b) => b.kind)).toEqual(['UNMATCHED_PAYMENT']);
    const cleared = await events('pay.PaymentCleared', pending.body.id);
    expect(cleared).toEqual([expect.objectContaining({ heldAsUnmatched: true })]);
    expect(await statusOf(placed.id)).toBe('CANCELLED');

    // The refund waits for a different approver: the canceller cannot approve it, the Owner can.
    expect((await decide('sales', refunds[0]!.approval!, 'approve')).status).toBe(403);
    await step('owner');
    const approved = await decide('owner', refunds[0]!.approval!, 'approve');
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await refundsOf(paid.body.id))[0]!.status).toBe('APPROVED');
    expect(await trialBalanceSum(database)).toBe('0');
  });

  it('does all of it or none of it: a refund the database refuses leaves the reservation held, the charge open and the order confirmed', async () => {
    await receiveCabbage('1.000');
    const placed = await placeOrder({ paymentTerms: 'PREPAID', lines: [{ productId: id('cabbage'), quantity: '1.000' }] });
    const paid = await initiateCharge(api.server, as('sales'), { amountPesewas: 1_000, orderId: placed.id, customerId: id('tema') });
    await approveAndDeliver(api.server, fake, referenceFor(paid.body.id));
    await confirmOrder(placed.id);
    const pending = await initiateCharge(api.server, as('sales'), { amountPesewas: 300, orderId: placed.id, customerId: id('tema') });
    await admin().query(`CREATE FUNCTION pay.test_refuse_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refund refused for the test'; END $$`);
    await admin().query('CREATE TRIGGER trg_test_refuse_refund BEFORE INSERT ON pay.refund FOR EACH ROW EXECUTE FUNCTION pay.test_refuse_refund()');
    try {
      const failed = await cancel('sales', placed.id, { reasonCode: 'CUSTOMER_CANCELLED' });
      expect(failed.status).toBe(500);
    } finally {
      await admin().query('DROP TRIGGER trg_test_refuse_refund ON pay.refund');
      await admin().query('DROP FUNCTION pay.test_refuse_refund()');
    }
    expect(await statusOf(placed.id)).toBe('CONFIRMED');
    expect(await reservations(placed.id)).toEqual([{ qty: '1.000', status: 'ACTIVE' }]);
    expect(await releasedAt(pending.body.id)).toBeNull();
    expect(await refundsOf(paid.body.id)).toEqual([]);
    expect(await events('ord.OrderCancelled', placed.id)).toEqual([]);
    const cancelled = await cancel('sales', placed.id, { reasonCode: 'CUSTOMER_CANCELLED' });
    expect(cancelled.status).toBe(200);
    expect(await refundsOf(paid.body.id)).toEqual([expect.objectContaining({ amount: 1_000, status: 'PENDING_APPROVAL' })]);
  });

  it('refuses to cancel a completed sale: it is voided or returned instead', async () => {
    const sale = await counterSale('cashier', 1, { id: '019a8000-0000-7000-8000-00000000c001', code: 'C1' });
    const refused = await cancel('manager', sale.id);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [expect.objectContaining({ code: 'COMPLETED' })] });
  });
});

describe('voidOrder under SALE_VOID (FR-ORD-002, abuse case 1)', () => {
  const TILL = { id: '019a8000-0000-7000-8000-00000000c003', code: 'C3' };
  let sale: { id: string; receiptId: string };
  let yamsBefore: string;
  let approvalId: string;

  beforeAll(async () => {
    yamsBefore = await onHand(id('yam'));
    sale = await counterSale('cashier', 2, TILL);
    expect(Number(yamsBefore) - Number(await onHand(id('yam')))).toBe(2);
    expect(await balanceOf(database, '1000', 'C3')).toBe(4_000);
  });

  it('refuses the Storekeeper, the Investor, the Accountant and another branch a void (ADR-0035)', async () => {
    for (const who of ['storekeeper', 'investor', 'accountant', 'elsewhere']) {
      expect((await askVoid(who, sale.id)).status, who).toBe(403);
    }
    expect(await admin().query('SELECT 1 FROM ord.order_void WHERE sales_order_id = $1', [sale.id])).toMatchObject({ rowCount: 0 });
  });

  it('takes the cashier’s request as 202 and changes nothing until a supervisor approves; every request is published for the exception report', async () => {
    const key = randomUUID();
    const asked = await askVoid('cashier', sale.id, undefined, key);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'SALE_VOID', subject: { id: sale.id, docType: 'SALES_ORDER' } });
    approvalId = asked.body.approvalRequestId as string;
    expect((await askVoid('cashier', sale.id, undefined, key)).body.approvalRequestId).toBe(approvalId);
    expect(await statusOf(sale.id)).toBe('COMPLETED');
    expect(await admin().query("SELECT 1 FROM bil.billing_document WHERE original_document_id = $1 AND kind = 'CREDIT_NOTE'", [sale.receiptId])).toMatchObject({ rowCount: 0 });
    expect(await events('ord.SaleVoidRequested', sale.id)).toEqual([
      expect.objectContaining({ amountPesewas: 4_000, reasonCode: 'CUSTOMER_CHANGED_MIND', requestedBy: id('user:cashier'), cashierId: id('user:cashier'), approvalRequestId: approvalId, abuseCases: [1] }),
    ]);
    const twice = await askVoid('sales', sale.id);
    expect(twice.status).toBe(422);
    expect(twice.body.error).toMatchObject({ code: 'ORDER_INVALID', details: [expect.objectContaining({ code: 'VOID_PENDING' })] });
    const wrongReason = await askVoid('sales', sale.id, { reasonCode: 'CUSTOMER_CANCELLED' });
    expect(wrongReason.body.error.details.map((d: { code: string }) => d.code)).toEqual(['VOID_PENDING', 'REASON_NOT_ALLOWED']);
  });

  it('refuses the cashier approving their own void, and anyone without ord.void.approve', async () => {
    const own = await decide('cashier', approvalId, 'approve');
    expect(own.status).toBe(403);
    expect((await decide('sales', approvalId, 'approve')).status).toBe(403);
    expect(await statusOf(sale.id)).toBe('COMPLETED');
  });

  it('voids on the Owner’s approval with step-up: a credit note of 4,000, the cash reversed out of the till, the yams back in stock, the books at zero', async () => {
    await step('owner');
    const approved = await decide('owner', approvalId, 'approve');
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const got = await get('cashier', `/orders/${sale.id}`);
    expect(got.body).toMatchObject({ status: 'VOIDED', finalTotalPesewas: 4_000, billingDocument: { id: sale.receiptId, docType: 'RECEIPT' } });
    const row = await admin().query<{ voided_by: string; void_approval_request_id: string }>('SELECT voided_by, void_approval_request_id FROM ord.sales_order WHERE id = $1', [sale.id]);
    expect(row.rows[0]).toEqual({ voided_by: id('user:owner'), void_approval_request_id: approvalId });

    const credit = await admin().query<{ id: string; document_no: string; gross: string; reason_code: string; created_by: string }>(
      "SELECT id, document_no, gross_pesewas::text AS gross, reason_code, created_by FROM bil.billing_document WHERE original_document_id = $1 AND kind = 'CREDIT_NOTE'",
      [sale.receiptId],
    );
    expect(credit.rows).toEqual([{ id: expect.any(String), document_no: expect.stringMatching(/^CRN-/), gross: '4000', reason_code: 'CUSTOMER_CHANGED_MIND', created_by: id('user:owner') }]);
    // The credit note takes the 4,000 back off the walk-in's receivable into sales returns (4200, ADR-0003), and the
    // reversed stock issue, sourced from the credit note, puts the yams' 2,400 of cost back into stock.
    expect(await journalOf(database, credit.rows[0]!.id, 'bil.CreditNoteIssued')).toEqual([
      ['4200', 'D', 4_000, null],
      ['1200', 'C', 4_000, 'Walk-in customer'],
    ]);
    expect(await journalOf(database, credit.rows[0]!.id, 'inv.StockIssuedForSale')).toEqual([
      ['5020', 'C', 2_400, null],
      ['1330', 'D', 2_400, null],
    ]);
    const settlement = await admin().query<{ credited: string; allocated: string; outstanding: string }>(
      'SELECT credited_pesewas::text AS credited, allocated_pesewas::text AS allocated, outstanding_pesewas::text AS outstanding FROM bil.document_settlement WHERE billing_document_id = $1',
      [sale.receiptId],
    );
    expect(settlement.rows[0]).toEqual({ credited: '4000', allocated: '0', outstanding: '0' });

    const payment = await admin().query<{ id: string; status: string }>("SELECT id, status FROM pay.payment WHERE order_document_id = $1 AND reverses_payment_id IS NULL", [sale.id]);
    expect(payment.rows.map((p) => p.status)).toEqual(['REVERSED']);
    const reversing = await admin().query<{ id: string }>('SELECT id FROM pay.payment WHERE reverses_payment_id = $1', [payment.rows[0]!.id]);
    const mirror = await journalOf(database, reversing.rows[0]!.id, 'pay.PaymentReversed');
    expect(mirror).toEqual([
      ['1000', 'C', 4_000, 'C3'],
      ['1200', 'D', 4_000, 'Walk-in customer'],
    ]);
    expect(await balanceOf(database, '1000', 'C3')).toBe(0);
    expect(await onHand(id('yam'))).toBe(yamsBefore);
    const movements = await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM inv.stock_movement WHERE reverses_movement_id IS NOT NULL AND source_document_id = $1", [credit.rows[0]!.id]);
    expect(movements.rows[0]!.n).toBe('1');

    const history = await get('cashier', `/orders/${sale.id}/history`);
    expect(history.body.data.map((c: { toStatus: string; actor: { id: string } }) => [c.toStatus, c.actor.id])).toEqual([
      ['PLACED', id('user:cashier')],
      ['COMPLETED', id('user:cashier')],
      ['VOIDED', id('user:owner')],
    ]);
    expect(await events('ord.OrderVoided', sale.id)).toEqual([
      expect.objectContaining({ amountPesewas: 4_000, creditNoteId: credit.rows[0]!.id, voidedBy: id('user:owner'), cashierId: id('user:cashier'), requestedBy: id('user:cashier'), abuseCases: [1] }),
    ]);
    expect(await trialBalanceSum(database)).toBe('0');
    const again = await askVoid('manager', sale.id);
    expect(again.status).toBe(422);
    expect(again.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [expect.objectContaining({ code: 'VOIDED' })] });
  });

  it('refuses a supervisor approving the void of a sale they made, keeps it waiting, and lets a rejection leave the sale as it was', async () => {
    const own = await counterSale('manager', 1, { id: '019a8000-0000-7000-8000-00000000c004', code: 'C4' });
    const asked = await askVoid('sales', own.id, { reasonCode: 'KEYING_ERROR' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    await step('manager');
    const refused = await decide('manager', asked.body.approvalRequestId, 'approve');
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('MAKER_CANNOT_CHECK');
    expect(await statusOf(own.id)).toBe('COMPLETED');
    await step('owner');
    const rejected = await decide('owner', asked.body.approvalRequestId, 'reject');
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(await statusOf(own.id)).toBe('COMPLETED');
    expect((await admin().query<{ status: string }>('SELECT status FROM ord.order_void WHERE sales_order_id = $1', [own.id])).rows.map((r) => r.status)).toEqual(['REJECTED']);
    expect(await balanceOf(database, '1000', 'C4')).toBe(2_000);
    expect((await askVoid('sales', own.id, { reasonCode: 'KEYING_ERROR' })).status).toBe(202);
  });

  it('refuses in the database a sale voided by the cashier who made it, and a void written other than waiting', async () => {
    const own = await counterSale('cashier', 1, { id: '019a8000-0000-7000-8000-00000000c005', code: 'C5' });
    const app = database.pool('app');
    const approval = (await admin().query<{ id: string }>('SELECT id FROM iam.approval_request LIMIT 1')).rows[0]!.id;
    await expect(
      app.query("UPDATE ord.sales_order SET status = 'VOIDED', void_approval_request_id = $2, voided_by = created_by, voided_at = now(), updated_by = created_by, version = version + 1 WHERE id = $1", [own.id, approval]),
    ).rejects.toMatchObject({ constraint: 'ck_sales_order_void_checker' });
    await expect(
      app.query("UPDATE ord.sales_order SET status = 'VOIDED', void_approval_request_id = $2, voided_by = salesperson_id, voided_at = now(), updated_by = created_by, version = version + 1 WHERE id = $1", [own.id, approval]),
    ).rejects.toMatchObject({ constraint: 'ck_sales_order_void_checker' });
    await expect(
      app.query("INSERT INTO ord.order_void (id, sales_order_id, reason_code, status, approval_request_id, branch_id, created_by, updated_by) VALUES ($1, $2, 'KEYING_ERROR', 'APPROVED', $3, $4, $5, $5)", [
        randomUUID(),
        own.id,
        approval,
        branchId,
        SYSTEM_PRINCIPAL,
      ]),
    ).rejects.toMatchObject({ code: 'HK004' });
  });

  it('refuses a void once the sale’s business day has ended, at the request and at the approval alike', async () => {
    const late = await counterSale('cashier', 1, { id: '019a8000-0000-7000-8000-00000000c006', code: 'C6' });
    const asked = await askVoid('cashier', late.id, { reasonCode: 'KEYING_ERROR' });
    expect(asked.status).toBe(202);
    const next = await counterSale('cashier', 1, { id: '019a8000-0000-7000-8000-00000000c007', code: 'C7' });
    // Just past midnight in Accra (UTC all year): the next business day.
    const now = clock.now();
    clock.advanceBy(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 1) - now.getTime());
    const tooLate = await askVoid('cashier', next.id, { reasonCode: 'KEYING_ERROR' });
    expect(tooLate.status).toBe(422);
    expect(tooLate.body.error.details).toEqual([expect.objectContaining({ code: 'VOID_DAY_CLOSED' })]);
    await step('owner');
    const approved = await decide('owner', asked.body.approvalRequestId, 'approve');
    expect(approved.status).toBe(422);
    expect(approved.body.error.details).toEqual([expect.objectContaining({ code: 'VOID_DAY_CLOSED' })]);
    expect(await statusOf(late.id)).toBe('COMPLETED');
    expect(await trialBalanceSum(database)).toBe('0');
  });

  /**
   * A sale credited to a salesperson other than the person who posted it. Every path built so far makes the poster its
   * salesperson; B9b's counter and B10's quotes will not. The admin connection credits it here, with the order's guard
   * off for that one statement, so each half of the rule is proved on its own.
   */
  async function creditedTo(saleId: string, salesperson: string): Promise<void> {
    const client = await admin().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query('UPDATE ord.sales_order SET salesperson_id = $2 WHERE id = $1', [saleId, id(`user:${salesperson}`)]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }

  it('refuses the supervisor who asked for a void approving it, in the application and in the database', async () => {
    const sale = await counterSale('cashier', 1, { id: '019a8000-0000-7000-8000-00000000c008', code: 'C8' });
    const asked = await askVoid('manager', sale.id, { reasonCode: 'KEYING_ERROR' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    await step('manager');
    const own = await decide('manager', asked.body.approvalRequestId, 'approve');
    expect(own.status).toBe(422);
    expect(own.body.error.code).toBe('MAKER_CANNOT_CHECK');
    expect(await statusOf(sale.id)).toBe('COMPLETED');
    const app = database.pool('app');
    await expect(
      app.query("UPDATE ord.order_void SET status = 'REJECTED', decided_by = created_by, decided_at = $2, updated_by = created_by, version = version + 1 WHERE sales_order_id = $1", [
        sale.id,
        clock.now(),
      ]),
    ).rejects.toMatchObject({ constraint: 'ck_order_void_decided' });
    expect((await admin().query<{ status: string }>('SELECT status FROM ord.order_void WHERE sales_order_id = $1', [sale.id])).rows.map((r) => r.status)).toEqual(['PENDING_APPROVAL']);
  });

  it('refuses the sale’s salesperson and its poster each on their own, in the application and in the database', async () => {
    // Posted by the cashier, credited to the Manager: the Manager is refused as its salesperson.
    const bySalesperson = await counterSale('cashier', 1, { id: '019a8000-0000-7000-8000-00000000c009', code: 'C9' });
    await creditedTo(bySalesperson.id, 'manager');
    const first = await askVoid('cashier', bySalesperson.id, { reasonCode: 'KEYING_ERROR' });
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    await step('manager');
    const salesperson = await decide('manager', first.body.approvalRequestId, 'approve');
    expect(salesperson.status, JSON.stringify(salesperson.body)).toBe(422);
    expect(salesperson.body.error.code).toBe('MAKER_CANNOT_CHECK');
    expect(await statusOf(bySalesperson.id)).toBe('COMPLETED');

    // Posted by the Manager, credited to Sales: the Manager is refused as its poster.
    const byPoster = await counterSale('manager', 1, { id: '019a8000-0000-7000-8000-00000000c00a', code: 'CA' });
    await creditedTo(byPoster.id, 'sales');
    const second = await askVoid('cashier', byPoster.id, { reasonCode: 'KEYING_ERROR' });
    expect(second.status, JSON.stringify(second.body)).toBe(202);
    await step('manager');
    const poster = await decide('manager', second.body.approvalRequestId, 'approve');
    expect(poster.status, JSON.stringify(poster.body)).toBe(422);
    expect(poster.body.error.code).toBe('MAKER_CANNOT_CHECK');
    expect(await statusOf(byPoster.id)).toBe('COMPLETED');

    // The database refuses each half of the rule where the other half would not catch it.
    const app = database.pool('app');
    const approval = second.body.approvalRequestId as string;
    for (const [saleId, voider] of [
      [bySalesperson.id, 'salesperson_id'],
      [byPoster.id, 'created_by'],
    ] as const) {
      await expect(
        app.query(`UPDATE ord.sales_order SET status = 'VOIDED', void_approval_request_id = $2, voided_by = ${voider}, voided_at = $3, updated_by = created_by, version = version + 1 WHERE id = $1`, [
          saleId,
          approval,
          clock.now(),
        ]),
        voider,
      ).rejects.toMatchObject({ constraint: 'ck_sales_order_void_checker' });
    }

    // The Owner, neither of them, voids the sale credited to the Manager.
    await step('owner');
    const approved = await decide('owner', first.body.approvalRequestId, 'approve');
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await statusOf(bySalesperson.id)).toBe('VOIDED');
    expect(await trialBalanceSum(database)).toBe('0');
  });

  it('refuses a void of a sale that also holds a mobile money payment: that money goes back through a return', async () => {
    const sale = await counterSale('cashier', 1, { id: '019a8000-0000-7000-8000-00000000c00b', code: 'CB' });
    const charge = await initiateCharge(api.server, as('sales'), { amountPesewas: 500, orderId: sale.id, customerId: id('tema') });
    expect(charge.status, JSON.stringify(charge.body)).toBe(201);
    const asked = await askVoid('cashier', sale.id, { reasonCode: 'KEYING_ERROR' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(422);
    expect(asked.body.error.details).toEqual([expect.objectContaining({ code: 'TENDER_NOT_VOIDABLE', field: '/payments' })]);
    expect(await admin().query('SELECT 1 FROM ord.order_void WHERE sales_order_id = $1', [sale.id])).toMatchObject({ rowCount: 0 });
  });
});
