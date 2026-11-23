import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock, Quantity } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stock } from '../../../src/modules/inv';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { DocumentRegistry } from '../../../src/platform/documents/document-registry';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { pesewasValue } from '../../support/money';
import { syncBatch, tillSale } from '../../support/offline';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Negative stock offline (the owner's decision 2 of 2026-11-18, ADR-0081, ADR-0018 Amendments, A-283): an offline sale
 * may take a location below zero; what the branch's cost pool did not hold is valued at the last known cost (Dr cost
 * of sales, Cr 1335) and trued up exactly when stock arrives (a nil lift before the arrival and a valued issue after
 * it, insert-only), flagged on the exception report's source with a count task; online sales keep today's rule.
 * Every quantity and pesewa is read by SQL over `inv.stock_movement`, `inv.stock_balance`, `inv.cost_pool`, the cost and
 * settlement rows and the journal lines, and every expected figure is worked out here by hand, never by the code.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let nextId: () => string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
/** Every business document each product's movements name, so its journal can be summed alone. */
const documents = new Map<string, string[]>();
const admin = () => database.pool('admin');
const rows = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => (await admin().query(sql, values)).rows as T[];
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await rows<T>(sql, values))[0]!;
const num = async (sql: string, values: unknown[] = []): Promise<number> => Number((await one<{ n: string | null }>(sql, values)).n ?? 0);
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const HOUR = 3_600_000;

/** A fresh countable, untracked product, a copy of the seeded cabbage, so its one pool per branch starts empty. */
async function product(code: string): Promise<string> {
  const productId = randomUUID();
  await admin().query(
    `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, species_id, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by)
     SELECT $1, $2, $2, category_id, stock_policy, tracking, species_id, base_uom, sale_uom, tax_category_id, gl_group, 'HIDDEN', 'ACTIVE', created_by, updated_by FROM mdm.product WHERE sku = 'PRD-0002'`,
    [productId, code],
  );
  ids.set(code, productId);
  documents.set(productId, []);
  return productId;
}

/** One movement posted through INV's `Stock` as its commands post it, in its own serializable transaction. */
function inTx<T>(productId: string, branch: string, run: (tx: Parameters<Parameters<UnitOfWork['run']>[1]>[0], documentId: string) => Promise<T>): Promise<T> {
  return runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Negative stock test' }, randomUUID(), () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable' }, async (tx) => {
      const documentId = randomUUID();
      await api.app.get(DocumentRegistry).register(tx, { id: documentId, docType: 'STOCK_ADJUSTMENT', ownerModule: 'inv', branchId: id(`branch:${branch}`), actorId: SYSTEM_PRINCIPAL });
      documents.get(productId)!.push(documentId);
      return run(tx, documentId);
    }),
  );
}

const receive = (productId: string, qty: string, value: number, branch = 'DDW', to = `${branch}:SHOP`) =>
  inTx(productId, branch, (tx, documentId) =>
    api.app.get(Stock).postIn(tx, SYSTEM_PRINCIPAL, {
      movementType: 'RECEIPT_PURCHASE',
      productId,
      branchId: id(`branch:${branch}`),
      fromLocationId: id(`${branch}:SUPPLIER`),
      toLocationId: id(to),
      qty: Quantity.parse(qty),
      value: pesewasValue(value),
      costElement: 'PURCHASE',
      sourceDocumentId: documentId,
      occurredAt: clock.now(),
    }),
  );

const sellOffline = (productId: string, qty: string, branch = 'DDW') =>
  inTx(productId, branch, (tx, documentId) =>
    api.app.get(Stock).postOfflineIssueIn(
      tx,
      SYSTEM_PRINCIPAL,
      { productId, branchId: id(`branch:${branch}`), fromLocationId: id(`${branch}:SHOP`), toLocationId: id(`${branch}:CUSTOMER`), qty: Quantity.parse(qty), sourceDocumentId: documentId, occurredAt: clock.now(), claim: { qty } },
      clock.now(),
    ),
  );

/** A transfer between branches: dispatched from DDW's shop into DDW's in-transit, received at ACC's shop. */
const transferToAcc = async (productId: string, qty: string) => {
  await inTx(productId, 'DDW', (tx, documentId) =>
    api.app.get(Stock).postIn(tx, SYSTEM_PRINCIPAL, { movementType: 'TRANSFER_DISPATCH', productId, branchId: id('branch:DDW'), fromLocationId: id('DDW:SHOP'), toLocationId: id('DDW:TRANSIT'), qty: Quantity.parse(qty), sourceDocumentId: documentId, occurredAt: clock.now() }),
  );
  return inTx(productId, 'DDW', (tx, documentId) =>
    api.app.get(Stock).postIn(tx, SYSTEM_PRINCIPAL, { movementType: 'TRANSFER_RECEIPT', productId, branchId: id('branch:DDW'), fromLocationId: id('DDW:TRANSIT'), toLocationId: id('ACC:SHOP'), qty: Quantity.parse(qty), sourceDocumentId: documentId, occurredAt: clock.now() }),
  );
};

