import { randomUUID } from 'node:crypto';
import { ManualClock, Money, Quantity, Weight } from '@hakorem/kernel';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BalanceReconciliation, InvModule, Lineage, Stock, type MovementRequest } from '../../../src/modules/inv';
import { OPERATION_METADATA, type OperationSpec } from '../../../src/platform/http/operation';
import { runAsSystem, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { SEED_HAND_COUNT } from '../../../src/seed/farm-inv';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The B5 gate over the seeded farm and the API (FR-INV-003, FR-INV-006, CR-001, CR-003): on hand derived from the
 * movements matches the hand count of the seeded farm, line by line and in value; each line's value at cost is its
 * exact share of its pool; reads are narrowed to the reader's grants and refused to the wrong role; and a lot
 * traces back to its animal and supplier and the animal forward to the lot and its sale, in one request each.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let accountant: TestSession;
let coldStorekeeper: TestSession;
let cashier: TestSession;
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');
const SYSTEM: Actor = { principalId: SYSTEM_PRINCIPAL, kind: 'SYSTEM', displayName: 'Scheduler', realm: null, sessionId: null, steppedUpAt: null };

interface Line {
  readonly location: { readonly code: string };
  readonly product: { readonly sku: string };
  readonly stockUnit: { readonly identifier: string } | null;
  readonly onHandQty: string;
  readonly valueAtCostPesewas: number;
  readonly unitCostPesewas: number;
  readonly valuationMethod: string;
  readonly uom: string;
  readonly uomDisplayDecimals: number;
}

/** Every line of the listing, page by page, and the total each page carried. */
async function allLines(session: TestSession, query: string, limit = 100): Promise<{ lines: Line[]; totals: number[] }> {
  const lines: Line[] = [];
  const totals: number[] = [];
  let cursor: string | null = null;
  do {
    const response = await get(session, `/stock/on-hand?${query}&limit=${limit}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
    expect(response.status).toBe(200);
    lines.push(...(response.body.data as Line[]));
    totals.push(response.body.totalValueAtCostPesewas as number);
    cursor = response.body.page.nextCursor as string | null;
  } while (cursor !== null);
  return { lines, totals };
}

/** Quantity by location code and SKU, summed over stock units, as a person would count a pen. */
function counted(lines: readonly Line[]): Record<string, string> {
  const totals = new Map<string, Quantity>();
  for (const line of lines) {
    const key = `${line.location.code}:${line.product.sku}`;
    totals.set(key, (totals.get(key) ?? Quantity.zero()).plus(Quantity.parse(line.onHandQty)));
  }
  return Object.fromEntries([...totals].map(([key, qty]) => [key, qty.toDecimalString()]));
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
       UNION ALL SELECT 'virtual:' || l.kind, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.is_virtual
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'unit:' || identifier, id FROM inv.stock_unit`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  coldStorekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:COLD') }] }));
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: id('location:SHOP') }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B5 gate: on hand derived from movements matches a hand count of the seeded farm', () => {
  it('lists exactly the hand-counted quantity at each Dodowa location, GHS 17,895.01 at cost in all', async () => {
    const { lines, totals } = await allLines(manager, `branchId=${id('branch:DDW')}`);
    expect(counted(lines)).toEqual(Object.fromEntries(SEED_HAND_COUNT.lines.map((l) => [`${l.location}:${l.sku}`, l.onHand])));
    expect(totals).toEqual([1_789_501]);
    expect(Money.sum(lines.map((line) => Money.fromJsonInteger(line.valueAtCostPesewas))).toJsonInteger()).toBe(SEED_HAND_COUNT.totalValueAtCostPesewas);
  });

  it('agrees with a fresh sum of the movement ledger at every physical location, and the nightly recompute finds no drift', async () => {
    const ledger = await admin().query<{ code: string; sku: string; qty: string }>(
      `WITH signed AS (
         SELECT to_location_id AS location_id, product_id, qty_base AS qty FROM inv.stock_movement
         UNION ALL SELECT from_location_id, product_id, -qty_base FROM inv.stock_movement)
       SELECT l.code, p.sku, sum(s.qty)::numeric(14,3)::text AS qty
         FROM signed s JOIN mdm.location l ON l.id = s.location_id JOIN mdm.product p ON p.id = s.product_id
        WHERE NOT l.is_virtual GROUP BY l.code, p.sku HAVING sum(s.qty) <> 0`,
    );
    const { lines } = await allLines(manager, `branchId=${id('branch:DDW')}`);
    expect(Object.fromEntries(ledger.rows.map((r) => [`${r.code}:${r.sku}`, r.qty]))).toEqual(counted(lines));
    const drift = await runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Nightly recompute' }, randomUUID(), () => api.app.get(BalanceReconciliation).run(SYSTEM));
    expect(drift).toEqual([]);
  });

  it('values each line at its own cost: four goats at 60,000, two sheep at 75,001 and 75,000, beef at 12,000 a kg', async () => {
    const { lines } = await allLines(manager, `branchId=${id('branch:DDW')}`);
    const unit = (identifier: string) => lines.find((l) => l.stockUnit?.identifier === identifier)!;
    for (const tag of ['G-0142', 'G-0143', 'G-0144', 'G-0145']) {
      expect(unit(tag)).toMatchObject({ onHandQty: '1.000', valueAtCostPesewas: 60_000, unitCostPesewas: 60_000, valuationMethod: 'SPECIFIC_IDENTIFICATION', uom: 'HEAD', uomDisplayDecimals: 0 });
    }
    expect([unit('S-0031').valueAtCostPesewas, unit('S-0032').valueAtCostPesewas]).toEqual([75_001, 75_000]);
    expect(unit('LOT-BEEF-2026-1110')).toMatchObject({ onHandQty: '45.000', valueAtCostPesewas: 540_000, unitCostPesewas: 12_000, uom: 'KG', uomDisplayDecimals: 3 });
    const yam = lines.find((l) => l.product.sku === 'PRD-YAM-TUBER')!;
    expect(yam).toMatchObject({ stockUnit: null, valuationMethod: 'WEIGHTED_AVERAGE', valueAtCostPesewas: 48_000, unitCostPesewas: 1_200 });
  });

  it('pages without losing or repeating a line, and every page carries the total of the whole filter', async () => {
    const whole = await allLines(manager, `branchId=${id('branch:DDW')}`);
    const paged = await allLines(manager, `branchId=${id('branch:DDW')}`, 3);
    expect(paged.lines).toEqual(whole.lines);
    expect(new Set(paged.totals)).toEqual(new Set([1_789_501]));
    expect(paged.totals.length).toBeGreaterThan(3);
  });

  it('narrows a cold room storekeeper to the cold room, refuses them the pens, and refuses the cashier any stock read', async () => {
    const { lines, totals } = await allLines(coldStorekeeper, 'includeZero=false');
    expect(new Set(lines.map((l) => l.location.code))).toEqual(new Set(['COLD']));
    expect(totals).toEqual([930_000]);
    expect((await get(coldStorekeeper, `/stock/on-hand?branchId=${id('branch:DDW')}&locationId=${id('location:PENS')}`)).status).toBe(403);
    expect((await get(cashier, '/stock/on-hand')).status).toBe(403);
    expect((await get(cashier, `/stock-units/${id('unit:G-0142')}`)).status).toBe(403);
    expect((await get(accountant, `/stock/on-hand?productId=${id('product:EGG-CRATE-BIG')}`)).body.totalValueAtCostPesewas).toBe(105_000);
  });

  it('filters by category and by days to expiry', async () => {
    const eggs = await allLines(manager, `expiringWithinDays=3650&productId=${id('product:EGG-CRATE-BIG')}`);
    expect(eggs.lines.map((l) => l.stockUnit?.identifier)).toEqual(['EGG-BIG-2026-1110']);
    const untracked = await allLines(manager, 'expiringWithinDays=3650');
    expect(untracked.lines.every((l) => l.stockUnit !== null)).toBe(true);
    const category = (await admin().query<{ category_id: string }>("SELECT category_id FROM mdm.product WHERE sku = 'MEAT-BEEF-15KG'")).rows[0]!.category_id;
    const meat = await allLines(manager, `categoryId=${category}`);
    expect(new Set(meat.lines.map((l) => l.product.sku))).toEqual(new Set(['MEAT-BEEF-15KG', 'MEAT-GOAT-15KG']));
  });
});

describe('B5 gate: a lot traces in both directions over the API (FR-INV-006)', () => {
  let lot: string;
  let order: string;
  const goat = () => id('unit:G-0143');

  beforeAll(async () => {
    // Until PRC exists (B6), the processing that turns G-0143 into a lot is written through INV's interface directly.
    const document = async () => {
      const docId = randomUUID();
      await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'STOCK_ADJUSTMENT', 'inv', $2, $3)", [
        docId,
        id('branch:DDW'),
        SYSTEM_PRINCIPAL,
      ]);
      return docId;
    };
    const uow = api.app.get(UnitOfWork);
    const stock = api.app.get(Stock);
    const virtual = async (kind: string) => (await admin().query<{ id: string }>('SELECT id FROM mdm.location WHERE branch_id = $1 AND kind = $2', [id('branch:DDW'), kind])).rows[0]!.id;
    const occurredAt = testStartTime();
    const postAll = (requests: Array<Omit<MovementRequest, 'branchId' | 'occurredAt'>>, link?: () => Promise<void>) =>
      runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Trace test' }, randomUUID(), () =>
        uow.run({ isolation: 'serializable' }, async (tx) => {
          for (const r of requests) await stock.postIn(tx, SYSTEM_PRINCIPAL, { branchId: id('branch:DDW'), occurredAt, ...r });
          await link?.();
        }),
      );
    const consumption = await virtual('CONSUMPTION');
    const processing = await virtual('PROCESSING');
    const customer = await virtual('CUSTOMER');
    const feedDoc = await document();
    await postAll([
      { movementType: 'COST_CAPITALISE', productId: id('product:LIV-GOAT'), stockUnitId: goat(), fromLocationId: consumption, toLocationId: id('location:PENS'), qty: Quantity.zero(), value: Money.ofPesewas(8_400n), costElement: 'FEED', sourceDocumentId: feedDoc },
      { movementType: 'COST_CAPITALISE', productId: id('product:LIV-GOAT'), stockUnitId: goat(), fromLocationId: consumption, toLocationId: id('location:PENS'), qty: Quantity.zero(), value: Money.ofPesewas(3_000n), costElement: 'VETERINARY', sourceDocumentId: feedDoc },
    ]);
    const processingOrder = await document();
    lot = randomUUID();
    await admin().query(
      `INSERT INTO inv.stock_unit (id, product_id, tracking, branch_id, identifier, status, produced_on, expires_on, source_document_id, created_by, updated_by)
       VALUES ($1, $2, 'LOT', $3, 'LOT-GOAT-0002', 'ACTIVE', '2026-11-14', '2027-02-12', $4, $5, $5)`,
      [lot, id('product:MEAT-GOAT-15KG'), id('branch:DDW'), processingOrder, SYSTEM_PRINCIPAL],
    );
    await postAll(
      [
        { movementType: 'PROCESS_CONSUME', productId: id('product:LIV-GOAT'), stockUnitId: goat(), fromLocationId: id('location:PENS'), toLocationId: processing, qty: Quantity.ofUnits(1n), sourceDocumentId: processingOrder },
        { movementType: 'PROCESS_OUTPUT', productId: id('product:MEAT-GOAT-15KG'), stockUnitId: lot, fromLocationId: processing, toLocationId: id('location:COLD'), qty: Quantity.parse('12.000'), value: Money.ofPesewas(71_400n), costElement: 'PROCESSING', sourceDocumentId: processingOrder },
      ],
      async () => api.app.get(Lineage).linkIn(api.app.get(UnitOfWork).current(), SYSTEM_PRINCIPAL, lot, [goat()], 'PROCESSING', processingOrder),
    );
    order = await document();
    await postAll([
      {
        movementType: 'SALE_ISSUE',
        productId: id('product:MEAT-GOAT-15KG'),
        stockUnitId: lot,
        fromLocationId: id('location:COLD'),
        toLocationId: customer,
        qty: Quantity.parse('12.000'),
        weight: { kg: Weight.parseKg('12.000'), source: 'SCALE' },
        sourceDocumentId: order,
      },
    ]);
  });

  it('traces sold lot LOT-GOAT-0002 back to G-0143, its supplier and its feed and veterinary cost, in one request', async () => {
    const response = await get(manager, `/stock-units/${lot}/trace`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      unit: { id: lot, identifier: 'LOT-GOAT-0002', tracking: 'LOT' },
      product: { sku: 'MEAT-GOAT-15KG' },
      ancestors: [{ unit: { identifier: 'G-0143', tracking: 'SERIAL' }, product: { sku: 'LIV-GOAT' }, linkType: 'PROCESSING', depth: 1 }],
      descendants: [],
      supplier: { name: 'Kpone Livestock Traders (SEED)' },
      costByElement: [
        { costElement: 'PURCHASE', valuePesewas: 60_000 },
        { costElement: 'FEED', valuePesewas: 8_400 },
        { costElement: 'VETERINARY', valuePesewas: 3_000 },
      ],
      sales: [{ order: { id: order, docType: 'STOCK_ADJUSTMENT', number: null }, billingDocument: null, customer: null, qty: '12.000', weightKg: '12.000' }],
      healthEvents: [],
      currency: 'GHS',
    });
  });

  it('traces G-0143 forward to the lot and its sale, and shows it consumed with nothing on hand', async () => {
    const response = await get(accountant, `/stock-units/${goat()}/trace`);
    expect(response.status).toBe(200);
    expect(response.body.ancestors).toEqual([]);
    expect(response.body.descendants).toMatchObject([{ unit: { identifier: 'LOT-GOAT-0002' }, linkType: 'PROCESSING', depth: 1 }]);
    expect(response.body.sales).toMatchObject([{ order: { id: order }, qty: '12.000' }]);
    const unit = await get(manager, `/stock-units/${goat()}`);
    expect(unit.body).toMatchObject({ identifier: 'G-0143', status: 'CONSUMED', onHandQty: '0.000', valueAtCostPesewas: 0, uomDisplayDecimals: 0, supplier: { name: 'Kpone Livestock Traders (SEED)' } });
  });

  it('refuses the trace to a storekeeper and a cashier (A-133), and answers 404 for no unit', async () => {
    expect((await get(coldStorekeeper, `/stock-units/${lot}/trace`)).status).toBe(403);
    expect((await get(cashier, `/stock-units/${lot}/trace`)).status).toBe(403);
    expect((await get(manager, `/stock-units/${randomUUID()}/trace`)).status).toBe(404);
  });
});

