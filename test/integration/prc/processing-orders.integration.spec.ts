import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProcessingOrderView } from '../../../src/modules/prc';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, consolePut, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The B6 gate (FR-PRC-001 to FR-PRC-008, FR-PRC-011, ADR-0018): a processing order consumes an animal and produces lots
 * whose costs sum exactly to the input cost plus the direct processing cost, on the seeded farm, over the real API.
 * Each goat the seed receives at Dodowa's pens carries 60,000 pesewas (240,000 over four, split evenly).
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let storekeeper: TestSession;
let coldStorekeeper: TestSession;
let accountant: TestSession;
const wrong = new Map<string, TestSession>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const v1 = (path: string) => `/v1${path}`;
const post = (session: TestSession, path: string, body: object = {}, key?: string) => consolePost(api.server, session, v1(path), key).send(body);
const put = (session: TestSession, path: string, body: object) => consolePut(api.server, session, v1(path)).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, v1(path));
const patch = (session: TestSession, path: string, body: object) =>
  request(api.server).patch(v1(path)).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send(body);
const admin = () => database.pool('admin');

const GOAT_COST = 60_000;

async function plan(session: TestSession, tag: string, weightKg = '28.000', locationCode = 'PENS') {
  return post(session, '/processing-orders', { locationId: id(`location:${locationCode}`), outputLocationId: id('location:COLD'), inputs: [{ stockUnitId: id(`unit:${tag}`), weightKg, weightSource: 'SCALE' }] });
}

