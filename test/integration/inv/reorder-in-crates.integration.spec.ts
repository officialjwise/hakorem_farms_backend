import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Reorder points in the selling unit (B09e continued, the rest of the owner's decision 6 of 2026-11-17): a reorder
 * rule's minimum, reorder point and maximum are entered in crates (a reorder point of 30 crates) and stored in eggs,
 * converted by the server through MasterDataRefs.toBaseIn and checked again by the database; the rule answers in both,
 * and so do its alerts and the suggested reorder: whole crates and the eggs left over, never a rounded part of a crate,
 * and the suggestion in whole crates rounded up so the order reaches the maximum. Every write refuses the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let storekeeper: TestSession;
let cashier: TestSession;
const ids = new Map<string, string>();

const id = (code: string) => ids.get(code)!;
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const patch = (session: TestSession, path: string, body: object, key: string = randomUUID()) =>
  request(api.server).patch(`/v1${path}`).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');

async function alertsOf(sku: string) {
  const page = await get(storekeeper, `/stock/alerts?limit=100`);
  expect(page.status).toBe(200);
  return (page.body.data as Array<Record<string, unknown> & { product: { sku: string }; kind: string }>).filter((a) => a.product.sku === sku).sort((a, b) => (a.kind < b.kind ? -1 : 1));
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  storekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId }] }));
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId }] }));
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('the seeded big eggs reorder in crates (A-261)', () => {
  it('holds the rule as 20, 30 and 80 crates, stored as 600, 900 and 2,400 eggs', async () => {
    const rules = (await get(storekeeper, `/reorder-rules?productId=${id('product:EGG-0003')}`)).body.data;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ uom: 'CRATE', minQty: '20.000', reorderPointQty: '30.000', maxQty: '80.000', baseUom: 'UNIT', minQtyBase: '600.000', reorderPointQtyBase: '900.000', maxQtyBase: '2400.000' });
  });

  it('opens the farm with one low-stock alert at 30 crates, suggesting 50 crates (1,500 eggs) to reach the maximum', async () => {
    const [low] = await alertsOf('EGG-0003');
    expect(low).toMatchObject({
      kind: 'LOW_STOCK',
      uom: 'UNIT',
      onHandQty: '900.000',
      thresholdQty: '900.000',
      suggestedQty: '1500.000',
      inRuleUnit: { uom: 'CRATE', onHandQty: '30.000', onHandLooseQty: '0.000', thresholdQty: '30.000', suggestedQty: '50.000' },
    });
  });
});