describe('B5 gate: stock cannot go negative outside the allowed movement types (FR-INV-019)', () => {
  const yam = () => ({ productId: id('product:PRD-YAM-TUBER'), branchId: id('branch:DDW'), toLocationId: id('virtual:CUSTOMER') });
  /** A sale through Stock.postIn; answers the movement id or the error code. */
  const sell = (movementType: string, from: string, qty: string) =>
    runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'B5 gate' }, randomUUID(), () =>
      api.app.get(UnitOfWork).run({ isolation: 'serializable' }, async (tx) => {
        const documentId = randomUUID();
        await tx.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'STOCK_ADJUSTMENT', 'inv', $2, $3)", [documentId, id('branch:DDW'), SYSTEM_PRINCIPAL]);
        return (await api.app.get(Stock).postIn(tx, SYSTEM_PRINCIPAL, { ...yam(), movementType, fromLocationId: id(from), qty: Quantity.parse(qty), sourceDocumentId: documentId, occurredAt: clock.now() })).id;
      }),
    ).catch((error: unknown) => (error as { code?: string }).code ?? String(error));
  const shopYam = async () =>
    (await admin().query<{ q: string }>('SELECT on_hand_qty::text AS q FROM inv.stock_balance WHERE product_id = $1 AND location_id = $2 AND stock_unit_id IS NULL', [id('product:PRD-YAM-TUBER'), id('location:SHOP')])).rows[0]!.q;

  it('refuses a counter sale of 41 yams from the 40 on the shop floor, and an offline sale out of a location that does not allow it', async () => {
    expect(await sell('SALE_ISSUE', 'location:SHOP', '41.000')).toBe('INSUFFICIENT_STOCK');
    expect(await sell('SALE_ISSUE_OFFLINE', 'location:PENS', '1.000')).toBe('INSUFFICIENT_STOCK');
    expect(await shopYam()).toBe('40.000');
  });

  it('refuses the offline sale at the seeded shop floor too, which does not allow negative stock: both type and location must allow it', async () => {
    // Where a location does allow it, the offline sale posts below zero with one NEGATIVE_STOCK exception
    // (stock-invariants.integration.spec.ts, FR-INV-019's acceptance on a branch whose counter allows it).
    expect(await sell('SALE_ISSUE_OFFLINE', 'location:SHOP', '41.000')).toBe('INSUFFICIENT_STOCK');
    expect(await shopYam()).toBe('40.000');
    const raised = await admin().query("SELECT 1 FROM inv.stock_exception WHERE kind = 'NEGATIVE_STOCK' AND product_id = $1", [id('product:PRD-YAM-TUBER')]);
    expect(raised.rowCount).toBe(0);
    // The ledger and its projection still agree everywhere: the nightly recompute finds no drift.
    expect(await api.app.get(BalanceReconciliation).run(SYSTEM)).toEqual([]);
  });
});

