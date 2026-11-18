import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, consolePut, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { syncBatch, tillSale, type TillLine, type TillSale } from '../../support/offline';
import { setTillPin, tillVerifier } from '../../support/till-pin';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The queue's other records (B09b continued 2c, OFFLINE_SYNC 5.3, 9.9 and 10, ADR-0027, ADR-0077): a shift the till
 * opened offline and sent hours later, the cash movements of a sync batch, and a mobile money tender taken unverified.
 * The till makes everything with no request to the server, then sends its queue. Every figure is read by SQL over the
 * shift, `pos.cash_movement`, `pos.cash_movement_sync`, `pay.payment`, `pay.reconciliation_break`, the journal lines and
 * the outbox, never from the answer under test; every expected cash figure is derived independently from those tables.
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
const step = (who: string) => stepUp(api.server, as(who) as TotpSession, clock);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ago = (ms: number) => new Date(clock.now().getTime() - ms);
const crateLine = (crates: number): TillLine => ({ productId: id('EGG-0003'), quantity: `${crates}.000`, uom: 'CRATE', agreedUnitPricePesewas: 6_000 });
const cash = (amount: number) => ({ paymentMethodId: id('CASH'), amountPesewas: amount });
const outbox = (type: string, subject: string) => rows<{ payload: Record<string, unknown> }>('SELECT payload FROM platform.outbox_message WHERE event_type = $1 AND subject_id = $2 ORDER BY recorded_at', [type, subject]);

/** `openShift` as the till sends it from its queue: the session, the device credential, the client id as the key. */
function openFromTill(who: string, till: string, body: { readonly id: string; readonly openedAt: Date; readonly float: number; readonly shiftSeq?: number }, device: string | null = till) {
  const call = consolePost(api.server, as(who), '/v1/shifts', body.id);
  if (device !== null) call.set('X-Device-Credential', credentials.get(device)!);
  return call.send({ id: body.id, registerId: id(`till:${till}`), openingFloatPesewas: body.float, openedAt: body.openedAt.toISOString(), ...(body.shiftSeq === undefined ? {} : { shiftSeq: body.shiftSeq }) });
}

/** The till's next shift sequence, as its last pack gave it. */
async function packSeq(who: string, till: string): Promise<number> {
  const read = await consoleGet(api.server, as(who), `/v1/registers/${id(`till:${till}`)}/offline-pack`).set('X-Device-Credential', credentials.get(till)!);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body.nextShiftSeq as number;
}

const sync = (who: string, till: string, sales: readonly TillSale[], cashMovements: readonly object[] = [], device: string = till) =>
  syncBatch(api.server, as(who), credentials.get(device)!, { deviceId: id(`device:${device}`), shiftId: shifts.get(till)!.id, sales, cashMovements });

/** Debits less credits on an account over the journals whose source is any of the documents. */
async function balance(code: string, documents: readonly string[]): Promise<number> {
  return num(
    `SELECT sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS n
       FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
      WHERE a.code = $1 AND e.source_document_id = ANY($2::uuid[])`,
    [code, documents],
  );
}

/** The documents a till's cash journals come from: the shift (its float and movements) and every payment it took. */
async function tillDocuments(shiftId: string): Promise<string[]> {
  return [shiftId, ...(await rows<{ id: string }>('SELECT id FROM pay.payment WHERE shift_document_id = $1', [shiftId])).map((r) => r.id)];
}

/**
 * The cash the till should hold, derived by SQL alone: the float and pay-ins, plus the cash payments that stand, less
 * the drops and the pay-outs (FR-POS-019).
 */
async function expectedCashBySql(shiftId: string): Promise<number> {
  return num(
    `SELECT (COALESCE((SELECT sum(CASE WHEN kind IN ('FLOAT_IN', 'PAY_IN') THEN amount_pesewas ELSE -amount_pesewas END) FROM pos.cash_movement WHERE shift_id = $1), 0)
           + COALESCE((SELECT sum(amount_pesewas - refunded_pesewas) FROM pay.payment WHERE shift_document_id = $1 AND method_kind = 'CASH' AND status = 'CLEARED'), 0))::text AS n`,
    [shiftId],
  );
}

async function setSetting(key: string, value: number | boolean, branchId?: string) {
  await step('owner');
  const current = await rows<{ version: number }>('SELECT version FROM platform.setting WHERE key = $1 AND branch_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL ORDER BY valid_from DESC LIMIT 1', [key, branchId ?? null]);
  const put = await consolePut(api.server, as('owner'), `/v1/admin/settings/${key}`).send({ value, version: current[0]?.version ?? 0, ...(branchId === undefined ? {} : { branchId }) });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  clock.advanceBy(31_000);
}

