import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { syncBatch, tillSale, type TillSale } from '../../support/offline';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The B9b gate (ADR-0015, ADR-0027, NFR-010, OFFLINE_SYNC 14): a till eight hours offline queues 500 cash sales with
 * no request to the server (the network disabled on the client side), then syncs them in one batch. Each is applied
 * exactly once with one official order number and one official receipt number, allocated in counter order; sending
 * the whole batch again changes nothing. Every total is an exact integer derived by SQL over the stock movements, the
 * payments and the journal lines, never from the answer. Then UAT scenario 6's interrupted sync as a dry run: fifty
 * sales, a sync cut off after twenty, sent again whole, and again.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let nextId: () => string;
const sessions = new Map<string, TestSession>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const credentials = new Map<string, string>();
const shifts = new Map<string, { readonly id: string; readonly seq: number; readonly openedAt: Date }>();
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const rows = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => (await admin().query(sql, values)).rows as T[];
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await rows<T>(sql, values))[0]!;
const num = async (sql: string, values: unknown[] = []): Promise<number> => Number((await one<{ n: string | null }>(sql, values)).n ?? 0);
const HOUR = 3_600_000;
const CRATE = 6_000;
const EGG = 220;

const sync = (who: string, till: string, sales: readonly TillSale[]) => syncBatch(api.server, as(who), credentials.get(till)!, { deviceId: id(`device:${till}`), shiftId: shifts.get(till)!.id, sales });

/** Debits less credits on an account over every journal whose source belongs to the shift's offline orders. */
async function shiftBalance(code: string, shiftId: string): Promise<number> {
  return num(
    `WITH orders AS (SELECT id, billing_document_id FROM ord.sales_order WHERE shift_document_id = $2 AND is_offline),
          documents AS (SELECT id FROM orders UNION SELECT billing_document_id FROM orders
                        UNION SELECT p.id FROM pay.payment p JOIN orders o ON o.id = p.order_document_id
                        UNION SELECT m.id FROM inv.stock_movement m JOIN orders o ON o.id = m.source_document_id)
     SELECT sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS n
       FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
      WHERE a.code = $1 AND e.source_document_id IN (SELECT id FROM documents)`,
    [code, shiftId],
  );
}

async function footprint(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ['ord.sales_order', 'pay.payment', 'inv.stock_movement', 'bil.billing_document', 'fin.journal_entry', 'fin.journal_line', 'platform.number_allocation', 'inv.stock_exception']) {
    counts[table] = await num(`SELECT count(*)::text AS n FROM ${table}`);
  }
  return counts;
}

/** The numbers allocated to a shift's offline orders or their receipts: how many, how many distinct, and the span of their values. */
async function numbering(shiftId: string, of: 'order' | 'receipt'): Promise<{ count: number; distinct: number; span: number; inCounterOrder: boolean }> {
  const column = of === 'order' ? 'o.id' : 'o.billing_document_id';
  const r = await one<{ count: string; distinct: string; span: string; ordered: boolean }>(
    `WITH n AS (SELECT a.value, s.device_counter FROM ord.sales_order o JOIN platform.number_allocation a ON a.document_id = ${column}
                  JOIN pos.sale_sync s ON s.client_sale_id = o.id AND s.outcome IN ('APPLIED', 'APPLIED_WITH_EXCEPTION')
                 WHERE o.shift_document_id = $1 AND o.is_offline)
     SELECT count(*)::text AS count, count(DISTINCT value)::text AS distinct, (max(value) - min(value) + 1)::text AS span,
            bool_and(ordered) AS ordered
       FROM (SELECT value, (value - min(value) OVER ()) = (rank() OVER (ORDER BY device_counter) - 1) AS ordered FROM n) x`,
    [shiftId],
  );
  return { count: Number(r.count), distinct: Number(r.distinct), span: Number(r.span), inCounterOrder: r.ordered };
}

