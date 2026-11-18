import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * CR-038 at the counter (B09b continued 2): a crate and a single egg of the seeded eggs (EGG-0003, counted in the egg
 * unit `EGG` since B09u, A-303; 30 to the crate) are each sold at their own price list entry, a line with no unit is in
 * the unit the product is sold by first (the crate), stock is issued in eggs, and a unit the product is not sold by at
 * the till is 400 `VALIDATION_FAILED` on `/lines/{i}/uom`, never priced from another unit. Every price is read by SQL
 * from the entries in force, every figure from the movements, the payment and the journal lines.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let nextId: () => string;
const sessions = new Map<string, TestSession>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
let credential: string;
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const one = async <T>(sql: string, values: unknown[]): Promise<T> => (await admin().query(sql, values)).rows[0] as T;

function sell(body: Record<string, unknown>) {
  const saleId = (body['id'] as string | undefined) ?? nextId();
  return consolePost(api.server, as('kofi'), '/v1/pos/sales', saleId)
    .set('X-Device-Credential', credential)
    .send({ id: saleId, shiftId: id('shift'), occurredAt: clock.now().toISOString(), ...body });
}
const cash = (amount: number, tendered?: number) => ({ paymentMethodId: id('CASH'), amountPesewas: amount, ...(tendered === undefined ? {} : { tenderedPesewas: tendered }) });

/** The list price of a product's entry for a unit (null: the base unit) on the POS walk for a walk-in: no POS list prices eggs, so the base list. */
async function listPrice(sku: string, uom: string | null): Promise<number> {
  const row = await one<{ price: string }>(
    `SELECT e.list_price_pesewas::text AS price
       FROM mdm.price_list_entry e JOIN mdm.price_list_version v ON v.id = e.version_id JOIN mdm.price_list l ON l.id = v.price_list_id JOIN mdm.product p ON p.id = e.product_id
      WHERE p.sku = $1 AND e.uom IS NOT DISTINCT FROM $2 AND l.kind = 'BASE' AND v.status = 'ACTIVE' AND v.valid_from <= $3 AND (v.valid_to IS NULL OR v.valid_to > $3)
        AND e.grade_id IS NULL AND e.weight_band_id IS NULL AND e.min_qty = (SELECT min(e2.min_qty) FROM mdm.price_list_entry e2 WHERE e2.version_id = e.version_id AND e2.product_id = e.product_id AND e2.uom IS NOT DISTINCT FROM $2)`,
    [sku, uom, clock.now()],
  );
  return Number(row.price);
}

/** Debits less credits on an account over the journals of one source document. */
async function balance(code: string, document: string): Promise<number> {
  const row = await one<{ n: string }>(
    `SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS n
       FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
      WHERE a.code = $1 AND e.source_document_id = $2`,
    [code, document],
  );
  return Number(row.n);
}

