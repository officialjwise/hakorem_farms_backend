import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock, Quantity, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerReconciliation } from '../../../src/modules/fin';
import { SalePosting, type SaleRequest, type SaleView } from '../../../src/modules/ord';
import { Reservations } from '../../../src/modules/inv';
import { runAsSystem, runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork, type Transaction } from '../../../src/platform/database/unit-of-work';
import { DomainEvents } from '../../../src/platform/events/domain-events';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { createUser, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { openTestShift, tillOf } from '../../support/till';

/**
 * The B9a gate's second half (FR-ORD-006, FR-ORD-007, FR-PAY-001, FR-PAY-009, ADR-0010, the owner's B9a note): a sale
 * posts stock, its billing document, its payments and the ledger in one serializable transaction, or nothing at all.
 * Proved by failure injection at each step (after the stock issue, after the billing document, after the payment, after
 * the journals, at commit), each time counting every table the sale writes; by a sale that succeeds with every part
 * present at exact pesewa amounts read straight from the journal; by a replay that answers the first sale and posts
 * nothing twice; by two sales of the last unit and of one animal at once, exactly one succeeding, with a serialization
 * failure retried by the unit of work; and by a trading day of sales after which the trial balance sums to zero, the
 * inventory accounts equal the cost pools and cost of sales equals the cost issued.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let sales: SalePosting;
let uow: UnitOfWork;
let cashier: Actor;
let branchId: string;
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const admin = () => database.pool('admin');
const till = { id: '019a8000-0000-7000-8000-00000000a7a1', code: 'T1' };
let nextOrderId: () => string;

/** Where the failure-injection hooks throw; null lets the sale through. */
let failAt: 'STOCK' | 'BILLING' | 'PAYMENT' | 'JOURNALS' | null = null;
/** Holds a sale's transaction open before commit: the hook on `ord.OrderCompleted` says it got there, then waits. */
let holdBeforeCommit: { readonly reached: () => void; readonly release: Promise<void> } | null = null;

function asCashier<T>(work: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'sale posting test', actor: cashier }, work);
}

/** Posts a sale as a selling command would: serializable, with the sale's series locks (A-186). */
function post(request: SaleRequest, options: { locks?: boolean; onAttempt?: (tx: Transaction) => Promise<void> } = {}): Promise<SaleView> {
  return asCashier(() =>
    uow.run({ isolation: 'serializable', seriesLocks: options.locks === false ? [] : sales.locksFor(request.branchId) }, async (tx) => {
      await options.onAttempt?.(tx);
      return sales.postIn(tx, cashier, { shiftDocumentId: await openTestShift(tx, cashier.principalId, request.branchId, tillOf(request)), ...request });
    }),
  );
}

/** The day's first sale: a goat by tag, two crates of eggs from their lot, three cabbages and 3.500 kg of goat meat weighed at the scale. */
function wholesaleSale(overrides: Partial<SaleRequest> = {}): SaleRequest {
  return {
    orderId: nextOrderId(),
    channel: 'WHOLESALE',
    branchId,
    fulfilmentMode: 'COUNTER',
    taxInclusive: true,
    lines: [
      { productId: id('goat'), stockUnitId: id('G-0142'), fromLocationId: id('PENS'), quantity: '1.000' },
      { productId: id('eggs'), stockUnitId: id('eggLot'), fromLocationId: id('SHOP'), quantity: '2.000', uom: 'CRATE' },
      { productId: id('cabbage'), fromLocationId: id('SHOP'), quantity: '3.000' },
      { productId: id('meat'), stockUnitId: id('meatLot'), fromLocationId: id('COLD'), quantity: '3.500', weightKg: '3.500', weightSource: 'SCALE' },
    ],
    tenders: [
      { methodCode: 'CASH', amountPesewas: 50_000n, register: till },
      { methodCode: 'CASH', amountPesewas: 30_430n, register: till },
    ],
    ...overrides,
  };
}

const COUNTED = [
  'platform.business_document',
  'platform.number_allocation',
  'platform.idempotency_key',
  'platform.outbox_message',
  'platform.audit_event',
  'inv.stock_movement',
  'bil.billing_document',
  'bil.billing_document_line',
  'pay.payment',
  'pay.payment_allocation',
  'fin.journal_entry',
  'fin.journal_line',
  'ord.sales_order',
  'ord.sales_order_line',
  'ord.order_status_history',
] as const;

