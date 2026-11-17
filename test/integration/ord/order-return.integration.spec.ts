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
import { journalOf, trialBalanceSum } from '../../support/pay';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Returns against the original sale (FR-ORD-015, FR-PAY-012, ADR-0066, abuse case 12, A-228). A return never takes back
 * more than was sold less what returns not rejected already hold, held by the database under concurrency; it waits for
 * a supervisor who did not make it; approved, it leaves a credit note made by its maker under that approval, the stock
 * back by its disposition at the cost it left at, and a refund against the credit note that neither its maker nor the
 * credit note's maker may approve. Every write refuses the wrong role and the wrong branch.
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
const decide = (who: string, approvalId: string, verb: 'approve' | 'reject') => post(who, `/iam/approvals/${approvalId}/${verb}`, { reason: 'Seen the goods come back' });
let till = 0;
const nextTill = () => {
  till += 1;
  return { id: `019a8000-0000-7000-8000-0000000d${String(till).padStart(4, '0')}`, code: `R${till}` };
};

type Disposition = 'RESTOCK' | 'RETURNS_HOLD' | 'WRITE_OFF';
interface Sale {
  readonly id: string;
  readonly receiptId: string;
  readonly lines: ReadonlyMap<string, { readonly id: string; readonly movementId: string }>;
}

const PRICE: Record<string, number> = { yam: 2_000, carrot: 25_000, cabbage: 1_000 };

/** A counter sale for cash, posted through `SalePosting.postIn` as the person named (the cashier). */
async function sell(who: string, items: Readonly<Record<string, number>>): Promise<Sale> {
  const uow = api.app.get(UnitOfWork);
  const sales = api.app.get(SalePosting);
  const actor: Actor = { principalId: id(`user:${who}`), kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null };
  const entries = Object.entries(items);
  const gross = entries.reduce((sum, [name, qty]) => sum + PRICE[name]! * qty, 0);
  const request: SaleRequest = {
    orderId: createUuidV7Generator(clock)(),
    channel: 'WHOLESALE',
    branchId,
    fulfilmentMode: 'COUNTER',
    taxInclusive: true,
    lines: entries.map(([name, qty]) => ({ productId: id(name), fromLocationId: id('SHOP'), quantity: `${qty}.000` })),
    tenders: [{ methodCode: 'CASH', amountPesewas: BigInt(gross), register: nextTill() }],
  };
  const sold = await runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'returns test', actor }, () =>
    uow.run({ isolation: 'serializable', seriesLocks: sales.locksFor(branchId) }, (tx) => sales.postIn(tx, actor, request)),
  );
  const order = await admin().query<{ billing_document_id: string }>('SELECT billing_document_id FROM ord.sales_order WHERE id = $1', [sold.id]);
  const lines = await admin().query<{ id: string; product_id: string; stock_movement_id: string }>('SELECT id, product_id, stock_movement_id FROM ord.sales_order_line WHERE sales_order_id = $1', [sold.id]);
  const byName = new Map<string, { id: string; movementId: string }>();
  for (const [name] of entries) {
    const line = lines.rows.find((l) => l.product_id === id(name))!;
    byName.set(name, { id: line.id, movementId: line.stock_movement_id });
  }
  return { id: sold.id, receiptId: order.rows[0]!.billing_document_id, lines: byName };
}

const returnBody = (sale: Sale, lines: readonly [string, number, Disposition][], over: Record<string, unknown> = {}) => ({
  orderId: sale.id,
  kind: 'RETURN',
  reasonCode: 'RETURN_UNWANTED',
  refundDestination: 'ORIGINAL_METHOD',
  lines: lines.map(([name, qty, disposition]) => ({ orderLineId: sale.lines.get(name)!.id, qty: `${qty}.000`, disposition })),
  ...over,
});
const createReturn = (who: string, sale: Sale, lines: readonly [string, number, Disposition][], key: string = randomUUID()) => post(who, '/returns', returnBody(sale, lines), key);
const submit = (who: string, returnId: string, key: string = randomUUID()) => post(who, `/returns/${returnId}/submit`, {}, key);

/** A return made, submitted and approved by the Owner: what a completed return leaves. */
async function completedReturn(maker: string, sale: Sale, lines: readonly [string, number, Disposition][]): Promise<{ id: string; approvalId: string }> {
  const created = await createReturn(maker, sale, lines);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const submitted = await submit(maker, created.body.id);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
  await step('owner');
  const approved = await decide('owner', submitted.body.approvalRequestId, 'approve');
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return { id: created.body.id, approvalId: submitted.body.approvalRequestId };
}