async function withdrawalHold(tag: string, endsAt: Date): Promise<void> {
  const documentId = randomUUID();
  await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'STOCK_HOLD', 'inv', $2, $3)", [
    documentId,
    id('branch:DDW'),
    id('principal:system'),
  ]);
  await admin().query(
    "INSERT INTO inv.stock_hold (id, stock_unit_id, kind, starts_at, ends_at, source_document_id, created_by) VALUES ($1, $2, 'WITHDRAWAL', $3, $4, $5, $6)",
    [randomUUID(), id(`unit:${tag}`), new Date(clock.now().getTime() - 3_600_000), endsAt, documentId, id('principal:system')],
  );
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
       UNION ALL SELECT 'unit:' || identifier, id FROM inv.stock_unit
       UNION ALL SELECT 'principal:system', '01900000-0000-7000-8000-000000000001'::uuid`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  storekeeper = await login(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'STOREKEEPER', branchId }] }));
  coldStorekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:COLD') }] }));
  for (const role of ['CASHIER', 'SALES', 'DRIVER', 'FARM_HAND', 'INVESTOR'] as const satisfies readonly RoleCode[]) {
    wrong.set(role, await login(api.server, await createUser(database, { name: `Wrong ${role.toLowerCase()}`, grants: [{ role, branchId }] })));
  }
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B6 gate: a processing order consumes an animal and its lots cost exactly the input cost plus direct cost', () => {
  let orderId: string;
  let completed: { status: number; body: ProcessingOrderView };

  it('plans goat G-0142 at the pens, showing the 60,000 pesewas it would carry now', async () => {
    const planned = await plan(manager, 'G-0142');
    expect(planned.status).toBe(201);
    expect(planned.body).toMatchObject({ status: 'PLANNED', orderNo: null, inputWeightKg: '28.000', inputCostPesewas: null, directCostPesewas: 0, totalCostPesewas: null });
    expect(planned.body.inputs).toEqual([
      expect.objectContaining({ stockUnit: { id: id('unit:G-0142'), identifier: 'G-0142', tracking: 'SERIAL' }, qty: '1.000', uom: 'HEAD', weightKg: '28.000', weightSource: 'SCALE', costPesewas: GOAT_COST }),
    ]);
    orderId = planned.body.id;
  });

  it('adds 4,000 of labour and 1,000 of consumables, and starts the order without moving stock', async () => {
    expect((await post(manager, `/processing-orders/${orderId}/costs`, { costKind: 'LABOUR', amountPesewas: 4_000, description: 'Slaughter and dressing, two hands' })).status).toBe(201);
    const costed = await post(storekeeper, `/processing-orders/${orderId}/costs`, { costKind: 'CONSUMABLE', amountPesewas: 1_000, description: 'Bags, labels and ice' });
    expect(costed.body.directCostPesewas).toBe(5_000);
    const started = await post(storekeeper, `/processing-orders/${orderId}/start`);
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('IN_PROGRESS');
    const moved = await admin().query('SELECT 1 FROM inv.stock_movement WHERE source_document_id = $1', [orderId]);
    expect(moved.rowCount).toBe(0);
  });

  it('refuses outputs weighing one gram more than the input, then records 13.400 kg of meat, 3.100 of offal and 9.000 of waste', async () => {
    const version = (await get(manager, `/processing-orders/${orderId}`)).body.version as number;
    const outputs = (wasteKg: string) => [
      { productId: id('product:MEAT-0007'), outputKind: 'MEAT', weightKg: '13.400', weightSource: 'SCALE', packCount: 1 },
      { productId: id('product:MEAT-0008'), outputKind: 'OFFAL', weightKg: '3.100', weightSource: 'SCALE' },
      { productId: id('product:MEAT-0008'), outputKind: 'WASTE', weightKg: wasteKg, weightSource: 'MANUAL' },
    ];
    const over = await put(manager, `/processing-orders/${orderId}/outputs`, { version, outputs: outputs('11.501') });
    expect(over.status).toBe(422);
    expect(over.body.error).toMatchObject({ code: 'PROCESSING_ORDER_INVALID', details: [expect.objectContaining({ field: '/outputs', code: 'OUTPUT_WEIGHT_ABOVE_INPUT' })] });
    const recorded = await put(manager, `/processing-orders/${orderId}/outputs`, { version, outputs: outputs('9.000') });
    expect(recorded.status).toBe(200);
    expect(recorded.body.outputs.map((o: { lineNo: number; outputKind: string; weightKg: string; allocatedCostPesewas: number }) => [o.lineNo, o.outputKind, o.weightKg, o.allocatedCostPesewas])).toEqual([
      [1, 'MEAT', '13.400', 0],
      [2, 'OFFAL', '3.100', 0],
      [3, 'WASTE', '9.000', 0],
    ]);
  });

  it('completes: 65,000 split 56,144 to meat and 8,856 to offal by relative sales value, nothing to waste', async () => {
    const key = randomUUID();
    completed = await post(manager, `/processing-orders/${orderId}/complete`, {}, key);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({
      status: 'COMPLETED',
      inputCostPesewas: GOAT_COST,
      directCostPesewas: 5_000,
      totalCostPesewas: 65_000,
      inputWeightKg: '28.000',
      outputWeightKg: '16.500',
      wasteWeightKg: '9.000',
      expectedYieldPercent: '59.000',
      actualYieldPercent: '58.929',
      yieldVarianceFlag: false,
    });
    expect(completed.body.inputs[0]!.costPesewas).toBe(GOAT_COST);
    const outputs = completed.body.outputs;
    expect(outputs.map((o) => [o.referencePricePesewasPerKg, o.allocationWeight, o.allocatedCostPesewas])).toEqual([
      [2_200, 29_480_000, 56_144],
      [1_500, 4_650_000, 8_856],
      [0, 0, 0],
    ]);
    expect(outputs.reduce((sum, o) => sum + o.allocatedCostPesewas, 0)).toBe(65_000);
    expect(outputs[2]!.stockUnit).toBeNull();
    // A replay with the same key returns the first answer and moves nothing again.
    const replay = await post(manager, `/processing-orders/${orderId}/complete`, {}, key);
    expect(replay.body).toEqual(completed.body);
    const again = await post(manager, `/processing-orders/${orderId}/complete`);
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('leaves the goat consumed with an empty pool, and each lot in the cold room with a pool equal to its allocated cost', async () => {
    const goat = await admin().query<{ status: string; value: string }>(
      `SELECT u.status, c.value_pesewas::text AS value FROM inv.stock_unit u JOIN inv.cost_pool c ON c.stock_unit_id = u.id WHERE u.id = $1`,
      [id('unit:G-0142')],
    );
    expect(goat.rows[0]).toEqual({ status: 'CONSUMED', value: '0' });
    const movements = await admin().query<{ movement_type: string; value: string; to_kind: string }>(
      `SELECT m.movement_type, m.value_pesewas::text AS value, l.kind AS to_kind FROM inv.stock_movement m JOIN mdm.location l ON l.id = m.to_location_id
        WHERE m.source_document_id = $1 ORDER BY m.recorded_at, m.movement_type`,
      [orderId],
    );
    expect(movements.rows).toEqual([
      { movement_type: 'PROCESS_CONSUME', value: '60000', to_kind: 'PROCESSING' },
      { movement_type: 'PROCESS_OUTPUT', value: '56144', to_kind: 'COLD_ROOM' },
      { movement_type: 'PROCESS_OUTPUT', value: '8856', to_kind: 'COLD_ROOM' },
    ]);
    const lots = await admin().query<{ value: string; qty: string; identifier: string; produced: boolean }>(
      `SELECT c.value_pesewas::text AS value, c.qty::text AS qty, u.identifier, u.produced_on IS NOT NULL AS produced
         FROM prc.processing_output o JOIN inv.stock_unit u ON u.id = o.stock_unit_id JOIN inv.cost_pool c ON c.stock_unit_id = u.id
        WHERE o.processing_order_id = $1 ORDER BY o.line_no`,
      [orderId],
    );
    expect(lots.rows.map((r) => [r.value, r.qty, r.produced])).toEqual([
      ['56144', '13.400', true],
      ['8856', '3.100', true],
    ]);
    expect(lots.rows[0]!.identifier).toMatch(/^PRC-\d{6}-[0-9a-f]{8}-01$/);
  });

  it('traces a meat lot back to the goat over the API', async () => {
    const lotId = completed.body.outputs[0]!.stockUnit!.id;
    const trace = await get(manager, `/stock-units/${lotId}/trace`);
    expect(trace.status).toBe(200);
    expect(JSON.stringify(trace.body.ancestors)).toContain(id('unit:G-0142'));
  });

  it('publishes the completion, both direct costs and the stock events in the same transaction', async () => {
    const events = await admin().query<{ event_type: string; count: string }>(
      `SELECT event_type, count(*)::text AS count FROM platform.outbox_message
        WHERE subject_id = $1 OR payload->>'sourceDocumentId' = $1::text GROUP BY event_type ORDER BY event_type`,
      [orderId],
    );
    expect(events.rows).toEqual([
      { event_type: 'inv.ProcessingOutputReceived', count: '2' },
      { event_type: 'inv.StockConsumedInProcessing', count: '1' },
      { event_type: 'prc.DirectCostIncurred', count: '2' },
      { event_type: 'prc.ProcessingOrderCompleted', count: '1' },
      { event_type: 'prc.ProcessingOrderStarted', count: '1' },
    ]);
  });

  it('refuses to process the consumed goat again, and a completed order cannot be edited, even by direct SQL', async () => {
    const reused = await plan(manager, 'G-0142');
    expect(reused.status).toBe(422);
    expect(reused.body.error.details).toEqual([expect.objectContaining({ field: '/inputs/0/stockUnitId', code: 'INPUT_NOT_AVAILABLE' })]);
    const edit = await patch(manager, `/processing-orders/${orderId}`, { version: completed.body.version, outputLocationId: id('location:SHOP') });
    expect(edit.status).toBe(422);
    expect(edit.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await sqlStateOf(admin().query('UPDATE prc.processing_order SET total_cost_pesewas = 1 WHERE id = $1', [orderId]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(admin().query('UPDATE prc.processing_output SET allocated_cost_pesewas = 1 WHERE processing_order_id = $1', [orderId]))).toBe(SQLSTATE.documentFrozen);
  });
});

describe('an awkward split and the yield variance flag (FR-PRC-005, threat model abuse case 18)', () => {
  it('splits 60,000 to 51,262 and 8,738, the leftover pesewa to the larger remainder, and flags a 12.000 kg meat yield', async () => {
    const planned = await plan(storekeeper, 'G-0143');
    const orderId = planned.body.id as string;
    await post(storekeeper, `/processing-orders/${orderId}/start`);
    const version = (await get(storekeeper, `/processing-orders/${orderId}`)).body.version as number;
    await put(storekeeper, `/processing-orders/${orderId}/outputs`, {
      version,
      outputs: [
        { productId: id('product:MEAT-0007'), outputKind: 'MEAT', weightKg: '12.000', weightSource: 'SCALE' },
        { productId: id('product:MEAT-0008'), outputKind: 'OFFAL', weightKg: '3.000', weightSource: 'SCALE' },
      ],
    });
    const done = await post(storekeeper, `/processing-orders/${orderId}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.outputs.map((o: { allocatedCostPesewas: number }) => o.allocatedCostPesewas)).toEqual([51_262, 8_738]);
    expect(done.body).toMatchObject({ totalCostPesewas: 60_000, yieldVarianceFlag: true, expectedYieldPercent: '59.000', actualYieldPercent: '53.571' });
    const flagged = await admin().query<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'prc.YieldVarianceFlagged' AND subject_id = $1", [orderId]);
    expect(flagged.rows[0]!.payload).toMatchObject({
      processingOrderId: orderId,
      abuseCases: [18],
      inputWeightKg: '28.000',
      lines: [
        { productId: id('product:MEAT-0007'), expectedKg: '13.440', actualKg: '12.000', varianceKg: '-1.440', flagged: true },
        { productId: id('product:MEAT-0008'), expectedKg: '3.080', actualKg: '3.000', varianceKg: '-0.080', flagged: false },
      ],
    });
    const listed = await get(manager, '/processing-orders?yieldVarianceFlag=true');
    expect(listed.body.data.map((o: { id: string }) => o.id)).toEqual([orderId]);
  });
});