/** Every table a sale writes, counted, with each series' next value and the stock and reservation state it moves. */
async function footprint(): Promise<Record<string, string>> {
  const counts: Record<string, string> = {};
  for (const table of COUNTED) {
    counts[table] = (await admin().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0]!.n;
  }
  const series = await admin().query<{ doc_type: string; next: string }>("SELECT doc_type, next_value::text AS next FROM platform.number_series WHERE doc_type IN ('SALES_ORDER', 'RECEIPT', 'JOURNAL') ORDER BY doc_type, branch_id");
  for (const s of series.rows) counts[`series:${s.doc_type}`] = s.next;
  const balances = await admin().query<{ k: string; on_hand: string; reserved: string }>(
    'SELECT product_id::text || location_id::text || COALESCE(stock_unit_id::text, \'\') AS k, on_hand_qty::text AS on_hand, reserved_qty::text AS reserved FROM inv.stock_balance ORDER BY 1',
  );
  for (const b of balances.rows) counts[`balance:${b.k}`] = `${b.on_hand}/${b.reserved}`;
  const reservations = await admin().query<{ status: string; n: string }>('SELECT status, count(*)::text AS n FROM inv.stock_reservation GROUP BY status ORDER BY status');
  for (const r of reservations.rows) counts[`reservation:${r.status}`] = r.n;
  const units = await admin().query<{ identifier: string; status: string }>('SELECT identifier, status FROM inv.stock_unit ORDER BY identifier');
  for (const u of units.rows) counts[`unit:${u.identifier}`] = u.status;
  return counts;
}

/** The journal lines posted from one source document, by account code, as [code, side, amount, party]. */
async function journalOf(sourceDocumentId: string): Promise<[string, string, number, string | null][]> {
  const { rows } = await admin().query<{ code: string; side: string; amount: string; party: string | null }>(
    `SELECT a.code, l.side, l.amount_pesewas::text AS amount, s.display_name AS party
       FROM fin.journal_entry e JOIN fin.journal_line l ON l.journal_entry_id = e.id JOIN fin.account a ON a.id = l.account_id
       LEFT JOIN fin.subledger_party s ON s.id = l.subledger_party_id
      WHERE e.source_document_id = $1 ORDER BY e.entry_no, l.line_no`,
    [sourceDocumentId],
  );
  return rows.map((r) => [r.code, r.side, Number(r.amount), r.party]);
}

