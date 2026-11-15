import { randomUUID } from 'node:crypto';
import { ManualClock, Quantity } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stock } from '../../../src/modules/inv';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { DocumentRegistry } from '../../../src/platform/documents/document-registry';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The B06 continued gate (FR-LIV-001, FR-LIV-004, FR-LIV-007 to FR-LIV-009, FR-LIV-012, FR-LIV-014, FR-LIV-015,
 * FR-LIV-017; ADR-0018, ADR-0019; threat model abuse case 2), over the real API on the seeded farm: every LIV write
 * refuses the wrong role; a withdrawal hold blocks sale and processing and nobody releases it early; mortality at or
 * above the threshold waits for a photograph and a different approver; feed and veterinary cost spread by head-days
 * sum exactly to the value issued. Feed, medicine, a store and two pens are arranged here through MDM and INV's API.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let secondManager: TestSession;
let storekeeper: TestSession;
let farmHand: TestSession;
let accountant: TestSession;
const wrong = new Map<string, TestSession>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const v1 = (path: string) => `/v1${path}`;
const post = (session: TestSession, path: string, body: object = {}, key?: string) => consolePost(api.server, session, v1(path), key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, v1(path));
const patch = (session: TestSession, path: string, body: object) =>
  request(api.server).patch(v1(path)).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send(body);
const admin = () => database.pool('admin');
const poolOf = async (unit: string) =>
  (await admin().query<{ value: string }>('SELECT value_pesewas::text AS value FROM inv.cost_pool WHERE stock_unit_id = $1', [id(`unit:${unit}`)])).rows[0]?.value;
const statusOf = async (unit: string) => (await admin().query<{ status: string }>('SELECT status FROM liv.animal WHERE stock_unit_id = $1', [id(`unit:${unit}`)])).rows[0]?.status;
const hoursAgo = (hours: number) => new Date(clock.now().getTime() - hours * 3_600_000).toISOString();

