import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { syncBatch, tillHash, tillSale, type TillLine, type TillSale, type TillTender } from '../../support/offline';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Offline sync (`syncOfflineSales`, FR-POS-011, FR-POS-013, FR-POS-014, ADR-0027, OFFLINE_SYNC 4, 6, 7 and 9.5 to 9.8,
 * B09b continued 2b). The till makes its sales with no request to the server (the network disabled on the client
 * side), then sends the queue. Each figure is read by SQL from the order, the receipt, the stock movements, the
 * payments and the journal lines, never from the answer under test: exactly once by the client id, a crate and a
 * single egg at their own entries, the receipt issued at the till's time and marked synced, counter gaps, integrity
 * refusals that record nothing, and the findings that record the sale and flag it (a till clock 301 seconds out, a
 * sale too old, a unit not sold, a tender not taken, a grant revoked while offline). Every wrong caller is refused.
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
const shifts = new Map<string, { readonly id: string; readonly seq: number; readonly openedAt: Date }>();
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const rows = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => (await admin().query(sql, values)).rows as T[];
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await rows<T>(sql, values))[0]!;
const num = async (sql: string, values: unknown[] = []): Promise<number> => Number((await one<{ n: string | null }>(sql, values)).n ?? 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
let crate = 0;
let egg = 0;

const cash = (amount: number, tendered?: number): TillTender => ({ paymentMethodId: id('CASH'), amountPesewas: amount, ...(tendered === undefined ? {} : { tenderedPesewas: tendered }) });
const eggs = (quantity: string, uom: string | undefined, price: number): TillLine => ({ productId: id('EGG-0003'), quantity, ...(uom === undefined ? {} : { uom }), agreedUnitPricePesewas: price });

/** A sale the till makes on its shift, offline: nothing is sent. */
function sale(till: string, counter: number, at: Date, lines: readonly TillLine[], tenders: readonly TillTender[], extra: { readonly id?: string; readonly provisionalRef?: string } = {}): TillSale {
  return tillSale({ till, shiftSeq: shifts.get(till)!.seq, counter, at, lines, tenders, ...extra });
}
const sync = (who: string | null, till: string, sales: readonly TillSale[], device: string | null = till, extra: object = {}) =>
  syncBatch(api.server, who === null ? null : as(who), device === null ? null : (credentials.get(device) ?? device), { deviceId: id(`device:${device ?? till}`), shiftId: shifts.get(till)!.id, sales, ...extra });

/** The list price of EGG-0003 in a unit on the base list in force (the POS walk for a walk-in prices eggs from it). */
async function listPrice(sku: string, uom: string | null): Promise<number> {
  return num(
    `SELECT e.list_price_pesewas::text AS n
       FROM mdm.price_list_entry e JOIN mdm.price_list_version v ON v.id = e.version_id JOIN mdm.price_list l ON l.id = v.price_list_id JOIN mdm.product p ON p.id = e.product_id
      WHERE p.sku = $1 AND e.uom IS NOT DISTINCT FROM $2 AND l.kind = 'BASE' AND v.status = 'ACTIVE' AND v.valid_from <= $3 AND (v.valid_to IS NULL OR v.valid_to > $3)
        AND e.grade_id IS NULL AND e.weight_band_id IS NULL AND e.min_qty = (SELECT min(e2.min_qty) FROM mdm.price_list_entry e2 WHERE e2.version_id = e.version_id AND e2.product_id = e.product_id AND e2.uom IS NOT DISTINCT FROM $2)`,
    [sku, uom, clock.now()],
  );
}

/** Debits less credits on an account over the journals whose source is any of the documents. */
async function balance(code: string, documents: readonly string[]): Promise<number> {
  return num(
    `SELECT sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS n
       FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
      WHERE a.code = $1 AND e.source_document_id = ANY($2::uuid[])`,
    [code, documents],
  );
}

/** The documents a sale's journals come from: its receipt, its payments and its stock movements. */
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

async function footprint(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ['ord.sales_order', 'pay.payment', 'inv.stock_movement', 'bil.billing_document', 'fin.journal_entry', 'platform.number_allocation', 'inv.stock_exception']) {
    counts[table] = await num(`SELECT count(*)::text AS n FROM ${table}`);
  }
  return counts;
}

const outbox = (type: string, subject: string) => rows<{ payload: Record<string, unknown> }>('SELECT payload FROM platform.outbox_message WHERE event_type = $1 AND subject_id = $2 ORDER BY recorded_at', [type, subject]);