async function onHand(locationCode: string, productKey: string): Promise<string> {
  const { rows } = await admin().query<{ qty: string }>('SELECT COALESCE(sum(on_hand_qty), 0)::text AS qty FROM inv.stock_balance WHERE product_id = $1 AND location_id = $2', [id(productKey), id(locationCode)]);
  return rows[0]!.qty;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextOrderId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  sales = api.app.get(SalePosting);
  uow = api.app.get(UnitOfWork);
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const code of ['PENS', 'SHOP', 'COLD']) {
    ids.set(code, (await admin().query<{ id: string }>('SELECT id FROM mdm.location WHERE branch_id = $1 AND code = $2', [branchId, code])).rows[0]!.id);
  }
  for (const [name, sku] of [['goat', 'LIV-0004'], ['eggs', 'EGG-0003'], ['cabbage', 'PRD-0002'], ['meat', 'MEAT-0007'], ['yam', 'PRD-0005'], ['sheep', 'LIV-0005']] as const) {
    ids.set(name, (await admin().query<{ id: string }>('SELECT id FROM mdm.product WHERE sku = $1', [sku])).rows[0]!.id);
  }
  for (const [name, identifier] of [['G-0142', 'G-0142'], ['G-0143', 'G-0143'], ['G-0144', 'G-0144'], ['eggLot', 'EGG-BIG-2026-1110'], ['meatLot', 'LOT-GOAT-0001'], ['S-0031', 'S-0031']] as const) {
    ids.set(name, (await admin().query<{ id: string }>('SELECT id FROM inv.stock_unit WHERE identifier = $1', [identifier])).rows[0]!.id);
  }
  const user = await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId }] });
  cashier = { principalId: user.principalId, kind: 'USER', displayName: 'Adwoa Darko', realm: 'STAFF', sessionId: null, steppedUpAt: null };

  // Failure injection: transactional subscribers registered after FIN's, so each throws once its step and its journal are written.
  const events = api.app.get(DomainEvents);
  const hook = (step: NonNullable<typeof failAt>) => async () => {
    if (failAt === step) throw new Error(`injected failure after ${step}`);
  };
  events.subscribeInTransaction('inv.StockIssuedForSale', hook('STOCK'));
  events.subscribeInTransaction('bil.InvoiceIssued', hook('BILLING'));
  events.subscribeInTransaction('pay.PaymentCleared', hook('PAYMENT'));
  events.subscribeInTransaction('ord.OrderCompleted', async () => {
    if (failAt === 'JOURNALS') throw new Error('injected failure after every journal');
    const hold = holdBeforeCommit;
    if (hold !== null) {
      holdBeforeCommit = null;
      hold.reached();
      await hold.release;
    }
  });
  // At commit: a deferred constraint trigger that refuses when the sale's transaction asks it to.
  await admin().query(`CREATE FUNCTION ord.test_fail_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF current_setting('hk.test_fail_at_commit', true) = 'on' THEN RAISE EXCEPTION 'injected failure at commit'; END IF;
      RETURN NULL;
    END $$`);
  await admin().query('CREATE CONSTRAINT TRIGGER trg_test_fail_at_commit AFTER INSERT ON ord.sales_order DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ord.test_fail_at_commit()');
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('a sale posts stock, document, payment and ledger in one transaction, or nothing (FR-ORD-006)', () => {
  for (const step of ['STOCK', 'BILLING', 'PAYMENT', 'JOURNALS'] as const) {
    it(`leaves nothing of the sale behind when it fails after ${step.toLowerCase()}, and the receipt number goes back to its series`, async () => {
      const before = await footprint();
      failAt = step;
      try {
        await expect(post(wholesaleSale())).rejects.toThrow(/injected failure/);
      } finally {
        failAt = null;
      }
      expect(await footprint()).toEqual(before);
    });
  }

  it('leaves nothing of the sale behind when the database refuses it at commit', async () => {
    const before = await footprint();
    await expect(
      post(wholesaleSale(), { onAttempt: async (tx) => void (await tx.query("SELECT set_config('hk.test_fail_at_commit', 'on', true)")) }),
    ).rejects.toThrow(/injected failure at commit/);
    expect(await footprint()).toEqual(before);
  });

  it('leaves the checkout’s reservation active when the sale that consumes it fails, and consumes it once the sale succeeds', async () => {
    const checkoutId = randomUUID();
    const reservationId = await asCashier(() =>
      uow.run({ isolation: 'serializable' }, async (tx) => {
        await tx.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'CHECKOUT_SESSION', 'shp', $2, $3)", [checkoutId, branchId, cashier.principalId]);
        return api.app.get(Reservations).reserveIn(tx, cashier.principalId, { productId: id('yam'), locationId: id('SHOP'), qty: Quantity.parse('2.000'), holderDocumentId: checkoutId, expiresAt: null });
      }),
    );
    const yams = () => wholesaleSale({
      sourceDocumentId: checkoutId,
      lines: [{ productId: id('yam'), reservationId, fromLocationId: id('SHOP'), quantity: '2.000' }],
      tenders: [{ methodCode: 'CASH', amountPesewas: 4_000n, register: till }],
    });
    const before = await footprint();
    failAt = 'PAYMENT';
    try {
      await expect(post(yams())).rejects.toThrow(/injected failure/);
    } finally {
      failAt = null;
    }
    expect(await footprint()).toEqual(before);
    expect((await admin().query<{ status: string }>('SELECT status FROM inv.stock_reservation WHERE id = $1', [reservationId])).rows[0]!.status).toBe('ACTIVE');
    const sale = await post(yams());
    expect(sale.finalTotalPesewas).toBe(4_000);
    expect((await admin().query<{ status: string }>('SELECT status FROM inv.stock_reservation WHERE id = $1', [reservationId])).rows[0]!.status).toBe('CONSUMED');
  });

  it('posts every part with exact amounts once nothing fails: one order, one receipt, two payments, one journal per step', async () => {
    const before = await footprint();
    const goatPool = BigInt((await admin().query<{ v: string }>('SELECT value_pesewas::text AS v FROM inv.cost_pool WHERE stock_unit_id = $1', [id('G-0142')])).rows[0]?.v ?? '0');
    const sale = await post(wholesaleSale());

    // The order: completed, its lines priced by the wholesale list (goat GOAT-M 65,000 less 10 percent; meat 2,200 less 10 percent a kg).
    expect(sale.status).toBe('COMPLETED');
    expect(sale.paymentStatus).toBe('PAID');
    expect(sale.orderNo).toMatch(/^SO-\d{4}-DDW-\d{6}$/);
    expect(sale.lines.map((l) => [l.lineNo, l.priceBasis, l.resolvedUnitPricePesewas, l.agreedUnitPricePesewas, l.finalLineTotalPesewas, l.lineStatus])).toEqual([
      [1, 'PER_HEAD', 58_500, 58_500, 58_500, 'FULFILLED'],
      [2, 'PER_UNIT', 6_000, 6_000, 12_000, 'FULFILLED'],
      [3, 'PER_UNIT', 1_000, 1_000, 3_000, 'FULFILLED'],
      [4, 'PER_KG', 1_980, 1_980, 6_930, 'FULFILLED'],
    ]);
    expect(sale.finalTotalPesewas).toBe(80_430);
    expect(sale.billingDocument).toEqual({ id: expect.any(String), kind: 'RECEIPT', documentNo: expect.stringMatching(/^RCP-\d{4}-DDW-\d{6}$/), grossPesewas: 80_430 });
    expect(sale.payments.map((p) => [p.methodCode, p.status, p.amountPesewas, p.allocatedPesewas, p.unallocatedPesewas])).toEqual([
      ['CASH', 'CLEARED', 50_000, 50_000, 0],
      ['CASH', 'CLEARED', 30_430, 30_430, 0],
    ]);
    expect(sale.outstandingPesewas).toBe(0);

    // Exactly what the sale writes, and nothing more.
    const after = await footprint();
    const delta = (table: string) => Number(after[table]) - Number(before[table]);
    expect([delta('ord.sales_order'), delta('ord.sales_order_line'), delta('ord.order_status_history')]).toEqual([1, 4, 2]);
    expect([delta('inv.stock_movement'), delta('bil.billing_document'), delta('pay.payment'), delta('pay.payment_allocation')]).toEqual([4, 1, 2, 2]);
    // Four stock issues, the receipt and two payments each post one entry.
    expect(delta('fin.journal_entry')).toBe(7);
    // The order, the receipt and the two payments are registered documents; the order and receipt are numbered, and each entry.
    expect(delta('platform.business_document')).toBe(4 + 7);
    expect(delta('platform.number_allocation')).toBe(2 + 7);
    expect(delta('platform.idempotency_key')).toBe(1);
    expect(after['unit:G-0142']).toBe('SOLD');

    // The receipt's journal (ADR-0003, A-200): 1200 against the walk-in party, sales by GL group at the resolved amount, each levy.
    expect(await journalOf(sale.billingDocument!.id)).toEqual([
      ['1200', 'D', 80_430, 'Walk-in customer'],
      ['4000', 'C', 58_500, null],
      ['4020', 'C', 12_000, null],
      ['4020', 'C', 3_000, null],
      ['4010', 'C', 5_775, null],
      ['2100', 'C', 866, expect.stringMatching(/VAT/)],
      ['2100', 'C', 145, expect.stringMatching(/NHIL/)],
      ['2100', 'C', 144, expect.stringMatching(/GETFUND|GETFund/i)],
    ]);
    // Each payment's journal: the till debited, receivables cleared against the same walk-in party.
    for (const [i, amount] of [50_000, 30_430].entries()) {
      expect(await journalOf(sale.payments[i]!.id)).toEqual([
        ['1000', 'D', amount, 'T1'],
        ['1200', 'C', amount, 'Walk-in customer'],
      ]);
    }
    // The goat's issue carries its whole cost pool to cost of sales; the eggs half_up(105,000 x 2 / 30) = 7,000.
    const moves = await admin().query<{ line_no: number; value: string; code_d: string; amount_d: string }>(
      `SELECT l.line_no, m.value_pesewas::text AS value, a.code AS code_d, jl.amount_pesewas::text AS amount_d
         FROM ord.sales_order_line l JOIN inv.stock_movement m ON m.id = l.stock_movement_id
         JOIN fin.journal_entry e ON e.event_subject_id = m.id JOIN fin.journal_line jl ON jl.journal_entry_id = e.id AND jl.side = 'D'
         JOIN fin.account a ON a.id = jl.account_id
        WHERE l.sales_order_id = $1 ORDER BY l.line_no`,
      [sale.id],
    );
    expect(moves.rows.map((r) => [r.line_no, BigInt(r.value) === BigInt(r.amount_d), r.code_d.startsWith('50')])).toEqual([
      [1, true, true],
      [2, true, true],
      [3, true, true],
      [4, true, true],
    ]);
    expect(BigInt(moves.rows[0]!.value)).toBe(goatPool);
    expect(moves.rows[1]!.value).toBe('7000');
    expect(moves.rows[2]!.value).toBe('1500');

    // The settlement summary, written through BIL: the receipt is PAID with nothing outstanding.
    const settlement = await admin().query<{ allocated: string; outstanding: string; status: string }>(
      'SELECT allocated_pesewas::text AS allocated, outstanding_pesewas::text AS outstanding, payment_status AS status FROM bil.document_settlement WHERE billing_document_id = $1',
      [sale.billingDocument!.id],
    );
    expect(settlement.rows[0]).toEqual({ allocated: '80430', outstanding: '0', status: 'PAID' });
    // The history: PLACED then COMPLETED, each by the cashier.
    const history = await admin().query<{ from_status: string | null; to_status: string; actor_id: string }>('SELECT from_status, to_status, actor_id FROM ord.order_status_history WHERE sales_order_id = $1 ORDER BY recorded_at, id', [sale.id]);
    expect(history.rows).toEqual([
      { from_status: null, to_status: 'PLACED', actor_id: cashier.principalId },
      { from_status: 'PLACED', to_status: 'COMPLETED', actor_id: cashier.principalId },
    ]);
    // One audit event for the sale and one outbox message announcing it.
    const audit = await admin().query("SELECT 1 FROM platform.audit_event WHERE entity_type = 'SalesOrder' AND entity_id = $1", [sale.id]);
    expect(audit.rows).toHaveLength(1);
    const outbox = await admin().query<{ event_type: string }>("SELECT event_type FROM platform.outbox_message WHERE subject_id = $1 AND event_type = 'ord.OrderCompleted'", [sale.id]);
    expect(outbox.rows).toHaveLength(1);
  });

  it('numbers the sales of a day contiguously even with the failed attempts between them', async () => {
    const { rows } = await admin().query<{ value: string; next: string }>(
      "SELECT a.value::text, s.next_value::text AS next FROM platform.number_allocation a JOIN platform.number_series s ON s.id = a.series_id WHERE s.doc_type = 'RECEIPT' AND s.branch_id = $1 ORDER BY a.value",
      [branchId],
    );
    expect(rows.map((r) => Number(r.value))).toEqual(rows.map((_, i) => i + 1));
    expect(Number(rows[0]!.next)).toBe(rows.length + 1);
  });
});