/** Debits less credits on an account over the journals of a product's documents. */
const account = (code: string, productId: string) =>
  num(
    `SELECT sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS n
       FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
      WHERE a.code = $1 AND e.source_document_id = ANY($2::uuid[])`,
    [code, documents.get(productId)!],
  );
/** What the product's pools hold, in every branch: quantity and value. */
const pools = (productId: string) => one<{ qty: string; value: string }>("SELECT COALESCE(sum(qty), 0)::text AS qty, COALESCE(sum(value_pesewas), 0)::text AS value FROM inv.cost_pool WHERE product_id = $1", [productId]);
const poolAt = (productId: string, branch: string) => one<{ qty: string; value: string } | undefined>('SELECT qty::text, value_pesewas::text AS value FROM inv.cost_pool WHERE product_id = $1 AND branch_id = $2', [productId, id(`branch:${branch}`)]);
const onHand = (productId: string, location: string) => num('SELECT on_hand_qty::text AS n FROM inv.stock_balance WHERE product_id = $1 AND location_id = $2 AND stock_unit_id IS NULL', [productId, id(location)]);
const movements = (productId: string) =>
  rows<{ type: string; qty: string; value: string; from: string; to: string }>(
    'SELECT movement_type AS type, qty_base::text AS qty, value_pesewas::text AS value, from_location_id AS "from", to_location_id AS "to" FROM inv.stock_movement WHERE product_id = $1 ORDER BY recorded_at, id',
    [productId],
  );
const costs = (productId: string) =>
  rows<{ uncovered: string; known: boolean; basis_qty: string | null; basis_value: string | null; value: string }>(
    'SELECT uncovered_qty::text AS uncovered, cost_known AS known, basis_qty::text, basis_value_pesewas::text AS basis_value, value_pesewas::text AS value FROM inv.negative_stock_cost WHERE product_id = $1 ORDER BY recorded_at, movement_id',
    [productId],
  );
const settlements = (productId: string) =>
  rows<{ qty: string; cleared: string; value: string }>(
    `SELECT s.qty::text, s.cleared_value_pesewas::text AS cleared, s.true_up_value_pesewas::text AS value FROM inv.negative_stock_settlement s
       JOIN inv.negative_stock_cost c ON c.id = s.cost_id WHERE c.product_id = $1 ORDER BY s.recorded_at, c.recorded_at, c.movement_id`,
    [productId],
  );

