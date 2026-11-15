import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { sqlStateOf, SQLSTATE } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Goods receipts over the seeded farm (FR-INV-005, FR-INV-009, ADR-0035): every write refuses the wrong role and a
 * storekeeper outside the receiving location; a posted receipt writes its movements at the exact value, registers
 * its stock units and is frozen, in the handler and in the database; the rules of a line refuse what they name.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let accountant: TestSession;
let coldStorekeeper: TestSession;
let pensStorekeeper: TestSession;
let cashier: TestSession;
let sales: TestSession;
let driver: TestSession;
let farmHand: TestSession;
const ids = new Map<string, string>();

const id = (code: string) => ids.get(code)!;
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const patch = (session: TestSession, path: string, body: object, key: string = randomUUID()) =>
  request(api.server).patch(`/v1${path}`).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');
const receivedAt = () => new Date(clock.now().getTime() - 3_600_000).toISOString();

function broilers(qty = '20.000', valuePesewas = 110_000, batchNo = `BR-${randomUUID().slice(0, 8)}`) {
  return {
    kind: 'PURCHASE',
    supplierId: id('supplier:Awutu Poultry Farm (SEED)'),
    locationId: id('location:PENS'),
    deliveryNoteRef: `APF-${randomUUID().slice(0, 6)}`,
    receivedAt: receivedAt(),
    lines: [{ productId: id('product:LIV-BROILER'), qtyReceived: qty, valuePesewas, batchNo }],
  };
}

