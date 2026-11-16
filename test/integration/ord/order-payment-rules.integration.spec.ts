import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Billing } from '../../../src/modules/bil';
import { SalePosting, type SaleRequest, type SaleView } from '../../../src/modules/ord';
import { Payments } from '../../../src/modules/pay';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { createUser, relaxRateLimits, testStartTime } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The order and payment rules a sale relies on, each refused by the service and, where the data model puts it there, by
 * the database itself through direct SQL as `hk_app` (FR-ORD-002 to FR-ORD-004, FR-ORD-007, FR-PAY-001, FR-PAY-002,
 * FR-PAY-005, FR-PAY-009, FR-PAY-010, abuse cases 3 and 4): the machine, the pricing record, one animal to a line, a
 * movement or exception on every completed line, the cleared payment frozen, mobile money never cleared by hand, and
 * allocations bounded by the payment and by the document; and the ledger row of `pay.PaymentCleared` with an
 * unallocated part, at exact amounts.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let sales: SalePosting;
let uow: UnitOfWork;
let cashier: Actor;
let branchId: string;
let nextOrderId: () => string;
let sold: SaleView;
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const till = { id: '019a8000-0000-7000-8000-00000000a7a2', code: 'T2' };

const asCashier = <T>(work: () => Promise<T>) => runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'order rules test', actor: cashier }, work);
const post = (request: SaleRequest) => asCashier(() => uow.run({ isolation: 'serializable', seriesLocks: sales.locksFor(request.branchId) }, (tx) => sales.postIn(tx, cashier, request)));
const eggs = (overrides: Partial<SaleRequest> = {}): SaleRequest => ({
  orderId: nextOrderId(),
  channel: 'WHOLESALE',
  branchId,
  fulfilmentMode: 'COUNTER',
  taxInclusive: true,
  lines: [{ productId: id('eggs'), stockUnitId: id('eggLot'), fromLocationId: id('SHOP'), quantity: '1.000' }],
  tenders: [{ methodCode: 'CASH', amountPesewas: 6_000n, register: till }],
  ...overrides,
});

