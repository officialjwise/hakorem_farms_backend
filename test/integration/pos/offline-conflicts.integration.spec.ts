import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { syncBatch, tillSale, type TillLine, type TillSale, type TillTender } from '../../support/offline';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * ADR-0027's conflict tests and the shift rules offline (FR-POS-012 to FR-POS-014, OFFLINE_SYNC 9.1 to 9.6, ADR-0077,
 * B09b continued 2b): an animal sold elsewhere, an animal on hold, countable stock gone negative, a missing device
 * counter, a sale on a shift that has closed or was force-closed, and a price beyond the cashier's limit. Each sale is
 * recorded with its receipt; each conflict becomes an exception naming the claim and the fact, never a refusal. Every
 * figure is derived independently by SQL over the stock movements, the payments and the journal lines. The sale dated
 * in a locked period is `offline-late-sale.integration.spec.ts`; the 500-sale test is `offline-sync-500`.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let nextId: () => string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const credentials = new Map<string, string>();
const shifts = new Map<string, { readonly id: string; readonly seq: number }>();
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const step = (who: string) => stepUp(api.server, as(who) as TotpSession, clock);
const rows = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => (await admin().query(sql, values)).rows as T[];
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await rows<T>(sql, values))[0]!;
const num = async (sql: string, values: unknown[] = []): Promise<number> => Number((await one<{ n: string | null }>(sql, values)).n ?? 0);
const MINUTE = 60_000;
const later = (minutes: number) => new Date(clock.now().getTime() + minutes * MINUTE);

const cash = (amount: number, tendered?: number): TillTender => ({ paymentMethodId: id('CASH'), amountPesewas: amount, ...(tendered === undefined ? {} : { tenderedPesewas: tendered }) });
function sale(till: string, counter: number, at: Date, lines: readonly TillLine[], tenders: readonly TillTender[]): TillSale {
  return tillSale({ till, shiftSeq: shifts.get(till)!.seq, counter, at, lines, tenders });
}
/** The base list's price of one cabbage in force. */
async function cabbagePrice(): Promise<number> {
  return num(
    `SELECT e.list_price_pesewas::text AS n FROM mdm.price_list_entry e JOIN mdm.price_list_version v ON v.id = e.version_id JOIN mdm.price_list l ON l.id = v.price_list_id
      WHERE e.product_id = $1 AND l.kind = 'BASE' AND v.status = 'ACTIVE' AND e.uom IS NULL ORDER BY e.min_qty LIMIT 1`,
    [id('PRD-0002')],
  );
}
const sync = (who: string, till: string, sales: readonly TillSale[]) => syncBatch(api.server, as(who), credentials.get(till)!, { deviceId: id(`device:${till}`), shiftId: shifts.get(till)!.id, sales });
const outbox = (type: string, subject: string) => rows<{ payload: Record<string, unknown> }>('SELECT payload FROM platform.outbox_message WHERE event_type = $1 AND subject_id = $2 ORDER BY recorded_at', [type, subject]);

/** Debits less credits on an account over the journals whose source is any of the documents. */
async function balance(code: string, documents: readonly string[]): Promise<number> {
  return num(
    `SELECT sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS n
       FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
      WHERE a.code = $1 AND e.source_document_id = ANY($2::uuid[])`,
    [code, documents],
  );
}
async function documentsOf(orderId: string): Promise<string[]> {
  return (
    await rows<{ id: string }>(
      `SELECT billing_document_id AS id FROM ord.sales_order WHERE id = $1
       UNION SELECT id FROM pay.payment WHERE order_document_id = $1
       UNION SELECT id FROM inv.stock_movement WHERE source_document_id = $1
       UNION SELECT $1::uuid`,
      [orderId],
    )
  ).map((r) => r.id);
}

