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
 * The reversing order (FR-PRC-011; A-162 as replaced by the owner, B06r; ADR-0048's pattern), over the real API on the
 * seeded farm: a completed order is frozen, and a mistake is corrected by reversing its movements through INV, only
 * while every output is unsold; the reversed goat is back in its pen, ALIVE, at exactly its prior cost. A reversal
 * valued at or above the adjustment threshold (50,000, copied onto the reversal) waits for a different approver with
 * step-up; below it the maker's reason posts it and the reversal is published for the exception report. Each seeded
 * goat at the pens carries 60,000 pesewas, so its order with 5,000 of labour reverses at 65,000.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let storekeeper: TestSession;
let approver: TestSession;
const wrong = new Map<string, TestSession>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const v1 = (path: string) => `/v1${path}`;
const post = (session: TestSession, path: string, body: object = {}, key?: string) => consolePost(api.server, session, v1(path), key).send(body);
const put = (session: TestSession, path: string, body: object) => consolePut(api.server, session, v1(path)).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, v1(path));
const admin = () => database.pool('admin');
const codes = (body: { error: { details: Array<{ code: string }> } }) => body.error.details.map((d) => d.code);
const poolOf = async (unitId: string) => (await admin().query<{ qty: string; value: string }>('SELECT qty::text, value_pesewas::text AS value FROM inv.cost_pool WHERE stock_unit_id = $1', [unitId])).rows[0];
const GOAT_COST = 60_000;