async function refusedBy(sql: string, values: unknown[]): Promise<string | undefined> {
  try {
    await app().query(sql, values);
    return undefined;
  } catch (error) {
    return `${(error as { code?: string }).code}:${(error as { constraint?: string }).constraint ?? ''}`;
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextOrderId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  sales = api.app.get(SalePosting);
  uow = api.app.get(UnitOfWork);
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const code of ['PENS', 'SHOP', 'COLD']) ids.set(code, (await admin().query<{ id: string }>('SELECT id FROM mdm.location WHERE branch_id = $1 AND code = $2', [branchId, code])).rows[0]!.id);
  for (const [name, sku] of [['goat', 'LIV-GOAT'], ['eggs', 'EGG-CRATE-BIG'], ['sheep', 'LIV-SHEEP'], ['cabbage', 'PRD-CABBAGE-HEAD']] as const) {
    ids.set(name, (await admin().query<{ id: string }>('SELECT id FROM mdm.product WHERE sku = $1', [sku])).rows[0]!.id);
  }
  for (const [name, identifier] of [['G-0142', 'G-0142'], ['eggLot', 'EGG-BIG-2026-1110'], ['S-0031', 'S-0031']] as const) {
    ids.set(name, (await admin().query<{ id: string }>('SELECT id FROM inv.stock_unit WHERE identifier = $1', [identifier])).rows[0]!.id);
  }
  ids.set('tema', (await admin().query<{ id: string }>("SELECT id FROM mdm.customer WHERE name = 'Tema Cold Store Ltd (SEED)'")).rows[0]!.id);
  const user = await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'CASHIER', branchId }] });
  cashier = { principalId: user.principalId, kind: 'USER', displayName: 'Kofi Mensah', realm: 'STAFF', sessionId: null, steppedUpAt: null };
  sold = await post(eggs());
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('a sale is refused, posting nothing, when it breaks a rule (FR-ORD-003, FR-ORD-006, FR-PAY-005)', () => {
  it('refuses a price below list with no approval, outside the band or not (abuse case 3, PRICE_OVERRIDE_NEEDS_APPROVAL)', async () => {
    const goat = { productId: id('goat'), stockUnitId: id('G-0142'), fromLocationId: id('PENS'), quantity: '1.000', varianceReasonCode: 'REGULAR_CUSTOMER' };
    // Wholesale GOAT-M: list 58,500, floor 36,000, ceiling 65,000.
    await expect(post(eggs({ lines: [{ ...goat, agreedUnitPricePesewas: 58_499n }], tenders: [{ methodCode: 'CASH', amountPesewas: 58_499n, register: till }] }))).rejects.toMatchObject({
      code: 'PRICE_OVERRIDE_NEEDS_APPROVAL',
      details: [expect.objectContaining({ code: 'BEYOND_ROLE_LIMIT' })],
    });
    await expect(post(eggs({ lines: [{ ...goat, agreedUnitPricePesewas: 65_001n }], tenders: [{ methodCode: 'CASH', amountPesewas: 65_001n, register: till }] }))).rejects.toMatchObject({
      code: 'PRICE_OVERRIDE_NEEDS_APPROVAL',
      details: [expect.objectContaining({ code: 'OUTSIDE_BAND' })],
    });
  });

  it('takes a price above list within the ceiling with its reason, recording the variance, and refuses it without one', async () => {
    const goat = { productId: id('goat'), stockUnitId: id('G-0142'), fromLocationId: id('PENS'), quantity: '1.000', agreedUnitPricePesewas: 60_000n };
    await expect(post(eggs({ lines: [goat], tenders: [{ methodCode: 'CASH', amountPesewas: 60_000n, register: till }] }))).rejects.toMatchObject({ code: 'SALE_INVALID', details: [expect.objectContaining({ code: 'VARIANCE_REASON_REQUIRED' })] });
    const sale = await post(eggs({ lines: [{ ...goat, varianceReasonCode: 'REGULAR_CUSTOMER' }], tenders: [{ methodCode: 'CASH', amountPesewas: 60_000n, register: till }] }));
    expect(sale.lines.map((l) => [l.resolvedUnitPricePesewas, l.agreedUnitPricePesewas, l.variancePesewas, l.varianceDirection, l.varianceReasonCode])).toEqual([[58_500, 60_000, 1_500, 'ABOVE', 'REGULAR_CUSTOMER']]);
    // The receipt posts the variance above list to 4210 (A-200): sales at 58,500, 4210 credited 1,500.
    const { rows } = await admin().query<{ code: string; side: string; amount: string }>(
      `SELECT a.code, l.side, l.amount_pesewas::text AS amount FROM fin.journal_entry e JOIN fin.journal_line l ON l.journal_entry_id = e.id JOIN fin.account a ON a.id = l.account_id
        WHERE e.source_document_id = $1 ORDER BY l.line_no`,
      [sale.billingDocument!.id],
    );
    expect(rows.map((r) => [r.code, r.side, Number(r.amount)])).toEqual([['1200', 'D', 60_000], ['4000', 'C', 58_500], ['4210', 'C', 1_500]]);
  });

  it('refuses what the engine cannot price as QUOTE_REQUIRED: a ram on the festival band is priced only by quote', async () => {
    await admin().query("UPDATE inv.stock_unit SET last_weight_kg = 70.000 WHERE id = $1", [id('S-0031')]).catch(() => undefined);
    await expect(post(eggs({ lines: [{ productId: id('sheep'), stockUnitId: id('S-0031'), fromLocationId: id('PENS'), quantity: '1.000', weightKg: '70.000', weightSource: 'SCALE' }] }))).rejects.toMatchObject({ code: 'QUOTE_REQUIRED' });
  });

  it('refuses a POS or QUOTE sale (their own paths, B9b and B10), delivery (B11), no lines and no tenders, every rule at once', async () => {
    await expect(post(eggs({ channel: 'POS', fulfilmentMode: 'DELIVERY', lines: [], tenders: [] }))).rejects.toMatchObject({
      code: 'SALE_INVALID',
      details: [
        expect.objectContaining({ code: 'CHANNEL_NOT_AVAILABLE' }),
        expect.objectContaining({ code: 'FULFILMENT_NOT_AVAILABLE' }),
        expect.objectContaining({ code: 'NO_LINES' }),
        expect.objectContaining({ code: 'NO_TENDERS' }),
      ],
    });
  });

  it('refuses two goats on one line, and a lot product with no lot named', async () => {
    await expect(post(eggs({ lines: [{ productId: id('goat'), stockUnitId: id('G-0142'), fromLocationId: id('PENS'), quantity: '2.000' }] }))).rejects.toMatchObject({ code: 'SALE_INVALID', details: [expect.objectContaining({ code: 'ONE_ANIMAL_PER_LINE' })] });
    await expect(post(eggs({ lines: [{ productId: id('eggs'), fromLocationId: id('SHOP'), quantity: '1.000' }] }))).rejects.toMatchObject({ code: 'SALE_INVALID', details: [expect.objectContaining({ code: 'STOCK_UNIT_REQUIRED' })] });
  });

  it('refuses a tender one pesewa short or over the receipt (TENDER_SHORT, TENDER_OVER)', async () => {
    await expect(post(eggs({ tenders: [{ methodCode: 'CASH', amountPesewas: 5_999n, register: till }] }))).rejects.toMatchObject({ code: 'SALE_INVALID', details: [expect.objectContaining({ code: 'TENDER_SHORT' })] });
    await expect(post(eggs({ tenders: [{ methodCode: 'CASH', amountPesewas: 6_001n, register: till }] }))).rejects.toMatchObject({ code: 'SALE_INVALID', details: [expect.objectContaining({ code: 'TENDER_OVER' })] });
  });

  it('never records mobile money or card as cleared from the counter’s word (abuse case 4, PAYMENT_METHOD_REQUIRES_VERIFICATION)', async () => {
    await expect(post(eggs({ tenders: [{ methodCode: 'MOMO', amountPesewas: 6_000n, register: null }] }))).rejects.toMatchObject({ code: 'PAYMENT_METHOD_REQUIRES_VERIFICATION' });
    await expect(post(eggs({ tenders: [{ methodCode: 'CARD', amountPesewas: 6_000n, register: null }] }))).rejects.toMatchObject({ code: 'PAYMENT_METHOD_REQUIRES_VERIFICATION' });
  });

  it('refuses cash with no till, and a method not open to the channel', async () => {
    await expect(post(eggs({ tenders: [{ methodCode: 'CASH', amountPesewas: 6_000n, register: null }] }))).rejects.toMatchObject({ code: 'PAYMENT_INVALID', details: [expect.objectContaining({ code: 'REGISTER_REQUIRED' })] });
    await expect(post(eggs({ channel: 'ONLINE', fulfilmentMode: 'COLLECTION', tenders: [{ methodCode: 'CASH', amountPesewas: 6_000n, register: till }] }))).rejects.toMatchObject({ code: 'PAYMENT_INVALID', details: [expect.objectContaining({ code: 'METHOD_NOT_FOR_CHANNEL' })] });
  });
});

