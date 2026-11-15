import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { sqlStateOf, SQLSTATE } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Transfers, adjustments and reversals over the seeded farm (FR-INV-004, FR-INV-010 to FR-INV-012, ADR-0017,
 * ADR-0035, threat model "an adjustment used to hide a shortage"): every write refuses the wrong role and the wrong
 * location; stock moves through in-transit at an unchanged value; a shortfall on arrival needs its reason and is a
 * loss with an exception; an adjustment at or above 50,000 pesewas waits for a different person; a movement is
 * reversed once at its original value.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession & { readonly secret: Buffer };
let owner: TestSession & { readonly secret: Buffer };
let accountant: TestSession;
let coldStorekeeper: TestSession;
let shopStorekeeper: TestSession;
let cashier: TestSession;
let sales: TestSession;
let driver: TestSession;
let farmHand: TestSession;
const ids = new Map<string, string>();

const id = (code: string) => ids.get(code)!;
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');

async function stepUp(session: TestSession & { readonly secret: Buffer }): Promise<void> {
  clock.advanceBy(30_000);
  const response = await post(session, '/auth/step-up', { code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) });
  expect(response.status).toBe(200);
}

async function onHand(location: string, unit: string | null, sku: string): Promise<string> {
  const { rows } = await admin().query<{ qty: string }>(
    `SELECT COALESCE(sum(b.on_hand_qty), 0)::numeric(14,3)::text AS qty FROM inv.stock_balance b
      WHERE b.location_id = $1 AND b.product_id = $2 AND b.stock_unit_id IS NOT DISTINCT FROM $3`,
    [id(`location:${location}`), id(`product:${sku}`), unit === null ? null : id(`unit:${unit}`)],
  );
  return rows[0]!.qty;
}

async function stockValue(): Promise<string> {
  return (await admin().query<{ v: string }>('SELECT sum(value_pesewas)::text AS v FROM inv.cost_pool')).rows[0]!.v;
}