/** The books agree with the stock: 1330 over the product's journals is what its pools hold, every step. */
async function expectReconciled(productId: string): Promise<void> {
  expect(await account('1330', productId)).toBe(Number((await pools(productId)).value));
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '172800', AUTH_STAFF_REFRESH_IDLE_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of await rows<{ code: string; id: string }>(
    `SELECT 'branch:DDW' AS code, id FROM mdm.branch WHERE code = 'DDW'
     UNION ALL SELECT 'DDW:' || CASE WHEN l.is_virtual THEN l.kind ELSE l.code END, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.deleted_at IS NULL
     UNION ALL SELECT code, id FROM mdm.payment_method`,
  )) {
    ids.set(row.code, row.id);
  }
  // A second branch for the transfers, with its shop and its virtual locations, as MDM creates them.
  const acc = randomUUID();
  await admin().query("INSERT INTO mdm.branch (id, code, name, status, created_by, updated_by) VALUES ($1, 'ACC', 'Accra shop', 'ACTIVE', $2, $2)", [acc, SYSTEM_PRINCIPAL]);
  ids.set('branch:ACC', acc);
  for (const [code, kind, virtual] of [['SHOP', 'SHOP_FLOOR', false], ['SUPPLIER', 'SUPPLIER', true], ['CUSTOMER', 'CUSTOMER', true], ['ADJUSTMENT', 'ADJUSTMENT', true]] as const) {
    const locationId = randomUUID();
    await admin().query('INSERT INTO mdm.location (id, branch_id, code, name, kind, is_virtual, is_sellable, allows_negative, created_by, updated_by) VALUES ($1, $2, $3, $3, $4, $5, $6, $5, $7, $7)', [
      locationId, acc, `ACC-${code}`, kind, virtual, !virtual, SYSTEM_PRINCIPAL,
    ]);
    ids.set(`ACC:${code}`, locationId);
  }
  for (const [who, name, role, totp] of [
    ['manager', 'Kwabena Owusu', 'MANAGER', true],
    ['abena', 'Abena Sarpong', 'CASHIER', false],
  ] as const) {
    const user = await createUser(database, { name, grants: [{ role, branchId: id('branch:DDW'), ...(role === 'CASHIER' ? { locationId: id('DDW:SHOP') } : {}) }] });
    users.set(who, user);
    sessions.set(who, totp ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  clock.advanceBy(7 * HOUR);
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('an offline sale beyond stock, end to end through the sync (OFFLINE_SYNC 9.3 as the owner ruled on 2026-11-18)', () => {
  it('moves the stock below zero on the shop floor, values what the pool lacked at its last known cost, flags it and raises a count task', async () => {
    await stepUp(api.server, as('manager') as TotpSession, clock);
    const till = await post('manager', '/registers', { branchId: id('branch:DDW'), locationId: id('DDW:SHOP'), code: 'N1', name: 'Shop till N1' });
    expect(till.status, JSON.stringify(till.body)).toBe(201);
    await stepUp(api.server, as('manager') as TotpSession, clock);
    const enrolled = await post('manager', `/registers/${till.body.id as string}/devices`, { deviceLabel: 'Shop tablet N1' });
    const credential = enrolled.body.deviceCredential as string;
    const pack = await consoleGet(api.server, as('abena'), `/v1/registers/${till.body.id as string}/offline-pack`).set('X-Device-Credential', credential);
    const shiftId = nextId();
    const seq = pack.body.nextShiftSeq as number;
    const opened = await consolePost(api.server, as('abena'), '/v1/shifts', shiftId).set('X-Device-Credential', credential).send({ id: shiftId, registerId: till.body.id, openingFloatPesewas: 0, openedAt: new Date(clock.now().getTime() - HOUR).toISOString(), shiftSeq: seq });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);

    // A fresh product with 5 on the shop floor at 24,000 (4,800 each), the numbers of OFFLINE_SYNC 9.3; the till sells 8.
    const egg = await product('NEG-E2E');
    await receive(egg, '5.000', 24_000);
    const before = (await poolAt(egg, 'DDW'))!;
    const shopBefore = await onHand(egg, 'DDW:SHOP');
    const poolQty = Number(before.qty);
    const sold = poolQty + 3;
    const uom = (await one<{ base_uom: string }>('SELECT base_uom FROM mdm.product WHERE id = $1', [egg])).base_uom;
    const sale = tillSale({ till: 'N1', shiftSeq: seq, counter: 1, at: new Date(clock.now().getTime() - 30 * 60_000), lines: [{ productId: egg, quantity: `${sold}.000`, uom, agreedUnitPricePesewas: 6_000 }], tenders: [{ paymentMethodId: id('CASH'), amountPesewas: sold * 6_000 }] });
    const synced = await syncBatch(api.server, as('abena'), credential, { deviceId: enrolled.body.device.id, shiftId, sales: [sale], cashMovements: [] });
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect(synced.body.results[0]).toMatchObject({ outcome: 'APPLIED_WITH_EXCEPTION', grossPesewas: sold * 6_000 });
    expect((synced.body.results[0].exceptions as { kind: string }[]).map((e) => e.kind)).toContain('NEGATIVE_STOCK');

    // The stock moved: the shop floor is down by the whole sale, below zero; the pool is at -3 and holds nothing.
    expect(await onHand(egg, 'DDW:SHOP')).toBe(shopBefore - sold);
    expect(await onHand(egg, 'DDW:SHOP')).toBeLessThan(0);
    expect(await poolAt(egg, 'DDW')).toEqual({ qty: '-3.000', value: '0' });
    const issue = await one<{ id: string; value: string; qty: string }>("SELECT id, value_pesewas::text AS value, qty_base::text AS qty FROM inv.stock_movement WHERE source_document_id = $1 AND movement_type = 'SALE_ISSUE_OFFLINE'", [sale.id]);
    expect([issue.qty, issue.value]).toEqual([`${sold}.000`, before.value]);
    // The uncovered 3 crates at the pool's own average before the sale, half-up once: V x 3 / Q.
    const lastKnown = Math.floor((2 * Number(before.value) * 3 + poolQty) / (2 * poolQty));
    const cost = await one<{ uncovered: string; known: boolean; value: string; basis_qty: string; basis_value: string }>(
      'SELECT uncovered_qty::text AS uncovered, cost_known AS known, value_pesewas::text AS value, basis_qty::text, basis_value_pesewas::text AS basis_value FROM inv.negative_stock_cost WHERE movement_id = $1',
      [issue.id],
    );
    expect(cost).toEqual({ uncovered: '3.000', known: true, value: String(lastKnown), basis_qty: `${poolQty}.000`, basis_value: before.value });
    // The journal of the sale's stock: Dr 5020 the pool's value and the last known cost of the 3; Cr 1330 the pool's value; Cr 1335 the 3.
    const stockLines = await rows<{ event: string; code: string; side: string; amount: string }>(
      `SELECT e.event_code AS event, a.code, l.side, l.amount_pesewas::text AS amount FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
        WHERE e.event_subject_id = $1 ORDER BY e.event_code, l.side DESC, a.code`,
      [issue.id],
    );
    expect(stockLines).toEqual([
      { event: 'inv.NegativeStockCosted', code: '5020', side: 'D', amount: String(lastKnown) },
      { event: 'inv.NegativeStockCosted', code: '1335', side: 'C', amount: String(lastKnown) },
      { event: 'inv.StockIssuedForSale', code: '5020', side: 'D', amount: before.value },
      { event: 'inv.StockIssuedForSale', code: '1330', side: 'C', amount: before.value },
    ]);
    // Flagged for the exception report's source, REVIEW, with abuse case 36, and a count task at the shop floor.
    const exception = await one<{ id: string }>("SELECT id FROM inv.stock_exception WHERE movement_id = $1 AND kind = 'NEGATIVE_STOCK'", [issue.id]);
    const task = await one<{ id: string; location_id: string; status: string; stock_exception_id: string }>('SELECT id, location_id, status, stock_exception_id FROM inv.count_task WHERE product_id = $1', [egg]);
    expect(task).toMatchObject({ location_id: id('DDW:SHOP'), status: 'OPEN', stock_exception_id: exception.id });
    const flagged = await rows<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pos.OfflineSaleFlagged' AND subject_id = $1 AND payload->>'exceptionKind' = 'STOCK_EXCEPTION'", [sale.id]);
    const negative = flagged.map((r) => r.payload).find((p) => (p['fact'] as Record<string, unknown>)['stockExceptionKind'] === 'NEGATIVE_STOCK')!;
    expect(negative).toMatchObject({ severity: 'REVIEW', abuseCases: [11, 36] });
    expect(negative['fact']).toMatchObject({ countTaskId: task.id, uncoveredQty: '3.000', costKnown: true, valuedAtLastKnownCostPesewas: lastKnown });

    // A second sale beyond stock at the same place raises its exception, but no second open count task.
    const again = tillSale({ till: 'N1', shiftSeq: seq, counter: 2, at: new Date(clock.now().getTime() - 20 * 60_000), lines: [{ productId: egg, quantity: '1.000', uom, agreedUnitPricePesewas: 6_000 }], tenders: [{ paymentMethodId: id('CASH'), amountPesewas: 6_000 }] });
    const second = await syncBatch(api.server, as('abena'), credential, { deviceId: enrolled.body.device.id, shiftId, sales: [again], cashMovements: [] });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(await num("SELECT count(*)::text AS n FROM inv.count_task WHERE product_id = $1 AND status = 'OPEN'", [egg])).toBe(1);
    expect(await num("SELECT count(*)::text AS n FROM inv.stock_exception WHERE product_id = $1 AND kind = 'NEGATIVE_STOCK' AND status = 'OPEN'", [egg])).toBe(2);

    // A product with no cost ever known, sold below zero: valued at nil, and so raised URGENT (A-283 (e)).
    const unknown = await product('NEG-E2E-NOCOST');
    const blind = tillSale({ till: 'N1', shiftSeq: seq, counter: 3, at: new Date(clock.now().getTime() - 10 * 60_000), lines: [{ productId: unknown, quantity: '2.000', uom, agreedUnitPricePesewas: 6_000 }], tenders: [{ paymentMethodId: id('CASH'), amountPesewas: 12_000 }] });
    const third = await syncBatch(api.server, as('abena'), credential, { deviceId: enrolled.body.device.id, shiftId, sales: [blind], cashMovements: [] });
    expect(third.status, JSON.stringify(third.body)).toBe(200);
    const urgent = (await rows<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pos.OfflineSaleFlagged' AND subject_id = $1 AND payload->>'exceptionKind' = 'STOCK_EXCEPTION'", [blind.id]))
      .map((r) => r.payload)
      .find((p) => (p['fact'] as Record<string, unknown>)['stockExceptionKind'] === 'NEGATIVE_STOCK')!;
    expect(urgent).toMatchObject({ severity: 'URGENT', abuseCases: [11, 36], fact: { costKnown: false, uncoveredQty: '2.000', valuedAtLastKnownCostPesewas: 0 } });
  });
});

describe('the true-up on arrival: exact, insert-only, the books reconciled at every step (ADR-0081)', () => {
  it('a dearer arrival: 3 owed at 4,800 settled at 5,000; 1335 back to zero, cost of sales up by exactly 600', async () => {
    const p = await product('NEG-DEAR');
    await receive(p, '5.000', 24_000);
    await expectReconciled(p);
    const sold = await sellOffline(p, '8.000');
    expect(sold).toMatchObject({ kind: 'MOVED', movement: { value: expect.objectContaining({ pesewas: 24_000n }) } });
    expect(await costs(p)).toEqual([{ uncovered: '3.000', known: true, basis_qty: '5.000', basis_value: '24000', value: '14400' }]);
    expect([await onHand(p, 'DDW:SHOP'), await poolAt(p, 'DDW')]).toEqual([-3, { qty: '-3.000', value: '0' }]);
    expect([await account('5020', p), await account('1335', p)]).toEqual([24_000 + 14_400, -14_400]);
    await expectReconciled(p);

    await receive(p, '10.000', 50_000);
    // The receipt of 10, the lift of 3 at nil before it, the issue of 3 at the pool's 50,000 x 3 / 10 = 15,000 after it
    // (one transaction, listed by id: the receipt's id was its command's own, made first).
    expect((await movements(p)).slice(2)).toEqual([
      { type: 'RECEIPT_PURCHASE', qty: '10.000', value: '50000', from: id('DDW:SUPPLIER'), to: id('DDW:SHOP') },
      { type: 'NEGATIVE_TRUE_UP_IN', qty: '3.000', value: '0', from: id('DDW:ADJUSTMENT'), to: id('DDW:SHOP') },
      { type: 'NEGATIVE_TRUE_UP', qty: '3.000', value: '15000', from: id('DDW:SHOP'), to: id('DDW:ADJUSTMENT') },
    ]);
    expect(await settlements(p)).toEqual([{ qty: '3.000', cleared: '14400', value: '15000' }]);
    expect([await onHand(p, 'DDW:SHOP'), await poolAt(p, 'DDW')]).toEqual([7, { qty: '7.000', value: '35000' }]);
    // 8 crates sold: 5 at 4,800 and 3 at 5,000 = 39,000; 1335 at zero; 1330 = the pool's 35,000.
    expect([await account('5020', p), await account('1335', p), await account('1330', p)]).toEqual([39_000, 0, 35_000]);
    await expectReconciled(p);
  });

  it('a cheaper arrival that overfills: 3 owed at 4,800 settled at 4,500 from 4 arriving; cost of sales down by exactly 900', async () => {
    const p = await product('NEG-CHEAP');
    await receive(p, '5.000', 24_000);
    await sellOffline(p, '8.000');
    await receive(p, '4.000', 18_000);
    expect(await settlements(p)).toEqual([{ qty: '3.000', cleared: '14400', value: '13500' }]);
    expect([await onHand(p, 'DDW:SHOP'), await poolAt(p, 'DDW')]).toEqual([1, { qty: '1.000', value: '4500' }]);
    expect([await account('5020', p), await account('1335', p)]).toEqual([24_000 + 13_500, 0]);
    await expectReconciled(p);
  });

  it('a part arrival: 5 owed, 3 arrive at 14,100: 3 settled for exactly 14,100, 2 stay owed and flagged; the next arrival settles the rest', async () => {
    const p = await product('NEG-PART');
    await receive(p, '2.000', 9_000);
    const sold = await sellOffline(p, '7.000');
    expect(sold.kind).toBe('MOVED');
    // 5 uncovered at 9,000 / 2 = 4,500 a crate.
    expect(await costs(p)).toEqual([{ uncovered: '5.000', known: true, basis_qty: '2.000', basis_value: '9000', value: '22500' }]);
    await receive(p, '3.000', 14_100);
    // Lift 5, receive 3, issue 5: the pool held 3 crates' 14,100, all of it leaves for the 3 settled.
    expect((await movements(p)).slice(2).map((m) => [m.type, m.qty, m.value])).toEqual([
      ['RECEIPT_PURCHASE', '3.000', '14100'],
      ['NEGATIVE_TRUE_UP_IN', '5.000', '0'],
      ['NEGATIVE_TRUE_UP', '5.000', '14100'],
    ]);
    // Cleared: half-up of 22,500 x 3 / 5 = 13,500; 2 crates and 9,000 of last known cost still owed.
    expect(await settlements(p)).toEqual([{ qty: '3.000', cleared: '13500', value: '14100' }]);
    expect([await onHand(p, 'DDW:SHOP'), await poolAt(p, 'DDW')]).toEqual([-2, { qty: '-2.000', value: '0' }]);
    expect(await account('1335', p)).toBe(-9_000);
    await expectReconciled(p);
    // Still flagged: the shop floor is below zero, an open NEGATIVE_STOCK and its count task stand.
    expect(await num("SELECT count(*)::text AS n FROM inv.count_task WHERE product_id = $1 AND status = 'OPEN'", [p])).toBe(1);

    await receive(p, '6.000', 28_800);
    // Lift 2, receive 6, issue 2 at 28,800 x 2 / 6 = 9,600; the last 9,000 cleared.
    expect((await settlements(p)).at(1)).toEqual({ qty: '2.000', cleared: '9000', value: '9600' });
    expect([await onHand(p, 'DDW:SHOP'), await poolAt(p, 'DDW')]).toEqual([4, { qty: '4.000', value: '19200' }]);
    // 7 sold: 2 at 4,500, 3 at 4,700, 2 at 4,800 = 32,700; 1335 at zero.
    expect([await account('5020', p), await account('1335', p)]).toEqual([32_700, 0]);
    await expectReconciled(p);
  });

  it('two sales at different last known costs settle oldest first, each at its own cleared cost (A-283 (c))', async () => {
    const p = await product('NEG-FIFO');
    await receive(p, '2.000', 10_000);
    await sellOffline(p, '4.000'); // 2 uncovered at 5,000 = 10,000
    clock.advanceBy(60_000);
    await receive(p, '1.000', 6_000); // a part arrival: 1 of the 2 settled at 6,000
    clock.advanceBy(60_000);
    await sellOffline(p, '2.000'); // nothing covered: the last known cost is now 6,000; 2 at 6,000 = 12,000
    expect((await costs(p)).map((c) => [c.uncovered, c.basis_qty, c.basis_value, c.value])).toEqual([
      ['2.000', '2.000', '10000', '10000'],
      ['2.000', '1.000', '6000', '12000'],
    ]);
    expect(await account('1335', p)).toBe(-10_000 + 5_000 - 12_000);
    clock.advanceBy(60_000);
    // 2 arrive at 11,000 against 3 owed: the older row's 1 first, then 1 of the newer 2; the whole 11,000 out.
    await receive(p, '2.000', 11_000);
    expect((await settlements(p)).slice(1)).toEqual([
      { qty: '1.000', cleared: '5000', value: '5500' },
      { qty: '1.000', cleared: '6000', value: '5500' },
    ]);
    expect([await poolAt(p, 'DDW'), await account('1335', p)]).toEqual([{ qty: '-1.000', value: '0' }, -6_000]);
    await expectReconciled(p);
    clock.advanceBy(60_000);
    // 3 at 16,500 settle the last 1 at 5,500 against its 6,000.
    await receive(p, '3.000', 16_500);
    expect((await settlements(p)).at(3)).toEqual({ qty: '1.000', cleared: '6000', value: '5500' });
    expect([await poolAt(p, 'DDW'), await account('1335', p)]).toEqual([{ qty: '2.000', value: '11000' }, 0]);
    // 6 sold: 2 at 5,000, 1 at 6,000, 3 at 5,500 = 32,500.
    expect(await account('5020', p)).toBe(32_500);
    await expectReconciled(p);
  });

  it('a product with no cost ever known: valued at nil, raised URGENT, and its whole cost recognised on arrival (A-283 (e))', async () => {
    const p = await product('NEG-NOCOST');
    const sold = await sellOffline(p, '2.000');
    expect(sold.kind === 'MOVED' && sold.exceptions.find((e) => e.kind === 'NEGATIVE_STOCK')!.fact).toMatchObject({ costKnown: false, uncoveredQty: '2.000', valuedAtLastKnownCostPesewas: 0 });
    expect(await costs(p)).toEqual([{ uncovered: '2.000', known: false, basis_qty: null, basis_value: null, value: '0' }]);
    expect(await num("SELECT count(*)::text AS n FROM fin.journal_entry WHERE event_code = 'inv.NegativeStockCosted' AND source_document_id = ANY($1::uuid[])", [documents.get(p)!])).toBe(0);
    await receive(p, '3.000', 15_000);
    expect(await settlements(p)).toEqual([{ qty: '2.000', cleared: '0', value: '10000' }]);
    expect([await account('5020', p), await account('1335', p), await poolAt(p, 'DDW')]).toEqual([10_000, 0, { qty: '1.000', value: '5000' }]);
    await expectReconciled(p);
  });

  it('a transfer between branches trues up as a receipt does: exact fill, part fill and overfill all succeed', async () => {
    // Exact: ACC owes 2 at 5,000; DDW sends exactly 2 of its 10 at 4,800 = 9,600.
    const exact = await product('NEG-T-EXACT');
    await receive(exact, '1.000', 5_000, 'ACC');
    await sellOffline(exact, '3.000', 'ACC');
    await receive(exact, '10.000', 48_000);
    await transferToAcc(exact, '2.000');
    expect(await settlements(exact)).toEqual([{ qty: '2.000', cleared: '10000', value: '9600' }]);
    expect([await poolAt(exact, 'ACC'), await poolAt(exact, 'DDW'), await onHand(exact, 'ACC:SHOP')]).toEqual([{ qty: '0.000', value: '0' }, { qty: '8.000', value: '38400' }, 0]);
    expect(await account('1335', exact)).toBe(0);
    await expectReconciled(exact);

    // Part, then over: ACC owes 3 at 5,000; 2 arrive (9,600), then 3 (14,400) of which 1 settles at 4,800.
    const part = await product('NEG-T-PART');
    await receive(part, '1.000', 5_000, 'ACC');
    await sellOffline(part, '4.000', 'ACC');
    await receive(part, '10.000', 48_000);
    await transferToAcc(part, '2.000');
    expect(await settlements(part)).toEqual([{ qty: '2.000', cleared: '10000', value: '9600' }]);
    expect([await poolAt(part, 'ACC'), await account('1335', part)]).toEqual([{ qty: '-1.000', value: '0' }, -5_000]);
    await expectReconciled(part);
    await transferToAcc(part, '3.000');
    expect((await settlements(part)).at(1)).toEqual({ qty: '1.000', cleared: '5000', value: '4800' });
    expect([await poolAt(part, 'ACC'), await poolAt(part, 'DDW'), await account('1335', part)]).toEqual([{ qty: '2.000', value: '9600' }, { qty: '5.000', value: '24000' }, 0]);
    // 4 sold at ACC: 1 at 5,000, 2 at 4,800, 1 at 4,800 = 19,400.
    expect(await account('5020', part)).toBe(19_400);
    await expectReconciled(part);
  });

  it('an arrival into a pool that owes nothing is exactly as before: one movement, its own journal, no lift and no issue', async () => {
    const p = await product('NEG-NONE');
    await receive(p, '4.000', 20_000);
    await receive(p, '2.000', 9_000);
    expect((await movements(p)).map((m) => [m.type, m.qty, m.value])).toEqual([
      ['RECEIPT_PURCHASE', '4.000', '20000'],
      ['RECEIPT_PURCHASE', '2.000', '9000'],
    ]);
    const lines = await rows<{ event: string; code: string; side: string; amount: string }>(
      `SELECT e.event_code AS event, a.code, l.side, l.amount_pesewas::text AS amount FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
        WHERE e.source_document_id = ANY($1::uuid[]) ORDER BY l.amount_pesewas DESC, l.side DESC`,
      [documents.get(p)!],
    );
    expect(lines).toEqual([
      { event: 'inv.GoodsReceived', code: '1330', side: 'D', amount: '20000' },
      { event: 'inv.GoodsReceived', code: '2010', side: 'C', amount: '20000' },
      { event: 'inv.GoodsReceived', code: '1330', side: 'D', amount: '9000' },
      { event: 'inv.GoodsReceived', code: '2010', side: 'C', amount: '9000' },
    ]);
    // An offline sale the pool covers, though the location goes below zero at another place, costs nothing extra.
    expect(await costs(p)).toEqual([]);
  });
});

describe('online sales keep today’s rule, and the database holds the true-up to its own rows', () => {
  it('refuses an online sale beyond stock (SALE_ISSUE), moving nothing', async () => {
    const p = await product('NEG-ONLINE');
    await receive(p, '2.000', 9_000);
    const refused = await inTx(p, 'DDW', (tx, documentId) =>
      api.app.get(Stock).postIn(tx, SYSTEM_PRINCIPAL, { movementType: 'SALE_ISSUE', productId: p, branchId: id('branch:DDW'), fromLocationId: id('DDW:SHOP'), toLocationId: id('DDW:CUSTOMER'), qty: Quantity.parse('3.000'), sourceDocumentId: documentId, occurredAt: clock.now() }),
    ).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect([await onHand(p, 'DDW:SHOP'), await poolAt(p, 'DDW'), await costs(p)]).toEqual([2, { qty: '2.000', value: '9000' }, []]);
    expect(await num('SELECT negative_anywhere::int::text AS n FROM inv.movement_type WHERE code = $1', ['SALE_ISSUE'])).toBe(0);
  });

  it('refuses a true-up or a cost row written by hand, a settlement beyond what is uncovered, and any change to either ledger', async () => {
    const p = await product('NEG-GUARD');
    await receive(p, '1.000', 5_000);
    await sellOffline(p, '3.000');
    const doc = documents.get(p)![0]!;
    const client = await database.pool('app').connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "INSERT INTO inv.stock_movement (id, movement_type, product_id, branch_id, from_location_id, to_location_id, qty_base, value_pesewas, source_document_id, occurred_at, actor_id) VALUES ($1, 'NEGATIVE_TRUE_UP_IN', $2, $3, $4, $5, 2, 0, $6, now(), $7)",
        [randomUUID(), p, id('branch:DDW'), id('DDW:ADJUSTMENT'), id('DDW:SHOP'), doc, SYSTEM_PRINCIPAL],
      );
      await expect(client.query('COMMIT')).rejects.toMatchObject({ constraint: 'ck_negative_true_up' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    const issue = await one<{ id: string }>("SELECT id FROM inv.stock_movement WHERE product_id = $1 AND movement_type = 'SALE_ISSUE_OFFLINE'", [p]);
    const cost = await one<{ id: string }>('SELECT id FROM inv.negative_stock_cost WHERE product_id = $1', [p]);
    await expect(
      database.pool('app').query("INSERT INTO inv.negative_stock_cost (movement_id, product_id, branch_id, location_id, uncovered_qty, cost_known, value_pesewas, recorded_at, actor_id) VALUES ($1, $2, $3, $4, 1, false, 0, now(), $5)", [
        issue.id, p, id('branch:DDW'), id('DDW:SHOP'), SYSTEM_PRINCIPAL,
      ]),
    ).rejects.toMatchObject({ constraint: 'ck_negative_stock_cost' });
    await expect(
      database.pool('app').query('INSERT INTO inv.negative_stock_settlement (cost_id, lift_movement_id, arrival_movement_id, true_up_movement_id, qty, cleared_value_pesewas, true_up_value_pesewas, recorded_at, actor_id) VALUES ($1, $2, $2, $2, 3, 0, 0, now(), $3)', [
        cost.id, issue.id, SYSTEM_PRINCIPAL,
      ]),
    ).rejects.toMatchObject({ constraint: 'ck_negative_stock_settled' });
    await expect(admin().query('UPDATE inv.negative_stock_cost SET value_pesewas = 0 WHERE id = $1', [cost.id])).rejects.toThrow();
    await expect(admin().query('DELETE FROM inv.negative_stock_cost WHERE id = $1', [cost.id])).rejects.toThrow();
    // A settlement row with a lift that is not one: refused even within what is uncovered.
    await expect(
      database.pool('app').query('INSERT INTO inv.negative_stock_settlement (cost_id, lift_movement_id, arrival_movement_id, true_up_movement_id, qty, cleared_value_pesewas, true_up_value_pesewas, recorded_at, actor_id) VALUES ($1, $2, $2, $2, 1, 2500, 0, now(), $3)', [
        cost.id, issue.id, SYSTEM_PRINCIPAL,
      ]),
    ).rejects.toMatchObject({ constraint: 'ck_negative_true_up' });
    // The real true-up settles it once, and the row it wrote cannot be changed or written twice.
    await receive(p, '2.000', 10_000);
    const settled = await one<{ id: string; cost_id: string; true_up_movement_id: string }>('SELECT s.id, s.cost_id, s.true_up_movement_id FROM inv.negative_stock_settlement s WHERE s.cost_id = $1', [cost.id]);
    await expect(admin().query('UPDATE inv.negative_stock_settlement SET qty = 1 WHERE id = $1', [settled.id])).rejects.toThrow();
    await expect(admin().query('DELETE FROM inv.negative_stock_settlement WHERE id = $1', [settled.id])).rejects.toThrow();
    expect(await account('1335', p)).toBe(0);
    await expectReconciled(p);
  });
});