async function openShift(who: string, till: string): Promise<void> {
  const shiftId = nextId();
  const opened = await post(who, '/shifts', { id: shiftId, registerId: id(`till:${till}`), openingFloatPesewas: 0, openedAt: clock.now().toISOString() }, shiftId);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  shifts.set(till, { id: shiftId, seq: opened.body.shiftSeq as number, openedAt: clock.now() });
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '172800', AUTH_STAFF_REFRESH_IDLE_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of await rows<{ code: string; id: string }>(
    `SELECT 'branch' AS code, id FROM mdm.branch WHERE code = 'DDW'
     UNION ALL SELECT 'shop', l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = 'SHOP'
     UNION ALL SELECT sku, id FROM mdm.product WHERE sku IN ('EGG-0003', 'PRD-0005')
     UNION ALL SELECT code, id FROM mdm.payment_method`,
  )) {
    ids.set(row.code, row.id);
  }
  const manager = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId: id('branch') }] });
  sessions.set('manager', await enrolAndLogin(api.server, manager, () => clock.now()));
  for (const [who, name] of [
    ['adwoa', 'Adwoa Darko'],
    ['nana', 'Nana Yeboah'],
  ] as const) {
    const user = await createUser(database, { name, grants: [{ role: 'CASHIER', branchId: id('branch'), locationId: id('shop') }] });
    sessions.set(who, await login(api.server, user));
  }
  for (const code of ['T1', 'T3']) {
    const till = await post('manager', '/registers', { branchId: id('branch'), locationId: id('shop'), code, name: `Till ${code}` });
    expect(till.status, JSON.stringify(till.body)).toBe(201);
    ids.set(`till:${code}`, till.body.id as string);
    await stepUp(api.server, as('manager') as TotpSession, clock);
    const enrolled = await post('manager', `/registers/${till.body.id as string}/devices`, { deviceLabel: `Tablet ${code}` });
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
    credentials.set(code, enrolled.body.deviceCredential as string);
    ids.set(`device:${code}`, enrolled.body.device.id as string);
  }
  await openShift('adwoa', 'T1');
  await openShift('nana', 'T3');
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('500 queued offline sales sync exactly once, each with one official number (the B9b gate)', () => {
  const CRATE_SALES = 10;
  const SALES = 500;
  let queue: TillSale[] = [];

  it('applies all 500 once, numbered in counter order, every total exact by SQL', { timeout: 600_000 }, async () => {
    const opened = shifts.get('T1')!.openedAt;
    const poolBefore = await one<{ qty: string; value: string }>('SELECT qty::text AS qty, value_pesewas::text AS value FROM inv.cost_pool WHERE product_id = $1', [id('EGG-0003')]);
    const before = await footprint();
    // Eight hours with no network: one sale every 57.6 seconds, the first ten a crate each, the rest a single egg. No request is made.
    queue = Array.from({ length: SALES }, (_, i) => {
      const counter = i + 1;
      const at = new Date(opened.getTime() + Math.round(counter * 57_600) - 1_000);
      const crate = counter <= CRATE_SALES;
      return tillSale({
        till: 'T1',
        shiftSeq: shifts.get('T1')!.seq,
        counter,
        at,
        lines: [{ productId: id('EGG-0003'), quantity: '1.000', uom: crate ? 'CRATE' : 'EGG', agreedUnitPricePesewas: crate ? CRATE : EGG }],
        tenders: [{ paymentMethodId: id('CASH'), amountPesewas: crate ? CRATE : EGG }],
      });
    });
    clock.advanceBy(8 * HOUR);
    // The device sends its queue as it holds it: shuffled, the server applies it in counter order.
    const shuffled = [...queue].sort((a, b) => (a.id.slice(-6) < b.id.slice(-6) ? -1 : 1));
    const synced = await sync('adwoa', 'T1', shuffled);
    expect(synced.status, JSON.stringify(synced.body).slice(0, 2_000)).toBe(200);
    const results = synced.body.results as { deviceCounter: number; outcome: string; orderNo: string; receiptNo: string; grossPesewas: number }[];
    expect(results.map((r) => r.deviceCounter)).toEqual(Array.from({ length: SALES }, (_, i) => i + 1));
    expect(results.every((r) => r.outcome === 'APPLIED')).toBe(true);
    expect(synced.body.counterGaps).toEqual([]);

    // Exactly once: 500 offline orders, receipts, payments and applied log rows; nothing else moved.
    const shiftId = shifts.get('T1')!.id;
    const expectedEggs = CRATE_SALES * 30 + (SALES - CRATE_SALES);
    const expectedGross = CRATE_SALES * CRATE + (SALES - CRATE_SALES) * EGG;
    expect([expectedEggs, expectedGross]).toEqual([790, 167_800]);
    expect(await num('SELECT count(*)::text AS n FROM ord.sales_order WHERE shift_document_id = $1 AND is_offline', [shiftId])).toBe(SALES);
    expect(await num("SELECT count(*)::text AS n FROM bil.billing_document d JOIN ord.sales_order o ON o.billing_document_id = d.id WHERE o.shift_document_id = $1 AND d.synced_from_offline AND d.kind = 'RECEIPT'", [shiftId])).toBe(SALES);
    expect(await num("SELECT count(*)::text AS n FROM pos.sale_sync WHERE shift_id = $1 AND outcome = 'APPLIED'", [shiftId])).toBe(SALES);
    const after = await footprint();
    expect(after['ord.sales_order']! - before['ord.sales_order']!).toBe(SALES);
    expect(after['pay.payment']! - before['pay.payment']!).toBe(SALES);
    expect(after['inv.stock_movement']! - before['inv.stock_movement']!).toBe(SALES);
    expect(after['bil.billing_document']! - before['bil.billing_document']!).toBe(SALES);
    // Three journal entries a sale (the receipt, the payment, the cost of sales), each numbered; five numbers a sale.
    expect(after['fin.journal_entry']! - before['fin.journal_entry']!).toBe(3 * SALES);
    expect(after['platform.number_allocation']! - before['platform.number_allocation']!).toBe(5 * SALES);
    expect(after['inv.stock_exception']!).toBe(before['inv.stock_exception']!);
    // One official number each, dense, in counter order, for the orders and for the receipts.
    expect(await numbering(shiftId, 'order')).toEqual({ count: SALES, distinct: SALES, span: SALES, inCounterOrder: true });
    expect(await numbering(shiftId, 'receipt')).toEqual({ count: SALES, distinct: SALES, span: SALES, inCounterOrder: true });
    expect(new Set(results.map((r) => r.receiptNo)).size).toBe(SALES);

    // The money, by SQL: 500 cash payments on Adwoa's shift; the ledger's egg sales, till cash and receivables.
    expect(await num('SELECT sum(amount_pesewas)::text AS n FROM pay.payment WHERE shift_document_id = $1', [shiftId])).toBe(expectedGross);
    expect(await shiftBalance('4020', shiftId)).toBe(-expectedGross);
    expect(await shiftBalance('1000', shiftId)).toBe(expectedGross);
    expect(await shiftBalance('1200', shiftId)).toBe(0);
    // The stock, by SQL: 790 eggs left the shop as SALE_ISSUE_OFFLINE; on hand fell from 900 to 110; cost of sales is
    // exactly what the pool gave up.
    expect(await num("SELECT sum(m.qty_base)::text AS n FROM inv.stock_movement m JOIN ord.sales_order o ON o.id = m.source_document_id WHERE o.shift_document_id = $1 AND m.movement_type = 'SALE_ISSUE_OFFLINE'", [shiftId])).toBe(expectedEggs);
    expect(await num('SELECT on_hand_qty::text AS n FROM inv.stock_balance WHERE product_id = $1 AND location_id = $2', [id('EGG-0003'), id('shop')])).toBe(900 - expectedEggs);
    const poolAfter = await one<{ qty: string; value: string }>('SELECT qty::text AS qty, value_pesewas::text AS value FROM inv.cost_pool WHERE product_id = $1', [id('EGG-0003')]);
    expect(Number(poolBefore.qty) - Number(poolAfter.qty)).toBe(expectedEggs);
    const given = Number(poolBefore.value) - Number(poolAfter.value);
    expect(await shiftBalance('5020', shiftId)).toBe(given);
    expect(await shiftBalance('1330', shiftId)).toBe(-given);
    expect(await num("SELECT sum(m.value_pesewas)::text AS n FROM inv.stock_movement m JOIN ord.sales_order o ON o.id = m.source_document_id WHERE o.shift_document_id = $1", [shiftId])).toBe(given);
    // The answer's totals agree with what was recorded.
    expect(results.reduce((sum, r) => sum + r.grossPesewas, 0)).toBe(expectedGross);
  });

  it('answers the same 500 sent again as duplicates of their first result, changing nothing', { timeout: 600_000 }, async () => {
    const before = await footprint();
    const first = await rows<{ client_sale_id: string; order_no: string; receipt_no: string }>("SELECT client_sale_id, order_no, receipt_no FROM pos.sale_sync WHERE shift_id = $1 AND outcome = 'APPLIED' ORDER BY device_counter", [shifts.get('T1')!.id]);
    const again = await sync('adwoa', 'T1', queue);
    expect(again.status).toBe(200);
    const results = again.body.results as { clientSaleId: string; outcome: string; orderNo: string; receiptNo: string }[];
    expect(results.every((r) => r.outcome === 'DUPLICATE')).toBe(true);
    expect(results.map((r) => [r.clientSaleId, r.orderNo, r.receiptNo])).toEqual(first.map((r) => [r.client_sale_id, r.order_no, r.receipt_no]));
    expect(await footprint()).toEqual(before);
  });
});

