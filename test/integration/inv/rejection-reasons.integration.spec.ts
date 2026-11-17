import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePatch, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Cracked on arrival (B09e continued 2, the owner's decision 5 of 2026-11-17; CR-035): a rejected quantity on a goods
 * receipt line carries its reason from the GOODS_RECEIPT_REJECTION domain (A-260) and, where the reason asks, a note;
 * a reason on nothing rejected is refused; the line answers both. A shop writes off broken eggs with the
 * STOCK_ADJUSTMENT reason BREAKAGE, which needs no note. The database refuses a rejected quantity without its reason.
 * Every write refuses the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let storekeeper: TestSession;
let cashier: TestSession;
const ids = new Map<string, string>();

const id = (code: string) => ids.get(code)!;
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');
const receivedAt = () => new Date(clock.now().getTime() - 3_600_000).toISOString();
const expiresOn = () => toBusinessDate(new Date(clock.now().getTime() + 14 * 86_400_000));

/** A delivery of big eggs from Awutu at the shop: one line, in crates, with whatever rejection the test names. */
function eggDelivery(line: Record<string, unknown>) {
  return {
    kind: 'PURCHASE',
    supplierId: id('supplier:Awutu Poultry Farm (SEED)'),
    locationId: id('location:SHOP'),
    deliveryNoteRef: `APF-${randomUUID().slice(0, 6)}`,
    receivedAt: receivedAt(),
    lines: [{ productId: id('product:EGG-0003'), uom: 'CRATE', qtyReceived: '9.000', valuePesewas: 42_750, batchNo: `EGG-${randomUUID().slice(0, 8)}`, expiresOn: expiresOn(), ...line }],
  };
}

const receipts = async () => (await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM inv.goods_receipt')).rows[0]!.n;

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
  storekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:SHOP') }] }));
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: id('location:SHOP') }] }));
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('the reasons for goods rejected at the door (A-260, CR-035 point 2)', () => {
  it('lists the GOODS_RECEIPT_REJECTION domain: CRACKED, BROKEN, DIRTY and SHORT need no note, a wrong item or a quality rejection does', async () => {
    const listed = await get(storekeeper, '/reason-codes?domain=GOODS_RECEIPT_REJECTION&limit=50');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const rows = (listed.body.data as { code: string; domain: string; requiresNote: boolean; lossAccountGroup: string | null }[]).map((r) => [r.code, r.domain, r.requiresNote, r.lossAccountGroup]);
    expect(rows.sort()).toEqual(
      [
        ['BROKEN', 'GOODS_RECEIPT_REJECTION', false, null],
        ['CRACKED', 'GOODS_RECEIPT_REJECTION', false, null],
        ['DIRTY', 'GOODS_RECEIPT_REJECTION', false, null],
        ['QUALITY_REJECTED', 'GOODS_RECEIPT_REJECTION', true, null],
        ['SHORT', 'GOODS_RECEIPT_REJECTION', false, null],
        ['WRONG_ITEM_DELIVERED', 'GOODS_RECEIPT_REJECTION', true, null],
      ].sort(),
    );
  });

  it('keeps a crate rejected as CRACKED on the line and answers its reason and note; an accepted-only line answers null', async () => {
    const draft = await post(storekeeper, '/goods-receipts', eggDelivery({ qtyRejected: '1.000', rejectionReasonCode: 'CRACKED', rejectionNote: 'Seven eggs cracked in the top tray' }));
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.lines[0]).toMatchObject({ uom: 'CRATE', qtyRejected: '1.000', qtyRejectedBase: '30.000', rejectionReasonCode: 'CRACKED', rejectionNote: 'Seven eggs cracked in the top tray' });
    const posted = await post(storekeeper, `/goods-receipts/${draft.body.id as string}/post`);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.lines[0]).toMatchObject({ rejectionReasonCode: 'CRACKED', rejectionNote: 'Seven eggs cracked in the top tray', valuePesewas: 42_750 });
    expect((await get(manager, `/goods-receipts/${draft.body.id as string}`)).body.lines[0]).toMatchObject({ rejectionReasonCode: 'CRACKED' });
    const { rows } = await admin().query('SELECT qty_rejected::text, rejection_reason_code, rejection_note FROM inv.goods_receipt_line WHERE goods_receipt_id = $1', [draft.body.id]);
    expect(rows).toEqual([{ qty_rejected: '30.000', rejection_reason_code: 'CRACKED', rejection_note: 'Seven eggs cracked in the top tray' }]);

    const clean = await post(storekeeper, '/goods-receipts', eggDelivery({}));
    expect(clean.status).toBe(201);
    expect(clean.body.lines[0]).toMatchObject({ qtyRejected: '0.000', rejectionReasonCode: null, rejectionNote: null });
  });

  it('takes a reason that needs no note without one', async () => {
    const draft = await post(storekeeper, '/goods-receipts', eggDelivery({ qtyReceived: '8.000', qtyRejected: '2.000', rejectionReasonCode: 'BROKEN', valuePesewas: 38_000 }));
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.lines[0]).toMatchObject({ rejectionReasonCode: 'BROKEN', rejectionNote: null });
  });

  it('refuses a rejected quantity without a reason, a reason on nothing rejected, a reason from another domain and a reason that needs a note without one', async () => {
    const before = await receipts();
    const cases: ReadonlyArray<readonly [Record<string, unknown>, { field: string; code: string }]> = [
      [{ qtyRejected: '1.000' }, { field: '/lines/0/rejectionReasonCode', code: 'REJECTION_REASON_REQUIRED' }],
      [{ rejectionReasonCode: 'CRACKED' }, { field: '/lines/0/rejectionReasonCode', code: 'REASON_NOT_ALLOWED' }],
      [{ qtyRejected: '0.000', rejectionReasonCode: 'CRACKED' }, { field: '/lines/0/rejectionReasonCode', code: 'REASON_NOT_ALLOWED' }],
      [{ rejectionNote: 'A note with nothing rejected' }, { field: '/lines/0/rejectionNote', code: 'REASON_NOT_ALLOWED' }],
      [{ qtyRejected: '1.000', rejectionReasonCode: 'WRONG_ITEM' }, { field: '/lines/0/rejectionReasonCode', code: 'REASON_NOT_ALLOWED' }],
      [{ qtyRejected: '1.000', rejectionReasonCode: 'BREAKAGE' }, { field: '/lines/0/rejectionReasonCode', code: 'REASON_NOT_ALLOWED' }],
      [{ qtyRejected: '1.000', rejectionReasonCode: 'QUALITY_REJECTED' }, { field: '/lines/0/rejectionNote', code: 'NOTE_REQUIRED' }],
    ];
    for (const [line, detail] of cases) {
      const refused = await post(storekeeper, '/goods-receipts', eggDelivery(line));
      expect(refused.status, JSON.stringify(line)).toBe(422);
      expect(refused.body.error, JSON.stringify(line)).toMatchObject({ code: 'GOODS_RECEIPT_INVALID', details: [detail] });
    }
    expect(await receipts()).toBe(before);
  });

  it('refuses the same rules on a draft changed by updateGoodsReceipt', async () => {
    const draft = await post(storekeeper, '/goods-receipts', eggDelivery({}));
    const refused = await patch(`/goods-receipts/${draft.body.id as string}`, { version: draft.body.version, lines: eggDelivery({ qtyRejected: '1.000' }).lines });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'GOODS_RECEIPT_INVALID', details: [{ field: '/lines/0/rejectionReasonCode', code: 'REJECTION_REASON_REQUIRED' }] });
    const changed = await patch(`/goods-receipts/${draft.body.id as string}`, { version: draft.body.version, lines: eggDelivery({ qtyRejected: '1.000', rejectionReasonCode: 'DIRTY' }).lines });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.lines[0]).toMatchObject({ rejectionReasonCode: 'DIRTY', rejectionNote: null });
  });

  it('is refused by the database itself: a rejected quantity without its reason, a reason or a note on nothing rejected', async () => {
    const draft = await post(storekeeper, '/goods-receipts', eggDelivery({}));
    const lineId = draft.body.lines[0].id as string;
    const tamper = (sql: string) => sqlStateOf(admin().query(sql, [lineId]));
    expect(await tamper("UPDATE inv.goods_receipt_line SET qty_rejected = 30, qty_rejected_uom = 1 WHERE id = $1")).toBe(SQLSTATE.checkViolation);
    expect(await tamper("UPDATE inv.goods_receipt_line SET rejection_reason_code = 'CRACKED' WHERE id = $1")).toBe(SQLSTATE.checkViolation);
    expect(await tamper("UPDATE inv.goods_receipt_line SET rejection_note = 'Nothing was rejected' WHERE id = $1")).toBe(SQLSTATE.checkViolation);
    expect(await tamper("UPDATE inv.goods_receipt_line SET qty_rejected = 30, qty_rejected_uom = 1, rejection_reason_code = 'NO_SUCH_REASON' WHERE id = $1")).toBe(SQLSTATE.foreignKeyViolation);
  });

  it('refuses the Cashier a receipt with a rejection, with 403, and nothing is written', async () => {
    const before = await receipts();
    const refused = await post(cashier, '/goods-receipts', eggDelivery({ qtyRejected: '1.000', rejectionReasonCode: 'CRACKED' }));
    expect(refused.status).toBe(403);
    expect(await receipts()).toBe(before);
  });
});