async function footprint(): Promise<Record<string, string>> {
  const counts: Record<string, string> = {};
  for (const table of ['ord.sales_order', 'pay.payment', 'inv.stock_movement', 'bil.billing_document', 'fin.journal_entry', 'platform.number_allocation']) {
    counts[table] = (await one<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`, [])).n;
  }
  return counts;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch' AS code, id FROM mdm.branch WHERE code = 'DDW'
       UNION ALL SELECT 'shop', l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = 'SHOP'
       UNION ALL SELECT sku, id FROM mdm.product WHERE sku IN ('EGG-0003', 'PRD-0002', 'PRD-0005')
       UNION ALL SELECT code, id FROM mdm.payment_method`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const manager = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId: id('branch') }] });
  sessions.set('manager', await enrolAndLogin(api.server, manager, () => clock.now()));
  const kofi = await createUser(database, { name: 'Kofi Boateng', grants: [{ role: 'CASHIER', branchId: id('branch'), locationId: id('shop') }] });
  sessions.set('kofi', await login(api.server, kofi));
  const till = await post('manager', '/registers', { branchId: id('branch'), locationId: id('shop'), code: 'E1', name: 'Egg till' });
  expect(till.status, JSON.stringify(till.body)).toBe(201);
  await stepUp(api.server, as('manager') as TotpSession, clock);
  const enrolled = await post('manager', `/registers/${till.body.id as string}/devices`, { deviceLabel: 'Egg tablet' });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  credential = enrolled.body.deviceCredential as string;
  const shift = nextId();
  expect((await post('kofi', '/shifts', { id: shift, registerId: till.body.id, openingFloatPesewas: 0, openedAt: clock.now().toISOString() }, shift)).status).toBe(201);
  ids.set('shift', shift);
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('a crate and a single egg at the counter, each at its own price (CR-038)', () => {
  it('sells a crate, three single eggs and two crates named by no unit at the crate and egg entries, issuing the eggs in eggs', async () => {
    const [crate, egg] = [await listPrice('EGG-0003', 'CRATE'), await listPrice('EGG-0003', null)];
    expect([crate, egg]).toEqual([6_000, 220]);
    const perCrate = Number((await one<{ n: string }>("SELECT numerator::text AS n FROM mdm.product_uom_conversion WHERE product_id = $1 AND from_uom = 'CRATE' AND deleted_at IS NULL", [id('EGG-0003')])).n);
    expect(perCrate).toBe(30);
    const total = 1 * crate + 3 * egg + 2 * crate; // 18,660
    const saleId = nextId();
    const sold = await sell({
      id: saleId,
      lines: [
        { productId: id('EGG-0003'), quantity: '1.000', uom: 'CRATE', agreedUnitPricePesewas: crate },
        { productId: id('EGG-0003'), quantity: '3.000', uom: 'EGG', agreedUnitPricePesewas: egg },
        { productId: id('EGG-0003'), quantity: '2.000', agreedUnitPricePesewas: crate },
      ],
      tenders: [cash(total, 20_000)],
    });
    expect(sold.status, JSON.stringify(sold.body)).toBe(201);
    expect(sold.body).toMatchObject({ order: { finalTotalPesewas: 18_660, paymentStatus: 'PAID' }, receipt: { grossPesewas: 18_660 }, changeDuePesewas: 20_000 - 18_660 });
    const lines = (sold.body.order.lines as { qtyOrdered: string; uom: string; resolvedUnitPricePesewas: number; finalLineTotalPesewas: number }[]).map((l) => [l.qtyOrdered, l.uom, l.resolvedUnitPricePesewas, l.finalLineTotalPesewas]);
    expect(lines).toEqual([
      ['1.000', 'CRATE', 6_000, 6_000],
      ['3.000', 'EGG', 220, 660],
      ['2.000', 'CRATE', 6_000, 12_000],
    ]);
    // Derived independently: the eggs issued in eggs, the cash taken, and the sale's credit to egg sales.
    const issued = await one<{ qty: string }>('SELECT sum(qty_base)::text AS qty FROM inv.stock_movement WHERE source_document_id = $1 AND product_id = $2', [saleId, id('EGG-0003')]);
    expect(Number(issued.qty)).toBe(1 * perCrate + 3 + 2 * perCrate);
    expect(await one('SELECT amount_pesewas::int AS amount FROM pay.payment WHERE order_document_id = $1', [saleId])).toEqual({ amount: 18_660 });
    const receipt = sold.body.receipt.id as string;
    expect(await balance('4020', receipt)).toBe(-18_660);
    expect(await balance('1200', receipt)).toBe(18_660);
    // The cost of sales carries exactly what the issues carried from the lot's pool.
    const cost = await one<{ v: string }>('SELECT sum(value_pesewas)::text AS v FROM inv.stock_movement WHERE source_document_id = $1', [saleId]);
    expect(await balance('5020', saleId) + (await balance('5020', receipt))).toBe(Number(cost.v));
  });

  it('refuses a unit the product is not sold by at the till, recording nothing: never priced from another unit', async () => {
    const before = await footprint();
    const refusals: [Record<string, unknown>, string][] = [
      // Cabbage converts from a crate of 24 (B06u), but no list in force prices a crate of cabbage.
      [{ productId: id('PRD-0002'), quantity: '1.000', uom: 'CRATE', agreedUnitPricePesewas: 24_000 }, '/lines/1/uom'],
      [{ productId: id('EGG-0003'), quantity: '1.000', uom: 'KG', agreedUnitPricePesewas: 6_000 }, '/lines/1/uom'],
      [{ productId: id('PRD-0005'), quantity: '1.000', uom: 'CRATE', agreedUnitPricePesewas: 2_000 }, '/lines/1/uom'],
    ];
    for (const [line, field] of refusals) {
      const refused = await sell({ lines: [{ productId: id('EGG-0003'), quantity: '1.000', uom: 'EGG', agreedUnitPricePesewas: 220 }, line], tenders: [cash(220 + (line['agreedUnitPricePesewas'] as number))] });
      expect([refused.status, refused.body.error?.code], JSON.stringify(refused.body)).toEqual([400, 'VALIDATION_FAILED']);
      expect(refused.body.error.details).toEqual([expect.objectContaining({ field, code: 'UNIT_NOT_SOLD' })]);
    }
    const malformed = await sell({ lines: [{ productId: id('EGG-0003'), quantity: '1.000', uom: 'crate', agreedUnitPricePesewas: 6_000 }], tenders: [cash(6_000)] });
    expect([malformed.status, malformed.body.error?.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(await footprint()).toEqual(before);
  });
});