describe('a reorder rule entered in crates (decision 6)', () => {
  let ruleId: string;

  it('takes a reorder point of 30 crates, stores 900 eggs, and alerts in both units at once on nothing in stock', async () => {
    const created = await post(storekeeper, '/reorder-rules', { productId: id('product:EGG-0002'), branchId: id('branch:DDW'), uom: 'CRATE', minQty: '20.000', reorderPointQty: '30.000', maxQty: '80.000' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    ruleId = created.body.id as string;
    expect(created.body).toMatchObject({ uom: 'CRATE', minQty: '20.000', reorderPointQty: '30.000', maxQty: '80.000', baseUom: 'UNIT', minQtyBase: '600.000', reorderPointQtyBase: '900.000', maxQtyBase: '2400.000' });
    const stored = (await admin().query('SELECT min_qty::text, reorder_point_qty::text, max_qty::text, uom, min_qty_uom::text, reorder_point_qty_uom::text, max_qty_uom::text FROM inv.reorder_rule WHERE id = $1', [ruleId])).rows;
    expect(stored).toEqual([{ min_qty: '600.000', reorder_point_qty: '900.000', max_qty: '2400.000', uom: 'CRATE', min_qty_uom: '20.000', reorder_point_qty_uom: '30.000', max_qty_uom: '80.000' }]);
    const [below, low] = await alertsOf('EGG-0002');
    expect(below).toMatchObject({ kind: 'BELOW_MINIMUM', onHandQty: '0.000', thresholdQty: '600.000', suggestedQty: '2400.000', inRuleUnit: { uom: 'CRATE', onHandQty: '0.000', onHandLooseQty: '0.000', thresholdQty: '20.000', suggestedQty: '80.000' } });
    expect(low).toMatchObject({ kind: 'LOW_STOCK', thresholdQty: '900.000', inRuleUnit: { thresholdQty: '30.000', suggestedQty: '80.000' } });
  });

  it('counts 10 crates and 5 eggs on hand as 305 eggs, and suggests 70 whole crates for the 2,095 eggs short', async () => {
    const draft = await post(storekeeper, '/goods-receipts', {
      kind: 'PURCHASE',
      supplierId: id('supplier:Awutu Poultry Farm (SEED)'),
      locationId: id('location:SHOP'),
      deliveryNoteRef: `APF-${randomUUID().slice(0, 6)}`,
      receivedAt: new Date(clock.now().getTime() - 3_600_000).toISOString(),
      lines: [
        { productId: id('product:EGG-0002'), uom: 'CRATE', qtyReceived: '10.000', valuePesewas: 36_000, batchNo: 'EGG-SMALL-R1', expiresOn: toBusinessDate(new Date(clock.now().getTime() + 14 * 86_400_000)) },
        { productId: id('product:EGG-0002'), qtyReceived: '5.000', valuePesewas: 600, batchNo: 'EGG-SMALL-R2', expiresOn: toBusinessDate(new Date(clock.now().getTime() + 14 * 86_400_000)) },
      ],
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect((await post(storekeeper, `/goods-receipts/${draft.body.id as string}/post`)).status).toBe(200);
    const [below, low] = await alertsOf('EGG-0002');
    expect(below).toMatchObject({ kind: 'BELOW_MINIMUM', onHandQty: '305.000', suggestedQty: '2095.000', inRuleUnit: { uom: 'CRATE', onHandQty: '10.000', onHandLooseQty: '5.000', thresholdQty: '20.000', suggestedQty: '70.000' } });
    expect(low).toMatchObject({ kind: 'LOW_STOCK', onHandQty: '305.000', inRuleUnit: { onHandQty: '10.000', onHandLooseQty: '5.000' } });
  });

  it('changes a level in the rule\'s own unit: a reorder point of 40 crates is 1,200 eggs', async () => {
    const rule = (await get(storekeeper, `/reorder-rules?productId=${id('product:EGG-0002')}`)).body.data[0];
    const changed = await patch(storekeeper, `/reorder-rules/${ruleId}`, { version: rule.version, reorderPointQty: '40.000' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ uom: 'CRATE', minQty: '20.000', reorderPointQty: '40.000', maxQty: '80.000', reorderPointQtyBase: '1200.000' });
  });

  it('refuses a unit the eggs are not counted in, and the database refuses a level that is not its crates times 30', async () => {
    const refused = await post(storekeeper, '/reorder-rules', { productId: id('product:EGG-0001'), branchId: id('branch:DDW'), uom: 'BAG', minQty: '1.000', reorderPointQty: '2.000', maxQty: '3.000' });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'REORDER_RULE_INVALID', details: [{ field: '/uom', code: 'NO_CONVERSION' }] });
    const tamper = (sql: string) => sqlStateOf(database.pool('app').query(sql, [ruleId]));
    expect(await tamper('UPDATE inv.reorder_rule SET min_qty = 601 WHERE id = $1')).toBe('HK010');
    expect(await tamper('UPDATE inv.reorder_rule SET uom = NULL, min_qty_uom = NULL, reorder_point_qty_uom = NULL, max_qty_uom = NULL WHERE id = $1')).toBe('HK010');
    const unitless = sqlStateOf(
      database.pool('app').query(
        `INSERT INTO inv.reorder_rule (id, product_id, branch_id, min_qty, reorder_point_qty, max_qty, min_qty_uom, created_by, updated_by)
         SELECT $1, $2, $3, 30, 60, 90, 1, created_by, created_by FROM inv.reorder_rule WHERE id = $4`,
        [randomUUID(), id('product:EGG-0001'), id('branch:DDW'), ruleId],
      ),
    );
    expect(await unitless).toBe(SQLSTATE.checkViolation);
  });
});

describe('every reorder rule write in crates refuses the wrong role (ADR-0035)', () => {
  it('the Cashier is refused creating and changing a rule in crates with 403, and nothing changes', async () => {
    const before = (await admin().query('SELECT version, reorder_point_qty::text FROM inv.reorder_rule WHERE product_id = $1', [id('product:EGG-0002')])).rows;
    const created = await post(cashier, '/reorder-rules', { productId: id('product:EGG-0001'), branchId: id('branch:DDW'), uom: 'CRATE', minQty: '1.000', reorderPointQty: '2.000', maxQty: '3.000' });
    expect(created.status).toBe(403);
    expect(created.body.error.code).toBe('FORBIDDEN');
    const rule = (await get(storekeeper, `/reorder-rules?productId=${id('product:EGG-0002')}`)).body.data[0];
    expect((await patch(cashier, `/reorder-rules/${rule.id as string}`, { version: rule.version, reorderPointQty: '45.000' })).status).toBe(403);
    expect((await admin().query('SELECT count(*)::int AS n FROM inv.reorder_rule WHERE product_id = $1', [id('product:EGG-0001')])).rows[0]!.n).toBe(0);
    expect((await admin().query('SELECT version, reorder_point_qty::text FROM inv.reorder_rule WHERE product_id = $1', [id('product:EGG-0002')])).rows).toEqual(before);
  });
});