async function enrol(till: string, device: string): Promise<void> {
  await step('manager');
  const enrolled = await post('manager', `/registers/${id(`till:${till}`)}/devices`, { deviceLabel: `Shop tablet ${device}` });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  credentials.set(device, enrolled.body.deviceCredential as string);
  ids.set(`device:${device}`, enrolled.body.device.id as string);
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
     UNION ALL SELECT sku, id FROM mdm.product WHERE sku = 'EGG-0003'
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
    ['yaw', 'Yaw Ofori', 'CASHIER', false],
    ['abena', 'Abena Sarpong', 'CASHIER', false],
    ['storekeeper', 'Kofi Mensah', 'STOREKEEPER', false],
  ] as const) {
    const user = await createUser(database, { name, grants: [{ role, branchId: id('branch'), ...(role === 'CASHIER' || role === 'STOREKEEPER' ? { locationId: id('shop') } : {}) }] });
    users.set(who, user);
    sessions.set(who, totp ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  // The manager approves and witnesses on the till with their till PIN, version 1 (B09b continued 3, ADR-0080).
  expect((await setTillPin(api.server, as('manager'), await tillVerifier('554031'))).status).toBe(200);
  for (const code of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']) {
    const till = await post('manager', '/registers', { branchId: id('branch'), locationId: id('shop'), code, name: `Shop till ${code}` });
    expect(till.status, JSON.stringify(till.body)).toBe(201);
    ids.set(`till:${code}`, till.body.id as string);
    await enrol(code, code);
  }
  await enrol('Q4', 'Q4b');
  // The shifts open well after the seeded prices take effect, so the till's hours-old times are still priced.
  clock.advanceBy(7 * HOUR);
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('a shift opened offline is applied once at sync with its till time (OFFLINE_SYNC 10, BL-078)', () => {
  it('keeps the till time five hours old, takes the sequence the pack gave, posts the float on it and is applied once by its id', async () => {
    const seq = await packSeq('kofi', 'Q1');
    const shiftId = nextId();
    const openedAt = ago(5 * HOUR);
    const opened = await openFromTill('kofi', 'Q1', { id: shiftId, openedAt, float: 20_000, shiftSeq: seq });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    shifts.set('Q1', { id: shiftId, seq, openedAt });
    const shift = await one<{ opened_at: Date; shift_seq: number; cashier_id: string; status: string }>('SELECT opened_at, shift_seq, cashier_id, status FROM pos.shift WHERE id = $1', [shiftId]);
    expect(shift).toMatchObject({ shift_seq: seq, cashier_id: users.get('kofi')!.principalId, status: 'OPEN' });
    expect(shift.opened_at.toISOString()).toBe(openedAt.toISOString());
    expect(opened.body).toMatchObject({ id: shiftId, shiftSeq: seq, openedAt: openedAt.toISOString(), openingFloatPesewas: 20_000 });
    // The float: one movement at the till's time, Dr 1000 20,000 and Cr 1010 20,000 on its date.
    const float = await one<{ occurred_at: Date; amount: string }>("SELECT occurred_at, amount_pesewas::text AS amount FROM pos.cash_movement WHERE shift_id = $1 AND kind = 'FLOAT_IN'", [shiftId]);
    expect([float.occurred_at.toISOString(), float.amount]).toEqual([openedAt.toISOString(), '20000']);
    expect([await balance('1000', [shiftId]), await balance('1010', [shiftId])]).toEqual([20_000, -20_000]);
    expect(await one("SELECT posting_date::text AS d FROM fin.journal_entry WHERE source_document_id = $1 AND event_code = 'pos.ShiftOpened'", [shiftId])).toEqual({ d: toBusinessDate(openedAt) });
    expect(await outbox('pos.OfflineShiftFlagged', shiftId)).toEqual([]);

    // Sent again, as a till does after a timeout: the first answer, nothing twice.
    const again = await openFromTill('kofi', 'Q1', { id: shiftId, openedAt, float: 20_000, shiftSeq: seq });
    expect([again.status, again.body.id, again.body.shiftSeq]).toEqual([201, shiftId, seq]);
    expect(await num('SELECT count(*)::text AS n FROM pos.shift WHERE id = $1', [shiftId])).toBe(1);
    expect(await num('SELECT count(*)::text AS n FROM pos.cash_movement WHERE shift_id = $1', [shiftId])).toBe(1);
    expect(await num("SELECT count(*)::text AS n FROM fin.journal_entry WHERE source_document_id = $1 AND event_code = 'pos.ShiftOpened'", [shiftId])).toBe(1);
    expect(await expectedCashBySql(shiftId)).toBe(20_000);
  });

  it('records a till clock 301 seconds ahead at the server time and flags it, never refusing; 300 seconds ahead is an online open', async () => {
    const ahead = nextId();
    const opened = await openFromTill('ama', 'Q2', { id: ahead, openedAt: new Date(clock.now().getTime() + 301_000), float: 0 });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect((await one<{ opened_at: Date }>('SELECT opened_at FROM pos.shift WHERE id = $1', [ahead])).opened_at.toISOString()).toBe(clock.now().toISOString());
    const flags = await outbox('pos.OfflineShiftFlagged', ahead);
    expect(flags.map((f) => [f.payload['exceptionKind'], f.payload['severity'], (f.payload['fact'] as Record<string, unknown>)['verdict']])).toEqual([['TILL_CLOCK_OUT_OF_TOLERANCE', 'REVIEW', 'AHEAD_OF_SERVER']]);
    expect(flags[0]!.payload).toMatchObject({ deviceId: id('device:Q2'), cashierId: users.get('ama')!.principalId, register: { id: id('till:Q2'), code: 'Q2' } });
    shifts.set('Q2', { id: ahead, seq: opened.body.shiftSeq as number, openedAt: clock.now() });

    const within = nextId();
    const online = await openFromTill('esi', 'Q3', { id: within, openedAt: new Date(clock.now().getTime() + 300_000), float: 0 });
    expect(online.status, JSON.stringify(online.body)).toBe(201);
    expect((await one<{ opened_at: Date }>('SELECT opened_at FROM pos.shift WHERE id = $1', [within])).opened_at.toISOString()).toBe(clock.now().toISOString());
    expect(await outbox('pos.OfflineShiftFlagged', within)).toEqual([]);
    shifts.set('Q3', { id: within, seq: online.body.shiftSeq as number, openedAt: clock.now() });
  });

  it('refuses the second of two devices that opened shifts on one till offline, as online, and raises it for a manager', async () => {
    const first = nextId();
    const firstAt = ago(3 * HOUR);
    expect((await openFromTill('yaw', 'Q4', { id: first, openedAt: firstAt, float: 0 }, 'Q4')).status).toBe(201);
    shifts.set('Q4', { id: first, seq: 1, openedAt: firstAt });
    const second = nextId();
    const refused = await openFromTill('abena', 'Q4', { id: second, openedAt: ago(2 * HOUR), float: 5_000 }, 'Q4b');
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'SHIFT_ALREADY_OPEN', details: [{ code: 'REGISTER_HAS_OPEN_SHIFT' }] });
    expect(await num('SELECT count(*)::text AS n FROM pos.shift WHERE id = $1', [second])).toBe(0);
    expect(await num('SELECT count(*)::text AS n FROM platform.business_document WHERE id = $1', [second])).toBe(0);
    const raised = await outbox('pos.OfflineShiftFlagged', id('till:Q4'));
    expect(raised.map((r) => [r.payload['exceptionKind'], r.payload['severity'], r.payload['shiftId'], r.payload['deviceId'], r.payload['cashierId'], r.payload['amountPesewas']])).toEqual([
      ['OFFLINE_SHIFT_REFUSED', 'URGENT', second, id('device:Q4b'), users.get('abena')!.principalId, 5_000],
    ]);
    expect(raised[0]!.payload['fact']).toMatchObject({ rule: 'REGISTER_HAS_OPEN_SHIFT', openShiftId: first, openShiftCashierId: users.get('yaw')!.principalId });
  });

  it('flags a provisional sequence the server did not give, keeping the server sequence', async () => {
    const seq = await packSeq('abena', 'Q5');
    const shiftId = nextId();
    const opened = await openFromTill('abena', 'Q5', { id: shiftId, openedAt: ago(1 * HOUR), float: 0, shiftSeq: seq + 4 });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body.shiftSeq).toBe(seq);
    expect((await outbox('pos.OfflineShiftFlagged', shiftId)).map((r) => [r.payload['exceptionKind'], r.payload['fact']])).toEqual([['SHIFT_SEQ_DIFFERS', { tillShiftSeq: seq + 4, serverShiftSeq: seq }]]);
    shifts.set('Q5', { id: shiftId, seq, openedAt: ago(1 * HOUR) });
  });

  it('keeps an online open without a device as B9b built it, and refuses a revoked device, another till device and the wrong role, recording nothing', async () => {
    const before = await num('SELECT count(*)::text AS n FROM pos.shift');
    const online = await openFromTill('storekeeper', 'Q1', { id: nextId(), openedAt: clock.now(), float: 0 }, null);
    expect(online.status).toBe(403);
    // A till's own device opens hours ago; without one the till time must be within the tolerance.
    await step('manager');
    const t6 = await post('manager', '/registers', { branchId: id('branch'), locationId: id('shop'), code: 'Q6', name: 'Shop till Q6' });
    ids.set('till:Q6', t6.body.id as string);
    await enrol('Q6', 'Q6');
    await enrol('Q6', 'Q6x');
    const stale = await openFromTill('storekeeper', 'Q6', { id: nextId(), openedAt: ago(2 * HOUR), float: 0 }, null);
    expect(stale.status).toBe(403);
    const late = consolePost(api.server, as('manager'), '/v1/shifts').send({ id: nextId(), registerId: id('till:Q6'), openingFloatPesewas: 0, openedAt: ago(2 * HOUR).toISOString() });
    expect((await late).body.error).toMatchObject({ code: 'SHIFT_INVALID', details: [{ code: 'OPENED_AT_OUT_OF_WINDOW' }] });
    await step('manager');
    expect((await post('manager', `/devices/${id('device:Q6x')}/revoke`, { reason: 'Left at the lorry station' })).status).toBe(200);
    const revoked = await consolePost(api.server, as('manager'), '/v1/shifts').set('X-Device-Credential', credentials.get('Q6x')!).send({ id: nextId(), registerId: id('till:Q6'), openingFloatPesewas: 0, openedAt: ago(2 * HOUR).toISOString() });
    expect([revoked.status, revoked.body.error.code]).toEqual([403, 'DEVICE_REVOKED']);
    const foreign = await consolePost(api.server, as('manager'), '/v1/shifts').set('X-Device-Credential', credentials.get('Q1')!).send({ id: nextId(), registerId: id('till:Q6'), openingFloatPesewas: 0, openedAt: ago(2 * HOUR).toISOString() });
    expect(foreign.status).toBe(403);
    const unknown = await consolePost(api.server, as('manager'), '/v1/shifts').set('X-Device-Credential', 'hkdev_Q6.nothing').send({ id: nextId(), registerId: id('till:Q6'), openingFloatPesewas: 0, openedAt: ago(2 * HOUR).toISOString() });
    expect([unknown.status, unknown.body.error.code]).toEqual([401, 'DEVICE_CREDENTIAL_INVALID']);
    expect(await num('SELECT count(*)::text AS n FROM pos.shift')).toBe(before);
  });
});