describe('breakage in store (CR-035 point 1)', () => {
  it('lists BREAKAGE and RODENT_DAMAGE as STOCK_ADJUSTMENT reasons with the WASTAGE loss group', async () => {
    const listed = await get(storekeeper, '/reason-codes?domain=STOCK_ADJUSTMENT&limit=50');
    expect(listed.status).toBe(200);
    const byCode = new Map((listed.body.data as { code: string; requiresNote: boolean; lossAccountGroup: string | null }[]).map((r) => [r.code, r]));
    expect(byCode.get('BREAKAGE')).toMatchObject({ code: 'BREAKAGE', domain: 'STOCK_ADJUSTMENT', description: 'Broken or cracked in store', requiresNote: false, lossAccountGroup: 'WASTAGE' });
    expect(byCode.get('RODENT_DAMAGE')).toMatchObject({ code: 'RODENT_DAMAGE', domain: 'STOCK_ADJUSTMENT', requiresNote: true, lossAccountGroup: 'WASTAGE' });
  });

  it('writes off 3 broken eggs with BREAKAGE and no note', async () => {
    const draft = await post(storekeeper, '/goods-receipts', eggDelivery({ qtyReceived: '1.000', valuePesewas: 4_750 }));
    const posted = await post(storekeeper, `/goods-receipts/${draft.body.id as string}/post`);
    const lot = posted.body.lines[0].stockUnit.id as string;
    const adjustment = await post(storekeeper, '/stock-adjustments', {
      locationId: id('location:SHOP'),
      reasonCode: 'BREAKAGE',
      lines: [{ productId: id('product:EGG-0003'), stockUnitId: lot, direction: 'LOSS', qty: '3.000' }],
    });
    expect(adjustment.status, JSON.stringify(adjustment.body)).toBe(201);
    const submitted = await post(storekeeper, `/stock-adjustments/${adjustment.body.id as string}/submit`);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body).toMatchObject({ status: 'POSTED', reasonCode: 'BREAKAGE' });
    // The first 3 eggs of a crate at 4,750 carry half_up(4,750 x 3 / 30) = 475 (ADR-0075).
    const { rows } = await admin().query<{ qty: string; value: string }>("SELECT qty_base::text AS qty, value_pesewas::text AS value FROM inv.stock_movement WHERE source_document_id = $1", [adjustment.body.id]);
    expect(rows).toEqual([{ qty: '3.000', value: '475' }]);
  });
});

/** updateGoodsReceipt, as the Storekeeper. */
function patch(path: string, body: object) {
  return consolePatch(api.server, storekeeper, `/v1${path}`, randomUUID()).send(body);
}