async function receive(name: string, qty: string, valuePesewas: number): Promise<void> {
  const documentId = randomUUID();
  const app = database.pool('app');
  await app.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'GOODS_RECEIPT', 'inv', $2, $3)", [documentId, branchId, SYSTEM_PRINCIPAL]);
  await app.query(
    `INSERT INTO inv.stock_movement (id, movement_type, product_id, branch_id, from_location_id, to_location_id, qty_base, value_pesewas, cost_element, source_document_id, occurred_at, actor_id)
     VALUES ($1, 'RECEIPT_PURCHASE', $2, $3, $4, $5, $6, $7, 'PURCHASE', $8, $9, $10)`,
    [randomUUID(), id(name), branchId, id('SUPPLIER'), id('SHOP'), qty, valuePesewas, documentId, clock.now(), SYSTEM_PRINCIPAL],
  );
}

const onHand = async (name: string, location: string) =>
  (await admin().query<{ qty: string | null }>('SELECT sum(on_hand_qty)::numeric(14,3)::text AS qty FROM inv.stock_balance WHERE product_id = $1 AND location_id = $2', [id(name), id(location)])).rows[0]!.qty ?? '0.000';
const returnedMovements = async (returnId: string) =>
  (
    await admin().query<{ qty: string; value: string; to_location_id: string; returns_movement_id: string; movement_type: string }>(
      'SELECT qty_base::text AS qty, value_pesewas::text AS value, to_location_id, returns_movement_id, movement_type FROM inv.stock_movement WHERE source_document_id = $1 ORDER BY id',
      [returnId],
    )
  ).rows;