describe('a replay of a sale answers the first sale and posts nothing twice (ADR-0013, ADR-0014)', () => {
  it('returns the same sale for the same order id and request, with no second movement, document, payment or journal', async () => {
    const request = wholesaleSale({
      lines: [{ productId: id('eggs'), stockUnitId: id('eggLot'), fromLocationId: id('SHOP'), quantity: '1.000', uom: 'CRATE' }],
      tenders: [{ methodCode: 'CASH', amountPesewas: 6_000n, register: till }],
    });
    const first = await post(request);
    const before = await footprint();
    const again = await post(request);
    expect(again).toEqual(JSON.parse(JSON.stringify(first)));
    expect(await footprint()).toEqual(before);
  });

  it('refuses the same order id with a different request, posting nothing', async () => {
    const request = wholesaleSale({
      lines: [{ productId: id('eggs'), stockUnitId: id('eggLot'), fromLocationId: id('SHOP'), quantity: '1.000', uom: 'CRATE' }],
      tenders: [{ methodCode: 'CASH', amountPesewas: 6_000n, register: till }],
    });
    await post(request);
    const before = await footprint();
    await expect(post({ ...request, lines: [{ ...request.lines[0]!, quantity: '2.000' }], tenders: [{ methodCode: 'CASH', amountPesewas: 12_000n, register: till }] })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await footprint()).toEqual(before);
  });
});

