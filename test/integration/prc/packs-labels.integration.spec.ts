import { randomUUID } from 'node:crypto';
import { ManualClock, Quantity, Weight } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stock } from '../../../src/modules/inv';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { DocumentRegistry } from '../../../src/platform/documents/document-registry';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, consolePut, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Packs and labels (FR-PRC-009, FR-PRC-010; A-161), over the real API on the seeded farm: a completed order's meat lot is
 * packed into weighed packs whose weights sum exactly to the lot's weight, each pack's label barcode encodes the lot and
 * the weight in grams, a reprint gives the same payload, and every pack write refuses the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let storekeeper: TestSession;
let accountant: TestSession;
const wrong = new Map<string, TestSession>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const v1 = (path: string) => `/v1${path}`;
const post = (session: TestSession, path: string, body: object = {}, key?: string) => consolePost(api.server, session, v1(path), key).send(body);
const put = (session: TestSession, path: string, body: object) => consolePut(api.server, session, v1(path)).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, v1(path));
const admin = () => database.pool('admin');
const codes = (body: { error: { details: Array<{ code: string }> } }) => body.error.details.map((d) => d.code);

async function refresh(): Promise<void> {
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'virtual:' || l.kind, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.is_virtual
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'unit:' || identifier, id FROM inv.stock_unit`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
}

/** Processes a seeded goat at the pens into a meat lot of `meatKg` (with `packCount`), offal and waste, and completes it. */
async function process(tag: string, inputKg: string, meatKg: string, packCount: number | null): Promise<{ orderId: string; lot: string; lotId: string }> {
  const planned = await post(manager, '/processing-orders', { locationId: id('location:PENS'), outputLocationId: id('location:COLD'), inputs: [{ stockUnitId: id(`unit:${tag}`), weightKg: inputKg, weightSource: 'SCALE' }] });
  expect(planned.status, JSON.stringify(planned.body)).toBe(201);
  const orderId = planned.body.id as string;
  expect((await post(manager, `/processing-orders/${orderId}/start`)).status).toBe(200);
  const version = (await get(manager, `/processing-orders/${orderId}`)).body.version as number;
  const recorded = await put(manager, `/processing-orders/${orderId}/outputs`, {
    version,
    outputs: [
      { productId: id('product:MEAT-GOAT-15KG'), outputKind: 'MEAT', weightKg: meatKg, weightSource: 'SCALE', ...(packCount === null ? {} : { packCount }) },
      { productId: id('product:BYP-GOAT-OFFAL'), outputKind: 'OFFAL', weightKg: '3.100', weightSource: 'SCALE' },
      { productId: id('product:BYP-GOAT-OFFAL'), outputKind: 'WASTE', weightKg: '6.000', weightSource: 'MANUAL' },
    ],
  });
  expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
  const completed = await post(manager, `/processing-orders/${orderId}/complete`);
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  const meat = (completed.body.outputs as Array<{ lineNo: number; stockUnit: { id: string; identifier: string } }>).find((o) => o.lineNo === 1)!;
  await refresh();
  return { orderId, lot: meat.stockUnit.identifier, lotId: meat.stockUnit.id };
}

/** Sells part of a lot from the cold room through INV's `Stock.postIn`, as the counter (B9b) will. */
async function sellFromLot(lotId: string, kg: string): Promise<void> {
  await runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Sale test' }, randomUUID(), () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable' }, async (tx) => {
      const documentId = randomUUID();
      await api.app.get(DocumentRegistry).register(tx, { id: documentId, docType: 'STOCK_ADJUSTMENT', ownerModule: 'inv', branchId: id('branch:DDW'), actorId: SYSTEM_PRINCIPAL });
      await api.app.get(Stock).postIn(tx, SYSTEM_PRINCIPAL, {
        movementType: 'SALE_ISSUE',
        productId: id('product:MEAT-GOAT-15KG'),
        stockUnitId: lotId,
        branchId: id('branch:DDW'),
        fromLocationId: id('location:COLD'),
        toLocationId: id('virtual:CUSTOMER'),
        qty: Quantity.parse(kg),
        weight: { kg: Weight.parseKg(kg), source: 'SCALE' },
        sourceDocumentId: documentId,
        occurredAt: clock.now(),
      });
    }),
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  await refresh();
  const branchId = id('branch:DDW');
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  storekeeper = await login(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'STOREKEEPER', branchId }] }));
  for (const role of ['CASHIER', 'SALES', 'DRIVER', 'FARM_HAND', 'INVESTOR'] as const satisfies readonly RoleCode[]) {
    wrong.set(role, await login(api.server, await createUser(database, { name: `Wrong ${role.toLowerCase()}`, grants: [{ role, branchId }] })));
  }
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('packing keeps pack weights equal to the lot weight (FR-PRC-009)', () => {
  let order: { orderId: string; lot: string; lotId: string };
  let packIds: string[];

  it('refuses packs of a goat meat lot of 15.200 kg that weigh 100 g more or 1 g less, and packs whose number is not the two recorded', async () => {
    order = await process('G-0142', '30.000', '15.200', 2);
    const over = await post(storekeeper, `/processing-orders/${order.orderId}/packs`, { outputLineNo: 1, packs: [{ weightKg: '8.000', weightSource: 'SCALE' }, { weightKg: '7.300', weightSource: 'SCALE' }] });
    expect(over.status).toBe(422);
    expect(codes(over.body)).toEqual(['PACK_WEIGHTS_NOT_LOT_WEIGHT']);
    const short = await post(storekeeper, `/processing-orders/${order.orderId}/packs`, { outputLineNo: 1, packs: [{ weightKg: '7.999', weightSource: 'SCALE' }, { weightKg: '7.200', weightSource: 'SCALE' }] });
    expect(codes(short.body)).toEqual(['PACK_WEIGHTS_NOT_LOT_WEIGHT']);
    const three = await post(storekeeper, `/processing-orders/${order.orderId}/packs`, {
      outputLineNo: 1,
      packs: [{ weightKg: '5.000', weightSource: 'SCALE' }, { weightKg: '5.000', weightSource: 'SCALE' }, { weightKg: '5.200', weightSource: 'SCALE' }],
    });
    expect(codes(three.body)).toEqual(['PACK_COUNT_NOT_OUTPUT_COUNT']);
    expect((await post(storekeeper, `/processing-orders/${order.orderId}/packs`, { outputLineNo: 2, packs: [{ weightKg: '3.100', weightSource: 'SCALE' }] })).status).toBe(201);
    expect(codes((await post(storekeeper, `/processing-orders/${order.orderId}/packs`, { outputLineNo: 3, packs: [{ weightKg: '6.000', weightSource: 'SCALE' }] })).body)).toEqual(['OUTPUT_IS_WASTE']);
  });

  it('packs it as 8.000 and 7.200 kg, which sum to 15.200 exactly, each with its lot and weight barcode, and replays the call once', async () => {
    const key = randomUUID();
    const body = { outputLineNo: 1, packs: [{ weightKg: '8.000', weightSource: 'SCALE' }, { weightKg: '7.200', weightSource: 'MANUAL' }] };
    const packed = await post(storekeeper, `/processing-orders/${order.orderId}/packs`, body, key);
    expect(packed.status, JSON.stringify(packed.body)).toBe(201);
    expect(contractSchema('PackList')(packed.body)).toBe(true);
    expect(packed.body.packs.map((p: { packNo: number; weightKg: string; weightSource: string; barcode: string; status: string }) => [p.packNo, p.weightKg, p.weightSource, p.barcode, p.status])).toEqual([
      [1, '8.000', 'SCALE', `${order.lot}/008000`, 'IN_STOCK'],
      [2, '7.200', 'MANUAL', `${order.lot}/007200`, 'IN_STOCK'],
    ]);
    packIds = packed.body.packs.map((p: { id: string }) => p.id);
    expect((await post(storekeeper, `/processing-orders/${order.orderId}/packs`, body, key)).body).toEqual(packed.body);
    const again = await post(storekeeper, `/processing-orders/${order.orderId}/packs`, body);
    expect(codes(again.body)).toEqual(['ALREADY_PACKED']);
    const sums = await admin().query<{ kg: string }>('SELECT sum(weight_kg)::text AS kg FROM prc.pack WHERE stock_unit_id = $1', [order.lotId]);
    expect(sums.rows[0]!.kg).toBe('15.200');
    // Packing moved nothing: the lot's 15.200 kg is still on hand in the cold room.
    const moved = await admin().query("SELECT 1 FROM inv.stock_movement WHERE stock_unit_id = $1 AND movement_type <> 'PROCESS_OUTPUT'", [order.lotId]);
    expect(moved.rowCount).toBe(0);
  });

  it('lists the packs in output line and pack order, for the Accountant too, and pages them', async () => {
    const listed = await get(accountant, `/processing-orders/${order.orderId}/packs?limit=2`);
    expect(listed.status).toBe(200);
    expect(contractSchema('PackPage')(listed.body)).toBe(true);
    expect(listed.body.data.map((p: { outputLineNo: number; packNo: number }) => [p.outputLineNo, p.packNo])).toEqual([[1, 1], [1, 2]]);
    expect(listed.body.page.hasMore).toBe(true);
    const next = await get(accountant, `/processing-orders/${order.orderId}/packs?limit=2&cursor=${encodeURIComponent(listed.body.page.nextCursor as string)}`);
    expect(next.body.data.map((p: { outputLineNo: number; weightKg: string }) => [p.outputLineNo, p.weightKg])).toEqual([[2, '3.100']]);
  });

  it('is held by the database too: packs that do not weigh their output, and a changed weight, are refused', async () => {
    const output = await admin().query<{ id: string }>('SELECT id FROM prc.processing_output WHERE stock_unit_id = $1', [order.lotId]);
    const app = await database.pool('app').connect();
    try {
      await app.query('BEGIN');
      await app.query('SET CONSTRAINTS ALL IMMEDIATE');
      const inserted = await sqlStateOf(
        app.query(
          `INSERT INTO prc.pack (id, stock_unit_id, processing_output_id, pack_no, weight_kg, weight_source, barcode, created_by, updated_by)
           VALUES ($1, $2, $3, 3, 0.001, 'SCALE', $4, $5, $5)`,
          [randomUUID(), order.lotId, output.rows[0]!.id, `${order.lot}/000001`, SYSTEM_PRINCIPAL],
        ),
      );
      expect(inserted).toBe('HK010');
      await app.query('ROLLBACK');
      expect(await sqlStateOf(app.query('UPDATE prc.pack SET weight_kg = 8.001, version = version + 1 WHERE id = $1', [packIds[0]]))).toBe(SQLSTATE.documentFrozen);
    } finally {
      app.release();
    }
  });
});

describe('pack labels carry the lot and the weight (FR-PRC-010, A-151)', () => {
  let orderId: string;
  let lot: string;
  let packIds: string[];

  it('prints the label data with a CODE_128 barcode of <lot>/<grams>, records the first print, and a reprint gives the same payload', async () => {
    const order = await process('G-0143', '30.000', '14.600', null);
    orderId = order.orderId;
    lot = order.lot;
    const packed = await post(storekeeper, `/processing-orders/${orderId}/packs`, { outputLineNo: 1, packs: [{ weightKg: '7.300', weightSource: 'SCALE' }, { weightKg: '7.300', weightSource: 'SCALE' }] });
    expect(packed.status, JSON.stringify(packed.body)).toBe(201);
    packIds = packed.body.packs.map((p: { id: string }) => p.id);
    // Two packs of one lot that weigh the same carry the same payload (A-161).
    expect(packed.body.packs.map((p: { barcode: string }) => p.barcode)).toEqual([`${lot}/007300`, `${lot}/007300`]);

    const printed = await post(storekeeper, `/processing-orders/${orderId}/labels`, { packIds: [packIds[0]] });
    expect(printed.status, JSON.stringify(printed.body)).toBe(200);
    expect(contractSchema('PackLabelSheet')(printed.body)).toBe(true);
    expect(printed.body).toMatchObject({
      format: 'PDF_LABEL_50x30',
      labels: [
        {
          pack: { id: packIds[0], packNo: 1 },
          lotNo: lot,
          product: { sku: 'MEAT-GOAT-15KG' },
          weightKg: '7.300',
          storageTempClass: expect.any(String),
          barcode: { symbology: 'CODE_128', payload: `${lot}/007300`, text: `${lot}/007300` },
          line: `${lot} · 7.300 kg`,
          reprint: false,
        },
      ],
    });
    const first = printed.body.labels[0].labelPrintedAt as string;
    clock.advanceBy(60_000);
    const reprinted = await post(storekeeper, `/processing-orders/${orderId}/labels`, { packIds: packIds, format: 'ZPL' });
    expect(reprinted.body.format).toBe('ZPL');
    expect(reprinted.body.labels.map((l: { barcode: { payload: string }; reprint: boolean; labelPrintedAt: string }) => [l.barcode.payload, l.reprint, l.labelPrintedAt === first])).toEqual([
      [`${lot}/007300`, true, true],
      [`${lot}/007300`, false, false],
    ]);
    const listed = await get(storekeeper, `/processing-orders/${orderId}/packs`);
    expect(listed.body.data[0].labelPrintedAt).toBe(first);
  });

  it('refuses a pack of another order, an order not completed, and packing a lot once part of it is sold', async () => {
    const strange = await post(storekeeper, `/processing-orders/${orderId}/labels`, { packIds: [randomUUID()] });
    expect(codes(strange.body)).toEqual(['PACK_NOT_IN_ORDER']);
    const planned = await post(manager, '/processing-orders', { locationId: id('location:PENS'), outputLocationId: id('location:COLD'), inputs: [{ stockUnitId: id('unit:G-0144'), weightKg: '30.000', weightSource: 'SCALE' }] });
    const early = await post(storekeeper, `/processing-orders/${planned.body.id as string}/packs`, { outputLineNo: 1, packs: [{ weightKg: '1.000', weightSource: 'SCALE' }] });
    expect(codes(early.body)).toEqual(['ORDER_NOT_COMPLETED']);
    expect((await post(manager, `/processing-orders/${planned.body.id as string}/cancel`, { reason: 'Kept for breeding' })).status).toBe(200);
    const partly = await process('G-0145', '30.000', '12.000', null);
    await sellFromLot(partly.lotId, '1.500');
    const late = await post(storekeeper, `/processing-orders/${partly.orderId}/packs`, { outputLineNo: 1, packs: [{ weightKg: '10.500', weightSource: 'SCALE' }] });
    expect(codes(late.body)).toEqual(['LOT_NOT_WHOLE']);
  });
});

describe('every pack write refuses the wrong role (ADR-0035; A-153 as decided in A-160)', () => {
  it('refuses the Cashier, Sales, Driver, Farm hand and Investor every pack read and write, and the Accountant every write', async () => {
    const orders = await admin().query<{ id: string }>("SELECT id FROM prc.processing_order WHERE status = 'COMPLETED' ORDER BY created_at LIMIT 1");
    const orderId = orders.rows[0]!.id;
    const pack = await admin().query<{ id: string }>('SELECT k.id FROM prc.pack k JOIN prc.processing_output p ON p.id = k.processing_output_id WHERE p.processing_order_id = $1 LIMIT 1', [orderId]);
    const sessions = [...wrong.entries(), ['ACCOUNTANT', accountant] as const];
    for (const [role, session] of sessions) {
      const writes = [
        await post(session, `/processing-orders/${orderId}/packs`, { outputLineNo: 1, packs: [{ weightKg: '1.000', weightSource: 'SCALE' }] }),
        await post(session, `/processing-orders/${orderId}/labels`, { packIds: [pack.rows[0]!.id] }),
      ];
      for (const refused of writes) {
        expect(refused.status, role).toBe(403);
        expect(refused.body.error.code).toBe('FORBIDDEN');
      }
      if (role !== 'ACCOUNTANT') expect((await get(session, `/processing-orders/${orderId}/packs`)).status, role).toBe(403);
    }
    const audited = await admin().query<{ action: string }>("SELECT action FROM platform.audit_event WHERE module = 'prc' AND action IN ('PACK', 'PRINT_LABELS') ORDER BY recorded_at");
    expect(new Set(audited.rows.map((r) => r.action))).toEqual(new Set(['PACK', 'PRINT_LABELS']));
  });
});