async function movementsOf(receiptId: string) {
  return (
    await admin().query<{ movement_type: string; qty_base: string; value_pesewas: string; stock_unit_id: string | null; to_location_id: string }>(
      'SELECT movement_type, qty_base, value_pesewas, stock_unit_id, to_location_id FROM inv.stock_movement WHERE source_document_id = $1 ORDER BY recorded_at, id',
      [receiptId],
    )
  ).rows;
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
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  coldStorekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:COLD') }] }));
  pensStorekeeper = await login(api.server, await createUser(database, { name: 'Kwesi Ofori', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:PENS') }] }));
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: id('location:SHOP') }] }));
  sales = await login(api.server, await createUser(database, { name: 'Esi Appiah', grants: [{ role: 'SALES', branchId }] }));
  driver = await login(api.server, await createUser(database, { name: 'Selorm Agbeko', grants: [{ role: 'DRIVER', branchId }] }));
  farmHand = await login(api.server, await createUser(database, { name: 'Abdul-Rahman Iddrisu', grants: [{ role: 'FARM_HAND', branchId, locationId: id('location:PENS') }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('wrong roles are refused on every goods receipt write (ADR-0035)', () => {
  let draftId: string;
  beforeAll(async () => {
    const created = await post(pensStorekeeper, '/goods-receipts', broilers());
    expect(created.status).toBe(201);
    draftId = created.body.id as string;
  });

  const roles = () => ({ accountant, cashier, sales, driver, farmHand }) as Record<string, TestSession>;
  const writes: ReadonlyArray<readonly [string, 'POST' | 'PATCH', () => string, () => object]> = [
    ['createGoodsReceipt', 'POST', () => '/goods-receipts', () => broilers()],
    ['updateGoodsReceipt', 'PATCH', () => `/goods-receipts/${draftId}`, () => ({ version: 1, notes: 'Refused' })],
    ['postGoodsReceipt', 'POST', () => `/goods-receipts/${draftId}/post`, () => ({})],
    ['cancelGoodsReceipt', 'POST', () => `/goods-receipts/${draftId}/cancel`, () => ({ reason: 'Refused' })],
  ];

  it.each(writes)('%s: the Accountant, Cashier, Sales, Driver and Farm hand are refused with 403 FORBIDDEN, and each refusal is audited', async (_op, method, path, body) => {
    const count = async () => (await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'")).rows[0]!.n;
    const before = await count();
    for (const [role, session] of Object.entries(roles())) {
      const response = method === 'POST' ? await post(session, path(), body()) : await patch(session, path(), body());
      expect(response.status, role).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    }
    expect((await count()) - before).toBe(5);
    expect((await get(manager, `/goods-receipts/${draftId}`)).body).toMatchObject({ status: 'DRAFT', version: 1 });
  });

  it('a storekeeper granted at the cold room cannot draft, change, post or cancel a receipt into the pens', async () => {
    expect((await post(coldStorekeeper, '/goods-receipts', broilers())).status).toBe(403);
    expect((await patch(coldStorekeeper, `/goods-receipts/${draftId}`, { version: 1, notes: 'Not mine' })).status).toBe(403);
    expect((await post(coldStorekeeper, `/goods-receipts/${draftId}/post`)).status).toBe(403);
    expect((await post(coldStorekeeper, `/goods-receipts/${draftId}/cancel`, { reason: 'Not mine' })).status).toBe(403);
    expect(await movementsOf(draftId)).toEqual([]);
  });

  it('reads are refused to the Cashier, Sales and Driver, and the cold room storekeeper does not see the pens receipt', async () => {
    for (const session of [cashier, sales, driver]) {
      expect((await get(session, '/goods-receipts')).status).toBe(403);
    }
    expect((await get(coldStorekeeper, `/goods-receipts/${draftId}`)).status).toBe(403);
    const listed = await get(coldStorekeeper, '/goods-receipts?status=DRAFT');
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((r: { id: string }) => r.id)).not.toContain(draftId);
    expect((await get(accountant, `/goods-receipts/${draftId}`)).status).toBe(200);
  });
});

describe('posting a goods receipt (FR-INV-009)', () => {
  it('receives 20 broilers at 5,500 pesewas each as one lot of 20 valued exactly 110,000, and freezes the receipt', async () => {
    const created = await post(pensStorekeeper, '/goods-receipts', broilers('20.000', 110_000, 'BR-TEST-0001'));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'DRAFT', receiptNo: null, totalValuePesewas: 110_000, currency: 'GHS', kind: 'PURCHASE' });
    const posted = await post(pensStorekeeper, `/goods-receipts/${created.body.id}/post`);
    expect(posted.status).toBe(200);
    expect(posted.body).toMatchObject({ status: 'POSTED', postedBy: { displayName: 'Kwesi Ofori' } });
    expect(posted.body.lines[0]).toMatchObject({ qtyReceived: '20.000', valuePesewas: 110_000, uom: 'HEAD', stockUnit: { identifier: 'BR-TEST-0001', tracking: 'LOT' } });
    const movements = await movementsOf(created.body.id as string);
    expect(movements).toEqual([{ movement_type: 'RECEIPT_PURCHASE', qty_base: '20.000', value_pesewas: '110000', stock_unit_id: posted.body.lines[0].stockUnit.id, to_location_id: id('location:PENS') }]);
    const pool = await admin().query('SELECT qty, value_pesewas FROM inv.cost_pool WHERE stock_unit_id = $1', [posted.body.lines[0].stockUnit.id]);
    expect(pool.rows).toEqual([{ qty: '20.000', value_pesewas: '110000' }]);

    const edit = await patch(pensStorekeeper, `/goods-receipts/${created.body.id}`, { version: posted.body.version, notes: 'Too late' });
    expect(edit.status).toBe(422);
    expect(edit.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect((await post(pensStorekeeper, `/goods-receipts/${created.body.id}/post`)).body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await sqlStateOf(database.pool('app').query("UPDATE inv.goods_receipt SET notes = 'edited' WHERE id = $1", [created.body.id]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(database.pool('app').query("UPDATE inv.goods_receipt_line SET value_pesewas = 1 WHERE goods_receipt_id = $1", [created.body.id]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(database.pool('app').query('DELETE FROM inv.goods_receipt WHERE id = $1', [created.body.id]))).toBe(SQLSTATE.insufficientPrivilege);
  });

  it('splits four goats bought for 100,001 pesewas as 25,001, 25,000, 25,000 and 25,000, one stock unit and one movement each', async () => {
    const tags = ['G-0901', 'G-0902', 'G-0903', 'G-0904'];
    const created = await post(manager, '/goods-receipts', {
      kind: 'PURCHASE',
      supplierId: id('supplier:Kpone Livestock Traders (SEED)'),
      locationId: id('location:PENS'),
      receivedAt: receivedAt(),
      lines: [{ productId: id('product:LIV-GOAT'), qtyReceived: '4.000', valuePesewas: 100_001, animals: tags.map((tagNo) => ({ tagNo, sex: 'FEMALE', weightKg: '24.350', weightSource: 'SCALE' })) }],
    });
    expect(created.status).toBe(201);
    const posted = await post(manager, `/goods-receipts/${created.body.id}/post`);
    expect(posted.status).toBe(200);
    const animals = posted.body.lines[0].animals as Array<{ tagNo: string; stockUnitId: string; purpose: string }>;
    expect(animals.map((a) => a.tagNo)).toEqual(tags);
    expect(animals.every((a) => a.purpose === 'GROWING' && a.stockUnitId !== null)).toBe(true);
    const values = await admin().query<{ identifier: string; value_pesewas: string; current_location_id: string; last_weight_kg: string; supplier_id: string }>(
      `SELECT u.identifier, c.value_pesewas, u.current_location_id, u.last_weight_kg, u.supplier_id FROM inv.stock_unit u JOIN inv.cost_pool c ON c.stock_unit_id = u.id
        WHERE u.identifier = ANY($1) ORDER BY u.identifier`,
      [tags],
    );
    expect(values.rows.map((r) => r.value_pesewas)).toEqual(['25001', '25000', '25000', '25000']);
    expect(values.rows.every((r) => r.current_location_id === id('location:PENS') && r.last_weight_kg === '24.350' && r.supplier_id === id('supplier:Kpone Livestock Traders (SEED)'))).toBe(true);
    expect(await movementsOf(created.body.id as string)).toHaveLength(4);
    const events = await admin().query<{ event_type: string; n: number }>(
      `SELECT event_type, count(*)::int AS n FROM platform.outbox_message WHERE payload->>'sourceDocumentId' = $1 GROUP BY event_type ORDER BY event_type`,
      [created.body.id],
    );
    expect(events.rows).toEqual([
      { event_type: 'inv.GoodsReceived', n: 4 },
      { event_type: 'inv.StockUnitRegistered', n: 4 },
    ]);
    const audit = await admin().query("SELECT 1 FROM platform.audit_event WHERE entity_type = 'GoodsReceipt' AND entity_id = $1 AND action = 'POST'", [created.body.id]);
    expect(audit.rows).toHaveLength(1);

    // The same tags again: refused at posting, because those animals are already on the farm.
    const second = await post(manager, '/goods-receipts', {
      kind: 'PURCHASE',
      supplierId: id('supplier:Kpone Livestock Traders (SEED)'),
      locationId: id('location:PENS'),
      receivedAt: receivedAt(),
      lines: [{ productId: id('product:LIV-GOAT'), qtyReceived: '1.000', valuePesewas: 60_000, animals: [{ tagNo: 'G-0902', sex: 'MALE' }] }],
    });
    const refused = await post(manager, `/goods-receipts/${second.body.id}/post`);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'GOODS_RECEIPT_INVALID', details: [{ field: '/lines/0/animals/0/tagNo', code: 'TAG_IN_USE' }] });
  });

  it('replays a post with the same key, writing its movements once', async () => {
    const created = await post(pensStorekeeper, '/goods-receipts', broilers('5.000', 27_500));
    const key = randomUUID();
    const first = await post(pensStorekeeper, `/goods-receipts/${created.body.id}/post`, {}, key);
    const replay = await post(pensStorekeeper, `/goods-receipts/${created.body.id}/post`, {}, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(await movementsOf(created.body.id as string)).toHaveLength(1);
  });

  it('cancels only a draft, with a reason, and a cancelled receipt cannot be posted', async () => {
    const created = await post(pensStorekeeper, '/goods-receipts', broilers());
    expect((await post(pensStorekeeper, `/goods-receipts/${created.body.id}/cancel`, {})).status).toBe(400);
    const cancelled = await post(pensStorekeeper, `/goods-receipts/${created.body.id}/cancel`, { reason: 'Delivery turned back at the gate' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect((await post(pensStorekeeper, `/goods-receipts/${created.body.id}/post`)).body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await movementsOf(created.body.id as string)).toEqual([]);
  });

  it('changes a draft only at the version read, replacing its lines', async () => {
    const created = await post(pensStorekeeper, '/goods-receipts', broilers());
    const stale = await patch(pensStorekeeper, `/goods-receipts/${created.body.id}`, { version: 7, notes: 'Stale' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const changed = await patch(pensStorekeeper, `/goods-receipts/${created.body.id}`, {
      version: 1,
      notes: 'Two birds died on the road',
      lines: [{ productId: id('product:LIV-BROILER'), qtyReceived: '18.000', qtyRejected: '2.000', valuePesewas: 99_000, batchNo: 'BR-TEST-0018' }],
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ version: 2, notes: 'Two birds died on the road', totalValuePesewas: 99_000 });
    expect(changed.body.lines).toHaveLength(1);
    expect(changed.body.lines[0]).toMatchObject({ qtyReceived: '18.000', qtyRejected: '2.000', batchNo: 'BR-TEST-0018' });
  });
});

describe('receipt rules (FR-INV-005, FR-INV-009)', () => {
  const beef = (expiresOn: string | undefined, batchNo = 'LOT-BEEF-2026-1113') => ({
    kind: 'PURCHASE',
    supplierId: id('supplier:Ashaiman Cold Store Ltd (SEED)'),
    locationId: id('location:COLD'),
    receivedAt: new Date('2026-11-13T08:00:00Z').toISOString(),
    lines: [{ productId: id('product:MEAT-BEEF-15KG'), qtyReceived: '15.000', weightKg: '15.000', weightSource: 'SCALE', valuePesewas: 180_000, batchNo, expiresOn }],
  });

  it('accepts beef lot LOT-BEEF-2026-1113 expiring 20 November, and refuses one expiring 12 November or none', async () => {
    const accepted = await post(coldStorekeeper, '/goods-receipts', beef('2026-11-20'));
    expect(accepted.status).toBe(201);
    const early = await post(coldStorekeeper, '/goods-receipts', beef('2026-11-12'));
    expect(early.status).toBe(422);
    expect(early.body.error).toMatchObject({ code: 'GOODS_RECEIPT_INVALID', details: [{ field: '/lines/0/expiresOn', code: 'EXPIRED_ON_ARRIVAL' }] });
    const missing = await post(coldStorekeeper, '/goods-receipts', beef(undefined));
    expect(missing.body.error.details).toEqual([expect.objectContaining({ field: '/lines/0/expiresOn', code: 'EXPIRY_REQUIRED' })]);
    expect((await post(coldStorekeeper, `/goods-receipts/${accepted.body.id}/post`)).status).toBe(200);
    // A second lot with the same batch number while the first is in stock: refused at posting.
    const duplicate = await post(coldStorekeeper, '/goods-receipts', beef('2026-11-20'));
    const refused = await post(coldStorekeeper, `/goods-receipts/${duplicate.body.id}/post`);
    expect(refused.body.error).toMatchObject({ code: 'GOODS_RECEIPT_INVALID', details: [{ field: '/lines/0/batchNo', code: 'BATCH_IN_USE' }] });
  });

  it('needs a supplier on a purchase and none on a harvest, a physical receiving location, and refuses an opening balance', async () => {
    const noSupplier = await post(manager, '/goods-receipts', { ...broilers(), supplierId: undefined });
    expect(noSupplier.body.error.details).toEqual([expect.objectContaining({ field: '/supplierId', code: 'SUPPLIER_REQUIRED' })]);
    const harvestWithSupplier = await post(manager, '/goods-receipts', { ...broilers(), kind: 'HARVEST' });
    expect(harvestWithSupplier.body.error.details).toEqual([expect.objectContaining({ field: '/supplierId', code: 'NOT_FOR_THIS_KIND' })]);
    const site = await post(manager, '/goods-receipts', { ...broilers(), locationId: id('location:SITE') });
    expect(site.body.error.details).toEqual([expect.objectContaining({ field: '/locationId', code: 'NOT_A_RECEIVING_LOCATION' })]);
    const virtual = await post(manager, '/goods-receipts', { ...broilers(), locationId: id('location:V-SUPPLIER') });
    expect(virtual.body.error.code).toBe('GOODS_RECEIPT_INVALID');
    const opening = await post(manager, '/goods-receipts', { ...broilers(), kind: 'OPENING', supplierId: undefined });
    expect(opening.body.error.details).toEqual([expect.objectContaining({ field: '/kind', code: 'OPENING_NOT_AVAILABLE' })]);
    const unknown = await post(manager, '/goods-receipts', { ...broilers(), purchaseOrderId: randomUUID() });
    expect(unknown.body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/purchaseOrderId' }] });
    const future = await post(manager, '/goods-receipts', { ...broilers(), receivedAt: new Date(clock.now().getTime() + 86_400_000).toISOString() });
    expect(future.body.error.details).toEqual([expect.objectContaining({ field: '/receivedAt', code: 'IN_THE_FUTURE' })]);
  });

  it('needs one tagged animal per head of a serialised product, and no batch on an untracked one', async () => {
    const goats = await post(manager, '/goods-receipts', {
      kind: 'PURCHASE',
      supplierId: id('supplier:Kpone Livestock Traders (SEED)'),
      locationId: id('location:PENS'),
      receivedAt: receivedAt(),
      lines: [{ productId: id('product:LIV-GOAT'), qtyReceived: '2.000', valuePesewas: 120_000, animals: [{ tagNo: 'G-0999', sex: 'MALE' }] }],
    });
    expect(goats.body.error.details).toEqual([expect.objectContaining({ field: '/lines/0/animals', code: 'ONE_ANIMAL_PER_HEAD' })]);
    const yam = await post(manager, '/goods-receipts', {
      kind: 'HARVEST',
      locationId: id('location:SHOP'),
      receivedAt: receivedAt(),
      lines: [{ productId: id('product:PRD-YAM-TUBER'), qtyReceived: '10.000', valuePesewas: 12_000, batchNo: 'YAM-1' }],
    });
    expect(yam.body.error.details).toEqual([expect.objectContaining({ field: '/lines/0/batchNo', code: 'PRODUCT_NOT_TRACKED' })]);
    const unknownProduct = await post(manager, '/goods-receipts', { ...broilers(), lines: [{ productId: randomUUID(), qtyReceived: '1.000', valuePesewas: 1 }] });
    expect(unknownProduct.body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/lines/0/productId' }] });
  });
});