const beefTransfer = (qty = '10.000') => ({
  fromLocationId: id('location:COLD'),
  toLocationId: id('location:SHOP'),
  lines: [{ productId: id('product:MEAT-BEEF-15KG'), stockUnitId: id('unit:LOT-BEEF-2026-1110'), qty }],
});
const eggLoss = (qty: string, reasonCode = 'DAMAGED', note: string | undefined = 'Crates dropped off the shelf') => ({
  locationId: id('location:SHOP'),
  reasonCode,
  ...(note === undefined ? {} : { note }),
  lines: [{ productId: id('product:EGG-CRATE-BIG'), stockUnitId: id('unit:EGG-BIG-2026-1110'), direction: 'LOSS', qty }],
});

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
       UNION ALL SELECT 'unit:' || identifier, id FROM inv.stock_unit`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Nana Ama Korsah', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  coldStorekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:COLD') }] }));
  shopStorekeeper = await login(api.server, await createUser(database, { name: 'Efua Quaye', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:SHOP') }] }));
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: id('location:SHOP') }] }));
  sales = await login(api.server, await createUser(database, { name: 'Esi Appiah', grants: [{ role: 'SALES', branchId }] }));
  driver = await login(api.server, await createUser(database, { name: 'Selorm Agbeko', grants: [{ role: 'DRIVER', branchId }] }));
  farmHand = await login(api.server, await createUser(database, { name: 'Abdul-Rahman Iddrisu', grants: [{ role: 'FARM_HAND', branchId, locationId: id('location:PENS') }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('wrong roles are refused on every transfer, adjustment and reversal write (ADR-0035)', () => {
  let transferId: string;
  let adjustmentId: string;
  let movementId: string;
  beforeAll(async () => {
    transferId = (await post(coldStorekeeper, '/stock-transfers', beefTransfer('1.000'))).body.id as string;
    adjustmentId = (await post(shopStorekeeper, '/stock-adjustments', eggLoss('1.000'))).body.id as string;
    movementId = (await get(manager, `/stock-units/${id('unit:EGG-BIG-2026-1110')}/movements`)).body.data[0].id as string;
    expect([transferId, adjustmentId, movementId].every((v) => typeof v === 'string')).toBe(true);
  });

  const writes = (): ReadonlyArray<readonly [string, string, object]> => [
    ['createStockTransfer', '/stock-transfers', beefTransfer('1.000')],
    ['dispatchStockTransfer', `/stock-transfers/${transferId}/dispatch`, {}],
    ['receiveStockTransfer', `/stock-transfers/${transferId}/receive`, { lines: [] }],
    ['cancelStockTransfer', `/stock-transfers/${transferId}/cancel`, { reason: 'Refused' }],
    ['createStockAdjustment', '/stock-adjustments', eggLoss('1.000')],
    ['submitStockAdjustment', `/stock-adjustments/${adjustmentId}/submit`, {}],
    ['reverseStockMovement', `/stock/movements/${movementId}/reverse`, { reasonCode: 'COUNT_ERROR', note: 'Refused' }],
  ];

  it('the Accountant, Cashier, Sales, Driver and Farm hand are refused with 403 FORBIDDEN on all seven writes, each refusal audited, and nothing moves', async () => {
    const count = async () => (await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'")).rows[0]!.n;
    const movements = async () => (await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM inv.stock_movement')).rows[0]!.n;
    const before = await count();
    const moved = await movements();
    for (const [op, path, body] of writes()) {
      for (const [role, session] of Object.entries({ accountant, cashier, sales, driver, farmHand })) {
        const response = await post(session, path, body);
        expect(response.status, `${op} as ${role}`).toBe(403);
        expect(response.body.error.code).toBe('FORBIDDEN');
      }
    }
    expect((await count()) - before).toBe(35);
    expect(await movements()).toBe(moved);
  });

  it('a storekeeper at the shop cannot draft, dispatch or cancel a cold room transfer, nor adjust or reverse at the cold room; the cold room one cannot receive at the shop', async () => {
    expect((await post(shopStorekeeper, '/stock-transfers', beefTransfer('1.000'))).status).toBe(403);
    expect((await post(shopStorekeeper, `/stock-transfers/${transferId}/dispatch`)).status).toBe(403);
    expect((await post(shopStorekeeper, `/stock-transfers/${transferId}/cancel`, { reason: 'Not mine' })).status).toBe(403);
    expect((await post(coldStorekeeper, '/stock-adjustments', eggLoss('1.000'))).status).toBe(403);
    expect((await post(coldStorekeeper, `/stock-adjustments/${adjustmentId}/submit`)).status).toBe(403);
    expect((await post(coldStorekeeper, `/stock/movements/${movementId}/reverse`, { reasonCode: 'COUNT_ERROR', note: 'Not mine' })).status).toBe(403);
    expect((await post(coldStorekeeper, `/stock-transfers/${transferId}/dispatch`)).status).toBe(200);
    expect((await post(coldStorekeeper, `/stock-transfers/${transferId}/receive`, { lines: [] })).status).toBe(403);
  });

  it('reads are refused to the Cashier, Sales and Driver; the Accountant reads all three', async () => {
    for (const session of [cashier, sales, driver]) {
      for (const path of ['/stock/movements', '/stock-transfers', '/stock-adjustments']) {
        expect((await get(session, path)).status).toBe(403);
      }
    }
    for (const path of ['/stock/movements', '/stock-transfers', '/stock-adjustments', `/stock-transfers/${transferId}`, `/stock-adjustments/${adjustmentId}`, `/stock/movements/${movementId}`]) {
      expect((await get(accountant, path)).status, path).toBe(200);
    }
  });

  it('the shop storekeeper receives the cold room transfer at the shop, and sees it as its destination', async () => {
    const transfer = (await get(shopStorekeeper, `/stock-transfers/${transferId}`)).body;
    expect(transfer.status).toBe('DISPATCHED');
    const received = await post(shopStorekeeper, `/stock-transfers/${transferId}/receive`, { lines: [{ lineId: transfer.lines[0].id, qtyReceived: '1.000' }] });
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    expect(received.body.status).toBe('RECEIVED');
  });
});

describe('a transfer through in-transit, received with a variance (FR-INV-010, FR-INV-011)', () => {
  let transfer: { id: string; lines: Array<{ id: string }> };

  it('dispatching 10.000 kg of beef from the cold room leaves it there 10.000 kg lower, puts 10.000 kg in transit, and keeps the stock value exactly', async () => {
    const coldBefore = await onHand('COLD', 'LOT-BEEF-2026-1110', 'MEAT-BEEF-15KG');
    const valueBefore = await stockValue();
    const created = await post(coldStorekeeper, '/stock-transfers', beefTransfer());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ status: 'DRAFT', transferNo: null, lines: [{ lineNo: 1, qtyDispatched: '10.000', qtyReceived: null, uom: 'KG' }] });
    transfer = created.body;
    const dispatched = await post(coldStorekeeper, `/stock-transfers/${transfer.id}/dispatch`);
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200);
    expect(dispatched.body.status).toBe('DISPATCHED');
    expect(await onHand('COLD', 'LOT-BEEF-2026-1110', 'MEAT-BEEF-15KG')).toBe((Number(coldBefore) - 10).toFixed(3));
    expect(await onHand('TRANSIT', 'LOT-BEEF-2026-1110', 'MEAT-BEEF-15KG')).toBe('10.000');
    expect(await stockValue()).toBe(valueBefore);
  });

  it('refuses 9.800 received with no reason for the 0.200 kg shortfall with 422 TRANSFER_VARIANCE, and posts nothing', async () => {
    const refused = await post(shopStorekeeper, `/stock-transfers/${transfer.id}/receive`, { lines: [{ lineId: transfer.lines[0]!.id, qtyReceived: '9.800' }] });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'TRANSFER_VARIANCE', details: [{ field: '/lines/0/varianceReasonCode', code: 'VARIANCE_REASON_REQUIRED' }] });
    const wrongReason = await post(shopStorekeeper, `/stock-transfers/${transfer.id}/receive`, { lines: [{ lineId: transfer.lines[0]!.id, qtyReceived: '9.800', varianceReasonCode: 'REGULAR_CUSTOMER' }] });
    expect(wrongReason.body.error.details).toEqual([expect.objectContaining({ code: 'REASON_NOT_ALLOWED' })]);
    expect(await onHand('TRANSIT', 'LOT-BEEF-2026-1110', 'MEAT-BEEF-15KG')).toBe('10.000');
  });

  it('receives 9.800 kg into the shop and posts the 0.200 kg variance as a loss valued 2,400 pesewas, with a TRANSFER_VARIANCE exception', async () => {
    const valueBefore = BigInt(await stockValue());
    const shopBefore = await onHand('SHOP', 'LOT-BEEF-2026-1110', 'MEAT-BEEF-15KG');
    const received = await post(shopStorekeeper, `/stock-transfers/${transfer.id}/receive`, { lines: [{ lineId: transfer.lines[0]!.id, qtyReceived: '9.800', varianceReasonCode: 'DAMAGED' }] });
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    expect(received.body).toMatchObject({ status: 'RECEIVED', lines: [{ qtyDispatched: '10.000', qtyReceived: '9.800', varianceQty: '0.200', varianceReasonCode: 'DAMAGED' }] });
    expect(await onHand('TRANSIT', 'LOT-BEEF-2026-1110', 'MEAT-BEEF-15KG')).toBe('0.000');
    expect(await onHand('SHOP', 'LOT-BEEF-2026-1110', 'MEAT-BEEF-15KG')).toBe((Number(shopBefore) + 9.8).toFixed(3));
    const loss = (
      await admin().query<{ value_pesewas: string; reason_code: string }>(
        "SELECT value_pesewas, reason_code FROM inv.stock_movement WHERE source_document_id = $1 AND movement_type = 'ADJUST_LOSS'",
        [transfer.id],
      )
    ).rows;
    // The lot's pool: 45.000 kg bought for 540,000, so 0.200 kg carries half_up(540,000 x 0.2 / 45) = 2,400.
    expect(loss).toEqual([{ value_pesewas: '2400', reason_code: 'DAMAGED' }]);
    expect(valueBefore - BigInt(await stockValue())).toBe(2_400n);
    const exceptions = (await admin().query<{ kind: string; qty: string; status: string }>('SELECT kind, qty, status FROM inv.stock_exception WHERE source_document_id = $1', [transfer.id])).rows;
    expect(exceptions).toEqual([{ kind: 'TRANSFER_VARIANCE', qty: '0.200', status: 'OPEN' }]);
  });

  it('a received transfer is final: receiving again or cancelling is 422 INVALID_STATE_TRANSITION, and the database refuses a change', async () => {
    expect((await post(shopStorekeeper, `/stock-transfers/${transfer.id}/receive`, { lines: [] })).body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect((await post(coldStorekeeper, `/stock-transfers/${transfer.id}/cancel`, { reason: 'Too late' })).body.error.code).toBe('INVALID_STATE_TRANSITION');
    const app = database.pool('app');
    expect(await sqlStateOf(app.query("UPDATE inv.stock_transfer SET status = 'DRAFT' WHERE id = $1", [transfer.id]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query("UPDATE inv.stock_transfer_line SET qty_received = '10.000', variance_qty = '0.000', variance_reason_code = NULL WHERE stock_transfer_id = $1", [transfer.id]))).toBe(
      SQLSTATE.documentFrozen,
    );
  });

  it('a transfer to the same place, or of more than one goat on a line, is refused with STOCK_TRANSFER_INVALID; a draft is cancelled with its reason', async () => {
    const same = await post(coldStorekeeper, '/stock-transfers', { ...beefTransfer(), toLocationId: id('location:COLD') });
    expect(same.body.error).toMatchObject({ code: 'STOCK_TRANSFER_INVALID', details: [{ field: '/toLocationId', code: 'SAME_LOCATION' }] });
    const goats = await post(manager, '/stock-transfers', { fromLocationId: id('location:PENS'), toLocationId: id('location:SHOP'), lines: [{ productId: id('product:LIV-GOAT'), stockUnitId: id('unit:G-0144'), qty: '2.000' }] });
    expect(goats.body.error.details).toEqual([expect.objectContaining({ code: 'WHOLE_ANIMALS_ONLY' })]);
    const draft = await post(coldStorekeeper, '/stock-transfers', beefTransfer('1.000'));
    const cancelled = await post(coldStorekeeper, `/stock-transfers/${draft.body.id as string}/cancel`, { reason: 'Van not available today' });
    expect(cancelled.body.status).toBe('CANCELLED');
  });
});

describe('an adjustment needs approval at or above the threshold, by someone else (FR-INV-012, abuse case: an adjustment used to hide a shortage)', () => {
  it('a loss of 12 crates of eggs valued 3,500 each (42,000) posts at once', async () => {
    const before = await onHand('SHOP', 'EGG-BIG-2026-1110', 'EGG-CRATE-BIG');
    const created = await post(shopStorekeeper, '/stock-adjustments', eggLoss('12.000'));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ status: 'DRAFT', totalValuePesewas: 42_000, lines: [{ valuePesewas: 42_000, movementId: null }] });
    const submitted = await post(shopStorekeeper, `/stock-adjustments/${created.body.id as string}/submit`);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body).toMatchObject({ status: 'POSTED', totalValuePesewas: 42_000, approvalRequestId: null });
    expect(submitted.body.lines[0].movementId).toEqual(expect.any(String));
    expect(await onHand('SHOP', 'EGG-BIG-2026-1110', 'EGG-CRATE-BIG')).toBe((Number(before) - 12).toFixed(3));
  });

  it('a loss of 15 crates (52,500) returns 202 and leaves stock unchanged; the maker cannot approve it; a different manager approves and it posts', async () => {
    const before = await onHand('SHOP', 'EGG-BIG-2026-1110', 'EGG-CRATE-BIG');
    const created = await post(manager, '/stock-adjustments', eggLoss('15.000', 'THEFT_SUSPECTED', 'Crates missing after the night shift'));
    expect(created.body.totalValuePesewas).toBe(52_500);
    const submitted = await post(manager, `/stock-adjustments/${created.body.id as string}/submit`);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
    expect(submitted.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'STOCK_WRITE_OFF', subject: { id: created.body.id, docType: 'STOCK_ADJUSTMENT' } });
    expect(await onHand('SHOP', 'EGG-BIG-2026-1110', 'EGG-CRATE-BIG')).toBe(before);
    expect((await get(manager, `/stock-adjustments/${created.body.id as string}`)).body.status).toBe('PENDING_APPROVAL');

    await stepUp(manager);
    const self = await post(manager, `/iam/approvals/${submitted.body.approvalRequestId as string}/approve`, { reason: 'My own' });
    expect(self.status).toBe(422);
    expect(self.body.error.code).toBe('MAKER_CANNOT_CHECK');
    expect(await onHand('SHOP', 'EGG-BIG-2026-1110', 'EGG-CRATE-BIG')).toBe(before);

    await stepUp(owner);
    const approved = await post(owner, `/iam/approvals/${submitted.body.approvalRequestId as string}/approve`, { reason: 'Checked the night log' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const posted = (await get(manager, `/stock-adjustments/${created.body.id as string}`)).body;
    expect(posted).toMatchObject({ status: 'POSTED', totalValuePesewas: 52_500, postedBy: { displayName: 'Nana Ama Korsah' } });
    expect(await onHand('SHOP', 'EGG-BIG-2026-1110', 'EGG-CRATE-BIG')).toBe((Number(before) - 15).toFixed(3));
  });

  it('a rejected adjustment is final and moved nothing', async () => {
    const yam = { locationId: id('location:SHOP'), reasonCode: 'SPOILED', note: 'Rotten at the core', lines: [{ productId: id('product:PRD-YAM-TUBER'), direction: 'LOSS', qty: '40.000' }] };
    const created = await post(shopStorekeeper, '/stock-adjustments', yam);
    expect(created.body.totalValuePesewas).toBe(48_000);
    const gain = await post(shopStorekeeper, '/stock-adjustments', { ...yam, reasonCode: 'FOUND_STOCK', note: 'Sack behind the counter', lines: [{ ...yam.lines[0], direction: 'GAIN', qty: '50.000' }] });
    // Found yam is booked at the pool's average: 50 x 48,000 / 40 = 60,000.
    expect(gain.body.totalValuePesewas).toBe(60_000);
    const submitted = await post(shopStorekeeper, `/stock-adjustments/${gain.body.id as string}/submit`);
    expect(submitted.status).toBe(202);
    await stepUp(manager);
    const rejected = await post(manager, `/iam/approvals/${submitted.body.approvalRequestId as string}/reject`, { reason: 'Count it again first' });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect((await get(manager, `/stock-adjustments/${gain.body.id as string}`)).body.status).toBe('REJECTED');
    expect(await onHand('SHOP', null, 'PRD-YAM-TUBER')).toBe('40.000');
  });

  it('a reason outside the adjustment and wastage lists, a missing note and an animal are refused with STOCK_ADJUSTMENT_INVALID', async () => {
    expect((await post(shopStorekeeper, '/stock-adjustments', eggLoss('1.000', 'REGULAR_CUSTOMER'))).body.error).toMatchObject({ code: 'STOCK_ADJUSTMENT_INVALID', details: [{ field: '/reasonCode', code: 'REASON_NOT_ALLOWED' }] });
    expect((await post(shopStorekeeper, '/stock-adjustments', { ...eggLoss('1.000', 'THEFT_SUSPECTED'), note: undefined })).body.error.details).toEqual([expect.objectContaining({ code: 'NOTE_REQUIRED' })]);
    const goat = await post(manager, '/stock-adjustments', { locationId: id('location:PENS'), reasonCode: 'COUNT_ERROR', note: 'Hidden goat', lines: [{ productId: id('product:LIV-GOAT'), stockUnitId: id('unit:G-0145'), direction: 'LOSS', qty: '1.000' }] });
    expect(goat.body.error.details).toEqual([expect.objectContaining({ code: 'ANIMAL_NOT_ADJUSTED' })]);
    expect((await post(shopStorekeeper, '/stock-adjustments', eggLoss('1.000', 'NOT_A_REASON'))).body.error.code).toBe('REFERENCE_NOT_FOUND');
  });

  it('the database refuses an adjustment posted at or above its threshold without an approval, whoever writes', async () => {
    const created = await post(shopStorekeeper, '/stock-adjustments', eggLoss('1.000'));
    const app = database.pool('app');
    const refused = (await app
      .query("UPDATE inv.stock_adjustment SET status = 'POSTED', total_value_pesewas = 60000, approval_threshold_pesewas = 50000, posted_at = now(), posted_by = created_by, version = version + 1 WHERE id = $1", [created.body.id])
      .catch((e: unknown) => e)) as { code?: string; constraint?: string };
    expect(refused).toMatchObject({ code: SQLSTATE.checkViolation, constraint: 'ck_stock_adjustment_approved' });
  });
});

describe('reversing a movement (FR-INV-004)', () => {
  let lossId: string;

  it('reverses a 3,500 pesewa egg loss at once with its original value, and on-hand returns to its prior figure', async () => {
    const created = await post(shopStorekeeper, '/stock-adjustments', eggLoss('1.000'));
    const submitted = await post(shopStorekeeper, `/stock-adjustments/${created.body.id as string}/submit`);
    lossId = submitted.body.lines[0].movementId as string;
    const before = await onHand('SHOP', 'EGG-BIG-2026-1110', 'EGG-CRATE-BIG');
    const reversed = await post(shopStorekeeper, `/stock/movements/${lossId}/reverse`, { reasonCode: 'COUNT_ERROR', note: 'The crate was found intact' });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(201);
    expect(reversed.body).toMatchObject({ movementType: 'ADJUST_LOSS', reversesMovementId: lossId, valuePesewas: 3_500, qty: '1.000', reasonCode: 'COUNT_ERROR', sourceDocument: { docType: 'STOCK_REVERSAL' } });
    expect(await onHand('SHOP', 'EGG-BIG-2026-1110', 'EGG-CRATE-BIG')).toBe((Number(before) + 1).toFixed(3));
    expect((await get(manager, `/stock/movements/${lossId}`)).body.reversedByMovementId).toBe(reversed.body.id);
  });

  it('a second reversal is 422 STOCK_MOVEMENT_ALREADY_REVERSED, and a reversal of the reversal is not possible', async () => {
    const again = await post(shopStorekeeper, `/stock/movements/${lossId}/reverse`, { reasonCode: 'COUNT_ERROR', note: 'Again' });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('STOCK_MOVEMENT_ALREADY_REVERSED');
    const reversing = (await get(manager, `/stock/movements/${lossId}`)).body.reversedByMovementId as string;
    expect((await post(shopStorekeeper, `/stock/movements/${reversing}/reverse`, { reasonCode: 'COUNT_ERROR', note: 'Back again' })).body.error).toMatchObject({
      code: 'STOCK_REVERSAL_NOT_POSSIBLE',
      details: [{ code: 'REVERSAL_OF_A_REVERSAL' }],
    });
  });

  it("reversing sheep S-0031's 75,001 pesewa receipt waits for approval, and a different manager's approval posts it", async () => {
    const receipt = (await get(manager, `/stock-units/${id('unit:S-0031')}/movements`)).body.data.at(-1);
    expect(receipt).toMatchObject({ movementType: 'RECEIPT_PURCHASE', valuePesewas: 75_001 });
    const asked = await post(manager, `/stock/movements/${receipt.id as string}/reverse`, { reasonCode: 'RECEIPT_ERROR', note: 'The supplier took the sheep back at the gate' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ kind: 'STOCK_REVERSAL', subject: { docType: 'STOCK_REVERSAL' } });
    expect(await onHand('PENS', 'S-0031', 'LIV-SHEEP')).toBe('1.000');
    expect((await post(manager, `/stock/movements/${receipt.id as string}/reverse`, { reasonCode: 'RECEIPT_ERROR', note: 'Twice' })).body.error.code).toBe('STOCK_MOVEMENT_ALREADY_REVERSED');
    await stepUp(owner);
    const approved = await post(owner, `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Seen the supplier note' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await onHand('PENS', 'S-0031', 'LIV-SHEEP')).toBe('0.000');
    const reversal = (await get(manager, `/stock/movements/${receipt.id as string}`)).body.reversedByMovementId as string;
    expect((await get(manager, `/stock/movements/${reversal}`)).body).toMatchObject({ valuePesewas: 75_001, reversesMovementId: receipt.id, actor: { displayName: 'Nana Ama Korsah' } });
  });

  it("a transfer's movement is never reversed by hand, and a reason outside the stock adjustment list is refused", async () => {
    const dispatch = (await get(manager, '/stock/movements?movementType=TRANSFER_DISPATCH')).body.data[0];
    expect((await post(manager, `/stock/movements/${dispatch.id as string}/reverse`, { reasonCode: 'COUNT_ERROR', note: 'No' })).body.error.details).toEqual([expect.objectContaining({ code: 'TRANSFER_MOVEMENT' })]);
    const receipt = (await get(manager, `/stock-units/${id('unit:G-0145')}/movements`)).body.data.at(-1);
    expect((await post(manager, `/stock/movements/${receipt.id as string}/reverse`, { reasonCode: 'DAMAGED', note: 'No' })).body.error.details).toEqual([expect.objectContaining({ code: 'REASON_NOT_ALLOWED' })]);
  });
});

describe('the movement ledger over HTTP (FR-INV-001, FR-INV-002)', () => {
  it('lists the movement types, newest movements first, and a storekeeper sees only movements touching their location', async () => {
    const types = await get(shopStorekeeper, '/stock/movement-types?limit=100');
    expect(types.status).toBe(200);
    expect(types.body.data.find((t: { code: string }) => t.code === 'SALE_ISSUE_OFFLINE')).toMatchObject({ allowsNegative: true, blockedByHold: true });
    const all = (await get(manager, '/stock/movements?limit=100')).body.data as Array<{ id: string; from: { code: string }; to: { code: string } }>;
    expect(all.map((m) => m.id)).toEqual([...all.map((m) => m.id)].sort().reverse());
    const shop = (await get(shopStorekeeper, '/stock/movements?limit=100')).body.data as typeof all;
    expect(shop.length).toBeGreaterThan(0);
    expect(shop.every((m) => m.from.code === 'SHOP' || m.to.code === 'SHOP')).toBe(true);
    expect((await get(shopStorekeeper, `/stock-units/${id('unit:G-0142')}/movements`)).status).toBe(403);
  });
});