describe("UAT scenario 6's interrupted sync, as a dry run (docs/UAT.md section 10, FR-POS-011's acceptance)", () => {
  it('syncs fifty sales cut off after twenty, then sent whole, then sent whole again: fifty orders, fifty receipts, consecutive', { timeout: 300_000 }, async () => {
    const opened = shifts.get('T3')!.openedAt;
    const fifty = Array.from({ length: 50 }, (_, i) =>
      tillSale({ till: 'T3', shiftSeq: shifts.get('T3')!.seq, counter: i + 1, at: new Date(opened.getTime() + (i + 1) * 60_000), lines: [{ productId: id('PRD-0005'), quantity: '1.000', agreedUnitPricePesewas: 2_000 }], tenders: [{ paymentMethodId: id('CASH'), amountPesewas: 2_000 }] }),
    );
    const cut = await sync('nana', 'T3', fifty.slice(0, 20));
    expect(cut.body.counterGaps).toEqual([]);
    const whole = await sync('nana', 'T3', fifty);
    const outcomes = (whole.body.results as { outcome: string }[]).map((r) => r.outcome);
    expect([outcomes.slice(0, 20).every((o) => o === 'DUPLICATE'), outcomes.slice(20).every((o) => o !== 'DUPLICATE' && o !== 'REJECTED_INTEGRITY')]).toEqual([true, true]);
    const third = await sync('nana', 'T3', fifty);
    expect((third.body.results as { outcome: string }[]).every((r) => r.outcome === 'DUPLICATE')).toBe(true);
    const shiftId = shifts.get('T3')!.id;
    expect(await num('SELECT count(*)::text AS n FROM ord.sales_order WHERE shift_document_id = $1', [shiftId])).toBe(50);
    expect(await numbering(shiftId, 'receipt')).toEqual({ count: 50, distinct: 50, span: 50, inCounterOrder: true });
    expect(await rows('SELECT outcome, count(*)::int AS n FROM pos.sale_sync WHERE shift_id = $1 GROUP BY outcome ORDER BY outcome', [shiftId])).toEqual([
      { outcome: 'APPLIED', n: 40 },
      { outcome: 'APPLIED_WITH_EXCEPTION', n: 10 },
      { outcome: 'DUPLICATE', n: 70 },
    ]);
    // Forty yams stood on the shop floor: the ten sales beyond them are recorded with their cash, their stock moves
    // below zero (the owner's decision 2 of 2026-11-18, ADR-0081, replacing A-278 (f); UAT 6.13 expects the count below
    // zero), each with its NEGATIVE_STOCK beside the movement, and one count of yams on the shop floor is raised.
    expect(await num('SELECT sum(amount_pesewas)::text AS n FROM pay.payment WHERE shift_document_id = $1', [shiftId])).toBe(100_000);
    expect(await num("SELECT count(*)::text AS n FROM inv.stock_exception e JOIN ord.sales_order o ON o.id = e.source_document_id WHERE o.shift_document_id = $1 AND e.kind = 'NEGATIVE_STOCK' AND e.movement_id IS NOT NULL", [shiftId])).toBe(10);
    expect(await num('SELECT on_hand_qty::text AS n FROM inv.stock_balance WHERE product_id = $1 AND location_id = $2', [id('PRD-0005'), id('shop')])).toBe(-10);
    expect(await num("SELECT count(*)::text AS n FROM inv.count_task WHERE product_id = $1 AND location_id = $2 AND status = 'OPEN'", [id('PRD-0005'), id('shop')])).toBe(1);
  });
});