describe('an order id is one sale, whoever sends it (ADR-0014)', () => {
  it('refuses a sale under an order id another person already posted, posting nothing', async () => {
    const request = wholesaleSale({
      lines: [{ productId: id('eggs'), stockUnitId: id('eggLot'), fromLocationId: id('SHOP'), quantity: '1.000', uom: 'CRATE' }],
      tenders: [{ methodCode: 'CASH', amountPesewas: 6_000n, register: till }],
    });
    await post(request);
    const other = await createUser(database, { name: 'Yaw Boadu', grants: [{ role: 'CASHIER', branchId }] });
    const otherActor: Actor = { ...cashier, principalId: other.principalId, displayName: 'Yaw Boadu' };
    const before = await footprint();
    await expect(
      runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'sale posting test', actor: otherActor }, () =>
        uow.run({ isolation: 'serializable', seriesLocks: sales.locksFor(branchId) }, (tx) => sales.postIn(tx, otherActor, request)),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await footprint()).toEqual(before);
  });
});

describe('two sales of the last unit, or of one animal, at once: exactly one succeeds (ADR-0005, ADR-0019)', () => {
  it('sells the same goat once when two tills sell it together, the other refused cleanly', async () => {
    const request = () => wholesaleSale({
      lines: [{ productId: id('goat'), stockUnitId: id('G-0143'), fromLocationId: id('PENS'), quantity: '1.000' }],
      tenders: [{ methodCode: 'CASH', amountPesewas: 58_500n, register: till }],
    });
    const results = await Promise.allSettled([post(request()), post(request())]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ status: 422 });
    const { rows } = await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM inv.stock_movement WHERE stock_unit_id = $1 AND movement_type = 'SALE_ISSUE'", [id('G-0143')]);
    expect(rows[0]!.n).toBe('1');
    // Four goats came in; G-0142 and now G-0143 are sold.
    expect(await onHand('PENS', 'goat')).toBe('2.000');
  });

  it('sells the last cabbage once when two sales take it together, and stock never goes below zero', async () => {
    const left = Number(await onHand('SHOP', 'cabbage'));
    const cabbages = (qty: number) => wholesaleSale({
      lines: [{ productId: id('cabbage'), fromLocationId: id('SHOP'), quantity: `${qty}.000` }],
      tenders: [{ methodCode: 'CASH', amountPesewas: BigInt(qty * 1_000), register: till }],
    });
    await post(cabbages(left - 1));
    expect(await onHand('SHOP', 'cabbage')).toBe('1.000');
    const results = await Promise.allSettled([post(cabbages(1)), post(cabbages(1))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(await onHand('SHOP', 'cabbage')).toBe('0.000');
    const negative = await admin().query('SELECT 1 FROM inv.stock_balance b JOIN mdm.location l ON l.id = b.location_id WHERE b.on_hand_qty < 0 AND NOT l.is_virtual');
    expect(negative.rows).toHaveLength(0);
  });

  it('retries a sale that met a serialization failure, and the retry is refused because the first sold the animal', async () => {
    let release!: () => void;
    let reached!: () => void;
    const atHold = new Promise<void>((resolve) => (reached = resolve));
    holdBeforeCommit = { reached, release: new Promise<void>((resolve) => (release = resolve)) };
    const attempts: number[] = [];
    const goat = (orderId: string) => wholesaleSale({
      orderId,
      lines: [{ productId: id('goat'), stockUnitId: id('G-0144'), fromLocationId: id('PENS'), quantity: '1.000' }],
      tenders: [{ methodCode: 'CASH', amountPesewas: 58_500n, register: till }],
    });
    try {
      const first = post(goat(nextOrderId()));
      await atHold;
      // The second takes its snapshot while the first is still open, without the series locks, so the two genuinely overlap.
      const second = post(goat(nextOrderId()), {
        locks: false,
        onAttempt: async (tx) => {
          attempts.push(tx.attempt);
          await tx.query('SELECT 1');
          if (tx.attempt === 1) setTimeout(release, 200);
        },
      });
      const results = await Promise.allSettled([first, second]);
      if (results[0]!.status === 'rejected') throw results[0]!.reason;
      expect(results[0]!.status).toBe('fulfilled');
      expect(results[1]!.status).toBe('rejected');
      expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ status: 422 });
    } finally {
      holdBeforeCommit = null;
    }
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.slice(0, 2)).toEqual([1, 2]);
    const { rows } = await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM inv.stock_movement WHERE stock_unit_id = $1 AND movement_type = 'SALE_ISSUE'", [id('G-0144')]);
    expect(rows[0]!.n).toBe('1');
  });
});