const statusOf = async (orderId: string) => (await admin().query<{ status: string }>('SELECT status FROM ord.sales_order WHERE id = $1', [orderId])).rows[0]!.status;
const creditNotesOf = async (receiptId: string) =>
  (await admin().query<{ id: string }>("SELECT id FROM bil.billing_document WHERE original_document_id = $1 AND kind = 'CREDIT_NOTE' ORDER BY id", [receiptId])).rows.map((r) => r.id);

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  fake = await startFakePaystack(() => clock.now());
  api = await startTestApp(database, { clock, environment: { ...paystackEnvironment(fake), AUTH_ACCESS_TTL_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const code of ['SHOP', 'RETURNS']) ids.set(code, (await admin().query<{ id: string }>('SELECT id FROM mdm.location WHERE branch_id = $1 AND code = $2', [branchId, code])).rows[0]!.id);
  ids.set('SUPPLIER', (await admin().query<{ id: string }>("SELECT id FROM mdm.location WHERE branch_id = $1 AND kind = 'SUPPLIER'", [branchId])).rows[0]!.id);
  for (const [name, sku] of [
    ['yam', 'PRD-YAM-TUBER'],
    ['carrot', 'PRD-CARROT-CRATE'],
    ['cabbage', 'PRD-CABBAGE-HEAD'],
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

describe('createReturn, getReturn and submitReturn refuse the wrong role and branch (ADR-0035)', () => {
  it('lets only those who sell make a return, those who see orders read it, and its maker alone submit it', async () => {
    const sale = await sell('cashier', { yam: 2 });
    for (const who of ['accountant', 'storekeeper', 'investor', 'elsewhere']) {
      expect((await createReturn(who, sale, [['yam', 1, 'RESTOCK']])).status, who).toBe(403);
    }
    expect(await admin().query('SELECT 1 FROM ord.order_return WHERE sales_order_id = $1', [sale.id])).toMatchObject({ rowCount: 0 });
    const made = await createReturn('cashier', sale, [['yam', 1, 'RESTOCK']]);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    for (const who of ['storekeeper', 'investor', 'elsewhere']) {
      expect((await get(who, `/returns/${made.body.id}`)).status, who).toBe(403);
    }
    for (const who of ['owner', 'accountant', 'sales', 'cashier']) {
      expect((await get(who, `/returns/${made.body.id}`)).status, who).toBe(200);
    }
    expect((await get('cashier', `/returns/${randomUUID()}`)).status).toBe(404);
    for (const who of ['storekeeper', 'investor', 'accountant']) {
      expect((await submit(who, made.body.id)).status, who).toBe(403);
    }
    const notMine = await submit('sales', made.body.id);
    expect(notMine.status).toBe(422);
    expect(notMine.body.error).toMatchObject({ code: 'ORDER_INVALID', details: [expect.objectContaining({ code: 'NOT_RETURN_MAKER' })] });
    expect((await get('cashier', `/returns/${made.body.id}`)).body.status).toBe('REQUESTED');
  });
});

describe('a return never exceeds what was sold less what was returned (FR-ORD-015)', () => {
  it('cannot exceed the quantity sold: sold 2, returned 1, returning 2 more is 422 and the trigger refuses a direct insert; the order stays COMPLETED', async () => {
    const sale = await sell('cashier', { yam: 2, cabbage: 1 });
    const key = randomUUID();
    const first = await createReturn('cashier', sale, [['yam', 1, 'RESTOCK']], key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({
      returnNo: expect.stringMatching(/^RET-\d{4}-DDW-\d{6}$/),
      status: 'REQUESTED',
      order: { id: sale.id, docType: 'SALES_ORDER' },
      originalBillingDocument: { id: sale.receiptId, docType: 'RECEIPT' },
      kind: 'RETURN',
      reasonCode: 'RETURN_UNWANTED',
      lines: [{ orderLineId: sale.lines.get('yam')!.id, product: { id: id('yam'), sku: 'PRD-YAM-TUBER' }, qty: '1.000', weightKg: null, disposition: 'RESTOCK', refundPesewas: 2_000 }],
      creditNote: null,
      refund: null,
      exchangeOrderId: null,
      approvalRequestId: null,
      totalRefundPesewas: 2_000,
      currency: 'GHS',
      branchId,
      createdBy: { id: id('user:cashier') },
    });
    expect((await createReturn('cashier', sale, [['yam', 1, 'RESTOCK']], key)).body.id).toBe(first.body.id);

    const tooMany = await createReturn('cashier', sale, [['yam', 2, 'RESTOCK']]);
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error).toMatchObject({ code: 'ORDER_INVALID', details: [{ field: '/lines/0/qty', code: 'RETURN_EXCEEDS_SOLD', message: expect.any(String) }] });

    // A second return of the cabbage, then 2 yams written into it by hand: the database refuses them.
    const second = await createReturn('cashier', sale, [['cabbage', 1, 'RESTOCK']]);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    await expect(
      database
        .pool('app')
        .query("INSERT INTO ord.order_return_line (id, order_return_id, sales_order_line_id, line_no, qty, disposition) VALUES ($1, $2, $3, 2, 2, 'RESTOCK')", [
          randomUUID(),
          second.body.id,
          sale.lines.get('yam')!.id,
        ]),
    ).rejects.toMatchObject({ constraint: 'ck_order_return_line_cap' });
    const held = await admin().query<{ qty: string }>('SELECT sum(qty)::text AS qty FROM ord.order_return_line WHERE sales_order_line_id = $1', [sale.lines.get('yam')!.id]);
    expect(held.rows[0]!.qty).toBe('1.000');
    expect(await statusOf(sale.id)).toBe('COMPLETED');
  });

  it('takes no return of an order that is not a completed sale', async () => {
    const placed = await post('sales', '/orders', { channel: 'WHOLESALE', customerId: id('tema'), fulfilmentMode: 'COLLECTION', paymentTerms: 'COD', lines: [{ productId: id('yam'), quantity: '1.000' }] });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const refused = await post('sales', '/returns', { orderId: placed.body.id, kind: 'RETURN', reasonCode: 'RETURN_UNWANTED', refundDestination: 'ORIGINAL_METHOD', lines: [{ orderLineId: placed.body.lines[0].id, qty: '1.000', disposition: 'RESTOCK' }] });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [expect.objectContaining({ code: 'PLACED' })] });
    expect((await post('sales', '/returns', { orderId: randomUUID(), kind: 'RETURN', reasonCode: 'RETURN_UNWANTED', refundDestination: 'ORIGINAL_METHOD', lines: [] })).status).toBe(404);
  });

  it('refuses an exchange, a reason that is not a return reason, and a reason without the note it asks for', async () => {
    const sale = await sell('cashier', { yam: 1 });
    const refused = await post('cashier', '/returns', returnBody(sale, [['yam', 1, 'RESTOCK']], { kind: 'EXCHANGE', reasonCode: 'CUSTOMER_CANCELLED' }));
    expect(refused.status).toBe(422);
    expect(refused.body.error.details.map((d: { code: string }) => d.code)).toEqual(['EXCHANGE_NOT_AVAILABLE', 'REASON_NOT_ALLOWED']);
    const noNote = await post('cashier', '/returns', returnBody(sale, [['yam', 1, 'RESTOCK']], { reasonCode: 'RETURN_QUALITY' }));
    expect(noNote.body.error.details.map((d: { code: string }) => d.code)).toEqual(['NOTE_REQUIRED']);
    expect((await post('cashier', '/returns', returnBody(sale, [['yam', 1, 'RESTOCK']], { reasonCode: 'RETURN_QUALITY', note: 'Soft at one end' }))).status).toBe(201);
  });

  it('holds the cap under concurrency: two returns of the last 2 at once leave one, over the API and by SQL', async () => {
    await receive('carrot', '2.000', 6_000);
    const sale = await sell('cashier', { yam: 2, carrot: 2, cabbage: 2 });
    const both = await Promise.all([createReturn('cashier', sale, [['yam', 2, 'RESTOCK']]), createReturn('cashier', sale, [['yam', 2, 'RESTOCK']])]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(both.find((r) => r.status === 422)!.body.error.details).toEqual([expect.objectContaining({ code: 'RETURN_EXCEEDS_SOLD' })]);

    // Without the application: two transactions write the carrots' last 2 into two returns of the sale at once. The
    // second waits on the sold line's lock, then finds the first's and is refused.
    const holders: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const made = await createReturn('cashier', sale, [['cabbage', 1, 'RESTOCK']]);
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      holders.push(made.body.id as string);
    }
    const one = await database.pool('app').connect();
    const two = await database.pool('app').connect();
    try {
      const insert = (client: typeof one, returnId: string) =>
        client.query("INSERT INTO ord.order_return_line (id, order_return_id, sales_order_line_id, line_no, qty, disposition) VALUES ($1, $2, $3, 2, 2, 'RESTOCK')", [randomUUID(), returnId, sale.lines.get('carrot')!.id]);
      await one.query('BEGIN');
      await two.query('BEGIN');
      await insert(one, holders[0]!).catch((e: unknown) => e);
      const waiting = insert(two, holders[1]!).then(
        () => 'written',
        (e: { constraint?: string }) => e.constraint,
      );
      await one.query('COMMIT');
      expect(await waiting).toBe('ck_order_return_line_cap');
      await two.query('ROLLBACK');
    } finally {
      one.release();
      two.release();
    }
    const held = await admin().query<{ qty: string }>('SELECT sum(qty)::text AS qty FROM ord.order_return_line WHERE sales_order_line_id = $1', [sale.lines.get('carrot')!.id]);
    expect(held.rows[0]!.qty).toBe('2.000');
  });
});

describe('submitReturn waits for a supervisor who did not make the return (ADR-0066)', () => {
  it('changes nothing until it is approved, refuses its maker as approver in IAM and in the database, and gives the quantity back when rejected', async () => {
    const sale = await sell('cashier', { yam: 1 });
    const made = await createReturn('manager', sale, [['yam', 1, 'RESTOCK']]);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const key = randomUUID();
    const submitted = await submit('manager', made.body.id, key);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
    expect(submitted.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'RETURN', subject: { id: made.body.id, docType: 'ORDER_RETURN', number: made.body.returnNo } });
    expect((await submit('manager', made.body.id, key)).body.approvalRequestId).toBe(submitted.body.approvalRequestId);
    const again = await submit('manager', made.body.id);
    expect(again.status).toBe(422);
    expect(again.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [expect.objectContaining({ code: 'PENDING_APPROVAL' })] });
    expect((await get('manager', `/returns/${made.body.id}`)).body).toMatchObject({ status: 'PENDING_APPROVAL', approvalRequestId: submitted.body.approvalRequestId, creditNote: null, refund: null });
    expect(await creditNotesOf(sale.receiptId)).toEqual([]);

    expect((await decide('sales', submitted.body.approvalRequestId, 'approve')).status).toBe(403);
    await step('manager');
    const own = await decide('manager', submitted.body.approvalRequestId, 'approve');
    expect(own.status).toBe(422);
    expect(own.body.error.code).toBe('MAKER_CANNOT_CHECK');
    await expect(
      database
        .pool('app')
        .query("UPDATE ord.order_return SET status = 'REJECTED', decided_by = created_by, decided_at = $2, updated_by = created_by, version = version + 1 WHERE id = $1", [made.body.id, clock.now()]),
    ).rejects.toMatchObject({ constraint: 'ck_order_return_decided' });
    await expect(
      database.pool('app').query('UPDATE ord.order_return_line SET qty = 0.5 WHERE order_return_id = $1', [made.body.id]),
    ).rejects.toMatchObject({ code: 'HK004' });

    await step('owner');
    expect((await decide('owner', submitted.body.approvalRequestId, 'reject')).status).toBe(200);
    expect((await get('manager', `/returns/${made.body.id}`)).body).toMatchObject({ status: 'REJECTED', creditNote: null, refund: null });
    expect(await creditNotesOf(sale.receiptId)).toEqual([]);
    expect((await createReturn('manager', sale, [['yam', 1, 'RESTOCK']])).status).toBe(201);
  });
});