/** The engine's price for one goat on the till's channel, with its grade and last weight; the line the till sells it on. */
async function goatLine(tag: string): Promise<TillLine> {
  const unit = await one<{ w: string; grade: string | null }>('SELECT last_weight_kg::text AS w, grade_id AS grade FROM inv.stock_unit WHERE id = $1', [id(tag)]);
  const weight = unit.w;
  const priced = await post('manager', '/pricing/resolve', {
    channel: 'POS',
    branchId: id('branch'),
    lines: [{ lineRef: '1', productId: id('goat'), quantity: '1.000', weightKg: weight, ...(unit.grade === null ? {} : { gradeId: unit.grade }) }],
  });
  expect(priced.status, JSON.stringify(priced.body)).toBe(200);
  const resolved = priced.body.lines[0].resolved as { listPricePesewas: number; basis: string };
  return {
    productId: id('goat'),
    stockUnitId: id(tag),
    quantity: '1.000',
    ...(resolved.basis === 'PER_KG' ? { weightKg: weight, weightSource: 'SCALE' as const } : {}),
    agreedUnitPricePesewas: resolved.listPricePesewas,
  };
}
/** What a line comes to: per kilogram times the weight, else per head. */
const lineTotal = (line: TillLine) => (line.weightKg === undefined ? line.agreedUnitPricePesewas : Math.round((line.agreedUnitPricePesewas * Math.round(Number(line.weightKg) * 1000)) / 1000));