describe('the cash movements of a sync batch: applied exactly once on their own open shift, answered per movement (OFFLINE_SYNC 10, ADR-0077)', () => {
  const movement = (kind: 'CASH_DROP' | 'PAY_OUT' | 'PAY_IN', amount: number, reasonCode: string, at: Date, extra: object = {}) => ({ id: createUuidV7Generator(new ManualClock(at))(), kind, amountPesewas: amount, reasonCode, occurredAt: at.toISOString(), ...extra });
  let sales: TillSale[];
  let moves: ReturnType<typeof movement>[];

  it('applies each at the till time hours old, posts it, and answers APPLIED; the till holds what the tables say', async () => {
    const q1 = shifts.get('Q1')!;
    sales = [
      tillSale({ till: 'Q1', shiftSeq: q1.seq, counter: 1, at: ago(4 * HOUR), lines: [crateLine(3)], tenders: [cash(18_000)] }),
      tillSale({ till: 'Q1', shiftSeq: q1.seq, counter: 2, at: ago(3 * HOUR), lines: [crateLine(2)], tenders: [cash(12_000)] }),
    ];
    moves = [
      movement('PAY_OUT', 1_500, 'FUEL_PAYOUT', ago(3.5 * HOUR), { note: 'Fuel for the generator' }),
      movement('CASH_DROP', 25_000, 'SAFE_DROP', ago(2.5 * HOUR)),
      movement('CASH_DROP', 2_000, 'SAFE_DROP', ago(2 * HOUR), { witnessId: users.get('manager')!.principalId, witnessPinVersion: 1 }),
      movement('PAY_IN', 5_000, 'FLOAT_TOP_UP', ago(1 * HOUR)),
    ];
    const synced = await sync('kofi', 'Q1', sales, moves);
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect(synced.body.cashMovementResults).toEqual(moves.map((m) => ({ clientId: m.id, outcome: 'APPLIED', reason: null })));
    for (const m of moves) {
      const row = await one<{ shift_id: string; kind: string; amount: string; occurred_at: Date; actor_id: string; witness_id: string | null; unwitnessed: boolean }>(
        'SELECT shift_id, kind, amount_pesewas::text AS amount, occurred_at, actor_id, witness_id, unwitnessed FROM pos.cash_movement WHERE id = $1',
        [m.id],
      );
      expect(row).toMatchObject({ shift_id: q1.id, kind: m.kind, amount: String(m.amountPesewas), actor_id: users.get('kofi')!.principalId });
      expect(row.occurred_at.toISOString()).toBe(m.occurredAt);
    }
    // The drop with no witness is marked unwitnessed; the witnessed one names the manager and the PIN version it was confirmed with.
    expect(await rows('SELECT witness_id, unwitnessed FROM pos.cash_movement WHERE id = ANY($1::uuid[]) ORDER BY occurred_at', [[moves[1]!.id, moves[2]!.id]])).toEqual([
      { witness_id: null, unwitnessed: true },
      { witness_id: users.get('manager')!.principalId, unwitnessed: false },
    ]);
    // 20,000 float + 30,000 sales - 1,500 - 25,000 - 2,000 + 5,000 = 26,500, by the tables and by the ledger.
    expect(await expectedCashBySql(q1.id)).toBe(26_500);
    const documents = await tillDocuments(q1.id);
    expect(await balance('1000', documents)).toBe(26_500);
    expect(await balance('1010', [q1.id])).toBe(-20_000 + 25_000 + 2_000 - 5_000);
    expect(await balance('6800', [q1.id])).toBe(1_500);
    expect(await balance('1200', documents.slice(1))).toBe(-30_000);
    for (const m of moves) {
      expect(await one("SELECT posting_date::text AS d FROM fin.journal_entry WHERE source_document_id = $1 AND event_subject_id = $2", [q1.id, m.id])).toEqual({ d: toBusinessDate(new Date(m.occurredAt)) });
    }
    expect(await rows('SELECT client_movement_id AS id, outcome, reason FROM pos.cash_movement_sync WHERE shift_id = $1 ORDER BY received_at, client_occurred_at', [q1.id])).toEqual(moves.map((m) => ({ id: m.id, outcome: 'APPLIED', reason: null })));
  });

  it('answers the whole batch sent again DUPLICATE, and records nothing twice', async () => {
    const q1 = shifts.get('Q1')!;
    const counts = async () => [await num('SELECT count(*)::text AS n FROM pos.cash_movement WHERE shift_id = $1', [q1.id]), await num('SELECT count(*)::text AS n FROM fin.journal_entry WHERE source_document_id = $1', [q1.id]), await expectedCashBySql(q1.id)];
    const before = await counts();
    const again = await sync('kofi', 'Q1', sales, moves);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.cashMovementResults).toEqual(moves.map((m) => ({ clientId: m.id, outcome: 'DUPLICATE', reason: null })));
    expect((again.body.results as { outcome: string }[]).map((r) => r.outcome)).toEqual(['DUPLICATE', 'DUPLICATE']);
    expect(await counts()).toEqual(before);
    expect(before).toEqual([5, 1 + 4, 26_500]);
    expect(await num("SELECT count(*)::text AS n FROM pos.cash_movement_sync WHERE shift_id = $1 AND outcome = 'DUPLICATE'", [q1.id])).toBe(4);
  });

  it('answers a movement already recorded online DUPLICATE, and refuses an id reused with other content', async () => {
    const q1 = shifts.get('Q1')!;
    const onlineId = nextId();
    const recorded = await post('kofi', `/shifts/${q1.id}/cash-movements`, { id: onlineId, kind: 'PAY_OUT', amountPesewas: 700, reasonCode: 'FUEL_PAYOUT', note: 'Fuel for the generator', occurredAt: clock.now().toISOString() }, onlineId);
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    const reused = { ...moves[0]!, amountPesewas: 1_600 };
    const synced = await sync('kofi', 'Q1', [], [{ id: onlineId, kind: 'PAY_OUT', amountPesewas: 700, reasonCode: 'FUEL_PAYOUT', note: 'Fuel for the generator', occurredAt: ago(10 * MINUTE).toISOString() }, reused]);
    expect(synced.body.cashMovementResults).toEqual([
      { clientId: onlineId, outcome: 'DUPLICATE', reason: null },
      { clientId: reused.id, outcome: 'REJECTED', reason: 'ID_REUSED_WITH_OTHER_CONTENT' },
    ]);
    expect(await num('SELECT amount_pesewas::text AS n FROM pos.cash_movement WHERE id = $1', [reused.id])).toBe(1_500);
    expect(await expectedCashBySql(q1.id)).toBe(26_500 - 700);
    const raised = await outbox('pos.OfflineCashMovementFlagged', reused.id);
    expect(raised.map((r) => [r.payload['exceptionKind'], r.payload['severity'], (r.payload['fact'] as Record<string, unknown>)['reason']])).toEqual([['CASH_MOVEMENT_REJECTED', 'URGENT', 'ID_REUSED_WITH_OTHER_CONTENT']]);
  });

  it('refuses a drop of more than the till holds, records nothing, raises it once and answers the same on every later sync', async () => {
    const q1 = shifts.get('Q1')!;
    const holds = await expectedCashBySql(q1.id);
    const tooMuch = movement('CASH_DROP', holds + 1, 'SAFE_DROP', ago(20 * MINUTE));
    const first = await sync('kofi', 'Q1', [], [tooMuch]);
    expect(first.body.cashMovementResults).toEqual([{ clientId: tooMuch.id, outcome: 'REJECTED', reason: 'TILL_OVERDRAWN' }]);
    // Sales that came in later would let the till hold it now: the refusal stands all the same.
    const more = tillSale({ till: 'Q1', shiftSeq: q1.seq, counter: 3, at: ago(15 * MINUTE), lines: [crateLine(1)], tenders: [cash(6_000)] });
    const second = await sync('kofi', 'Q1', [more], [tooMuch]);
    expect(second.body.cashMovementResults).toEqual([{ clientId: tooMuch.id, outcome: 'REJECTED', reason: 'TILL_OVERDRAWN' }]);
    expect(await num('SELECT count(*)::text AS n FROM pos.cash_movement WHERE id = $1', [tooMuch.id])).toBe(0);
    expect(await expectedCashBySql(q1.id)).toBe(holds + 6_000);
    expect(await rows('SELECT outcome, reason, answers_id IS NULL AS decides FROM pos.cash_movement_sync WHERE client_movement_id = $1 ORDER BY received_at', [tooMuch.id])).toEqual([
      { outcome: 'REJECTED', reason: 'TILL_OVERDRAWN', decides: true },
      { outcome: 'REJECTED', reason: 'TILL_OVERDRAWN', decides: false },
    ]);
    const raised = await outbox('pos.OfflineCashMovementFlagged', tooMuch.id);
    expect(raised.map((r) => [r.payload['exceptionKind'], r.payload['severity'], r.payload['amountPesewas'], r.payload['cashierId'], r.payload['abuseCases']])).toEqual([['CASH_MOVEMENT_REJECTED', 'URGENT', holds + 1, users.get('kofi')!.principalId, [17]]]);
  });

  it('refuses a queued drop whose named witness sent no PIN version, or a version not in force: a name alone is no witness (CR-032 point 4)', async () => {
    const q1 = shifts.get('Q1')!;
    const nameOnly = movement('CASH_DROP', 100, 'SAFE_DROP', ago(12 * MINUTE), { witnessId: users.get('manager')!.principalId });
    const unknown = movement('CASH_DROP', 100, 'SAFE_DROP', ago(11 * MINUTE), { witnessId: users.get('manager')!.principalId, witnessPinVersion: 3 });
    const synced = await sync('kofi', 'Q1', [], [nameOnly, unknown]);
    expect(synced.body.cashMovementResults).toEqual([
      { clientId: nameOnly.id, outcome: 'REJECTED', reason: 'WITNESS_PIN_REQUIRED' },
      { clientId: unknown.id, outcome: 'REJECTED', reason: 'WITNESS_PIN_UNKNOWN' },
    ]);
    expect(await num('SELECT count(*)::text AS n FROM pos.cash_movement WHERE id = ANY($1::uuid[])', [[nameOnly.id, unknown.id]])).toBe(0);
    for (const m of [nameOnly, unknown]) {
      expect((await outbox('pos.OfflineCashMovementFlagged', m.id)).map((r) => [r.payload['exceptionKind'], r.payload['severity']])).toEqual([['CASH_MOVEMENT_REJECTED', 'URGENT']]);
    }
    expect(q1.id).toBeDefined();
  });

  it('records a movement whose till clock is 301 seconds ahead at the server time, flagged; 300 seconds is kept', async () => {
    const ahead = movement('PAY_OUT', 300, 'FUEL_PAYOUT', new Date(clock.now().getTime() + 301_000), { note: 'Fuel for the generator' });
    const edge = movement('PAY_OUT', 200, 'FUEL_PAYOUT', new Date(clock.now().getTime() + 300_000), { note: 'Fuel for the generator' });
    const synced = await sync('kofi', 'Q1', [], [ahead, edge]);
    expect(synced.body.cashMovementResults).toEqual([
      { clientId: ahead.id, outcome: 'APPLIED', reason: null },
      { clientId: edge.id, outcome: 'APPLIED', reason: null },
    ]);
    expect((await one<{ at: Date }>('SELECT occurred_at AS at FROM pos.cash_movement WHERE id = $1', [ahead.id])).at.toISOString()).toBe(clock.now().toISOString());
    expect((await one<{ at: Date }>('SELECT occurred_at AS at FROM pos.cash_movement WHERE id = $1', [edge.id])).at.toISOString()).toBe(edge.occurredAt);
    expect((await outbox('pos.OfflineCashMovementFlagged', ahead.id)).map((r) => [r.payload['exceptionKind'], (r.payload['fact'] as Record<string, unknown>)['verdict']])).toEqual([['TILL_CLOCK_OUT_OF_TOLERANCE', 'AHEAD_OF_SERVER']]);
    expect(await outbox('pos.OfflineCashMovementFlagged', edge.id)).toEqual([]);
    expect(await num('SELECT clock_verdict IS NOT NULL AS n FROM pos.cash_movement_sync WHERE client_movement_id = $1', [ahead.id])).toBe(1);
  });

  it('never puts a movement onto another cashier shift: the batch is refused whole, nothing recorded', async () => {
    const before = await num('SELECT count(*)::text AS n FROM pos.cash_movement');
    const other = movement('PAY_OUT', 100, 'FUEL_PAYOUT', ago(5 * MINUTE), { note: 'Fuel for the generator' });
    const refused = await syncBatch(api.server, as('kofi'), credentials.get('Q2')!, { deviceId: id('device:Q2'), shiftId: shifts.get('Q2')!.id, sales: [], cashMovements: [other] });
    expect(refused.status).toBe(403);
    expect(await num('SELECT count(*)::text AS n FROM pos.cash_movement')).toBe(before);
    expect(await num('SELECT count(*)::text AS n FROM pos.cash_movement_sync WHERE client_movement_id = $1', [other.id])).toBe(0);
  });

  it('records a closed shift movement nowhere, answers it REJECTED SHIFT_NOT_OPEN and raises it, the closed figures untouched', async () => {
    const q3 = shifts.get('Q3')!;
    const declared = await post('esi', `/shifts/${q3.id}/close`, { declared: [{ paymentMethodId: id('CASH'), declaredPesewas: 0 }], lastDeviceCounter: 0 });
    expect(declared.status, JSON.stringify(declared.body)).toBe(200);
    await step('manager');
    const signed = await post('manager', `/shifts/${q3.id}/approve-close`, { reason: 'Counted with Esi' });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    const frozen = await one('SELECT expected_cash_pesewas::text AS e, status FROM pos.shift WHERE id = $1', [q3.id]);
    const late = movement('PAY_OUT', 400, 'FUEL_PAYOUT', ago(1 * MINUTE), { note: 'Fuel for the generator' });
    const synced = await sync('esi', 'Q3', [], [late]);
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect(synced.body.cashMovementResults).toEqual([{ clientId: late.id, outcome: 'REJECTED', reason: 'SHIFT_NOT_OPEN' }]);
    expect(await num('SELECT count(*)::text AS n FROM pos.cash_movement WHERE id = $1', [late.id])).toBe(0);
    expect(await one('SELECT expected_cash_pesewas::text AS e, status FROM pos.shift WHERE id = $1', [q3.id])).toEqual(frozen);
    expect((await outbox('pos.OfflineCashMovementFlagged', late.id)).map((r) => [r.payload['exceptionKind'], r.payload['severity'], (r.payload['fact'] as Record<string, unknown>)['shiftStatus']])).toEqual([['CASH_MOVEMENT_REJECTED', 'URGENT', 'CLOSED']]);
  });

  it('records a force-closed shift movement nowhere, answers it REJECTED SHIFT_NOT_OPEN and raises it', async () => {
    const q2 = shifts.get('Q2')!;
    await step('manager');
    const forced = await post('manager', `/shifts/${q2.id}/force-close`, { reason: 'The tablet will not power on and the cashier has gone home' });
    expect(forced.status, JSON.stringify(forced.body)).toBe(200);
    const late = movement('CASH_DROP', 1_000, 'SAFE_DROP', ago(1 * MINUTE));
    const synced = await sync('ama', 'Q2', [], [late]);
    expect(synced.body.cashMovementResults).toEqual([{ clientId: late.id, outcome: 'REJECTED', reason: 'SHIFT_NOT_OPEN' }]);
    expect(await num('SELECT count(*)::text AS n FROM pos.cash_movement WHERE id = $1', [late.id])).toBe(0);
    expect(await num("SELECT count(*)::text AS n FROM pos.cash_movement WHERE shift_id = $1 AND kind <> 'FLOAT_IN'", [q2.id])).toBe(0);
    const raised = await outbox('pos.OfflineCashMovementFlagged', late.id);
    expect(raised.map((r) => [r.payload['exceptionKind'], r.payload['severity'], (r.payload['fact'] as Record<string, unknown>)['forceClosed']])).toEqual([['CASH_MOVEMENT_REJECTED', 'URGENT', true]]);
  });

  it('holds exactly once in the database: a second applied row for one movement, and any change to the log, are refused', async () => {
    const [applied] = await rows<Record<string, unknown>>("SELECT * FROM pos.cash_movement_sync WHERE outcome = 'APPLIED' LIMIT 1");
    await expect(admin().query('INSERT INTO pos.cash_movement_sync SELECT $1::uuid, device_id, shift_id, branch_id, client_movement_id, kind, amount_pesewas, client_occurred_at, outcome, reason, cash_movement_id, answers_id, clock_verdict, received_at, recorded_at, actor_id FROM pos.cash_movement_sync WHERE id = $2', [randomUUID(), applied!['id']])).rejects.toMatchObject({ code: '23505', constraint: 'uq_cash_movement_sync_decided' });
    await expect(admin().query("UPDATE pos.cash_movement_sync SET reason = 'X1' WHERE id = $1", [applied!['id']])).rejects.toMatchObject({ code: 'HK001' });
    await expect(admin().query("INSERT INTO pos.cash_movement_sync SELECT $1::uuid, device_id, shift_id, branch_id, $2::uuid, kind, amount_pesewas, client_occurred_at, 'APPLIED', NULL, cash_movement_id, NULL, NULL, received_at, recorded_at, actor_id FROM pos.cash_movement_sync WHERE id = $3", [randomUUID(), randomUUID(), applied!['id']])).rejects.toMatchObject({ code: 'HK010' });
  });
});