describe('an approved return credits the sale, takes the goods back and asks for the refund (ADR-0066, abuse case 12)', () => {
  it('leaves a credit note of 4,000 by its maker, the yams back on the shelf at their cost, and a refund that neither the maker nor the credit note’s maker approves', async () => {
    const sale = await sell('cashier', { yam: 3 });
    const shelf = await onHand('yam', 'SHOP');
    const done = await completedReturn('manager', sale, [['yam', 2, 'RESTOCK']]);
    const view = await get('cashier', `/returns/${done.id}`);
    expect(view.body).toMatchObject({
      status: 'COMPLETED',
      approvalRequestId: done.approvalId,
      creditNote: { docType: 'CREDIT_NOTE', number: expect.stringMatching(/^CRN-/) },
      refund: { status: 'PENDING_APPROVAL', amountPesewas: 4_000 },
      lines: [expect.objectContaining({ qty: '2.000', disposition: 'RESTOCK', refundPesewas: 4_000 })],
      totalRefundPesewas: 4_000,
    });
    const [creditId] = await creditNotesOf(sale.receiptId);
    expect(view.body.creditNote.id).toBe(creditId);
    const credit = await admin().query<{ gross: string; reason_code: string; created_by: string }>('SELECT gross_pesewas::text AS gross, reason_code, created_by FROM bil.billing_document WHERE id = $1', [creditId]);
    expect(credit.rows[0]).toEqual({ gross: '4000', reason_code: 'RETURN_UNWANTED', created_by: id('user:manager') });
    expect(await journalOf(database, creditId!, 'bil.CreditNoteIssued')).toEqual([
      ['4200', 'D', 4_000, null],
      ['1200', 'C', 4_000, 'Walk-in customer'],
    ]);

    // The 2 yams go back on the shelf from the customer at the 2,400 they left at: inventory up, cost of sales down.
    expect(await returnedMovements(done.id)).toEqual([{ qty: '2.000', value: '2400', to_location_id: id('SHOP'), returns_movement_id: sale.lines.get('yam')!.movementId, movement_type: 'SALE_RETURN' }]);
    expect(await journalOf(database, done.id, 'inv.SaleReturnReceived')).toEqual([
      ['1330', 'D', 2_400, null],
      ['5020', 'C', 2_400, null],
    ]);
    expect(Number(await onHand('yam', 'SHOP')) - Number(shelf)).toBe(2);

    // The refund is the maker's, against the credit note, and waits for someone who is neither of them.
    const refund = await admin().query<{ id: string; amount: string; credit_note_id: string; created_by: string; reason_code: string; destination: string; approval_request_id: string }>(
      'SELECT id, amount_pesewas::text AS amount, credit_note_id, created_by, reason_code, destination, approval_request_id FROM pay.refund WHERE id = $1',
      [view.body.refund.id],
    );
    expect(refund.rows[0]).toMatchObject({ amount: '4000', credit_note_id: creditId, created_by: id('user:manager'), reason_code: 'ORDER_RETURNED', destination: 'ORIGINAL_METHOD' });
    await step('manager');
    const byMaker = await decide('manager', refund.rows[0]!.approval_request_id, 'approve');
    expect(byMaker.status).toBe(422);
    expect(byMaker.body.error.code).toBe('MAKER_CANNOT_CHECK');
    await step('owner');
    expect((await decide('owner', refund.rows[0]!.approval_request_id, 'approve')).status).toBe(200);
    expect((await get('cashier', `/returns/${done.id}`)).body.refund.status).toBe('APPROVED');

    const events = await admin().query<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'ord.ReturnCompleted' AND subject_id = $1", [done.id]);
    expect(events.rows.map((r) => r.payload)).toEqual([
      expect.objectContaining({ returnId: done.id, orderId: sale.id, creditNoteId: creditId, refundId: view.body.refund.id, totalRefundPesewas: 4_000, makerId: id('user:manager'), approvedBy: id('user:owner'), abuseCases: [12] }),
    ]);
    expect(await statusOf(sale.id)).toBe('COMPLETED');
    expect(await trialBalanceSum(database)).toBe('0');

    // The third yam is written off: credited and refunded, never back in stock.
    const writtenOff = await completedReturn('manager', sale, [['yam', 1, 'WRITE_OFF']]);
    expect(await returnedMovements(writtenOff.id)).toEqual([]);
    expect(Number(await onHand('yam', 'SHOP')) - Number(shelf)).toBe(2);
    expect((await get('cashier', `/returns/${writtenOff.id}`)).body).toMatchObject({ status: 'COMPLETED', totalRefundPesewas: 2_000, refund: { amountPesewas: 2_000 } });
    expect(await creditNotesOf(sale.receiptId)).toHaveLength(2);
    expect((await createReturn('manager', sale, [['yam', 1, 'RESTOCK']])).status).toBe(422);
    expect(await trialBalanceSum(database)).toBe('0');
  });

  it('takes each part of an issue back at its share, the parts summing exactly to the issue, to the shelf or the holding area', async () => {
    await receive('carrot', '3.000', 10_000);
    const sale = await sell('cashier', { carrot: 3 });
    const issued = await admin().query<{ value: string }>('SELECT value_pesewas::text AS value FROM inv.stock_movement WHERE id = $1', [sale.lines.get('carrot')!.movementId]);
    expect(issued.rows[0]!.value).toBe('10000');
    const values: string[] = [];
    for (const disposition of ['RESTOCK', 'RETURNS_HOLD', 'RESTOCK'] as const) {
      const done = await completedReturn('manager', sale, [['carrot', 1, disposition]]);
      const [moved] = await returnedMovements(done.id);
      expect(moved!.to_location_id).toBe(id(disposition === 'RESTOCK' ? 'SHOP' : 'RETURNS'));
      values.push(moved!.value);
      expect((await get('manager', `/returns/${done.id}`)).body.totalRefundPesewas).toBe(25_000);
    }
    // half_up(10,000 x 1/3) = 3,333; half_up(10,000 x 2/3) = 6,667, so 3,334; the last takes the 3,333 left.
    expect(values).toEqual(['3333', '3334', '3333']);
    expect(await onHand('carrot', 'SHOP')).toBe('2.000');
    expect(await onHand('carrot', 'RETURNS')).toBe('1.000');

    // Nothing more of the issue can come back, even written by hand.
    const documentId = randomUUID();
    const app = database.pool('app');
    await app.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'GOODS_RECEIPT', 'inv', $2, $3)", [documentId, branchId, SYSTEM_PRINCIPAL]);
    const customer = (await admin().query<{ to_location_id: string }>('SELECT to_location_id FROM inv.stock_movement WHERE id = $1', [sale.lines.get('carrot')!.movementId])).rows[0]!.to_location_id;
    await expect(
      app.query(
        `INSERT INTO inv.stock_movement (id, movement_type, product_id, branch_id, from_location_id, to_location_id, qty_base, value_pesewas, reason_code, source_document_id, returns_movement_id, occurred_at, actor_id)
         VALUES ($1, 'SALE_RETURN', $2, $3, $4, $5, 1, 0, 'RETURN_UNWANTED', $6, $7, $8, $9)`,
        [randomUUID(), id('carrot'), branchId, customer, id('SHOP'), documentId, sale.lines.get('carrot')!.movementId, clock.now(), SYSTEM_PRINCIPAL],
      ),
    ).rejects.toMatchObject({ constraint: 'ck_stock_sale_return' });
    // And a return from a customer always names the issue it takes back.
    await expect(
      app.query(
        `INSERT INTO inv.stock_movement (id, movement_type, product_id, branch_id, from_location_id, to_location_id, qty_base, value_pesewas, reason_code, source_document_id, occurred_at, actor_id)
         VALUES ($1, 'SALE_RETURN', $2, $3, $4, $5, 1, 0, 'RETURN_UNWANTED', $6, $7, $8)`,
        [randomUUID(), id('carrot'), branchId, customer, id('SHOP'), documentId, clock.now(), SYSTEM_PRINCIPAL],
      ),
    ).rejects.toMatchObject({ constraint: 'ck_stock_sale_return' });
    expect(await trialBalanceSum(database)).toBe('0');
  });
});