async function refresh(): Promise<void> {
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'species:' || code, id FROM mdm.species
       UNION ALL SELECT 'supplier:' || supplier_no, id FROM mdm.supplier
       UNION ALL SELECT 'unit:' || identifier, id FROM inv.stock_unit`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
}

/** A sale of one animal from where it stands, as the counter will post it (B9b), through INV's `Stock.postIn`. */
async function sell(tag: string, from = 'location:PENS'): Promise<string> {
  return runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Sale test' }, randomUUID(), () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable' }, async (tx) => {
      const documentId = randomUUID();
      await api.app.get(DocumentRegistry).register(tx, { id: documentId, docType: 'STOCK_ADJUSTMENT', ownerModule: 'inv', branchId: id('branch:DDW'), actorId: SYSTEM_PRINCIPAL });
      const posted = await api.app.get(Stock).postIn(tx, SYSTEM_PRINCIPAL, {
        movementType: 'SALE_ISSUE',
        productId: id('product:LIV-GOAT'),
        stockUnitId: id(`unit:${tag}`),
        branchId: id('branch:DDW'),
        fromLocationId: id(from),
        toLocationId: id('virtual:CUSTOMER'),
        qty: Quantity.parse('1.000'),
        sourceDocumentId: documentId,
        occurredAt: clock.now(),
      });
      return posted.id;
    }),
  ).catch((error: unknown) => (error as { code?: string }).code ?? String(error));
}

async function receive(locationCode: string, lines: object[]): Promise<void> {
  const created = await post(manager, '/goods-receipts', {
    kind: 'PURCHASE',
    supplierId: [...ids.entries()].find(([code]) => code.startsWith('supplier:'))![1],
    locationId: id(`location:${locationCode}`),
    deliveryNoteRef: `LIV-TEST-${randomUUID().slice(0, 8)}`,
    receivedAt: hoursAgo(2),
    lines,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const posted = await post(manager, `/goods-receipts/${created.body.id as string}/post`);
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  await refresh();
}

async function evidence(session: TestSession, name: string): Promise<string> {
  const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1_020, 9)]);
  const uploaded = await consolePost(api.server, session, '/v1/files').field('purpose', 'EVIDENCE').attach('file', photo, name);
  expect(uploaded.status).toBe(201);
  // The scanner's verdict, as the worker records it (hk_worker is the only role that may).
  await database.pool('worker').query("UPDATE platform.stored_file SET scan_status = 'CLEAN', scanned_at = now(), version = version + 1 WHERE id = $1", [uploaded.body.id]);
  return uploaded.body.id as string;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  await refresh();
  for (const row of (await admin().query<{ kind: string; id: string }>("SELECT l.kind, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.is_virtual")).rows) {
    ids.set(`virtual:${row.kind}`, row.id);
  }
  const branchId = id('branch:DDW');
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  secondManager = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Darko', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  storekeeper = await login(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'STOREKEEPER', branchId }] }));
  farmHand = await login(api.server, await createUser(database, { name: 'Abena Quaye', grants: [{ role: 'FARM_HAND', branchId }] }));
  for (const role of ['CASHIER', 'SALES', 'DRIVER', 'INVESTOR'] as const satisfies readonly RoleCode[]) {
    wrong.set(role, await login(api.server, await createUser(database, { name: `Wrong ${role.toLowerCase()}`, grants: [{ role, branchId }] })));
  }

  // Feed and medicine and two more pens, through MDM; then their stock, through INV.
  // The seed's feed and medicine category and its store (B06 continued 2); this test's own products keep their own pools.
  const categoryId = (await admin().query<{ id: string }>("SELECT id FROM mdm.category WHERE code = 'FEED-MED'")).rows[0]!.id;
  const product = (sku: string, name: string, baseUom: string, extra: object = {}) =>
    post(manager, '/products', { sku, name, categoryId, stockPolicy: 'COUNTABLE', baseUom, saleUom: baseUom, onlineMode: 'HIDDEN', isSellable: false, ...extra });
  expect((await product('FEED-GROWER-KG', 'Broiler grower pellets, per kg', 'KG')).status).toBe(201);
  expect((await product('MED-OXYTET-L', 'Oxytetracycline 20% injection, per litre', 'LITRE', { withdrawalDays: 28 })).status).toBe(201);
  for (const [code, name, kind] of [
    ['PEN-T', 'Treatment pen', 'PEN'],
    ['PEN-F', 'Broiler house 2', 'PEN'],
  ] as const) {
    const location = await post(manager, '/locations', { branchId, code, name, kind });
    expect(location.status, JSON.stringify(location.body)).toBe(201);
  }
  await refresh();
  // 20.000 kg of feed at GHS 200.02, so 10.000 kg issues at half_up(20,002 x 10 / 20) = 10,001; a litre of medicine at GHS 300.
  await receive('STORE', [
    { productId: id('product:FEED-GROWER-KG'), qtyReceived: '20.000', valuePesewas: 20_002 },
    { productId: id('product:MED-OXYTET-L'), qtyReceived: '1.000', valuePesewas: 30_000 },
  ]);
  // Three goats in the treatment pen at 50,000 each, the third a breeding doe; three flocks of 10, 10 and 5 broilers.
  await receive('PEN-T', [
    {
      productId: id('product:LIV-GOAT'),
      qtyReceived: '3.000',
      valuePesewas: 150_000,
      animals: [
        { tagNo: 'T-0201', sex: 'MALE', breed: 'West African Dwarf', purpose: 'GROWING' },
        { tagNo: 'T-0202', sex: 'MALE', breed: 'West African Dwarf', purpose: 'GROWING' },
        { tagNo: 'T-0203', sex: 'FEMALE', breed: 'West African Dwarf', purpose: 'BREEDING' },
      ],
    },
  ]);
  await receive('PEN-F', [
    { productId: id('product:LIV-BROILER'), qtyReceived: '10.000', valuePesewas: 50_000, batchNo: 'BRF-A' },
    { productId: id('product:LIV-BROILER'), qtyReceived: '10.000', valuePesewas: 50_000, batchNo: 'BRF-B' },
    { productId: id('product:LIV-BROILER'), qtyReceived: '5.000', valuePesewas: 25_000, batchNo: 'BRF-C' },
  ]);
  // A kid at 12,000 and a doe at 62,500, for the mortality threshold of 50,000.
  await receive('PENS', [
    { productId: id('product:LIV-GOAT'), qtyReceived: '1.000', valuePesewas: 12_000, animals: [{ tagNo: 'K-0301', sex: 'MALE', weightKg: '8.200', weightSource: 'SCALE' }] },
    { productId: id('product:LIV-GOAT'), qtyReceived: '1.000', valuePesewas: 62_500, animals: [{ tagNo: 'D-017', sex: 'FEMALE', purpose: 'BREEDING' }] },
  ]);
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the animal register (FR-LIV-001, FR-LIV-017)', () => {
  it('opens one animal per serialised unit received, at the cost the receipt carried, with its pen and band', async () => {
    const goat = await get(manager, `/animals/${id('unit:G-0142')}`);
    expect(goat.status).toBe(200);
    expect(goat.body).toMatchObject({
      tagNo: 'G-0142',
      species: { code: 'GOAT' },
      product: { sku: 'LIV-GOAT' },
      sex: 'MALE',
      source: 'PURCHASE',
      supplier: { name: 'Kpone Livestock Traders (SEED)' },
      purpose: 'GROWING',
      status: 'ALIVE',
      currentLocation: { code: 'PENS', kind: 'PEN' },
      accumulatedCostPesewas: 60_000,
      currency: 'GHS',
      withdrawalUntil: null,
      sellable: true,
      batch: null,
      // The seed weighed it at 24.350 kg; the counter's band for that weight prices it per head.
      lastWeightKg: '24.350',
      lastWeighedAt: '2026-11-10T08:00:00.000Z',
      priceBand: expect.objectContaining({ basis: 'PER_HEAD' }),
      weightBand: expect.objectContaining({ code: expect.stringMatching(/^GOAT-/) }),
    });
    const kid = await get(manager, `/animals/${id('unit:K-0301')}`);
    expect(kid.body, JSON.stringify(kid.body)).toMatchObject({ lastWeightKg: '8.200', accumulatedCostPesewas: 12_000 });
    const page = await get(manager, '/animals?speciesId=' + id('species:GOAT') + '&limit=100');
    expect(page.body.data.map((a: { tagNo: string }) => a.tagNo).sort()).toEqual(['D-017', 'G-0142', 'G-0143', 'G-0144', 'G-0145', 'K-0301', 'T-0201', 'T-0202', 'T-0203']);
    const pen = await get(manager, `/animals?locationId=${id('location:PEN-T')}`);
    expect(pen.body.data.map((a: { tagNo: string }) => a.tagNo)).toEqual(['T-0201', 'T-0202', 'T-0203']);
  });

  it('refuses a second live animal with a tag already in the register', async () => {
    const created = await post(manager, '/goods-receipts', {
      kind: 'PURCHASE',
      supplierId: [...ids.entries()].find(([code]) => code.startsWith('supplier:'))![1],
      locationId: id('location:PENS'),
      receivedAt: hoursAgo(1),
      lines: [{ productId: id('product:LIV-SHEEP'), qtyReceived: '1.000', valuePesewas: 70_000, animals: [{ tagNo: 'G-0142', sex: 'FEMALE' }] }],
    });
    const posted = await post(manager, `/goods-receipts/${created.body.id as string}/post`);
    expect(posted.status).toBe(422);
    expect(posted.body.error).toMatchObject({ code: 'LIVESTOCK_RECORD_INVALID', details: [expect.objectContaining({ code: 'TAG_IN_USE' })] });
  });
});

describe('weights with their source (FR-LIV-004)', () => {
  const weighing = (overrides: object = {}) => ({ id: randomUUID(), stockUnitId: id('unit:G-0142'), weightKg: '18.400', weightSource: 'SCALE', measuredAt: hoursAgo(1), ...overrides });

  it('records 18.400 kg by SCALE, copies it to the unit, and counts a resubmission as a duplicate', async () => {
    const record = weighing();
    const first = await post(farmHand, '/weight-records', { records: [record] });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ accepted: 1, duplicates: 0, records: [{ id: record.id, weightKg: '18.400', weightSource: 'SCALE', headWeighed: 1, actor: { displayName: 'Abena Quaye' } }] });
    const again = await post(farmHand, '/weight-records', { records: [record] });
    expect(again.body).toMatchObject({ accepted: 0, duplicates: 1 });
    expect((await get(manager, `/animals/${id('unit:G-0142')}`)).body.lastWeightKg).toBe('18.400');
    const reused = await post(farmHand, '/weight-records', { records: [{ ...record, weightKg: '19.000' }] });
    expect(reused.body.error.details).toEqual([expect.objectContaining({ code: 'ID_REUSED' })]);
  });

  it('refuses 18.4004 kg, a negative weight and a weight with no source, and a sample larger than the flock', async () => {
    expect((await post(farmHand, '/weight-records', { records: [weighing({ weightKg: '18.4004' })] })).status).toBe(400);
    expect((await post(farmHand, '/weight-records', { records: [weighing({ weightKg: '-1.000' })] })).status).toBe(400);
    const { weightSource: _source, ...unsourced } = weighing();
    expect((await post(farmHand, '/weight-records', { records: [unsourced] })).status).toBe(400);
    const flock = await post(farmHand, '/weight-records', { records: [weighing({ stockUnitId: id('unit:BRF-C'), weightKg: '1.850', headWeighed: 6 })] });
    expect(flock.body.error.details).toEqual([expect.objectContaining({ code: 'HEAD_ABOVE_FLOCK' })]);
    const sample = await post(farmHand, '/weight-records', { records: [weighing({ stockUnitId: id('unit:BRF-C'), weightKg: '1.850', headWeighed: 5 })] });
    expect(sample.status).toBe(200);
  });
});

describe('a withdrawal hold blocks sale and processing, and nobody releases it early (FR-LIV-007, FR-LIV-008)', () => {
  let holdId: string;
  let treatedAt: Date;

  it('treats G-0143 with 0.005 l of oxytetracycline: issues it at 150 pesewas and holds the goat for 28 days', async () => {
    treatedAt = new Date(clock.now().getTime() - 27 * 86_400_000);
    const treated = await post(farmHand, '/health-events', {
      kind: 'TREATMENT',
      stockUnitId: id('unit:G-0143'),
      productId: id('product:MED-OXYTET-L'),
      dose: '5 mL intramuscular',
      qtyUsed: '0.005',
      administeredBy: 'Dr Kofi Ampofo (SEED)',
      occurredAt: treatedAt.toISOString(),
    });
    expect(treated.status, JSON.stringify(treated.body)).toBe(201);
    expect(treated.body).toMatchObject({ kind: 'TREATMENT', withdrawalDays: 28, withdrawalEndsAt: new Date(treatedAt.getTime() + 28 * 86_400_000).toISOString(), holdsPlaced: 1, costPesewas: 150 });
    expect(await poolOf('G-0143')).toBe('60150');
    const hold = await admin().query<{ id: string; kind: string; ends_at: Date }>('SELECT id, kind, ends_at FROM inv.stock_hold WHERE source_document_id = $1', [treated.body.id]);
    expect(hold.rows).toEqual([expect.objectContaining({ kind: 'WITHDRAWAL' })]);
    holdId = hold.rows[0]!.id;
    const animal = await get(manager, `/animals/${id('unit:G-0143')}`);
    expect(animal.body).toMatchObject({ sellable: false, withdrawalUntil: new Date(treatedAt.getTime() + 28 * 86_400_000).toISOString() });
  });

  it('refuses the sale of G-0143 with STOCK_UNIT_ON_HOLD, and the database refuses a direct SALE_ISSUE', async () => {
    expect(await sell('G-0143')).toBe('STOCK_UNIT_ON_HOLD');
    const client = await admin().connect();
    try {
      await client.query('BEGIN');
      const doc = randomUUID();
      await client.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'STOCK_ADJUSTMENT', 'inv', $2, $3)", [doc, id('branch:DDW'), SYSTEM_PRINCIPAL]);
      const direct = await client
        .query(
          `INSERT INTO inv.stock_movement (id, movement_type, product_id, stock_unit_id, branch_id, from_location_id, to_location_id, qty_base, source_document_id, occurred_at, actor_id)
           VALUES ($1, 'SALE_ISSUE', $2, $3, $4, $5, $6, 1, $7, now(), $8)`,
          [randomUUID(), id('product:LIV-GOAT'), id('unit:G-0143'), id('branch:DDW'), id('location:PENS'), id('virtual:CUSTOMER'), doc, SYSTEM_PRINCIPAL],
        )
        .then(
          () => null,
          (error: { constraint?: string }) => error.constraint,
        );
      expect(direct).toBe('ck_stock_on_hold');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('refuses to plan G-0143 for slaughter while the hold is in force', async () => {
    const planned = await post(manager, '/processing-orders', {
      locationId: id('location:PENS'),
      outputLocationId: id('location:COLD'),
      inputs: [{ stockUnitId: id('unit:G-0143'), weightKg: '27.000', weightSource: 'SCALE' }],
    });
    expect(planned.status).toBe(422);
    expect(planned.body.error).toMatchObject({ code: 'STOCK_UNIT_ON_HOLD', details: [expect.objectContaining({ code: 'WITHDRAWAL' })] });
  });

  it('lets neither manager release it early: WITHDRAWAL_CANNOT_BE_RELEASED', async () => {
    for (const session of [manager, secondManager]) {
      const released = await post(session, `/stock/holds/${holdId}/release`, { reasonCode: 'TEST_NEGATIVE', note: 'The vet says the goat is fine' });
      expect(released.status).toBe(422);
      expect(released.body.error.code).toBe('WITHDRAWAL_CANNOT_BE_RELEASED');
    }
  });
});

describe('veterinary and feed cost spread by head-days, exactly (FR-LIV-009, FR-LIV-015, ADR-0018)', () => {
  it('spreads a 9,001 pesewa vaccination over the treatment pen: 3,001 and 3,000 capitalised, 3,000 expensed for the doe', async () => {
    const vaccinated = await post(storekeeper, '/health-events', { kind: 'VACCINATION', locationId: id('location:PEN-T'), costPesewas: 9_001, administeredBy: 'Dr Kofi Ampofo (SEED)', notes: 'PPR vaccine, pen round', occurredAt: hoursAgo(1) });
    expect(vaccinated.status, JSON.stringify(vaccinated.body)).toBe(201);
    expect(vaccinated.body).toMatchObject({ costPesewas: 9_001, holdsPlaced: 0, withdrawalDays: 0, location: { code: 'PEN-T' }, stockUnit: null });
    const spread = await admin().query<{ tag: string; head_days: number; amount: string; treatment: string }>(
      `SELECT u.identifier AS tag, a.head_days, a.amount_pesewas::text AS amount, a.treatment
         FROM liv.health_cost_allocation a JOIN inv.stock_unit u ON u.id = a.stock_unit_id WHERE a.health_event_id = $1 ORDER BY u.identifier`,
      [vaccinated.body.id],
    );
    expect(spread.rows).toEqual([
      { tag: 'T-0201', head_days: 1, amount: '3001', treatment: 'CAPITALISED' },
      { tag: 'T-0202', head_days: 1, amount: '3000', treatment: 'CAPITALISED' },
      { tag: 'T-0203', head_days: 1, amount: '3000', treatment: 'EXPENSED' },
    ]);
    expect([await poolOf('T-0201'), await poolOf('T-0202'), await poolOf('T-0203')]).toEqual(['53001', '53000', '50000']);
    const expensed = await admin().query("SELECT payload->>'valuePesewas' AS value FROM platform.outbox_message WHERE event_type = 'inv.UpkeepExpensed' AND payload->>'sourceDocumentId' = $1", [vaccinated.body.id]);
    expect(expensed.rows).toEqual([{ value: '3000' }]);
  });

  it('issues 10.000 kg of feed valued 10,001 to flocks of 10, 10 and 5: 4,001, 4,000 and 2,000', async () => {
    const fed = await post(farmHand, '/feed-consumption', { locationId: id('location:PEN-F'), feedProductId: id('product:FEED-GROWER-KG'), qty: '10.000', consumedOn: clock.now().toISOString().slice(0, 10) });
    expect(fed.status, JSON.stringify(fed.body)).toBe(201);
    expect(fed.body).toMatchObject({ status: 'POSTED', valuePesewas: 10_001, qty: '10.000', uom: 'KG', location: { code: 'PEN-F' } });
    expect(fed.body.allocations.map((a: { stockUnit: { identifier: string }; headDays: number; amountPesewas: number; treatment: string }) => [a.stockUnit.identifier, a.headDays, a.amountPesewas, a.treatment])).toEqual([
      ['BRF-A', 10, 4_001, 'CAPITALISED'],
      ['BRF-B', 10, 4_000, 'CAPITALISED'],
      ['BRF-C', 5, 2_000, 'CAPITALISED'],
    ]);
    expect([await poolOf('BRF-A'), await poolOf('BRF-B'), await poolOf('BRF-C')]).toEqual(['54001', '54000', '27000']);
    const store = await admin().query<{ qty: string; value: string }>('SELECT qty::text, value_pesewas::text AS value FROM inv.cost_pool WHERE product_id = $1', [id('product:FEED-GROWER-KG')]);
    expect(store.rows).toEqual([{ qty: '10.000', value: '10001' }]);
    expect((await get(accountant, `/feed-consumption/${fed.body.id as string}`)).body.allocations).toHaveLength(3);
  });

  it('is refused by the deferred check when a consumption is spread inconsistently: 10,000 allocated of 10,001', async () => {
    const issue = (await admin().query<{ issue_movement_id: string }>('SELECT issue_movement_id FROM liv.feed_consumption LIMIT 1')).rows[0]!.issue_movement_id;
    const client = await admin().connect();
    try {
      await client.query('BEGIN');
      const doc = randomUUID();
      await client.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'FEED_CONSUMPTION', 'liv', $2, $3)", [doc, id('branch:DDW'), SYSTEM_PRINCIPAL]);
      await client.query(
        `INSERT INTO liv.feed_consumption (id, location_id, from_location_id, feed_product_id, qty, consumed_on, value_pesewas, issue_movement_id, status, branch_id, posted_at, posted_by, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 10, current_date, 10001, $5, 'POSTED', $6, now(), $7, $7, $7)`,
        [doc, id('location:PEN-F'), id('location:STORE'), id('product:FEED-GROWER-KG'), issue, id('branch:DDW'), SYSTEM_PRINCIPAL],
      );
      await client.query("INSERT INTO liv.feed_cost_allocation (feed_consumption_id, stock_unit_id, head_days, amount_pesewas, treatment, actor_id) VALUES ($1, $2, 25, 10000, 'EXPENSED', $3)", [
        doc,
        id('unit:BRF-A'),
        SYSTEM_PRINCIPAL,
      ]);
      const committed = await client.query('COMMIT').then(
        () => null,
        (error: { code?: string; constraint?: string }) => [error.code, error.constraint],
      );
      expect(committed).toEqual(['HK010', 'ck_feed_consumption_spread']);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('refuses feed for a pen with no animals, and anything that is not feed', async () => {
    const empty = await post(farmHand, '/feed-consumption', { locationId: id('location:COLD'), feedProductId: id('product:FEED-GROWER-KG'), qty: '1.000', consumedOn: clock.now().toISOString().slice(0, 10) });
    expect(empty.body.error.details).toEqual([expect.objectContaining({ code: 'NO_ANIMALS_HERE' })]);
    const meat = await post(farmHand, '/feed-consumption', { locationId: id('location:PEN-F'), feedProductId: id('product:MEAT-BEEF-15KG'), qty: '1.000', consumedOn: clock.now().toISOString().slice(0, 10) });
    expect(meat.body.error.details).toEqual([expect.objectContaining({ code: 'NOT_FEED' })]);
  });
});

describe('rations (FR-LIV-014)', () => {
  it('creates 0.120 kg of grower pellets per broiler per day, changes it, and refuses the same name twice', async () => {
    const created = await post(manager, '/rations', { name: 'Broiler grower', speciesId: id('species:BROILER'), feedProductId: id('product:FEED-GROWER-KG'), qtyPerHeadPerDay: '0.120', stage: 'Grower' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ name: 'Broiler grower', species: { code: 'BROILER' }, qtyPerHeadPerDay: '0.120', uom: 'KG', stage: 'Grower', version: 1 });
    const changed = await patch(manager, `/rations/${created.body.id as string}`, { version: 1, qtyPerHeadPerDay: '0.130' });
    expect(changed.body).toMatchObject({ qtyPerHeadPerDay: '0.130', version: 2 });
    const twice = await post(manager, '/rations', { name: 'Broiler grower', speciesId: id('species:BROILER'), feedProductId: id('product:FEED-GROWER-KG'), qtyPerHeadPerDay: '0.100' });
    expect(twice.body.error).toMatchObject({ code: 'RATION_INVALID', details: [expect.objectContaining({ code: 'NAME_TAKEN' })] });
    // The seed's three rations (B06 continued 2) and this one.
    expect((await get(storekeeper, `/rations?speciesId=${id('species:BROILER')}`)).body.data.map((r: { name: string }) => r.name).sort()).toEqual(['Broiler grower', 'Broiler grower (SEED)']);
  });
});

describe('mortality waits for a photograph and a different approver at or above 50,000 (FR-LIV-012, abuse case 2)', () => {
  it('writes off a kid with accumulated cost 12,000 on submit, and the register shows it DEAD', async () => {
    const reported = await post(farmHand, '/mortality-records', { kind: 'DEATH', stockUnitId: id('unit:K-0301'), reasonCode: 'UNKNOWN_CAUSE', foundAt: hoursAgo(1), disposalNote: 'Buried behind the pens' });
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    expect(reported.body).toMatchObject({ status: 'REPORTED', valuePesewas: 12_000, animal: { tagNo: 'K-0301' }, location: { code: 'PENS' }, reportedBy: { displayName: 'Abena Quaye' } });
    const submitted = await post(farmHand, `/mortality-records/${reported.body.id as string}/submit`);
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({ status: 'POSTED', valuePesewas: 12_000, approvalRequestId: null });
    expect(await statusOf('K-0301')).toBe('DEAD');
    expect(await poolOf('K-0301')).toBe('0');
    expect((await get(manager, `/animals/${id('unit:K-0301')}`)).body).toMatchObject({ status: 'DEAD', accumulatedCostPesewas: 12_000, currentLocation: null, sellable: false });
    const weighed = await post(farmHand, '/weight-records', { records: [{ id: randomUUID(), stockUnitId: id('unit:K-0301'), weightKg: '8.000', weightSource: 'SCALE', measuredAt: hoursAgo(0.5) }] });
    expect(weighed.body.error.details).toEqual([expect.objectContaining({ code: 'ANIMAL_NOT_ALIVE' })]);
  });

  it('refuses to submit the doe at 62,500 without a photograph, and a cull with a death reason', async () => {
    const culled = await post(storekeeper, '/mortality-records', { kind: 'CULL', stockUnitId: id('unit:D-017'), reasonCode: 'DISEASE_SUSPECTED', foundAt: hoursAgo(1) });
    expect(culled.body.error.details).toEqual([expect.objectContaining({ code: 'REASON_NOT_FOR_KIND' })]);
    const reported = await post(storekeeper, '/mortality-records', { kind: 'DEATH', stockUnitId: id('unit:D-017'), reasonCode: 'DISEASE_SUSPECTED', foundAt: hoursAgo(1) });
    expect(reported.body).toMatchObject({ status: 'REPORTED', valuePesewas: 62_500 });
    const submitted = await post(storekeeper, `/mortality-records/${reported.body.id as string}/submit`);
    expect(submitted.status).toBe(422);
    expect(submitted.body.error.code).toBe('MORTALITY_PHOTO_REQUIRED');
    expect(await statusOf('D-017')).toBe('ALIVE');
  });

  it('with a photograph waits as PENDING_APPROVAL with the doe still on hand, refuses the maker as checker, and posts on a different approval', async () => {
    const photo = await evidence(manager, 'doe-d-017.jpg');
    const reported = await post(manager, '/mortality-records', { kind: 'DEATH', stockUnitId: id('unit:D-017'), reasonCode: 'DISEASE_SUSPECTED', foundAt: hoursAgo(1), photoFileId: photo });
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    expect((await post(storekeeper, `/mortality-records/${reported.body.id as string}/submit`)).body.error.details).toEqual([expect.objectContaining({ code: 'SUBMITTER_NOT_REPORTER' })]);
    const submitted = await post(manager, `/mortality-records/${reported.body.id as string}/submit`);
    expect(submitted.status).toBe(202);
    expect(submitted.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'MORTALITY_WRITE_OFF', subject: { id: reported.body.id, docType: 'MORTALITY_RECORD' } });
    expect(await statusOf('D-017')).toBe('ALIVE');
    expect(await poolOf('D-017')).toBe('62500');
    const request = await get(secondManager, `/iam/approvals/${submitted.body.approvalRequestId as string}`);
    expect(request.body).toMatchObject({ evidenceFileId: photo, amountPesewas: 62_500 });

    const own = await post(manager, `/iam/approvals/${submitted.body.approvalRequestId as string}/approve`, {});
    expect(own.status).toBe(422);
    expect(own.body.error.code).toBe('MAKER_CANNOT_CHECK');
    expect((await post(storekeeper, `/iam/approvals/${submitted.body.approvalRequestId as string}/approve`, {})).status).toBe(403);
    const approved = await post(secondManager, `/iam/approvals/${submitted.body.approvalRequestId as string}/approve`, { reason: 'Saw the carcass photograph with the vet' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const record = await get(manager, `/mortality-records/${reported.body.id as string}`);
    expect(record.body).toMatchObject({ status: 'POSTED', valuePesewas: 62_500, photoFileId: photo, approvalRequestId: submitted.body.approvalRequestId });
    expect(await statusOf('D-017')).toBe('DEAD');
    expect(await poolOf('D-017')).toBe('0');
    const reportedEvents = await admin().query("SELECT payload->>'needsApproval' AS approval, payload->'abuseCases' AS cases FROM platform.outbox_message WHERE event_type = 'liv.MortalityReported' AND subject_id = $1", [reported.body.id]);
    expect(reportedEvents.rows).toEqual([{ approval: 'true', cases: [2] }]);
  });

  it('is refused by the database when posted at or above its threshold without an approval', async () => {
    const record = (await admin().query<{ id: string }>("SELECT id FROM liv.mortality_record WHERE status = 'REPORTED' AND value_pesewas = 62500 LIMIT 1")).rows[0]!;
    const refused = await admin()
      .query("UPDATE liv.mortality_record SET status = 'POSTED', threshold_pesewas = 50000, movement_id = (SELECT id FROM inv.stock_movement LIMIT 1), posted_at = now(), posted_by = $2, version = version + 1 WHERE id = $1", [record.id, SYSTEM_PRINCIPAL])
      .then(
        () => null,
        (error: { constraint?: string }) => error.constraint,
      );
    expect(refused).toBe('ck_mortality_record_approved');
  });
});

describe('every LIV write refuses the wrong role, and reads stay with the roles that may see cost (ADR-0035)', () => {
  const writes = () => [
    { path: '/weight-records', body: { records: [{ id: randomUUID(), stockUnitId: id('unit:G-0144'), weightKg: '20.000', weightSource: 'SCALE', measuredAt: hoursAgo(1) }] } },
    { path: '/health-events', body: { kind: 'CHECK', stockUnitId: id('unit:G-0144'), occurredAt: hoursAgo(1) } },
    { path: '/mortality-records', body: { kind: 'DEATH', stockUnitId: id('unit:G-0144'), reasonCode: 'UNKNOWN_CAUSE', foundAt: hoursAgo(1) } },
    { path: '/feed-consumption', body: { locationId: id('location:PEN-F'), feedProductId: id('product:FEED-GROWER-KG'), qty: '1.000', consumedOn: clock.now().toISOString().slice(0, 10) } },
    { path: '/rations', body: { name: `Goat browse ${randomUUID().slice(0, 4)}`, speciesId: id('species:GOAT'), feedProductId: id('product:FEED-GROWER-KG'), qtyPerHeadPerDay: '0.500' } },
  ];

  it('refuses the Cashier, Sales, Driver, Investor and Accountant every write, and the Farm hand and Storekeeper the rations', async () => {
    for (const [role, session] of [...wrong.entries(), ['ACCOUNTANT', accountant] as const]) {
      for (const write of writes()) {
        const refused = await post(session, write.path, write.body);
        expect(refused.status, `${role} ${write.path}`).toBe(403);
        expect(refused.body.error.code).toBe('FORBIDDEN');
      }
      expect((await post(session, `/mortality-records/${randomUUID()}/submit`)).status, role).toBe(403);
    }
    for (const session of [farmHand, storekeeper]) {
      expect((await post(session, '/rations', writes()[4]!.body)).status).toBe(403);
      expect((await patch(session, `/rations/${randomUUID()}`, { version: 1, qtyPerHeadPerDay: '0.140' })).status).toBe(403);
    }
  });

  it('refuses the Farm hand the reads that show a cost they did not enter, and every read to the Cashier', async () => {
    for (const path of ['/animals', `/animals/${id('unit:G-0142')}`, '/health-events', '/mortality-records', '/feed-consumption', '/rations']) {
      expect((await get(farmHand, path)).status, path).toBe(403);
    }
    expect((await get(farmHand, '/weight-records')).status).toBe(200);
    for (const path of ['/animals', '/weight-records', '/health-events', '/mortality-records', '/feed-consumption', '/rations']) {
      expect((await get(wrong.get('CASHIER')!, path)).status, path).toBe(403);
    }
  });
});

describe("the animal's status follows its unit once the withdrawal ends (FR-LIV-008, FR-LIV-017)", () => {
  it('sells G-0143 on the day the hold ends, marks it SOLD in the same transaction, and refuses a second sale', async () => {
    clock.advanceBy(86_400_000 + 60_000);
    expect(await sell('G-0143')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await statusOf('G-0143')).toBe('SOLD');
    expect((await admin().query<{ exit: string }>('SELECT exit_value_pesewas::text AS exit FROM liv.animal WHERE stock_unit_id = $1', [id('unit:G-0143')])).rows[0]!.exit).toBe('60150');
    expect(await sell('G-0143')).toMatch(/STOCK_UNIT_NOT_AVAILABLE|STOCK_UNIT_INACTIVE|SERIAL/);
  });
});