describe('inputs under a hold, absent or of the wrong kind are refused (FR-PRC-001, FR-LIV-008)', () => {
  it('refuses a goat under a withdrawal hold with STOCK_UNIT_ON_HOLD naming the hold and its end', async () => {
    const endsAt = new Date(clock.now().getTime() + 14 * 86_400_000);
    await withdrawalHold('G-0144', endsAt);
    const refused = await plan(manager, 'G-0144');
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('STOCK_UNIT_ON_HOLD');
    expect(refused.body.error.details).toEqual([expect.objectContaining({ field: '/inputs/0/stockUnitId', code: 'WITHDRAWAL' })]);
    expect(refused.body.error.details[0].message).toContain(endsAt.toISOString());
  });

  it('refuses to start an order whose goat was put under a hold after it was planned', async () => {
    const planned = await plan(manager, 'G-0145');
    expect(planned.status).toBe(201);
    await withdrawalHold('G-0145', new Date(clock.now().getTime() + 86_400_000));
    const refused = await post(manager, `/processing-orders/${planned.body.id}/start`);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('STOCK_UNIT_ON_HOLD');
    const cancelled = await post(manager, `/processing-orders/${planned.body.id}/cancel`, { reason: 'Goat treated after planning' });
    expect(cancelled.body.status).toBe('CANCELLED');
  });

  it('refuses a goat that is not at the processing location, a lot as an input, and a virtual location', async () => {
    const elsewhere = await plan(manager, 'G-0145', '28.000', 'SHOP');
    expect(elsewhere.body.error.details).toEqual([expect.objectContaining({ code: 'INPUT_NOT_HERE' })]);
    const lot = await plan(manager, 'LOT-BEEF-2026-1110');
    expect(lot.body.error.details).toEqual([expect.objectContaining({ code: 'INPUT_NOT_AN_ANIMAL' })]);
    const virtual = await post(manager, '/processing-orders', {
      locationId: (await admin().query<{ id: string }>("SELECT id FROM mdm.location WHERE kind = 'PROCESSING' AND branch_id = $1", [id('branch:DDW')])).rows[0]!.id,
      outputLocationId: id('location:COLD'),
      inputs: [{ stockUnitId: id('unit:G-0145'), weightKg: '28.000', weightSource: 'SCALE' }],
    });
    expect(virtual.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ field: '/locationId', code: 'NOT_A_PROCESSING_LOCATION' })]));
  });
});