describe('B5 gate: every INV write refuses the wrong role (ADR-0017, ADR-0035)', () => {
  /** A body that passes validation for each INV write, so the refusal seen is the permission's. */
  const VALID_BODY: Readonly<Record<string, object>> = {
    createGoodsReceipt: { kind: 'HARVEST', locationId: randomUUID(), receivedAt: '2026-11-10T07:00:00Z', lines: [] },
    updateGoodsReceipt: { version: 1, notes: 'Two birds died on the road' },
    cancelGoodsReceipt: { reason: 'Delivery turned back at the gate' },
    reverseStockMovement: { reasonCode: 'COUNT_ERROR', note: 'Posted twice from the cold room tablet' },
    createStockTransfer: { fromLocationId: randomUUID(), toLocationId: randomUUID(), lines: [] },
    receiveStockTransfer: { lines: [] },
    cancelStockTransfer: { reason: 'Van not available' },
    createStockAdjustment: { locationId: randomUUID(), reasonCode: 'COUNT_ERROR', lines: [] },
    createStockTake: { locationId: randomUUID(), scope: 'FULL' },
    recordStockTakeCounts: { counts: [] },
    cancelStockTake: { reason: 'Refused' },
    createStockHold: { stockUnitId: randomUUID(), kind: 'INVESTIGATION', note: 'Refused' },
    releaseStockHold: { reasonCode: 'INVESTIGATION_CLOSED', note: 'Refused' },
    resolveStockException: { resolutionKind: 'WRITE_OFF', note: 'Refused' },
    releaseStockReservation: { reason: 'Refused' },
    createReorderRule: { productId: randomUUID(), branchId: randomUUID(), minQty: '10.000', reorderPointQty: '15.000', maxQty: '60.000' },
    updateReorderRule: { version: 1, reorderPointQty: '20.000' },
    recordTemperatureReading: { locationId: randomUUID(), readingC: '-18.0', measuredAt: '2026-11-13T10:00:00Z', source: 'MANUAL' },
  };

  /** Every state-changing route INV's controllers mount, with the operation it declares. */
  function invWrites(): Array<{ method: string; path: string; spec: OperationSpec }> {
    const found: Array<{ method: string; path: string; spec: OperationSpec }> = [];
    for (const module of api.app.get(ModulesContainer).values()) {
      if (module.metatype !== InvModule) continue;
      for (const wrapper of module.controllers.values()) {
        const type = wrapper.metatype as (new (...args: never[]) => object) | null;
        if (type === null) continue;
        const base = String(Reflect.getMetadata(PATH_METADATA, type) ?? '');
        for (const name of Object.getOwnPropertyNames(type.prototype)) {
          const handler = (type.prototype as Record<string, unknown>)[name];
          if (name === 'constructor' || typeof handler !== 'function' || Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
          const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number]!;
          if (method === 'GET') continue;
          const path = `/v1/${[base, String(Reflect.getMetadata(PATH_METADATA, handler))].filter((p) => p !== '' && p !== '/').join('/')}`.replace(/\/+/g, '/');
          found.push({ method, path, spec: Reflect.getMetadata(OPERATION_METADATA, handler) as OperationSpec });
        }
      }
    }
    return found;
  }

  it('walks all 24 INV writes and answers 403 to the accountant, the cashier, the sales clerk, the driver and the farm hand', async () => {
    const branchId = id('branch:DDW');
    const sessions: Record<string, TestSession> = {
      ACCOUNTANT: accountant,
      CASHIER: cashier,
      SALES: await login(api.server, await createUser(database, { name: 'Esi Appiah', grants: [{ role: 'SALES', branchId }] })),
      DRIVER: await login(api.server, await createUser(database, { name: 'Selorm Agbeko', grants: [{ role: 'DRIVER', branchId }] })),
      FARM_HAND: await login(api.server, await createUser(database, { name: 'Abdul-Rahman Iddrisu', grants: [{ role: 'FARM_HAND', branchId, locationId: id('location:PENS') }] })),
    };
    const writes = invWrites();
    expect(writes.map((w) => w.spec.operationId).sort()).toEqual(
      [
        'createGoodsReceipt', 'updateGoodsReceipt', 'postGoodsReceipt', 'cancelGoodsReceipt', 'reverseStockMovement',
        'createStockTransfer', 'dispatchStockTransfer', 'receiveStockTransfer', 'cancelStockTransfer', 'createStockAdjustment', 'submitStockAdjustment',
        'createStockTake', 'startStockTake', 'recordStockTakeCounts', 'closeStockTakeCounting', 'submitStockTake', 'cancelStockTake',
        'createStockHold', 'releaseStockHold', 'resolveStockException', 'releaseStockReservation',
        'createReorderRule', 'updateReorderRule', 'recordTemperatureReading',
      ].sort(),
    );
    for (const [role, session] of Object.entries(sessions)) {
      for (const write of writes) {
        const path = write.path.replace(/:[a-zA-Z]+/g, randomUUID());
        const body = VALID_BODY[write.spec.operationId] ?? {};
        const response =
          write.method === 'PATCH' || write.method === 'PUT'
            ? await (write.method === 'PUT' ? request(api.server).put(path) : request(api.server).patch(path)).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send(body)
            : await consolePost(api.server, session, path).send(body);
        expect(response.status, `${role} ${write.spec.operationId}`).toBe(403);
        expect(response.body.error.code, `${role} ${write.spec.operationId}`).toBe('FORBIDDEN');
      }
    }
  });
});