describe('the database holds the order record (FR-ORD-002 to FR-ORD-004, FR-ORD-007)', () => {
  it('refuses a completed order moved anywhere but VOIDED, and a status outside the machine', async () => {
    expect(await refusedBy("UPDATE ord.sales_order SET status = 'DELIVERED', version = version + 1 WHERE id = $1", [sold.id])).toBe('HK004:ck_sales_order_transition');
    // The check holds even with every trigger switched off (a superuser's replica session).
    const client = await admin().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await expect(client.query("UPDATE ord.sales_order SET status = 'SHIPPED' WHERE id = $1", [sold.id])).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('refuses a change to a completed order’s total or its lines, and the removal of its history', async () => {
    expect(await refusedBy('UPDATE ord.sales_order SET final_total_pesewas = 1, version = version + 1 WHERE id = $1', [sold.id])).toBe('HK004:ck_sales_order_transition');
    expect(await refusedBy('UPDATE ord.sales_order_line SET agreed_unit_price_pesewas = 1 WHERE sales_order_id = $1', [sold.id])).toBe('HK004:ck_sales_order_line_frozen');
    expect(await refusedBy('DELETE FROM ord.order_status_history WHERE sales_order_id = $1', [sold.id])).toBe('42501:');
  });

  it('refuses an order written other than PLACED, a POS order with no shift, and an agreed price outside the band unflagged', async () => {
    const orderId = randomUUID();
    await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'SALES_ORDER', 'ord', $2, $3)", [orderId, branchId, cashier.principalId]);
    const insert = (status: string, channel: string) =>
      refusedBy(
        `INSERT INTO ord.sales_order (id, channel, status, payment_terms, fulfilment_mode, tax_inclusive, estimated_total_pesewas, maximum_total_pesewas, placed_at, branch_id, created_by, updated_by)
         VALUES ($1, $2, $3, 'IMMEDIATE', 'COUNTER', true, 100, 100, now(), $4, $5, $5)`,
        [orderId, channel, status, branchId, cashier.principalId],
      );
    expect(await insert('COMPLETED', 'WHOLESALE')).toBe('HK004:ck_sales_order_transition');
    expect(await insert('PLACED', 'POS')).toBe('23514:ck_sales_order_pos_shift');
    expect(await insert('PLACED', 'WHOLESALE')).toBeUndefined();
    const replica = await admin().connect();
    try {
      await replica.query('BEGIN');
      await replica.query('SET LOCAL session_replication_role = replica');
      await expect(replica.query("UPDATE ord.sales_order SET status = 'SHIPPED' WHERE id = $1", [orderId])).rejects.toMatchObject({ code: '23514', constraint: 'ck_sales_order_status_value' });
    } finally {
      await replica.query('ROLLBACK');
      replica.release();
    }
    const line = (agreed: number, flagged: boolean, productKey = 'eggs', qty = '1.000', unit: string | null = null) =>
      refusedBy(
        `INSERT INTO ord.sales_order_line (id, sales_order_id, line_no, product_id, stock_unit_id, qty_ordered, uom, price_source, price_basis, resolved_unit_price_pesewas,
                                           floor_unit_price_pesewas, ceiling_unit_price_pesewas, agreed_unit_price_pesewas, variance_pesewas, variance_direction,
                                           variance_reason_code, variance_requires_approval, estimated_line_total_pesewas, line_status)
         VALUES ($1, $2, (SELECT count(*) + 1 FROM ord.sales_order_line WHERE sales_order_id = $2), $3, $4, $5, 'CRATE', 'MANUAL_APPROVED', 'PER_UNIT', 80000, 80000, 90000, $6::bigint,
                 $7::bigint, CASE WHEN $6::bigint = 80000 THEN NULL ELSE 'BELOW' END, CASE WHEN $6::bigint = 80000 THEN NULL ELSE 'MANAGER_DISCRETION' END, $8, $6::bigint, 'OPEN')`,
        [randomUUID(), orderId, id(productKey), unit, qty, agreed, agreed === 80_000 ? 0 : 80_000 - agreed, flagged],
      );
    // FR-ORD-003: agreed 75,000 on floor 80,000 without the flag is refused by the database; flagged, it is written.
    expect(await line(75_000, false)).toBe('23514:ck_sales_order_line_outside_band');
    expect(await line(75_000, true)).toBeUndefined();
    // FR-ORD-004: a serialised product on a line names one animal, one to a line.
    expect(await line(80_000, false, 'goat', '2.000', id('G-0142'))).toBe('HK010:ck_sales_order_line_serial');
    expect(await line(80_000, false, 'goat', '1.000', null)).toBe('HK010:ck_sales_order_line_serial');
    // Past PLACED, the flagged line has no approval: refused at commit; and a completed order's line needs its movement.
    const client = await app().connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE ord.sales_order SET status = 'CONFIRMED', version = version + 1 WHERE id = $1", [orderId]);
      await expect(client.query('COMMIT')).rejects.toMatchObject({ constraint: 'ck_sales_order_settled_lines' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

describe('the database holds the payment record (FR-PAY-001, FR-PAY-002, FR-PAY-005, FR-PAY-009)', () => {
  it('refuses any change to a cleared payment but its allocated and refunded amounts, and a move back to PENDING', async () => {
    const paymentId = sold.payments[0]!.id;
    expect(await refusedBy('UPDATE pay.payment SET amount_pesewas = 1, version = version + 1 WHERE id = $1', [paymentId])).toBe('HK004:ck_payment_transition');
    expect(await refusedBy("UPDATE pay.payment SET status = 'PENDING', cleared_at = NULL, posted_at = NULL, posted_by = NULL, version = version + 1 WHERE id = $1", [paymentId])).toBe('HK004:ck_payment_transition');
  });

  it('refuses a mobile money payment written CLEARED without the provider, even by direct SQL', async () => {
    const paymentId = randomUUID();
    await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'PAYMENT', 'pay', $2, $3)", [paymentId, branchId, cashier.principalId]);
    expect(
      await refusedBy(
        `INSERT INTO pay.payment (id, payment_method_id, method_kind, amount_pesewas, verification, received_at, cleared_at, status, branch_id, created_by, updated_by, posted_at, posted_by)
         VALUES ($1, '01900000-0000-7000-8001-000000000002', 'MOBILE_MONEY', 6000, 'NOT_REQUIRED', now(), now(), 'CLEARED', $2, $3, $3, now(), $3)`,
        [paymentId, branchId, cashier.principalId],
      ),
    ).toBe('23514:ck_payment_verified');
  });

  it('refuses an allocation beyond the payment, and one beyond what the document has outstanding', async () => {
    const paymentId = sold.payments[0]!.id;
    expect(await refusedBy("INSERT INTO pay.payment_allocation (id, payment_id, billing_document_id, amount_pesewas, actor_id) VALUES ($1, $2, $3, 1, $4)", [randomUUID(), paymentId, sold.billingDocument!.id, cashier.principalId])).toBe('HK010:ck_payment_allocation_cap');
    expect(await refusedBy('SELECT bil.apply_settlement($1, 1, $2)', [sold.billingDocument!.id, 'APPLY'])).toBe('HK010:ck_document_settlement_outstanding');
    expect(await refusedBy('DELETE FROM pay.payment_allocation WHERE payment_id = $1', [paymentId])).toBe('42501:');
  });

  it('refuses an allocation through BIL beyond the outstanding amount as ALLOCATION_EXCEEDS_AVAILABLE', async () => {
    await expect(asCashier(() => uow.run({ isolation: 'serializable' }, (tx) => api.app.get(Billing).settleIn(tx, sold.billingDocument!.id, 1n, 'APPLY')))).rejects.toMatchObject({ code: 'ALLOCATION_EXCEEDS_AVAILABLE' });
  });
});

describe('pay.PaymentCleared posts its exact amounts (ADR-0003, ADR-0056)', () => {
  it('holds the part of a cash payment not allocated as the customer’s deposit in 2200', async () => {
    const payment = await asCashier(() =>
      uow.run({ isolation: 'serializable', seriesLocks: [`JOURNAL:${clock.now().getUTCFullYear()}:${branchId}`] }, (tx) =>
        api.app.get(Payments).recordIn(tx, cashier, { branchId, channel: 'WHOLESALE', methodCode: 'CASH', amountPesewas: 120_000n, customerId: id('tema'), orderDocumentId: null, register: till, receivedAt: clock.now(), allocations: [] }),
      ),
    );
    expect([payment.status, payment.amountPesewas, payment.allocatedPesewas, payment.unallocatedPesewas]).toEqual(['CLEARED', 120_000, 0, 120_000]);
    const { rows } = await admin().query<{ code: string; side: string; amount: string; party: string | null }>(
      `SELECT a.code, l.side, l.amount_pesewas::text AS amount, s.display_name AS party FROM fin.journal_entry e JOIN fin.journal_line l ON l.journal_entry_id = e.id
         JOIN fin.account a ON a.id = l.account_id LEFT JOIN fin.subledger_party s ON s.id = l.subledger_party_id WHERE e.source_document_id = $1 ORDER BY l.line_no`,
      [payment.id],
    );
    expect(rows.map((r) => [r.code, r.side, Number(r.amount), r.party])).toEqual([['1000', 'D', 120_000, 'T2'], ['2200', 'C', 120_000, 'Tema Cold Store Ltd (SEED)']]);
  });
});