describe('cancelling an order in progress moves nothing (FR-PRC-011)', () => {
  it('cancels a started order of a sheep, which stays active in the pens at its cost', async () => {
    const sheep = (await admin().query<{ identifier: string }>("SELECT u.identifier FROM inv.stock_unit u JOIN mdm.product p ON p.id = u.product_id WHERE p.sku = 'LIV-0005' ORDER BY u.identifier LIMIT 1")).rows[0]!.identifier;
    const planned = await plan(manager, sheep, '31.500');
    await post(manager, `/processing-orders/${planned.body.id}/start`);
    const cancelled = await post(manager, `/processing-orders/${planned.body.id}/cancel`, { reason: 'Buyer wants the ram live' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    const unit = await admin().query<{ status: string; code: string }>('SELECT u.status, l.code FROM inv.stock_unit u JOIN mdm.location l ON l.id = u.current_location_id WHERE u.id = $1', [id(`unit:${sheep}`)]);
    expect(unit.rows[0]).toEqual({ status: 'ACTIVE', code: 'PENS' });
    expect((await admin().query('SELECT 1 FROM inv.stock_movement WHERE source_document_id = $1', [planned.body.id])).rowCount).toBe(0);
  });
});

describe('the database checks a completed order\'s sums at commit (ck_processing_order_costs)', () => {
  it('refuses a completion whose output costs sum to one pesewa less than the total, and accepts the exact sum', async () => {
    const sheep = (await admin().query<{ identifier: string }>("SELECT u.identifier FROM inv.stock_unit u JOIN mdm.product p ON p.id = u.product_id WHERE p.sku = 'LIV-0005' ORDER BY u.identifier DESC LIMIT 1")).rows[0]!.identifier;
    const planned = await plan(manager, sheep, '31.500');
    const orderId = planned.body.id as string;
    await post(manager, `/processing-orders/${orderId}/start`);
    const version = (await get(manager, `/processing-orders/${orderId}`)).body.version as number;
    await put(manager, `/processing-orders/${orderId}/outputs`, {
      version,
      outputs: [
        { productId: id('product:MEAT-0007'), outputKind: 'MEAT', weightKg: '14.000', weightSource: 'SCALE' },
        { productId: id('product:MEAT-0008'), outputKind: 'OFFAL', weightKg: '3.000', weightSource: 'SCALE' },
      ],
    });
    const anyMovement = (await admin().query<{ id: string; unit: string }>('SELECT id, stock_unit_id AS unit FROM inv.stock_movement WHERE stock_unit_id IS NOT NULL LIMIT 1')).rows[0]!;
    const completeBySql = async (meat: number, offal: number) => {
      const client = await admin().connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE prc.processing_input SET cost_pesewas = 76400, movement_id = $2 WHERE processing_order_id = $1', [orderId, anyMovement.id]);
        await client.query(
          `UPDATE prc.processing_output SET allocated_cost_pesewas = CASE line_no WHEN 1 THEN $2::bigint ELSE $3::bigint END, stock_unit_id = $4, movement_id = $5 WHERE processing_order_id = $1`,
          [orderId, meat, offal, anyMovement.unit, anyMovement.id],
        );
        await client.query(
          `UPDATE prc.processing_order SET status = 'COMPLETED', completed_at = now(), posted_at = now(), posted_by = $2, input_weight_kg = 31.5, output_weight_kg = 17, waste_weight_kg = 0,
                  input_cost_pesewas = 76400, total_cost_pesewas = 76400, version = version + 1 WHERE id = $1`,
          [orderId, id('principal:system')],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    expect(await sqlStateOf(completeBySql(69_567, 6_832))).toBe('HK010');
    expect(await sqlStateOf(completeBySql(69_568, 6_832))).toBeUndefined();
  });
});

describe('authorisation: every PRC operation refuses the wrong role (ADR-0035)', () => {
  it('refuses the Cashier, Sales, Driver, Farm hand and Investor every read and write', async () => {
    for (const [role, session] of wrong) {
      expect((await get(session, '/processing-orders')).status, role).toBe(403);
      expect((await plan(session, 'G-0145')).status, role).toBe(403);
      expect((await get(session, '/yield-standards')).status, role).toBe(403);
    }
  });

  it('lets the Accountant read orders and standards and refuses every write', async () => {
    expect((await get(accountant, '/processing-orders')).status).toBe(200);
    expect((await get(accountant, '/yield-standards')).status).toBe(200);
    expect((await plan(accountant, 'G-0145')).status).toBe(403);
    const standard = (await get(accountant, '/yield-standards')).body.data[0];
    expect((await patch(accountant, `/yield-standards/${standard.id}`, { version: standard.version, tolerancePercent: '6' })).status).toBe(403);
  });

  it('refuses a Storekeeper granted only at the cold room an order at the pens, and refuses any Storekeeper the yield standards', async () => {
    expect((await plan(coldStorekeeper, 'G-0145')).status).toBe(403);
    const standard = (await get(storekeeper, '/yield-standards')).body.data[0];
    expect((await patch(storekeeper, `/yield-standards/${standard.id}`, { version: standard.version, tolerancePercent: '6' })).status).toBe(403);
  });
});

describe('yield standards (FR-PRC-004)', () => {
  it('lists the seeded goat standards, refuses a second standard for the same pair, and refuses a stale version', async () => {
    const listed = await get(manager, '/yield-standards');
    expect(listed.body.data.map((s: { outputProduct: { sku: string }; expectedPercent: string; tolerancePercent: string }) => [s.outputProduct.sku, s.expectedPercent, s.tolerancePercent])).toEqual([
      ['MEAT-0007', '48', '5'],
      ['MEAT-0008', '11', '5'],
    ]);
    const duplicate = await post(manager, '/yield-standards', { inputProductId: id('product:LIV-0004'), outputProductId: id('product:MEAT-0007'), expectedPercent: '50' });
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.error.details).toEqual([expect.objectContaining({ code: 'STANDARD_EXISTS' })]);
    const standard = listed.body.data[0];
    const changed = await patch(manager, `/yield-standards/${standard.id}`, { version: standard.version, tolerancePercent: '6' });
    expect(changed.body).toMatchObject({ tolerancePercent: '6', version: standard.version + 1 });
    expect((await patch(manager, `/yield-standards/${standard.id}`, { version: standard.version, tolerancePercent: '7' })).status).toBe(409);
    const audit = await admin().query("SELECT 1 FROM platform.audit_event WHERE module = 'prc' AND entity_type = 'YieldStandard' AND action = 'UPDATE' AND entity_id = $1", [standard.id]);
    expect(audit.rowCount).toBe(1);
  });
});