describe('after a trading day of sales the books still tie (FR-FIN-011, FR-FIN-016)', () => {
  it('posts an online collection paid in cash on the same path', async () => {
    const sale = await post(wholesaleSale({
      channel: 'ONLINE',
      fulfilmentMode: 'COLLECTION',
      contactName: 'Efua Asante',
      contactPhone: '+233244000301',
      lines: [{ productId: id('eggs'), stockUnitId: id('eggLot'), fromLocationId: id('SHOP'), quantity: '1.000', uom: 'CRATE' }],
      tenders: [{ methodCode: 'COD', amountPesewas: 6_000n, register: till }],
    }));
    expect([sale.channel, sale.status, sale.paymentStatus, sale.finalTotalPesewas]).toEqual(['ONLINE', 'COMPLETED', 'PAID', 6_000]);
  });

  it('sums the trial balance to exactly zero, finds no break between stock and the ledger, and books cost of sales at the cost issued', async () => {
    const totals = await admin().query<{ signed: string; lines: string }>("SELECT COALESCE(sum(CASE side WHEN 'D' THEN amount_pesewas ELSE -amount_pesewas END), 0)::text AS signed, count(*)::text AS lines FROM fin.journal_line");
    expect(totals.rows[0]!.signed).toBe('0');
    const report = await runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () =>
      api.app.get(LedgerReconciliation).run({ principalId: SYSTEM_PRINCIPAL, kind: 'SYSTEM', displayName: 'Scheduler', realm: null, sessionId: null, steppedUpAt: null }),
    );
    expect(report.signedSumPesewas).toBe(0n);
    expect(report.unbalancedEntries).toEqual([]);
    expect(report.sources.flatMap((s) => s.breaks)).toEqual([]);
    const cost = await admin().query<{ issued: string; booked: string }>(
      `SELECT (SELECT sum(value_pesewas) FROM inv.stock_movement WHERE movement_type = 'SALE_ISSUE')::text AS issued,
              (SELECT sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END) FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id WHERE a.code LIKE '50__')::text AS booked`,
    );
    expect(cost.rows[0]!.booked).toBe(cost.rows[0]!.issued);
    // The day's receivables from sales net to zero: every receipt was paid in full.
    const walkIn = await admin().query<{ balance: string }>(
      `SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS balance
         FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
        WHERE a.code = '1200' AND e.source_document_id IN (SELECT billing_document_id FROM ord.sales_order UNION SELECT id FROM pay.payment)`,
    );
    expect(walkIn.rows[0]!.balance).toBe('0');
    expect(toBusinessDate(clock.now())).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('links every cleared payment of the day in full to a numbered receipt or invoice the customer holds, none left unlinked (the owner, A-208 (f))', async () => {
    const payments = await admin().query<{ id: string; amount: string; linked: string; unlinked_docs: string }>(
      `SELECT p.id, p.amount_pesewas::text AS amount,
              COALESCE(sum(CASE a.direction WHEN 'APPLY' THEN a.amount_pesewas ELSE -a.amount_pesewas END)
                         FILTER (WHERE d.kind IN ('RECEIPT', 'INVOICE') AND d.document_no IS NOT NULL), 0)::text AS linked,
              count(a.id) FILTER (WHERE d.document_no IS NULL OR d.kind NOT IN ('RECEIPT', 'INVOICE'))::text AS unlinked_docs
         FROM pay.payment p
         LEFT JOIN pay.payment_allocation a ON a.payment_id = p.id
         LEFT JOIN bil.billing_document d ON d.id = a.billing_document_id
        WHERE p.status = 'CLEARED' GROUP BY p.id ORDER BY p.id`,
    );
    expect(payments.rows.length).toBeGreaterThan(0);
    for (const row of payments.rows) {
      expect({ id: row.id, linked: row.linked, unlinkedDocuments: row.unlinked_docs }).toEqual({ id: row.id, linked: row.amount, unlinkedDocuments: '0' });
    }
    const deposits = await admin().query<{ deposits: string }>(
      `SELECT count(*)::text AS deposits FROM pay.payment WHERE status = 'CLEARED' AND amount_pesewas - allocated_pesewas - refunded_pesewas > 0`,
    );
    expect(deposits.rows[0]!.deposits).toBe('0');
  });
});