async function openShift(who: string, till: string): Promise<void> {
  const shiftId = nextId();
  const opened = await post(who, '/shifts', { id: shiftId, registerId: id(`till:${till}`), openingFloatPesewas: 0, openedAt: clock.now().toISOString() }, shiftId);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  shifts.set(till, { id: shiftId, seq: opened.body.shiftSeq as number });
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of await rows<{ code: string; id: string }>(
    `SELECT 'branch' AS code, id FROM mdm.branch WHERE code = 'DDW'
     UNION ALL SELECT l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code IN ('SHOP', 'PENS')
     UNION ALL SELECT sku, id FROM mdm.product WHERE sku IN ('EGG-0003', 'PRD-0002', 'LIV-0004')
     UNION ALL SELECT 'goat', id FROM mdm.product WHERE sku = 'LIV-0004'
     UNION ALL SELECT identifier, id FROM inv.stock_unit WHERE identifier LIKE 'G-014%'
     UNION ALL SELECT code, id FROM mdm.payment_method`,
  )) {
    ids.set(row.code, row.id);
  }
  for (const [who, name, role, location, totp] of [
    ['manager', 'Kwabena Owusu', 'MANAGER', null, true],
    ['kofi', 'Kofi Boateng', 'CASHIER', 'SHOP', false],
    ['ama', 'Ama Asante', 'CASHIER', 'PENS', false],
    ['esi', 'Esi Darko', 'CASHIER', 'SHOP', false],
    ['yaw', 'Yaw Mensah', 'CASHIER', 'SHOP', false],
    ['abena', 'Abena Ofori', 'CASHIER', null, false],
  ] as const) {
    const user = await createUser(database, { name, grants: [{ role, branchId: id('branch'), ...(location === null ? {} : { locationId: id(location) }) }] });
    users.set(who, user);
    sessions.set(who, totp ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  // A market stall that may run below zero (OFFLINE_SYNC 9.3); the seeded shop floor does not allow it.
  await step('manager');
  const stall = await post('manager', '/locations', { branchId: id('branch'), code: 'STALL', name: 'Roadside stall', kind: 'SHOP_FLOOR', isSellable: true, allowsNegative: true });
  expect(stall.status, JSON.stringify(stall.body)).toBe(201);
  ids.set('STALL', stall.body.id as string);
  for (const [code, location] of [
    ['M1', 'STALL'],
    ['P1', 'PENS'],
    ['S1', 'SHOP'],
    ['F1', 'SHOP'],
    ['V1', 'SHOP'],
  ] as const) {
    const till = await post('manager', '/registers', { branchId: id('branch'), locationId: id(location), code, name: `Till ${code}` });
    expect(till.status, JSON.stringify(till.body)).toBe(201);
    ids.set(`till:${code}`, till.body.id as string);
    await step('manager');
    const enrolled = await post('manager', `/registers/${till.body.id as string}/devices`, { deviceLabel: `Tablet ${code}` });
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
    credentials.set(code, enrolled.body.deviceCredential as string);
    ids.set(`device:${code}`, enrolled.body.device.id as string);
  }
  await openShift('ama', 'P1');
  await openShift('kofi', 'S1');
  await openShift('esi', 'F1');
  await openShift('yaw', 'V1');
  await openShift('abena', 'M1');
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe("ADR-0027's conflicts: the sale and its money are recorded, the stock conflict becomes an exception (OFFLINE_SYNC 9.1 to 9.3, 9.5)", () => {
  it('an animal sold elsewhere: the sale, receipt and cash post, no second movement, and a SERIAL_CONFLICT names both facts (9.1)', async () => {
    const line = await goatLine('G-0142');
    const total = lineTotal(line);
    const offline = sale('P1', 1, later(10), [line], [cash(total, total + 5_000)]);
    // Meanwhile the same goat is sold at the counter while the server is reachable.
    clock.advanceBy(20 * MINUTE);
    const onlineId = nextId();
    const online = await consolePost(api.server, as('ama'), '/v1/pos/sales', onlineId)
      .set('X-Device-Credential', credentials.get('P1')!)
      .send({ id: onlineId, shiftId: shifts.get('P1')!.id, occurredAt: clock.now().toISOString(), lines: [line], tenders: [cash(total)] });
    expect(online.status, JSON.stringify(online.body)).toBe(201);
    clock.advanceBy(30 * MINUTE);

    const synced = await sync('ama', 'P1', [offline]);
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect(synced.body.results[0]).toMatchObject({ outcome: 'APPLIED_WITH_EXCEPTION', orderId: offline.id, grossPesewas: total, exceptions: [expect.objectContaining({ kind: 'SERIAL_CONFLICT' })] });
    // The line names the exception in the movement's place; the goat moved once, by the counter sale.
    const lineRow = await one<{ movement: string | null; exception: string | null }>('SELECT stock_movement_id AS movement, stock_exception_id AS exception FROM ord.sales_order_line WHERE sales_order_id = $1', [offline.id]);
    expect(lineRow.movement).toBeNull();
    const exception = await one<{ kind: string; status: string; details: { claim: Record<string, unknown>; fact: Record<string, unknown> }; source: string; movement: string | null }>(
      'SELECT kind, status, details, source_document_id AS source, movement_id AS movement FROM inv.stock_exception WHERE id = $1',
      [lineRow.exception],
    );
    expect(exception).toMatchObject({ kind: 'SERIAL_CONFLICT', status: 'OPEN', source: offline.id, movement: null });
    expect(exception.details.claim).toMatchObject({ source: 'POS_OFFLINE', deviceCounter: 1, stockUnit: 'G-0142', occurredAt: offline.occurredAt, provisionalRef: offline.provisionalRef });
    expect(exception.details.fact).toMatchObject({ stockUnit: 'G-0142', status: 'SOLD' });
    expect(await rows('SELECT movement_type, source_document_id AS source FROM inv.stock_movement WHERE stock_unit_id = $1 AND movement_type LIKE $2', [id('G-0142'), 'SALE_ISSUE%'])).toEqual([{ movement_type: 'SALE_ISSUE', source: onlineId }]);
    // The money: the cash on Ama's shift, the revenue, the receivable settled, and no cost of sales for this line.
    const documents = await documentsOf(offline.id);
    expect(await num('SELECT amount_pesewas::text AS n FROM pay.payment WHERE order_document_id = $1 AND shift_document_id = $2', [offline.id, shifts.get('P1')!.id])).toBe(total);
    expect(await balance('4000', documents)).toBe(-total);
    expect(await balance('1000', documents)).toBe(total);
    expect(await balance('1200', documents)).toBe(0);
    expect(await balance('5000', documents)).toBe(0);
    const [flag] = (await outbox('pos.OfflineSaleFlagged', offline.id)).map((r) => r.payload);
    expect(flag).toMatchObject({ exceptionKind: 'STOCK_EXCEPTION', severity: 'URGENT', amountPesewas: total, cashierId: users.get('ama')!.principalId, abuseCases: [11], fact: expect.objectContaining({ stockExceptionKind: 'SERIAL_CONFLICT' }) });
  });

  it('an animal put on hold after the till went offline: recorded with no movement and a HOLD_CONFLICT, the goat still in its pen (9.2)', async () => {
    const line = await goatLine('G-0143');
    const total = lineTotal(line);
    await step('manager');
    const held = await post('manager', '/stock/holds', { stockUnitId: id('G-0143'), kind: 'QUARANTINE', note: 'Coughing, kept apart for the vet' });
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    const offline = sale('P1', 2, later(10), [line], [cash(total)]);
    clock.advanceBy(40 * MINUTE);
    const synced = await sync('ama', 'P1', [offline]);
    expect(synced.body.results[0]).toMatchObject({ outcome: 'APPLIED_WITH_EXCEPTION', grossPesewas: total, exceptions: [expect.objectContaining({ kind: 'HOLD_CONFLICT' })] });
    const exception = await one<{ kind: string; details: { fact: { holds: { kind: string }[] } } }>(
      'SELECT e.kind, e.details FROM inv.stock_exception e JOIN ord.sales_order_line l ON l.stock_exception_id = e.id WHERE l.sales_order_id = $1',
      [offline.id],
    );
    expect(exception.kind).toBe('HOLD_CONFLICT');
    expect(exception.details.fact.holds.map((h) => h.kind)).toEqual(['QUARANTINE']);
    expect(await num("SELECT count(*)::text AS n FROM inv.stock_movement WHERE stock_unit_id = $1 AND movement_type LIKE 'SALE_ISSUE%'", [id('G-0143')])).toBe(0);
    expect(await one('SELECT status, current_location_id AS at FROM inv.stock_unit WHERE id = $1', [id('G-0143')])).toEqual({ status: 'ACTIVE', at: id('PENS') });
    expect(await num('SELECT amount_pesewas::text AS n FROM pay.payment WHERE order_document_id = $1', [offline.id])).toBe(total);
    expect((await outbox('pos.OfflineSaleFlagged', offline.id)).map((r) => [r.payload['exceptionKind'], r.payload['severity']])).toEqual([['STOCK_EXCEPTION', 'REVIEW']]);
  });

  it('countable stock gone negative where the location allows it: the movement posts, the stall goes to -6 cabbages, a NEGATIVE_STOCK names it (9.3)', async () => {
    const price = await cabbagePrice();
    const offline = sale('M1', 1, later(5), [{ productId: id('PRD-0002'), quantity: '6.000', agreedUnitPricePesewas: price }], [cash(6 * price, 6 * price)]);
    clock.advanceBy(20 * MINUTE);
    const synced = await sync('abena', 'M1', [offline]);
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    // The trigger raises what it finds: below zero, and so below the (nil) reserved quantity as well (migration 0044).
    expect(synced.body.results[0]).toMatchObject({ outcome: 'APPLIED_WITH_EXCEPTION', grossPesewas: 6 * price });
    expect((synced.body.results[0].exceptions as { kind: string }[]).map((e) => e.kind)).toEqual(['NEGATIVE_STOCK', 'RESERVATION_CONFLICT']);
    const movement = await one<{ id: string; qty: string; value: string; type: string }>('SELECT id, qty_base::text AS qty, value_pesewas::text AS value, movement_type AS type FROM inv.stock_movement WHERE source_document_id = $1', [offline.id]);
    expect([movement.qty, movement.type]).toEqual(['6.000', 'SALE_ISSUE_OFFLINE']);
    // The stall held none: it stands at -6, and the exception names the movement and the six uncovered.
    expect(await num('SELECT on_hand_qty::text AS n FROM inv.stock_balance WHERE product_id = $1 AND location_id = $2', [id('PRD-0002'), id('STALL')])).toBe(-6);
    expect(await rows('SELECT kind, qty::text AS qty, source_document_id AS source FROM inv.stock_exception WHERE movement_id = $1 ORDER BY kind', [movement.id])).toEqual([
      { kind: 'NEGATIVE_STOCK', qty: '6.000', source: offline.id },
      { kind: 'RESERVATION_CONFLICT', qty: '6.000', source: offline.id },
    ]);
    // A line holds a movement or an exception, never both: it keeps its movement, which the exception names.
    expect(await one('SELECT stock_movement_id AS movement, stock_exception_id AS exception FROM ord.sales_order_line WHERE sales_order_id = $1', [offline.id])).toEqual({ movement: movement.id, exception: null });
    const documents = await documentsOf(offline.id);
    expect(await balance('4020', documents)).toBe(-6 * price);
    expect(await balance('1000', documents)).toBe(6 * price);
    // Cost of sales is exactly what the issue carried from the branch's pool, and the inventory gives it up.
    expect(await balance('5020', documents)).toBe(Number(movement.value));
    expect(await balance('1330', documents)).toBe(-Number(movement.value));
    expect((await outbox('pos.OfflineSaleFlagged', offline.id)).map((r) => [r.payload['exceptionKind'], r.payload['severity'], r.payload['amountPesewas']])).toEqual([
      ['STOCK_EXCEPTION', 'REVIEW', 6 * price],
      ['STOCK_EXCEPTION', 'REVIEW', 6 * price],
    ]);
  });

  it('countable stock gone negative where the location does not allow it: the sale and cash post, the eggs go below zero, the uncovered part at its last known cost (9.3, ADR-0081, replacing A-278 (f))', async () => {
    const before = await one<{ qty: string; value: string }>('SELECT qty::text AS qty, value_pesewas::text AS value FROM inv.cost_pool WHERE product_id = $1', [id('EGG-0003')]);
    const onHand = await num('SELECT on_hand_qty::text AS n FROM inv.stock_balance WHERE product_id = $1 AND location_id = $2', [id('EGG-0003'), id('SHOP')]);
    expect([Number(before.qty), onHand]).toEqual([900, 900]);
    const offline = sale('S1', 1, later(5), [{ productId: id('EGG-0003'), quantity: '31.000', uom: 'CRATE', agreedUnitPricePesewas: 6_000 }], [cash(186_000, 190_000)]);
    clock.advanceBy(20 * MINUTE);
    const synced = await sync('kofi', 'S1', [offline]);
    // NEGATIVE_STOCK, and the trigger's RESERVATION_CONFLICT beside it (on hand below the nil reserved, A-278 (f), BL-105).
    expect(synced.body.results[0]).toMatchObject({ outcome: 'APPLIED_WITH_EXCEPTION', grossPesewas: 186_000 });
    expect((synced.body.results[0].exceptions as { kind: string }[]).map((e) => e.kind)).toEqual(['NEGATIVE_STOCK', 'RESERVATION_CONFLICT']);
    // The owner's decision 2 of 2026-11-18: the 930 eggs move, the shop floor goes to -30, the exception names the movement.
    const issue = await one<{ id: string; qty: string; value: string }>("SELECT id, qty_base::text AS qty, value_pesewas::text AS value FROM inv.stock_movement WHERE source_document_id = $1 AND movement_type = 'SALE_ISSUE_OFFLINE'", [offline.id]);
    expect([issue.qty, issue.value]).toEqual(['930.000', before.value]);
    const exception = await one<{ kind: string; qty: string; movement: string | null }>(
      'SELECT e.kind, e.qty::text AS qty, e.movement_id AS movement FROM inv.stock_exception e JOIN ord.sales_order_line l ON l.stock_movement_id = e.movement_id WHERE l.sales_order_id = $1 AND e.kind = $2',
      [offline.id, 'NEGATIVE_STOCK'],
    );
    expect([exception.kind, exception.qty, exception.movement]).toEqual(['NEGATIVE_STOCK', '30.000', issue.id]);
    expect(await num('SELECT on_hand_qty::text AS n FROM inv.stock_balance WHERE product_id = $1 AND location_id = $2', [id('EGG-0003'), id('SHOP')])).toBe(-30);
    // The 30 the lot did not hold, at its own average before the sale (V x 30 / 900, half-up once), to 5020 against 1335.
    const uncovered = Math.floor((2 * Number(before.value) * 30 + 900) / (2 * 900));
    const documents = await documentsOf(offline.id);
    expect(await balance('4020', documents)).toBe(-186_000);
    expect(await balance('1000', documents)).toBe(186_000);
    expect(await balance('5020', documents)).toBe(Number(before.value) + uncovered);
    expect(await balance('1335', documents)).toBe(-uncovered);
  });

  it('a missing device counter: counters 2 to 9 without 8 sync, 8 is answered missing and raised once, URGENT (9.5)', async () => {
    const price = await cabbagePrice();
    const priced = [2, 3, 4, 5, 6, 7, 9].map((c) => sale('S1', c, later(1), [{ productId: id('PRD-0002'), quantity: '1.000', agreedUnitPricePesewas: price }], [cash(price)]));
    clock.advanceBy(10 * MINUTE);
    const synced = await sync('kofi', 'S1', priced);
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect((synced.body.results as { outcome: string }[]).map((r) => r.outcome)).toEqual(Array(7).fill('APPLIED'));
    expect(synced.body.counterGaps).toEqual([8]);
    expect(await num('SELECT last_device_counter::text AS n FROM pos.shift WHERE id = $1', [shifts.get('S1')!.id])).toBe(9);
    expect(await num("SELECT count(*)::text AS n FROM pos.sale_sync WHERE shift_id = $1 AND outcome IN ('APPLIED', 'APPLIED_WITH_EXCEPTION')", [shifts.get('S1')!.id])).toBe(8);
    expect((await outbox('pos.DeviceCounterGap', shifts.get('S1')!.id)).map((r) => r.payload)).toEqual([
      expect.objectContaining({ missing: [8], highestSynced: 9, severity: 'URGENT', cashierId: users.get('kofi')!.principalId, abuseCases: [10] }),
    ]);
  });
});

describe('ADR-0077 offline as amended by the owner on 2026-11-18: cash from the queue goes onto its own shift, as a late entry once that shift is closed or force-closed (OFFLINE_SYNC 9.4.2)', () => {
  it('records sales queued on a shift force-closed meanwhile with their cash on that shift as late entries, each receipt settled, the one made after the close URGENT', async () => {
    const before = sale('F1', 1, later(5), [{ productId: id('EGG-0003'), quantity: '2.000', uom: 'EGG', agreedUnitPricePesewas: 220 }], [cash(440)]);
    clock.advanceBy(30 * MINUTE);
    await step('manager');
    const forced = await post('manager', `/shifts/${shifts.get('F1')!.id}/force-close`, { reason: 'The tablet will not power on and the cashier has gone home' });
    expect(forced.status, JSON.stringify(forced.body)).toBe(200);
    const after = sale('F1', 2, later(5), [{ productId: id('EGG-0003'), quantity: '1.000', uom: 'EGG', agreedUnitPricePesewas: 220 }], [cash(220)]);
    clock.advanceBy(30 * MINUTE);
    const synced = await sync('esi', 'F1', [before, after]);
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    const [r1, r2] = synced.body.results as { outcome: string; grossPesewas: number; exceptions: { kind: string }[] }[];
    // The eggs on the shop floor are below zero since the 9.3 sale above (ADR-0081), so these egg sales raise NEGATIVE_STOCK too.
    expect([r1!.outcome, r1!.grossPesewas, r1!.exceptions.map((e) => e.kind).sort()]).toEqual(['APPLIED_WITH_EXCEPTION', 440, ['NEGATIVE_STOCK', 'OFFLINE_LATE_CASH', 'OFFLINE_LATE_POSTING']]);
    expect([r2!.outcome, r2!.grossPesewas, r2!.exceptions.map((e) => e.kind).sort()]).toEqual(['APPLIED_WITH_EXCEPTION', 220, ['NEGATIVE_STOCK', 'OFFLINE_LATE_CASH', 'OFFLINE_LATE_POSTING']]);
    // The cash went onto the force-closed shift it happened in, marked late, and nowhere else; each receipt is settled.
    for (const [s, gross] of [
      [before, 440],
      [after, 220],
    ] as const) {
      expect(await rows('SELECT shift_document_id AS shift, late_entry, amount_pesewas::text AS amount FROM pay.payment WHERE order_document_id = $1', [s.id])).toEqual([{ shift: shifts.get('F1')!.id, late_entry: true, amount: String(gross) }]);
      const documents = await documentsOf(s.id);
      expect(await balance('1200', documents)).toBe(0);
      expect(await balance('1000', documents)).toBe(gross);
      expect(await num('SELECT final_total_pesewas::text AS n FROM ord.sales_order WHERE id = $1 AND shift_document_id = $2', [s.id, shifts.get('F1')!.id])).toBe(gross);
    }
    // Not counted yet: the two adjustments show the shift short by the cash until the drawer is counted with it in.
    expect(await balance('6900', [shifts.get('F1')!.id])).toBe(660);
    expect(await rows('SELECT device_counter, posted_late_reason FROM pos.sale_sync WHERE shift_id = $1 ORDER BY device_counter', [shifts.get('F1')!.id])).toEqual([
      { device_counter: 1, posted_late_reason: 'SHIFT_CLOSED' },
      { device_counter: 2, posted_late_reason: 'AFTER_FORCE_CLOSE' },
    ]);
    // The eggs' NEGATIVE_STOCK (below zero since the 9.3 sale above, ADR-0081) is its own flag, checked apart.
    const negative = async (s: TillSale) => (await outbox('pos.OfflineSaleFlagged', s.id)).filter((r) => r.payload['exceptionKind'] === 'STOCK_EXCEPTION').map((r) => (r.payload['fact'] as Record<string, unknown>)['stockExceptionKind']);
    expect([await negative(before), await negative(after)]).toEqual([['NEGATIVE_STOCK'], ['NEGATIVE_STOCK']]);
    const severities = async (s: TillSale) => (await outbox('pos.OfflineSaleFlagged', s.id)).filter((r) => r.payload['exceptionKind'] !== 'STOCK_EXCEPTION').map((r) => [r.payload['exceptionKind'], r.payload['severity'], r.payload['amountPesewas']]).sort();
    expect(await severities(before)).toEqual([
      ['OFFLINE_LATE_CASH', 'REVIEW', 440],
      ['OFFLINE_LATE_POSTING', 'REVIEW', 440],
    ]);
    expect(await severities(after)).toEqual([
      ['OFFLINE_LATE_CASH', 'URGENT', 220],
      ['OFFLINE_LATE_POSTING', 'URGENT', 220],
    ]);
  });
});

describe('a price beyond the cashier limit or out of the band is re-checked at sync, posted and raised URGENT, never refused (OFFLINE_SYNC 9.6, A-278 (h) as amended 2026-11-18)', () => {
  it('posts two cabbages at 900 against the list 1,000 (within the band, beyond a limit of 0) and a crate at 5,800 against a fixed 6,000, each variance on 4210', async () => {
    const list = await cabbagePrice();
    expect(list).toBe(1_000);
    const offline = sale(
      'V1',
      1,
      later(5),
      [
        { productId: id('PRD-0002'), quantity: '2.000', agreedUnitPricePesewas: 900, varianceReasonCode: 'REGULAR_CUSTOMER' },
        { productId: id('EGG-0003'), quantity: '1.000', uom: 'CRATE', agreedUnitPricePesewas: 5_800, varianceReasonCode: 'REGULAR_CUSTOMER' },
      ],
      [cash(7_600)],
    );
    clock.advanceBy(15 * MINUTE);
    const synced = await sync('yaw', 'V1', [offline]);
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect(synced.body.results[0]).toMatchObject({ outcome: 'APPLIED_WITH_EXCEPTION', grossPesewas: 7_600 });
    // The crate of eggs takes the shop floor further below zero (since the 9.3 sale above, ADR-0081): NEGATIVE_STOCK beside the overrides.
    expect((synced.body.results[0].exceptions as { kind: string }[]).map((e) => e.kind)).toEqual(['NEGATIVE_STOCK', 'PRICE_OVERRIDE', 'PRICE_OVERRIDE']);
    expect(
      await rows(
        'SELECT line_no, resolved_unit_price_pesewas::int AS resolved, floor_unit_price_pesewas::int AS floor, agreed_unit_price_pesewas::int AS agreed, variance_pesewas::int AS variance, variance_direction AS direction, variance_requires_approval AS approval FROM ord.sales_order_line WHERE sales_order_id = $1 ORDER BY line_no',
        [offline.id],
      ),
    ).toEqual([
      { line_no: 1, resolved: 1_000, floor: 800, agreed: 900, variance: 200, direction: 'BELOW', approval: false },
      // Below the fixed band: recorded with its floor stretched to the agreed price; the server's band is in the finding.
      { line_no: 2, resolved: 6_000, floor: 5_800, agreed: 5_800, variance: 200, direction: 'BELOW', approval: false },
    ]);
    const documents = await documentsOf(offline.id);
    expect(await balance('4210', documents)).toBe(400);
    expect(await balance('1000', documents)).toBe(7_600);
    // Beyond the cashier's limit with no supervisor's PIN, and outside the band: each URGENT, outside the rules (the owner, 2026-11-18).
    // The crate's NEGATIVE_STOCK (the eggs below zero since the 9.3 sale above, ADR-0081) is not an override.
    const flags = (await outbox('pos.OfflineSaleFlagged', offline.id)).filter((r) => r.payload['exceptionKind'] !== 'STOCK_EXCEPTION').map((r) => [r.payload['exceptionKind'], r.payload['severity'], r.payload['amountPesewas'], (r.payload['fact'] as Record<string, unknown>)['beyondCashier'], (r.payload['fact'] as Record<string, unknown>)['reason'], (r.payload['fact'] as Record<string, unknown>)['band']]);
    expect(flags).toEqual([
      ['PRICE_OVERRIDE', 'URGENT', 200, 'BEYOND_ROLE_LIMIT', 'NO_SUPERVISOR_PIN', { listPricePesewas: 1_000, floorPricePesewas: 800, ceilingPricePesewas: 1_200 }],
      ['PRICE_OVERRIDE', 'URGENT', 200, 'OUTSIDE_BAND', 'OUTSIDE_BAND', { listPricePesewas: 6_000, floorPricePesewas: 6_000, ceilingPricePesewas: 6_000 }],
    ]);
  });
});