describe('the unverified mobile money tender (OFFLINE_SYNC 5.3 and 9.9, abuse case 4)', () => {
  let reviewed: TillSale;
  const momo = (amount: number, approvedById: string, providerReference = 'MP261113.1149.C41872', approvedByPinVersion?: number) => ({
    paymentMethodId: id('MOMO'),
    amountPesewas: amount,
    unverifiedMobileMoney: { payerPhone: '+233245550142', network: 'MTN', providerReference, approvedById, ...(approvedByPinVersion === undefined ? {} : { approvedByPinVersion }) },
  });

  it('with the branch setting off, stays as B09b continued 2b built it: not recorded, raised', async () => {
    const q5 = shifts.get('Q5')!;
    const s = tillSale({ till: 'Q5', shiftSeq: q5.seq, counter: 1, at: ago(30 * MINUTE), lines: [crateLine(2)], tenders: [momo(12_000, users.get('manager')!.principalId)] });
    const synced = await sync('abena', 'Q5', [s]);
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect((synced.body.results as { exceptions: { kind: string }[] }[])[0]!.exceptions.map((e) => e.kind)).toEqual(['UNMATCHED_PAYMENT']);
    expect(await num('SELECT count(*)::text AS n FROM pay.payment WHERE order_document_id = $1', [s.id])).toBe(0);
    expect(await num("SELECT count(*)::text AS n FROM pay.reconciliation_break WHERE kind = 'UNVERIFIED_PAYMENT'")).toBe(0);
    expect((await outbox('pos.OfflineSaleFlagged', s.id)).map((r) => [r.payload['exceptionKind'], r.payload['severity']])).toEqual([['UNMATCHED_PAYMENT', 'URGENT']]);
  });

  it('while the branch allows it, records it UNVERIFIED and PENDING on its own open shift, allocated to the receipt, posted, with its break for review', async () => {
    await setSetting('pos.offline.allow_unverified_mobile_money', true, id('branch'));
    const q5 = shifts.get('Q5')!;
    // 5 crates at 6,000 = 30,000: mobile money 20,000 approved by the shop's manager, cash 10,000 (OFFLINE_SYNC 9.9).
    const s = tillSale({ till: 'Q5', shiftSeq: q5.seq, counter: 2, at: ago(20 * MINUTE), lines: [crateLine(5)], tenders: [momo(20_000, users.get('manager')!.principalId, 'MP261113.1149.C41872', 1), cash(10_000)] });
    reviewed = s;
    const synced = await sync('abena', 'Q5', [s]);
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect((synced.body.results as Record<string, unknown>[])[0]).toMatchObject({ outcome: 'APPLIED', grossPesewas: 30_000, exceptions: [] });
    const payment = await one<Record<string, unknown>>(
      `SELECT id, method_kind, amount_pesewas::text AS amount, verification, status, allocated_pesewas::text AS allocated, shift_document_id AS shift, register_ref, external_reference, payer_phone_masked, received_at, cleared_at, bank_account_id
         FROM pay.payment WHERE order_document_id = $1 AND method_kind = 'MOBILE_MONEY'`,
      [s.id],
    );
    expect(payment).toMatchObject({ method_kind: 'MOBILE_MONEY', amount: '20000', verification: 'UNVERIFIED', status: 'PENDING', allocated: '20000', shift: q5.id, register_ref: id('till:Q5'), external_reference: 'MP261113.1149.C41872', payer_phone_masked: '+233 24 *** *142', cleared_at: null });
    expect((payment['received_at'] as Date).toISOString()).toBe(s.occurredAt);
    const receipt = await one<{ id: string; outstanding: string }>('SELECT d.id, s.outstanding_pesewas::text AS outstanding FROM bil.billing_document d JOIN bil.document_settlement s ON s.billing_document_id = d.id WHERE d.order_document_id = $1', [s.id]);
    expect(receipt.outstanding).toBe('0');
    // The ledger: Dr 1110 20,000 against the farm's wallet (never 1120: no provider took it), Dr 1000 10,000 against the
    // till; Cr 1200 30,000 off the receipt's Dr 1200 30,000 (OFFLINE_SYNC 9.9).
    const wallet = await one<{ id: string }>("SELECT id FROM fin.bank_account WHERE kind = 'MOBILE_MONEY' AND is_active ORDER BY (branch_id IS NULL), created_at, id LIMIT 1");
    expect(payment).toMatchObject({ bank_account_id: wallet.id });
    const paymentIds = (await rows<{ id: string }>('SELECT id FROM pay.payment WHERE order_document_id = $1', [s.id])).map((r) => r.id);
    expect([await balance('1110', paymentIds), await balance('1120', paymentIds), await balance('1000', paymentIds), await balance('1200', [...paymentIds, receipt.id])]).toEqual([20_000, 0, 10_000, 0]);
    expect(
      await num(
        `SELECT sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS n FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id
           JOIN fin.account a ON a.id = l.account_id JOIN fin.subledger_party sp ON sp.id = l.subledger_party_id WHERE a.code = '1110' AND e.source_document_id = ANY($1::uuid[]) AND sp.ref_id = $2`,
        [paymentIds, wallet.id],
      ),
    ).toBe(20_000);
    const brk = await one<{ kind: string; status: string; amount: string; reference: string; details: Record<string, unknown>; raised_at: Date }>(
      "SELECT kind, status, amount_pesewas::text AS amount, reference, details, raised_at FROM pay.reconciliation_break WHERE payment_id = $1",
      [payment['id']],
    );
    expect(brk).toMatchObject({ kind: 'UNVERIFIED_PAYMENT', status: 'OPEN', amount: '20000', reference: 'MP261113.1149.C41872' });
    expect(brk.details).toMatchObject({
      severity: 'REVIEW',
      approvedById: users.get('manager')!.principalId,
      // Checked against the manager's till PIN version 1 (B09b continued 3, CR-032 point 4).
      approvalVerified: true,
      approvalCheck: { pinVersion: 1, verdict: 'VERIFIED' },
      approverIsSupervisor: true,
      cashierId: users.get('abena')!.principalId,
      shiftId: q5.id,
      saleId: s.id,
      register: { id: id('till:Q5'), code: 'Q5' },
      network: 'MTN',
      payerPhoneMasked: '+233 24 *** *142',
      unverifiedWindowDays: 3,
      urgentFrom: new Date(new Date(s.occurredAt).getTime() + 3 * 24 * HOUR).toISOString(),
    });
    const event = await one<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pay.ReconciliationBreakRaised' AND payload->>'paymentId' = $1", [payment['id']]);
    expect(event.payload).toMatchObject({ kind: 'UNVERIFIED_PAYMENT', severity: 'REVIEW', abuseCases: [4], amountPesewas: 20_000 });
    // The shift's cash is only the cash: the unverified tender does not count as cash taken.
    expect(await num("SELECT sum(amount_pesewas)::text AS n FROM pay.payment WHERE shift_document_id = $1 AND method_kind = 'CASH'", [q5.id])).toBe(10_000);
  });

  it('raises the break as urgent when the approver the till names is no supervisor, and records the tender all the same', async () => {
    const q5 = shifts.get('Q5')!;
    const s = tillSale({ till: 'Q5', shiftSeq: q5.seq, counter: 3, at: ago(10 * MINUTE), lines: [crateLine(1)], tenders: [momo(6_000, users.get('abena')!.principalId, 'MP261113.1201.C41999')] });
    const synced = await sync('abena', 'Q5', [s]);
    expect((synced.body.results as Record<string, unknown>[])[0]).toMatchObject({ outcome: 'APPLIED', grossPesewas: 6_000 });
    const brk = await one<{ details: Record<string, unknown> }>("SELECT b.details FROM pay.reconciliation_break b JOIN pay.payment p ON p.id = b.payment_id WHERE p.order_document_id = $1", [s.id]);
    expect(brk.details).toMatchObject({ severity: 'URGENT', approverIsSupervisor: false, approvedById: users.get('abena')!.principalId });
  });

  it('raises the break as urgent when the supervisor the till names sent no PIN version: a name alone is no approval (CR-032 point 4)', async () => {
    const q5 = shifts.get('Q5')!;
    const s = tillSale({ till: 'Q5', shiftSeq: q5.seq, counter: 4, at: ago(8 * MINUTE), lines: [crateLine(1)], tenders: [momo(6_000, users.get('manager')!.principalId, 'MP261113.1203.C42001')] });
    const synced = await sync('abena', 'Q5', [s]);
    expect((synced.body.results as Record<string, unknown>[])[0]).toMatchObject({ outcome: 'APPLIED', grossPesewas: 6_000 });
    const brk = await one<{ details: Record<string, unknown> }>("SELECT b.details FROM pay.reconciliation_break b JOIN pay.payment p ON p.id = b.payment_id WHERE p.order_document_id = $1", [s.id]);
    expect(brk.details).toMatchObject({ severity: 'URGENT', approvalVerified: false, approverIsSupervisor: false, approvalCheck: { pinVersion: null, verdict: 'PIN_NOT_SENT' }, approvedById: users.get('manager')!.principalId });
    expect(await num("SELECT count(*)::text AS n FROM pay.payment WHERE order_document_id = $1 AND verification = 'UNVERIFIED'", [s.id])).toBe(1);
  });

  it('takes no unverified tender onto a shift no longer open: not recorded, raised URGENT (ADR-0077)', async () => {
    const q2 = shifts.get('Q2')!;
    const s = tillSale({ till: 'Q2', shiftSeq: q2.seq, counter: 1, at: ago(5 * MINUTE), lines: [crateLine(1)], tenders: [momo(6_000, users.get('manager')!.principalId, 'MP261113.1300.C42000')] });
    const synced = await sync('ama', 'Q2', [s]);
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect(await num('SELECT count(*)::text AS n FROM pay.payment WHERE order_document_id = $1', [s.id])).toBe(0);
    const flagged = await outbox('pos.OfflineSaleFlagged', s.id);
    expect(flagged.filter((r) => r.payload['exceptionKind'] === 'UNMATCHED_PAYMENT').map((r) => [r.payload['severity'], (r.payload['fact'] as Record<string, unknown>)['notTaken']])).toEqual([['URGENT', 'SHIFT_NOT_OPEN']]);
  });

  it('records it once: the sale sent again is a DUPLICATE with one payment and one break', async () => {
    const q5 = shifts.get('Q5')!;
    const counts = async () => [await num("SELECT count(*)::text AS n FROM pay.payment WHERE shift_document_id = $1 AND verification = 'UNVERIFIED'", [q5.id]), await num("SELECT count(*)::text AS n FROM pay.reconciliation_break WHERE kind = 'UNVERIFIED_PAYMENT'")];
    // The reviewed tender, the one approved by a cashier and the one approved by a name with no PIN version.
    expect(await counts()).toEqual([3, 3]);
    const again = await sync('abena', 'Q5', [reviewed]);
    expect((again.body.results as Record<string, unknown>[])[0]).toMatchObject({ outcome: 'DUPLICATE', grossPesewas: 30_000 });
    expect(await counts()).toEqual([3, 3]);
    expect(await num("SELECT count(*)::text AS n FROM platform.outbox_message WHERE event_type = 'pay.ReconciliationBreakRaised' AND payload->>'kind' = 'UNVERIFIED_PAYMENT'")).toBe(3);
  });
});