async function openShift(who: string, till: string): Promise<void> {
  const shiftId = nextId();
  const opened = await post(who, '/shifts', { id: shiftId, registerId: id(`till:${till}`), openingFloatPesewas: 0, openedAt: clock.now().toISOString() }, shiftId);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  shifts.set(till, { id: shiftId, seq: opened.body.shiftSeq as number, openedAt: clock.now() });
}


beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '172800', AUTH_STAFF_REFRESH_IDLE_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of await rows<{ code: string; id: string }>(
    `SELECT 'branch' AS code, id FROM mdm.branch WHERE code = 'DDW'
     UNION ALL SELECT 'shop', l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = 'SHOP'
     UNION ALL SELECT sku, id FROM mdm.product WHERE sku IN ('EGG-0003', 'PRD-0002', 'PRD-0005')
     UNION ALL SELECT code, id FROM mdm.payment_method`,
  )) {
    ids.set(row.code, row.id);
  }
  for (const [who, name, role, totp] of [
    ['owner', 'Akosua Owner', 'OWNER', true],
    ['manager', 'Kwabena Owusu', 'MANAGER', true],
    ['kofi', 'Kofi Boateng', 'CASHIER', false],
    ['ama', 'Ama Asante', 'CASHIER', false],
    ['esi', 'Esi Darko', 'CASHIER', false],
    ['storekeeper', 'Kofi Mensah', 'STOREKEEPER', false],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
  ] as const) {
    const user = await createUser(database, { name, grants: [{ role, branchId: id('branch'), ...(role === 'CASHIER' || role === 'STOREKEEPER' ? { locationId: id('shop') } : {}) }] });
    users.set(who, user);
    sessions.set(who, totp ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  for (const code of ['S1', 'S2', 'S3']) {
    const till = await post('manager', '/registers', { branchId: id('branch'), locationId: id('shop'), code, name: `Shop till ${code}` });
    expect(till.status, JSON.stringify(till.body)).toBe(201);
    ids.set(`till:${code}`, till.body.id as string);
    await stepUp(api.server, as('manager') as TotpSession, clock);
    const enrolled = await post('manager', `/registers/${till.body.id as string}/devices`, { deviceLabel: `Shop tablet ${code}` });
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
    credentials.set(code, enrolled.body.deviceCredential as string);
    ids.set(`device:${code}`, enrolled.body.device.id as string);
  }
  await stepUp(api.server, as('manager') as TotpSession, clock);
  const lost = await post('manager', `/registers/${id('till:S1')}/devices`, { deviceLabel: 'Lost tablet' });
  credentials.set('lost', lost.body.deviceCredential as string);
  ids.set('device:lost', lost.body.device.id as string);
  await stepUp(api.server, as('manager') as TotpSession, clock);
  expect((await post('manager', `/devices/${lost.body.device.id as string}/revoke`, { reason: 'Left at the lorry station' })).status).toBe(200);
  // The shifts open well after the seeded prices take effect, so a till time just before a shift opened is still priced.
  clock.advanceBy(20 * MINUTE);
  await openShift('kofi', 'S1');
  await openShift('ama', 'S2');
  await openShift('esi', 'S3');
  crate = await listPrice('EGG-0003', 'CRATE');
  egg = await listPrice('EGG-0003', null);
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('a queued sale syncs exactly once, a crate and a single egg each at its own price (FR-POS-011, CR-038 at sync)', () => {
  let first: TillSale;

  it('records the order, the receipt issued at the till time, the stock in eggs, the cash on the shift and the ledger, each by SQL', async () => {
    expect([crate, egg]).toEqual([6_000, 220]);
    const at = new Date(clock.now().getTime() + 10 * MINUTE);
    // Two crates, three single eggs, and one crate named by no unit: 3 x 6,000 + 3 x 220 = 18,660.
    first = sale('S1', 1, at, [eggs('2.000', 'CRATE', crate), eggs('3.000', 'EGG', egg), eggs('1.000', undefined, crate)], [cash(18_660, 20_000)]);
    clock.advanceBy(2 * HOUR);
    const synced = await sync('kofi', 'S1', [first]);
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    const [result] = synced.body.results as Record<string, unknown>[];
    expect(result).toMatchObject({ clientSaleId: first.id, deviceCounter: 1, outcome: 'APPLIED', orderId: first.id, grossPesewas: 18_660, currency: 'GHS', exceptions: [] });
    expect(synced.body.counterGaps).toEqual([]);

    const order = await one<{ order_no: string; is_offline: boolean; placed_at: Date; completed_at: Date; final: string; channel: string; salesperson_id: string; shift: string }>(
      'SELECT order_no, is_offline, placed_at, completed_at, final_total_pesewas::text AS final, channel, salesperson_id, shift_document_id AS shift FROM ord.sales_order WHERE id = $1',
      [first.id],
    );
    expect(order).toMatchObject({ order_no: result!['orderNo'], is_offline: true, final: '18660', channel: 'POS', salesperson_id: users.get('kofi')!.principalId, shift: shifts.get('S1')!.id });
    expect([order.placed_at.toISOString(), order.completed_at.toISOString()]).toEqual([at.toISOString(), at.toISOString()]);
    const receipt = await one<{ id: string; document_no: string; synced: boolean; issued_at: Date; issue_date: string; provisional_ref: string; gross: string }>(
      'SELECT d.id, d.document_no, d.synced_from_offline AS synced, d.issued_at, d.issue_date::text, d.provisional_ref, d.gross_pesewas::text AS gross FROM bil.billing_document d WHERE d.order_document_id = $1',
      [first.id],
    );
    expect(receipt).toMatchObject({ document_no: result!['receiptNo'], synced: true, issue_date: toBusinessDate(at), provisional_ref: `P-S1-${shifts.get('S1')!.seq}-0001`, gross: '18660' });
    expect(receipt.issued_at.toISOString()).toBe(at.toISOString());
    // The document read shows it too.
    const read = await consoleGet(api.server, as('manager'), `/v1/billing-documents/${receipt.id}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({ syncedFromOffline: true, provisionalRef: receipt.provisional_ref, issuedAt: at.toISOString(), occurredAt: at.toISOString(), issueDate: toBusinessDate(at) });

    // Stock left in eggs, as SALE_ISSUE_OFFLINE: 60 + 3 + 30 = 93.
    expect(await num("SELECT sum(qty_base)::text AS n FROM inv.stock_movement WHERE source_document_id = $1 AND movement_type = 'SALE_ISSUE_OFFLINE'", [first.id])).toBe(93);
    expect(await num("SELECT count(*)::text AS n FROM inv.stock_movement WHERE source_document_id = $1 AND movement_type <> 'SALE_ISSUE_OFFLINE'", [first.id])).toBe(0);
    // The cash: one payment of 18,660 on Kofi's shift, received at the till's time.
    const paid = await one<{ amount: string; shift: string; received_at: Date }>('SELECT amount_pesewas::text AS amount, shift_document_id AS shift, received_at FROM pay.payment WHERE order_document_id = $1', [first.id]);
    expect(paid).toMatchObject({ amount: '18660', shift: shifts.get('S1')!.id });
    expect(paid.received_at.toISOString()).toBe(at.toISOString());
    // The ledger: egg sales credited 18,660, the till's cash debited 18,660, the receivable settled to 0; cost of sales is what the issues carried.
    const documents = await documentsOf(first.id);
    expect(await balance('4020', documents)).toBe(-18_660);
    expect(await balance('1000', documents)).toBe(18_660);
    expect(await balance('1200', documents)).toBe(0);
    const cost = await num('SELECT sum(value_pesewas)::text AS n FROM inv.stock_movement WHERE source_document_id = $1', [first.id]);
    expect(await balance('5020', documents)).toBe(cost);
    // Every journal of the sale is dated the day it happened at the till, its period open.
    expect(await rows("SELECT DISTINCT posting_date::text AS d FROM fin.journal_entry WHERE source_document_id = ANY($1::uuid[])", [documents])).toEqual([{ d: toBusinessDate(at) }]);
    expect(await rows('SELECT outcome, exception_count, order_no, receipt_no, gross_pesewas::text AS gross, posted_late_reason, too_old, clock_verdict FROM pos.sale_sync WHERE client_sale_id = $1', [first.id])).toEqual([
      { outcome: 'APPLIED', exception_count: 0, order_no: result!['orderNo'], receipt_no: result!['receiptNo'], gross: '18660', posted_late_reason: null, too_old: false, clock_verdict: null },
    ]);
    expect(await num('SELECT last_device_counter::text AS n FROM pos.shift WHERE id = $1', [shifts.get('S1')!.id])).toBe(1);
  });

  it('answers the same batch sent again with the first result, consuming no number and posting nothing', async () => {
    const before = await footprint();
    const again = await sync('kofi', 'S1', [first]);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const [result] = again.body.results as Record<string, unknown>[];
    const firstRow = await one<{ order_no: string; receipt_no: string }>("SELECT order_no, receipt_no FROM pos.sale_sync WHERE client_sale_id = $1 AND outcome = 'APPLIED'", [first.id]);
    expect(result).toMatchObject({ outcome: 'DUPLICATE', orderId: first.id, orderNo: firstRow.order_no, receiptNo: firstRow.receipt_no, grossPesewas: 18_660, exceptions: [] });
    expect(await footprint()).toEqual(before);
    expect(await rows('SELECT outcome FROM pos.sale_sync WHERE client_sale_id = $1 ORDER BY recorded_at, outcome', [first.id])).toEqual([{ outcome: 'APPLIED' }, { outcome: 'DUPLICATE' }]);
  });

  it('stores a sale sent by two requests at once exactly once: one applies, the other answers it as a duplicate', async () => {
    const twice = sale('S1', 2, new Date(clock.now().getTime() - 30 * MINUTE), [eggs('1.000', 'EGG', egg)], [cash(egg)]);
    const [a, b] = await Promise.all([sync('kofi', 'S1', [twice]), sync('kofi', 'S1', [twice])]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.results[0].outcome, b.body.results[0].outcome].sort()).toEqual(['APPLIED', 'DUPLICATE']);
    expect(await num('SELECT count(*)::text AS n FROM ord.sales_order WHERE id = $1', [twice.id])).toBe(1);
    expect(await num('SELECT count(*)::text AS n FROM pay.payment WHERE order_document_id = $1', [twice.id])).toBe(1);
    expect(await num('SELECT count(*)::text AS n FROM bil.billing_document WHERE order_document_id = $1', [twice.id])).toBe(1);
  });

  it('refuses a direct second applied row for a sale or a counter in the database', async () => {
    const row = await one<Record<string, unknown>>("SELECT * FROM pos.sale_sync WHERE client_sale_id = $1 AND outcome = 'APPLIED'", [first.id]);
    const insert = (fields: Record<string, unknown>) =>
      admin().query(
        `INSERT INTO pos.sale_sync (id, device_id, shift_id, branch_id, client_sale_id, device_counter, provisional_ref, client_occurred_at, payload_hash, outcome, order_document_id, order_no, receipt_no,
                                    gross_pesewas, exceptions, exception_count, posting_date, too_old, received_at, recorded_at, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'APPLIED', $5, $10, $11, $12, '[]', 0, $13, false, $14, $14, $15)`,
        [nextId(), row['device_id'], row['shift_id'], row['branch_id'], fields['client'] ?? row['client_sale_id'], fields['counter'] ?? row['device_counter'], row['provisional_ref'], row['client_occurred_at'], row['payload_hash'], row['order_no'], row['receipt_no'], row['gross_pesewas'], row['posting_date'], clock.now(), row['actor_id']],
      );
    await expect(insert({})).rejects.toMatchObject({ code: '23505', constraint: 'uq_sale_sync_applied' });
    await expect(insert({ client: nextId(), counter: 1 })).rejects.toMatchObject({ code: '23505', constraint: 'uq_sale_sync_counter' });
    await expect(admin().query("UPDATE pos.sale_sync SET outcome = 'DUPLICATE' WHERE id = $1", [row['id']])).rejects.toMatchObject({ code: 'HK001' });
  });
});

describe('a sale whose integrity fails is refused and recorded nowhere but the log and the evidence (OFFLINE_SYNC 9.8)', () => {
  it('refuses a payload edited after its hash, keeps the submission as evidence, and takes the corrected sale under the same counter', async () => {
    const at = new Date(clock.now().getTime() - 20 * MINUTE);
    const honest = sale('S1', 3, at, [eggs('6.000', 'EGG', egg)], [cash(6 * egg, 2_000)]);
    // Edited in the browser's store: one egg and 220 in the drawer, the hash left as it was.
    const tampered: TillSale = { ...honest, lines: [eggs('1.000', 'EGG', egg)], tenders: [cash(egg, 2_000)] };
    const before = await footprint();
    const refused = await sync('kofi', 'S1', [tampered]);
    expect(refused.status, JSON.stringify(refused.body)).toBe(200);
    expect(refused.body.results[0]).toEqual({ clientSaleId: honest.id, deviceCounter: 3, outcome: 'REJECTED_INTEGRITY', orderId: null, orderNo: null, receiptNo: null, grossPesewas: null, currency: 'GHS', exceptions: [{ kind: 'SYNC_REJECTED', summary: 'Payload hash does not match. The sale was not recorded.' }] });
    expect(await footprint()).toEqual(before);
    expect(await one('SELECT outcome, rejection_rule, encode(payload_hash, $2) AS hash FROM pos.sale_sync WHERE client_sale_id = $1', [honest.id, 'hex'])).toEqual({ outcome: 'REJECTED_INTEGRITY', rejection_rule: 'PAYLOAD_HASH_MISMATCH', hash: honest.payloadHash });
    const [evidence] = await outbox('pos.OfflineSaleRejected', shifts.get('S1')!.id);
    expect(evidence!.payload).toMatchObject({ saleId: honest.id, rule: 'PAYLOAD_HASH_MISMATCH', severity: 'URGENT', exceptionKind: 'SYNC_REJECTED', receivedHash: honest.payloadHash, recomputedHash: tillHash({ ...tampered, payloadHash: undefined } as never), submitted: tampered, amountPesewas: egg });
    expect(await num("SELECT count(*)::text AS n FROM platform.audit_event WHERE action = 'SYNC_REJECTED' AND entity_id = $1", [shifts.get('S1')!.id])).toBe(1);
    // A received counter is not a gap.
    expect(refused.body.counterGaps).toEqual([]);
    // The honest sale under the same counter is applied: the refused row holds no counter.
    const corrected = await sync('kofi', 'S1', [honest]);
    expect(corrected.body.results[0]).toMatchObject({ outcome: 'APPLIED', grossPesewas: 6 * egg });
  });

  it('refuses an id that is not a UUIDv7, an id applied before with other content, and a counter another sale holds', async () => {
    const at = new Date(clock.now().getTime() - 10 * MINUTE);
    const v4 = sale('S1', 4, at, [eggs('1.000', 'EGG', egg)], [cash(egg)], { id: randomUUID() });
    const reused = sale('S1', 5, at, [eggs('2.000', 'EGG', egg)], [cash(2 * egg)], { id: (await one<{ id: string }>("SELECT client_sale_id AS id FROM pos.sale_sync WHERE device_counter = 1 AND outcome = 'APPLIED' AND shift_id = $1", [shifts.get('S1')!.id])).id });
    const counter = sale('S1', 1, at, [eggs('1.000', 'EGG', egg)], [cash(egg)]);
    const before = await footprint();
    const answer = await sync('kofi', 'S1', [v4, reused, counter]);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const outcomes = (answer.body.results as { deviceCounter: number; outcome: string }[]).map((r) => [r.deviceCounter, r.outcome]);
    expect(outcomes).toEqual([
      [1, 'REJECTED_INTEGRITY'],
      [4, 'REJECTED_INTEGRITY'],
      [5, 'REJECTED_INTEGRITY'],
    ]);
    expect(await footprint()).toEqual(before);
    expect(await rows("SELECT device_counter, rejection_rule FROM pos.sale_sync WHERE outcome = 'REJECTED_INTEGRITY' AND shift_id = $1 AND device_counter IN (1, 4, 5) ORDER BY device_counter", [shifts.get('S1')!.id])).toEqual([
      { device_counter: 1, rejection_rule: 'COUNTER_USED_BY_ANOTHER_SALE' },
      { device_counter: 4, rejection_rule: 'ID_NOT_UUID_V7' },
      { device_counter: 5, rejection_rule: 'ID_REUSED_WITH_OTHER_CONTENT' },
    ]);
  });
});

describe('the device counter reveals a sale that never arrived (FR-POS-013, OFFLINE_SYNC 9.5, abuse case 10)', () => {
  it('answers counter 7 missing on every sync until it arrives, and raises it once', async () => {
    const at = new Date(clock.now().getTime() - 5 * MINUTE);
    const six = sale('S1', 6, at, [eggs('1.000', 'EGG', egg)], [cash(egg)]);
    const seven = sale('S1', 7, at, [eggs('3.000', 'EGG', egg)], [cash(3 * egg)]);
    const eight = sale('S1', 8, at, [eggs('1.000', 'EGG', egg)], [cash(egg)]);
    const first = await sync('kofi', 'S1', [eight, six]);
    expect((first.body.results as { deviceCounter: number }[]).map((r) => r.deviceCounter)).toEqual([6, 8]);
    expect(first.body.counterGaps).toEqual([7]);
    expect(await num('SELECT last_device_counter::text AS n FROM pos.shift WHERE id = $1', [shifts.get('S1')!.id])).toBe(8);
    const again = await sync('kofi', 'S1', [eight]);
    expect(again.body.counterGaps).toEqual([7]);
    const raised = await outbox('pos.DeviceCounterGap', shifts.get('S1')!.id);
    expect(raised.map((r) => r.payload)).toEqual([expect.objectContaining({ missing: [7], highestSynced: 8, severity: 'URGENT', cashierId: users.get('kofi')!.principalId, exceptionKind: 'DEVICE_COUNTER_GAP', abuseCases: [10] })]);
    const arrived = await sync('kofi', 'S1', [seven]);
    expect(arrived.body.results[0].outcome).toBe('APPLIED');
    expect(arrived.body.counterGaps).toEqual([]);
    expect((await outbox('pos.DeviceCounterGap', shifts.get('S1')!.id)).length).toBe(1);
  });
});

describe('nothing in sync refuses a sale that passes integrity: each finding records it and raises an exception (ADR-0027 points 2 and 10)', () => {
  const flagged = async (saleId: string) => (await outbox('pos.OfflineSaleFlagged', saleId)).map((r) => r.payload);

  it('flags a till clock 301 seconds ahead of the server or before its shift opened, and not one 300 seconds out (the owner on A-273 (g))', async () => {
    const now = clock.now();
    const opened = shifts.get('S1')!.openedAt;
    const ahead = sale('S1', 9, new Date(now.getTime() + 301_000), [eggs('1.000', 'EGG', egg)], [cash(egg)]);
    const justAhead = sale('S1', 10, new Date(now.getTime() + 300_000), [eggs('1.000', 'EGG', egg)], [cash(egg)]);
    const before = sale('S1', 11, new Date(opened.getTime() - 301_000), [eggs('1.000', 'EGG', egg)], [cash(egg)]);
    const justBefore = sale('S1', 12, new Date(opened.getTime() - 300_000), [eggs('1.000', 'EGG', egg)], [cash(egg)]);
    const answer = await sync('kofi', 'S1', [ahead, justAhead, before, justBefore]);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const byCounter = new Map((answer.body.results as { deviceCounter: number; outcome: string; exceptions: { kind: string }[] }[]).map((r) => [r.deviceCounter, r]));
    expect([9, 10, 11, 12].map((c) => [c, byCounter.get(c)!.outcome, byCounter.get(c)!.exceptions.map((e) => e.kind)])).toEqual([
      [9, 'APPLIED_WITH_EXCEPTION', ['TILL_CLOCK_OUT_OF_TOLERANCE']],
      [10, 'APPLIED', []],
      [11, 'APPLIED_WITH_EXCEPTION', ['TILL_CLOCK_OUT_OF_TOLERANCE']],
      [12, 'APPLIED', []],
    ]);
    // Each is recorded with its money, and the flag is on the sale and the report's source.
    for (const s of [ahead, before]) {
      expect(await num('SELECT amount_pesewas::text AS n FROM pay.payment WHERE order_document_id = $1', [s.id])).toBe(egg);
    }
    expect(await rows('SELECT device_counter, clock_verdict FROM pos.sale_sync WHERE client_sale_id = ANY($1::uuid[]) ORDER BY device_counter', [[ahead.id, before.id]])).toEqual([
      { device_counter: 9, clock_verdict: 'AHEAD_OF_SERVER' },
      { device_counter: 11, clock_verdict: 'BEFORE_SHIFT_OPENED' },
    ]);
    expect(await flagged(ahead.id)).toEqual([expect.objectContaining({ exceptionKind: 'TILL_CLOCK_OUT_OF_TOLERANCE', severity: 'REVIEW', cashierId: users.get('kofi')!.principalId, deviceId: id('device:S1'), fact: expect.objectContaining({ verdict: 'AHEAD_OF_SERVER', toleranceSeconds: 300, differenceSeconds: 301 }) })]);
  });

  it('flags a sale that reached the server more than 8 hours after it was made, and records it (A-278 (c))', async () => {
    clock.advanceBy(9 * HOUR);
    const now = clock.now();
    const old = sale('S1', 13, new Date(now.getTime() - 8 * HOUR - 1_000), [eggs('1.000', 'CRATE', crate)], [cash(crate)]);
    const eight = sale('S1', 14, new Date(now.getTime() - 8 * HOUR), [eggs('1.000', 'CRATE', crate)], [cash(crate)]);
    const answer = await sync('kofi', 'S1', [old, eight]);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect((answer.body.results as { outcome: string; exceptions: { kind: string }[] }[]).map((r) => [r.outcome, r.exceptions.map((e) => e.kind)])).toEqual([
      ['APPLIED_WITH_EXCEPTION', ['OFFLINE_SALE_TOO_OLD']],
      ['APPLIED', []],
    ]);
    expect(await num('SELECT final_total_pesewas::text AS n FROM ord.sales_order WHERE id = $1', [old.id])).toBe(crate);
    expect(await one('SELECT too_old FROM pos.sale_sync WHERE client_sale_id = $1', [old.id])).toEqual({ too_old: true });
  });

  it('records a crate of cabbage, a unit it is not sold by, at the price the till agreed, moving 24 heads and asking a manager (CR-038)', async () => {
    const at = new Date(clock.now().getTime() - 15 * MINUTE);
    const cabbage = sale('S1', 15, at, [{ productId: id('PRD-0002'), quantity: '1.000', uom: 'CRATE', agreedUnitPricePesewas: 9_000 }], [cash(9_000)]);
    const answer = await sync('kofi', 'S1', [cabbage]);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.results[0]).toMatchObject({ outcome: 'APPLIED_WITH_EXCEPTION', grossPesewas: 9_000 });
    expect((answer.body.results[0].exceptions as { kind: string }[]).map((e) => e.kind).sort()).toEqual(['NOT_PRICED_AT_SYNC', 'UNIT_NOT_SOLD']);
    expect(await num('SELECT sum(qty_base)::text AS n FROM inv.stock_movement WHERE source_document_id = $1', [cabbage.id])).toBe(24);
    // No list prices it: the agreed price is its own band, with no variance, and a manager reviews it on the report.
    expect(await one('SELECT price_source, price_list_entry_id, resolved_unit_price_pesewas::int AS resolved, floor_unit_price_pesewas::int AS floor, variance_pesewas::int AS variance, variance_requires_approval FROM ord.sales_order_line WHERE sales_order_id = $1', [cabbage.id])).toEqual({
      price_source: 'MANUAL_APPROVED',
      price_list_entry_id: null,
      resolved: 9_000,
      floor: 9_000,
      variance: 0,
      variance_requires_approval: false,
    });
    expect(await num('SELECT amount_pesewas::text AS n FROM pay.payment WHERE order_document_id = $1', [cabbage.id])).toBe(9_000);
  });

  it('records a sale with a mobile money tender, takes no unverified money, and leaves the receipt outstanding (abuse case 4)', async () => {
    const at = new Date(clock.now().getTime() - 10 * MINUTE);
    const momo = sale('S1', 16, at, [eggs('1.000', 'CRATE', crate)], [{ paymentMethodId: id('MOMO'), amountPesewas: crate }]);
    const answer = await sync('kofi', 'S1', [momo]);
    expect(answer.body.results[0]).toMatchObject({ outcome: 'APPLIED_WITH_EXCEPTION', grossPesewas: crate, exceptions: [expect.objectContaining({ kind: 'UNMATCHED_PAYMENT' })] });
    expect(await num('SELECT count(*)::text AS n FROM pay.payment WHERE order_document_id = $1', [momo.id])).toBe(0);
    const documents = await documentsOf(momo.id);
    expect(await balance('1200', documents)).toBe(crate);
    expect(await flagged(momo.id)).toEqual([expect.objectContaining({ exceptionKind: 'UNMATCHED_PAYMENT', severity: 'URGENT', amountPesewas: crate, abuseCases: [4] })]);
  });

  it('records a sale of a cashier whose grant was revoked while the till was offline, synced by a manager recovering the till, attributed to the cashier', async () => {
    const at = new Date(clock.now().getTime() - 20 * MINUTE);
    const esis = sale('S3', 1, at, [eggs('2.000', 'EGG', egg)], [cash(2 * egg)]);
    const grant = await one<{ id: string }>('SELECT id FROM iam.role_grant WHERE principal_id = $1', [users.get('esi')!.principalId]);
    await stepUp(api.server, as('owner') as TotpSession, clock);
    expect((await post('owner', `/iam/grants/${grant.id}/revoke`, { reason: 'Left the shop' })).status).toBe(200);
    expect((await sync('esi', 'S3', [esis])).status).toBe(403);
    await stepUp(api.server, as('manager') as TotpSession, clock);
    const recovered = await sync('manager', 'S3', [esis]);
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(recovered.body.results[0]).toMatchObject({ outcome: 'APPLIED_WITH_EXCEPTION', grossPesewas: 2 * egg, exceptions: [expect.objectContaining({ kind: 'AUTHORISATION_FAILURE' })] });
    expect(await one('SELECT salesperson_id FROM ord.sales_order WHERE id = $1', [esis.id])).toEqual({ salesperson_id: users.get('esi')!.principalId });
    expect(await num('SELECT amount_pesewas::text AS n FROM pay.payment WHERE order_document_id = $1 AND shift_document_id = $2', [esis.id, shifts.get('S3')!.id])).toBe(2 * egg);
    expect(await flagged(esis.id)).toEqual([expect.objectContaining({ exceptionKind: 'AUTHORISATION_FAILURE', severity: 'URGENT', cashierId: users.get('esi')!.principalId })]);
  });
});

describe('who may sync, and the batch refused whole (OFFLINE_SYNC 6.3 and 7 steps 1 to 4)', () => {
  it('refuses every wrong caller, device and batch, recording nothing', async () => {
    const one1 = sale('S2', 1, new Date(clock.now().getTime() - MINUTE), [eggs('1.000', 'EGG', egg)], [cash(egg)]);
    const before = await footprint();
    expect((await sync('storekeeper', 'S2', [one1])).status).toBe(403);
    expect((await sync('accountant', 'S2', [one1])).status).toBe(403);
    expect((await sync(null, 'S2', [one1])).status).toBe(401);
    // Kofi is not the shift's cashier and holds no force close.
    expect((await sync('kofi', 'S2', [one1])).status).toBe(403);
    const unknown = await syncBatch(api.server, as('ama'), 'hkdev_S2.unknown', { deviceId: id('device:S2'), shiftId: shifts.get('S2')!.id, sales: [one1] });
    expect([unknown.status, unknown.body.error?.code]).toEqual([401, 'DEVICE_CREDENTIAL_INVALID']);
    const missing = await syncBatch(api.server, as('ama'), null, { deviceId: id('device:S2'), shiftId: shifts.get('S2')!.id, sales: [one1] });
    expect([missing.status, missing.body.error?.code]).toEqual([401, 'DEVICE_CREDENTIAL_INVALID']);
    const revoked = await syncBatch(api.server, as('ama'), credentials.get('lost')!, { deviceId: id('device:lost'), shiftId: shifts.get('S2')!.id, sales: [one1] });
    expect([revoked.status, revoked.body.error?.code]).toEqual([403, 'DEVICE_REVOKED']);
    // Another till's device, and a batch naming a device other than its credential's.
    expect((await syncBatch(api.server, as('ama'), credentials.get('S1')!, { deviceId: id('device:S1'), shiftId: shifts.get('S2')!.id, sales: [one1] })).status).toBe(403);
    expect((await syncBatch(api.server, as('ama'), credentials.get('S2')!, { deviceId: id('device:S1'), shiftId: shifts.get('S2')!.id, sales: [one1] })).status).toBe(403);
    const nothing = await syncBatch(api.server, as('ama'), credentials.get('S2')!, { deviceId: id('device:S2'), shiftId: nextId(), sales: [one1] });
    expect(nothing.status).toBe(404);
    expect(Object.keys(nothing.body)).toEqual(['error']);
    const big = Array.from({ length: 501 }, (_, i) => sale('S2', i + 1, new Date(clock.now().getTime() - MINUTE), [eggs('1.000', 'EGG', egg)], [cash(egg)]));
    const tooMany = await sync('ama', 'S2', big);
    expect([tooMany.status, tooMany.body.error?.code]).toEqual([400, 'SYNC_BATCH_TOO_LARGE']);
    expect(await footprint()).toEqual(before);
    expect(await num('SELECT count(*)::text AS n FROM pos.sale_sync WHERE shift_id = $1', [shifts.get('S2')!.id])).toBe(0);
  });

  it('answers a cash movement in the batch as not taken at sync, so the till keeps it to record online (A-278 (a))', async () => {
    const movement = { id: nextId(), kind: 'PAY_OUT', amountPesewas: 1_000, reasonCode: 'FUEL_PAYOUT', occurredAt: clock.now().toISOString() };
    const answer = await sync('ama', 'S2', [], 'S2', { cashMovements: [movement] });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.cashMovementResults).toEqual([{ clientId: movement.id, outcome: 'REJECTED', reason: 'CASH_MOVEMENT_NOT_TAKEN_AT_SYNC' }]);
    expect(await num('SELECT count(*)::text AS n FROM pos.cash_movement WHERE id = $1', [movement.id])).toBe(0);
  });
});