async function refresh(): Promise<void> {
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'virtual:' || l.kind, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.is_virtual
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier
       UNION ALL SELECT 'unit:' || identifier, id FROM inv.stock_unit`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
}

async function process(tag: string): Promise<{ orderId: string; lots: string[]; body: Record<string, unknown> }> {
  const planned = await post(manager, '/processing-orders', { locationId: id('location:PENS'), outputLocationId: id('location:COLD'), inputs: [{ stockUnitId: id(`unit:${tag}`), weightKg: '30.000', weightSource: 'SCALE' }] });
  expect(planned.status, JSON.stringify(planned.body)).toBe(201);
  const orderId = planned.body.id as string;
  expect((await post(manager, `/processing-orders/${orderId}/costs`, { costKind: 'LABOUR', amountPesewas: 5_000, description: 'Slaughter and dressing, two hands' })).status).toBe(201);
  expect((await post(manager, `/processing-orders/${orderId}/start`)).status).toBe(200);
  const version = (await get(manager, `/processing-orders/${orderId}`)).body.version as number;
  const recorded = await put(manager, `/processing-orders/${orderId}/outputs`, {
    version,
    outputs: [
      { productId: id('product:MEAT-GOAT-15KG'), outputKind: 'MEAT', weightKg: '14.200', weightSource: 'SCALE' },
      { productId: id('product:BYP-GOAT-OFFAL'), outputKind: 'OFFAL', weightKg: '3.300', weightSource: 'SCALE' },
      { productId: id('product:BYP-GOAT-OFFAL'), outputKind: 'WASTE', weightKg: '8.000', weightSource: 'MANUAL' },
    ],
  });
  expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
  const completed = await post(manager, `/processing-orders/${orderId}/complete`);
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  await refresh();
  const lots = (completed.body.outputs as Array<{ stockUnit: { id: string } | null }>).flatMap((o) => (o.stockUnit === null ? [] : [o.stockUnit.id]));
  return { orderId, lots, body: completed.body };
}

/** A goat bought from Kpone into the pens at its own value. */
async function buyGoat(tag: string, valuePesewas: number): Promise<void> {
  const created = await post(manager, '/goods-receipts', {
    kind: 'PURCHASE',
    supplierId: id('supplier:Kpone Livestock Traders (SEED)'),
    locationId: id('location:PENS'),
    deliveryNoteRef: `RV-${randomUUID().slice(0, 8)}`,
    receivedAt: new Date(clock.now().getTime() - 86_400_000).toISOString(),
    lines: [{ productId: id('product:LIV-GOAT'), qtyReceived: '1.000', valuePesewas, animals: [{ tagNo: tag, sex: 'MALE', breed: 'West African Dwarf', purpose: 'GROWING' }] }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await post(manager, `/goods-receipts/${created.body.id as string}/post`)).status).toBe(200);
  await refresh();
}

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
  approver = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Darko', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  storekeeper = await login(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'STOREKEEPER', branchId }] }));
  for (const role of ['CASHIER', 'SALES', 'DRIVER', 'FARM_HAND', 'INVESTOR'] as const satisfies readonly RoleCode[]) {
    wrong.set(role, await login(api.server, await createUser(database, { name: `Wrong ${role.toLowerCase()}`, grants: [{ role, branchId }] })));
  }
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('a completed order is frozen and reverses only while its outputs are unsold (FR-PRC-011)', () => {
  let orderId: string;
  let lots: string[];
  let requestId: string;

  it('refuses an edit of a completed order, in the API and in the database', async () => {
    ({ orderId, lots } = await process('G-0142'));
    expect(await poolOf(id('unit:G-0142'))).toEqual({ qty: '0.000', value: '0' });
    expect(await sqlStateOf(admin().query('UPDATE prc.processing_order SET total_cost_pesewas = 1 WHERE id = $1', [orderId]))).toBe(SQLSTATE.documentFrozen);
    const packed = await post(storekeeper, `/processing-orders/${orderId}/packs`, { outputLineNo: 1, packs: [{ weightKg: '7.100', weightSource: 'SCALE' }, { weightKg: '7.100', weightSource: 'SCALE' }] });
    expect(packed.status, JSON.stringify(packed.body)).toBe(201);
  });

  it('refuses the Storekeeper, who may cancel an order not yet completed, and every other role but the Owner and Manager', async () => {
    const refused = await post(storekeeper, `/processing-orders/${orderId}/cancel`, { reason: 'Wrong goat slaughtered' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    for (const [role, session] of wrong) {
      expect((await post(session, `/processing-orders/${orderId}/cancel`, { reason: 'Wrong goat' })).status, role).toBe(403);
    }
  });

  it('waits at 65,000, at or above the 50,000 adjustment threshold, for a different approver, and moves nothing meanwhile', async () => {
    const key = randomUUID();
    const asked = await post(manager, `/processing-orders/${orderId}/cancel`, { reason: 'Wrong goat slaughtered, the order named G-0142' }, key);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(contractSchema('ApprovalPending')(asked.body)).toBe(true);
    expect(asked.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'PROCESSING_REVERSAL', subject: { docType: 'PROCESSING_REVERSAL', number: null } });
    requestId = asked.body.approvalRequestId as string;
    expect((await post(manager, `/processing-orders/${orderId}/cancel`, { reason: 'Wrong goat slaughtered, the order named G-0142' }, key)).body).toEqual(asked.body);

    const order = await get(manager, `/processing-orders/${orderId}`);
    expect(contractSchema('ProcessingOrder')(order.body)).toBe(true);
    expect(order.body.reversal).toBeNull();
    expect(order.body.pendingReversal).toMatchObject({ id: asked.body.subject.id, valuePesewas: GOAT_COST + 5_000, thresholdPesewas: 50_000, approvalRequestId: requestId, requestedBy: { displayName: 'Akosua Boateng' } });
    expect(await poolOf(id('unit:G-0142'))).toEqual({ qty: '0.000', value: '0' });
    for (const lot of lots) expect((await poolOf(lot))!.qty).not.toBe('0.000');
    const row = await admin().query('SELECT status, value_pesewas::int AS value, threshold_pesewas::int AS threshold FROM prc.processing_reversal WHERE processing_order_id = $1', [orderId]);
    expect(row.rows).toEqual([{ status: 'PENDING_APPROVAL', value: 65_000, threshold: 50_000 }]);

    const twice = await post(manager, `/processing-orders/${orderId}/cancel`, { reason: 'Asking again' });
    expect(twice.status).toBe(422);
    expect(codes(twice.body)).toEqual(['REVERSAL_PENDING']);
  });

  it('finds the order from its approval request\'s subject: listProcessingOrders by reversalId answers that order alone (CR-027)', async () => {
    const request = await get(approver, `/iam/approvals/${requestId}`);
    expect(request.status, JSON.stringify(request.body)).toBe(200);
    // The request's subject stays the reversal; the order is one read away by it.
    expect(request.body.subject).toMatchObject({ docType: 'PROCESSING_REVERSAL' });
    const reversalId = request.body.subject.id as string;
    const found = await get(manager, `/processing-orders?reversalId=${reversalId}`);
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body.data.map((o: { id: string }) => o.id)).toEqual([orderId]);
    expect(found.body.data[0].pendingReversal.id).toBe(reversalId);
    expect(found.body.page).toEqual({ nextCursor: null, limit: 25, hasMore: false });
    expect((await get(manager, `/processing-orders?reversalId=${randomUUID()}`)).body.data).toEqual([]);
    expect((await get(manager, '/processing-orders?reversalId=not-a-uuid')).status).toBe(400);
    for (const [role, session] of wrong) expect((await get(session, `/processing-orders?reversalId=${reversalId}`)).status, role).toBe(403);
  });

  it('keeps the threshold it was judged against: raising the policy afterwards changes nothing on the reversal', async () => {
    await admin().query("UPDATE iam.approval_policy SET threshold_pesewas = 100000, version = version + 1 WHERE kind = 'STOCK_WRITE_OFF' AND branch_id IS NULL");
    expect((await get(manager, `/processing-orders/${orderId}`)).body.pendingReversal.thresholdPesewas).toBe(50_000);
    await admin().query("UPDATE iam.approval_policy SET threshold_pesewas = 50000, version = version + 1 WHERE kind = 'STOCK_WRITE_OFF' AND branch_id IS NULL");
  });

  it('refuses the maker as checker and the Storekeeper as approver', async () => {
    const own = await post(manager, `/iam/approvals/${requestId}/approve`, {});
    expect(own.status).toBe(422);
    expect(own.body.error.code).toBe('MAKER_CANNOT_CHECK');
    expect((await post(storekeeper, `/iam/approvals/${requestId}/approve`, {})).status).toBe(403);
    for (const [role, session] of wrong) expect((await post(session, `/iam/approvals/${requestId}/approve`, {})).status, role).toBe(403);
  });

  it('reverses it on the second manager\'s approval: the goat is back in the pens, ALIVE, at exactly its prior 60,000, the lots are empty and the packs REVERSED', async () => {
    const approved = await post(approver, `/iam/approvals/${requestId}/approve`, { reason: 'Checked the slaughter sheet' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const reversed = await get(manager, `/processing-orders/${orderId}`);
    expect(contractSchema('ProcessingOrder')(reversed.body)).toBe(true);
    expect(reversed.body).toMatchObject({
      id: orderId,
      status: 'COMPLETED',
      pendingReversal: null,
      reversal: {
        reason: 'Wrong goat slaughtered, the order named G-0142',
        reversedBy: { displayName: 'Akosua Boateng' },
        approvedBy: { displayName: 'Yaw Darko' },
        approvalRequestId: requestId,
        valuePesewas: 65_000,
        thresholdPesewas: 50_000,
      },
    });

    expect(await poolOf(id('unit:G-0142'))).toEqual({ qty: '1.000', value: String(GOAT_COST) });
    for (const lot of lots) expect(await poolOf(lot)).toEqual({ qty: '0.000', value: '0' });
    const goat = await get(manager, `/animals/${id('unit:G-0142')}`);
    expect(goat.body).toMatchObject({ status: 'ALIVE', accumulatedCostPesewas: GOAT_COST, currentLocation: { code: 'PENS' } });

    const movements = await admin().query<{ movement_type: string; value: string; reverses: boolean; source: string }>(
      `SELECT r.movement_type, r.value_pesewas::text AS value, r.reverses_movement_id = o.id AS reverses, r.source_document_id::text AS source
         FROM inv.stock_movement o JOIN inv.stock_movement r ON r.reverses_movement_id = o.id
        WHERE o.source_document_id = $1 ORDER BY r.movement_type`,
      [orderId],
    );
    expect(movements.rows.map((m) => [m.movement_type, m.value, m.reverses, m.source === reversed.body.reversal.id])).toEqual([
      ['PROCESS_CONSUME', String(GOAT_COST), true, true],
      ['PROCESS_OUTPUT', expect.any(String), true, true],
      ['PROCESS_OUTPUT', expect.any(String), true, true],
    ]);
    const outputs = movements.rows.filter((m) => m.movement_type === 'PROCESS_OUTPUT').reduce((sum, m) => sum + Number(m.value), 0);
    expect(outputs).toBe(GOAT_COST + 5_000);

    const packs = await get(manager, `/processing-orders/${orderId}/packs`);
    expect(packs.body.data.map((p: { status: string }) => p.status)).toEqual(['REVERSED', 'REVERSED']);
    const events = await admin().query<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'prc.ProcessingOrderReversed' AND subject_id = $1", [orderId]);
    expect(events.rows).toEqual([
      {
        payload: expect.objectContaining({
          processingOrderId: orderId,
          directCostPesewas: 5_000,
          inputCostPesewas: GOAT_COST,
          totalCostPesewas: GOAT_COST + 5_000,
          valuePesewas: GOAT_COST + 5_000,
          thresholdPesewas: 50_000,
          needsApproval: true,
          approvalRequestId: requestId,
          abuseCases: [29],
        }),
      },
    ]);
    const audit = await admin().query("SELECT 1 FROM platform.audit_event WHERE module = 'prc' AND action = 'REVERSE' AND entity_id = $1", [orderId]);
    expect(audit.rowCount).toBe(1);
  });

  it('refuses a second reversal, packing the reversed order, and an edit of the reversal in the database', async () => {
    const again = await post(manager, `/processing-orders/${orderId}/cancel`, { reason: 'Again' });
    expect(again.status).toBe(422);
    expect(codes(again.body)).toEqual(['ORDER_REVERSED']);
    expect(await sqlStateOf(admin().query("UPDATE prc.processing_reversal SET reason = 'x', version = version + 1 WHERE processing_order_id = $1", [orderId]))).toBe(SQLSTATE.documentFrozen);
    expect((await get(manager, `/processing-orders/${orderId}`)).body.reversal).not.toBeNull();
  });

  it('lets the goat be processed again, since it is back in its pen', async () => {
    const replanned = await post(manager, '/processing-orders', { locationId: id('location:PENS'), outputLocationId: id('location:COLD'), inputs: [{ stockUnitId: id('unit:G-0142'), weightKg: '30.000', weightSource: 'SCALE' }] });
    expect(replanned.status, JSON.stringify(replanned.body)).toBe(201);
    expect(replanned.body.inputs[0].costPesewas).toBe(GOAT_COST);
  });
});

describe('a reversal refuses an order whose outputs are not all unsold (FR-PRC-011)', () => {
  it('returns 422 OUTPUT_SOLD when 1.000 kg of the meat lot is sold, and moves nothing', async () => {
    const { orderId, lots } = await process('G-0143');
    await sellFromLot(lots[0]!, '1.000');
    const before = await admin().query('SELECT count(*)::int AS n FROM inv.stock_movement');
    const refused = await post(manager, `/processing-orders/${orderId}/cancel`, { reason: 'Wrong goat' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(codes(refused.body)).toEqual(['OUTPUT_SOLD']);
    expect((await admin().query('SELECT count(*)::int AS n FROM inv.stock_movement')).rows).toEqual(before.rows);
    expect((await get(manager, `/animals/${id('unit:G-0143')}`)).body.status).toBe('SLAUGHTERED');
  });

  it('returns 422 OUTPUT_SOLD when a pack of the lot has been picked for an order', async () => {
    const { orderId } = await process('G-0144');
    const packed = await post(storekeeper, `/processing-orders/${orderId}/packs`, { outputLineNo: 1, packs: [{ weightKg: '14.200', weightSource: 'SCALE' }] });
    expect(packed.status).toBe(201);
    await admin().query("UPDATE prc.pack SET status = 'PICKED', version = version + 1 WHERE id = $1", [packed.body.packs[0].id]);
    const refused = await post(manager, `/processing-orders/${orderId}/cancel`, { reason: 'Wrong goat' });
    expect(codes(refused.body)).toEqual(['OUTPUT_SOLD']);
  });
});

describe('below the threshold the maker\'s reason posts the reversal, and it reaches the exception report\'s sources (ADR-0048 pattern)', () => {
  it('reverses a 30,000 goat\'s order (35,000 with its labour) at once, with the threshold on the document', async () => {
    await buyGoat('RV-G01', 30_000);
    const { orderId } = await process('RV-G01');
    const reversed = await post(manager, `/processing-orders/${orderId}/cancel`, { reason: 'Slaughtered for an order the buyer cancelled the same hour' });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect(contractSchema('ProcessingOrder')(reversed.body)).toBe(true);
    expect(reversed.body.reversal).toMatchObject({ valuePesewas: 35_000, thresholdPesewas: 50_000, approvalRequestId: null, approvedBy: null, reversedBy: { displayName: 'Akosua Boateng' } });
    expect(await poolOf(id('unit:RV-G01'))).toEqual({ qty: '1.000', value: '30000' });
    const events = await admin().query<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'prc.ProcessingOrderReversed' AND subject_id = $1", [orderId]);
    expect(events.rows).toEqual([
      { payload: expect.objectContaining({ valuePesewas: 35_000, thresholdPesewas: 50_000, needsApproval: false, approvalRequestId: null, approvedBy: null, reason: 'Slaughtered for an order the buyer cancelled the same hour', abuseCases: [29] }) },
    ]);
  });

  it('requires the reason: an empty or missing one is refused before anything is judged', async () => {
    await buyGoat('RV-G02', 30_000);
    const { orderId } = await process('RV-G02');
    expect((await post(manager, `/processing-orders/${orderId}/cancel`, { reason: '' })).status).toBe(400);
    expect((await post(manager, `/processing-orders/${orderId}/cancel`, {})).status).toBe(400);
    expect((await get(manager, `/processing-orders/${orderId}`)).body.reversal).toBeNull();
  });
});

describe('a reversal is refused outright once a pack it produced has been sold or moved, by the domain and the database (FR-PRC-011)', () => {
  it('refuses the approval of a waiting reversal once a pack has been picked meanwhile, and nothing moves', async () => {
    const { orderId } = await process('G-0145');
    const packed = await post(storekeeper, `/processing-orders/${orderId}/packs`, { outputLineNo: 1, packs: [{ weightKg: '14.200', weightSource: 'SCALE' }] });
    expect(packed.status).toBe(201);
    const asked = await post(manager, `/processing-orders/${orderId}/cancel`, { reason: 'Wrong goat' });
    expect(asked.status).toBe(202);
    await admin().query("UPDATE prc.pack SET status = 'PICKED', version = version + 1 WHERE id = $1", [packed.body.packs[0].id]);
    const before = await admin().query('SELECT count(*)::int AS n FROM inv.stock_movement');
    const refused = await post(approver, `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, {});
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error.code).toBe('APPROVAL_SUBJECT_CHANGED');
    expect((await admin().query('SELECT count(*)::int AS n FROM inv.stock_movement')).rows).toEqual(before.rows);
    expect((await get(manager, `/animals/${id('unit:G-0145')}`)).body.status).toBe('SLAUGHTERED');
    // Rejected, it frees the order for a reversal asked again, which is refused outright while the pack is picked.
    expect((await post(approver, `/iam/approvals/${asked.body.approvalRequestId as string}/reject`, { reason: 'The pack has gone to the counter' })).status).toBe(200);
    const again = await post(manager, `/processing-orders/${orderId}/cancel`, { reason: 'Wrong goat' });
    expect(codes(again.body)).toEqual(['OUTPUT_SOLD']);
  });

  it('refuses, in the database alone, a POSTED reversal of an order one of whose packs is picked, sold or written off', async () => {
    const order = (await admin().query<{ id: string; branch_id: string }>(
      `SELECT o.id, o.branch_id FROM prc.processing_order o JOIN prc.processing_output po ON po.processing_order_id = o.id JOIN prc.pack p ON p.processing_output_id = po.id
        WHERE p.status = 'PICKED' AND NOT EXISTS (SELECT 1 FROM prc.processing_reversal r WHERE r.processing_order_id = o.id AND r.status <> 'REJECTED') LIMIT 1`,
    )).rows[0]!;
    const documentId = randomUUID();
    await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'PROCESSING_REVERSAL', 'prc', $2, $3)", [documentId, order.branch_id, SYSTEM_PRINCIPAL]);
    const refused = await admin()
      .query(
        `INSERT INTO prc.processing_reversal (id, processing_order_id, branch_id, reason, status, value_pesewas, threshold_pesewas, posted_at, posted_by, created_by, updated_by)
         VALUES ($1, $2, $3, 'Straight into the table', 'POSTED', 1000, 50000, now(), $4, $4, $4)`,
        [documentId, order.id, order.branch_id, SYSTEM_PRINCIPAL],
      )
      .then(
        () => null,
        (error: { constraint?: string }) => error.constraint ?? 'refused',
      );
    expect(refused).toBe('ck_processing_reversal_unsold');
  });

  it('refuses, in the database, a POSTED reversal at or above its threshold without a different approver', async () => {
    await buyGoat('RV-G03', 30_000);
    const { orderId } = await process('RV-G03');
    const branchId = id('branch:DDW');
    const insert = async (approval: string | null, postedBy: string) => {
      const documentId = randomUUID();
      await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'PROCESSING_REVERSAL', 'prc', $2, $3)", [documentId, branchId, SYSTEM_PRINCIPAL]);
      return admin()
        .query(
          `INSERT INTO prc.processing_reversal (id, processing_order_id, branch_id, reason, status, value_pesewas, threshold_pesewas, approval_request_id, posted_at, posted_by, created_by, updated_by)
           VALUES ($1, $2, $3, 'Straight into the table', 'POSTED', 60000, 50000, $4, now(), $5, $6, $6)`,
          [documentId, orderId, branchId, approval, postedBy, SYSTEM_PRINCIPAL],
        )
        .then(
          () => null,
          (error: { constraint?: string }) => error.constraint ?? 'refused',
        );
    };
    expect(await insert(null, SYSTEM_PRINCIPAL)).toBe('ck_processing_reversal_approved');
    const anyRequest = (await admin().query<{ id: string }>('SELECT id FROM iam.approval_request LIMIT 1')).rows[0]!.id;
    expect(await insert(anyRequest, SYSTEM_PRINCIPAL)).toBe('ck_processing_reversal_approved');
  });
});
