import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Payments } from '../../../src/modules/pay';
import { type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { syncBatch, tillSale, type TillSale } from '../../support/offline';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Late cash on a closed shift (B09b continued 3b, ADR-0077 Amendments, the owner on 2026-11-18): cash from a till's
 * queue whose shift has since closed, or been force-closed, is recorded on the shift it happened in as a late entry; the
 * shift is not reopened; the over or short moves by a post-close adjustment (Dr 6900 Cr 1000 short, Dr 1000 Cr 6900
 * over); cash the cashier did not hand in shows the shift short by exactly its amount. Every figure is read by SQL over
 * `pay.payment`, `pos.cash_movement`, `pos.shift_late_entry`, the journal lines and the outbox, never from the answer
 * under test.
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
const rows = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => (await admin().query(sql, values)).rows as T[];
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await rows<T>(sql, values))[0]!;
const num = async (sql: string, values: unknown[] = []): Promise<number> => Number((await one<{ n: string | null }>(sql, values)).n ?? 0);
const step = (who: string) => stepUp(api.server, as(who) as TotpSession, clock);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const FLOAT = 20_000;
const ago = (ms: number) => new Date(clock.now().getTime() - ms);
const actorOf = (who: string): Actor => ({ principalId: users.get(who)!.principalId, kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });
const outbox = (type: string, subject: string) => rows<{ payload: Record<string, unknown> }>('SELECT payload FROM platform.outbox_message WHERE event_type = $1 AND subject_id = $2 ORDER BY recorded_at', [type, subject]);
const movement = (kind: 'CASH_DROP' | 'PAY_OUT' | 'PAY_IN', amount: number, reasonCode: string, at: Date) => ({ id: createUuidV7Generator(new ManualClock(at))(), kind, amountPesewas: amount, reasonCode, occurredAt: at.toISOString() });
const crates = (till: string, counter: number, at: Date, n: number): TillSale =>
  tillSale({ till, shiftSeq: shifts.get(till)!.seq, counter, at, lines: [{ productId: id('EGG-0003'), quantity: `${n}.000`, uom: 'CRATE', agreedUnitPricePesewas: 6_000 }], tenders: [{ paymentMethodId: id('CASH'), amountPesewas: n * 6_000 }] });
const sync = (who: string, till: string, sales: readonly TillSale[], cashMovements: readonly object[] = []) =>
  syncBatch(api.server, as(who), credentials.get(till)!, { deviceId: id(`device:${till}`), shiftId: shifts.get(till)!.id, sales, cashMovements });

/** Debits less credits on an account over the journals whose source is any of the documents. */
async function balance(code: string, documents: readonly string[]): Promise<number> {
  return num(
    `SELECT sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS n
       FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
      WHERE a.code = $1 AND e.source_document_id = ANY($2::uuid[])`,
    [code, documents],
  );
}

/** Debits less credits on 1000 against one till, over every journal. */
async function tillLedger(till: string): Promise<number> {
  return num(
    `SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS n
       FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id JOIN fin.subledger_party p ON p.id = l.subledger_party_id
      WHERE a.code = '1000' AND p.kind = 'REGISTER' AND p.ref_id = $1`,
    [id(`till:${till}`)],
  );
}

/** Each line of the shift's post-close adjustments, by account and side. */
const adjustmentLines = (shiftId: string) =>
  rows<{ code: string; side: string; amount: string }>(
    `SELECT a.code, l.side, l.amount_pesewas::text AS amount FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
      WHERE e.event_code = 'pos.ShiftLateEntryPosted' AND e.source_document_id = $1 ORDER BY a.code, l.side`,
    [shiftId],
  );

/** Everything a shift's cash journals come from: the shift (float, movements, close, adjustments) and every payment it took. */
async function shiftDocuments(shiftId: string): Promise<string[]> {
  return [shiftId, ...(await rows<{ id: string }>('SELECT id FROM pay.payment WHERE shift_document_id = $1', [shiftId])).map((r) => r.id)];
}

async function openShift(who: string, till: string): Promise<void> {
  const shiftId = nextId();
  const opened = await consolePost(api.server, as(who), '/v1/shifts', shiftId)
    .set('X-Device-Credential', credentials.get(till)!)
    .send({ id: shiftId, registerId: id(`till:${till}`), openingFloatPesewas: FLOAT, openedAt: ago(3 * HOUR).toISOString() });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  shifts.set(till, { id: shiftId, seq: opened.body.shiftSeq as number });
}

async function closeAndSignOff(who: string, till: string, declared: number): Promise<void> {
  const shiftId = shifts.get(till)!.id;
  const closed = await post(who, `/shifts/${shiftId}/close`, { declared: [{ paymentMethodId: id('CASH'), declaredPesewas: declared }], lastDeviceCounter: 0 });
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  await step('manager');
  const signed = await post('manager', `/shifts/${shiftId}/approve-close`, { reason: 'Counted at the end of the day' });
  expect(signed.status, JSON.stringify(signed.body)).toBe(200);
}

async function forceClose(till: string): Promise<void> {
  await step('manager');
  const forced = await post('manager', `/shifts/${shifts.get(till)!.id}/force-close`, { reason: 'The tablet will not power on and the cashier has gone home' });
  expect(forced.status, JSON.stringify(forced.body)).toBe(200);
}

async function countLate(till: string, declared: number): Promise<void> {
  await step('owner');
  const counted = await post('owner', `/shifts/${shifts.get(till)!.id}/late-count`, { declaredCashPesewas: declared, reason: 'Counted the drawer the next morning' });
  expect(counted.status, JSON.stringify(counted.body)).toBe(200);
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
  for (const code of ['L1', 'L2', 'L3', 'L4', 'L5']) {
    const till = await post('manager', '/registers', { branchId: id('branch'), locationId: id('shop'), code, name: `Shop till ${code}` });
    expect(till.status, JSON.stringify(till.body)).toBe(201);
    ids.set(`till:${code}`, till.body.id as string);
    await step('manager');
    const enrolled = await post('manager', `/registers/${id(`till:${code}`)}/devices`, { deviceLabel: `Shop tablet ${code}` });
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
    credentials.set(code, enrolled.body.deviceCredential as string);
    ids.set(`device:${code}`, enrolled.body.device.id as string);
  }
  // The shifts open well after the seeded prices take effect, so the till's hours-old times are still priced.
  clock.advanceBy(7 * HOUR);
  for (const [who, till] of [
    ['kofi', 'L1'],
    ['ama', 'L2'],
    ['esi', 'L3'],
    ['yaw', 'L4'],
    ['abena', 'L5'],
  ] as const) {
    await openShift(who, till);
  }
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('a late sale on a signed-off shift (ADR-0077 Amendments, the owner on 2026-11-18)', () => {
  it('records its cash on the shift it happened in as a late entry and shows the shift short by exactly it, when the cashier did not hand it in', async () => {
    const shiftId = shifts.get('L1')!.id;
    const queued = crates('L1', 1, ago(60 * MINUTE), 2);
    await closeAndSignOff('kofi', 'L1', FLOAT);
    // The close counted the float alone: expected 20,000, EXACT, the till's 1000 back to 0.
    expect(await one('SELECT status, expected_cash_pesewas::text AS e, over_short_direction AS d FROM pos.shift WHERE id = $1', [shiftId])).toEqual({ status: 'CLOSED', e: '20000', d: 'EXACT' });
    expect(await tillLedger('L1')).toBe(0);
    const frozen = await one('SELECT * FROM pos.shift WHERE id = $1', [shiftId]);
    clock.advanceBy(5 * MINUTE);

    const synced = await sync('kofi', 'L1', [queued]);
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect(synced.body.results[0]).toMatchObject({ outcome: 'APPLIED_WITH_EXCEPTION', grossPesewas: 12_000 });
    expect((synced.body.results[0].exceptions as { kind: string }[]).map((e) => e.kind).sort()).toEqual(['OFFLINE_LATE_CASH', 'OFFLINE_LATE_POSTING']);
    // The cash is one payment on this shift and this till, marked late, by the cashier, settling the receipt whole.
    const payment = await one<{ id: string; shift: string; register: string; late: boolean; amount: string; allocated: string; status: string; by: string }>(
      'SELECT id, shift_document_id AS shift, register_ref AS register, late_entry AS late, amount_pesewas::text AS amount, allocated_pesewas::text AS allocated, status, created_by AS by FROM pay.payment WHERE order_document_id = $1',
      [queued.id],
    );
    expect(payment).toMatchObject({ shift: shiftId, register: id('till:L1'), late: true, amount: '12000', allocated: '12000', status: 'CLEARED', by: users.get('kofi')!.principalId });
    expect(await num('SELECT count(*)::text AS n FROM pay.payment WHERE order_document_id = $1', [queued.id])).toBe(1);
    const receipt = (await one<{ id: string }>('SELECT billing_document_id AS id FROM ord.sales_order WHERE id = $1', [queued.id])).id;
    expect(await balance('1200', [receipt, payment.id])).toBe(0);
    // The late entry and its adjustment: Dr 6900 12,000, Cr 1000 12,000 against the till.
    expect(await one('SELECT source_kind, payment_id, amount_pesewas::text AS amount, expected_effect, adjustment_direction, shift_state, severity FROM pos.shift_late_entry WHERE shift_id = $1', [shiftId])).toEqual({
      source_kind: 'SALE_CASH',
      payment_id: payment.id,
      amount: '12000',
      expected_effect: 'RAISES',
      adjustment_direction: 'SHORT',
      shift_state: 'CLOSED',
      severity: 'REVIEW',
    });
    expect(await adjustmentLines(shiftId)).toEqual([
      { code: '1000', side: 'C', amount: '12000' },
      { code: '6900', side: 'D', amount: '12000' },
    ]);
    // The payment Dr 1000 12,000 and the adjustment Cr 1000 12,000: the till's 1000 stays at 0; 6900 shows short 12,000.
    const documents = await shiftDocuments(shiftId);
    expect(await balance('1000', documents)).toBe(0);
    expect(await tillLedger('L1')).toBe(0);
    expect(await balance('6900', documents)).toBe(12_000);
    // The shift is not reopened and nothing of its close changed.
    expect(await one('SELECT * FROM pos.shift WHERE id = $1', [shiftId])).toEqual(frozen);
    expect((await outbox('pos.OfflineSaleFlagged', queued.id)).filter((r) => r.payload['exceptionKind'] === 'OFFLINE_LATE_CASH').map((r) => [r.payload['severity'], r.payload['amountPesewas'], r.payload['abuseCases']])).toEqual([['REVIEW', 12_000, [17]]]);

    // Sent again: DUPLICATE, nothing twice.
    clock.advanceBy(MINUTE);
    const again = await sync('kofi', 'L1', [queued]);
    expect(again.body.results[0]).toMatchObject({ outcome: 'DUPLICATE' });
    expect(await num('SELECT count(*)::text AS n FROM pos.shift_late_entry WHERE shift_id = $1', [shiftId])).toBe(1);
    expect(await balance('6900', await shiftDocuments(shiftId))).toBe(12_000);
  });

  it('brings the shift back to exact when the cashier had handed the cash in: the close was over by it, the adjustment takes it off', async () => {
    const shiftId = shifts.get('L2')!.id;
    const queued = crates('L2', 1, ago(40 * MINUTE), 1);
    await closeAndSignOff('ama', 'L2', FLOAT + 6_000);
    expect(await one('SELECT over_short_pesewas::text AS a, over_short_direction AS d FROM pos.shift WHERE id = $1', [shiftId])).toEqual({ a: '6000', d: 'OVER' });
    clock.advanceBy(5 * MINUTE);
    expect((await sync('ama', 'L2', [queued])).status).toBe(200);
    expect(await adjustmentLines(shiftId)).toEqual([
      { code: '1000', side: 'C', amount: '6000' },
      { code: '6900', side: 'D', amount: '6000' },
    ]);
    const documents = await shiftDocuments(shiftId);
    // Cr 6900 6,000 at the close, Dr 6900 6,000 now: the shift is exact; the counted 26,000 is in the safe.
    expect([await balance('6900', documents), await balance('1000', documents), await tillLedger('L2'), await balance('1010', documents)]).toEqual([0, 0, 0, 6_000]);
  });
});

describe('a late sale on a shift declared but not yet signed off (CLOSING)', () => {
  it('posts its adjustment at sync and the sign-off counts without it: over by the cash at the close, short by it now, exact together', async () => {
    const shiftId = shifts.get('L5')!.id;
    const queued = crates('L5', 1, ago(30 * MINUTE), 1);
    const closed = await post('abena', `/shifts/${shiftId}/close`, { declared: [{ paymentMethodId: id('CASH'), declaredPesewas: FLOAT + 6_000 }], lastDeviceCounter: 0 });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    clock.advanceBy(2 * MINUTE);
    expect((await sync('abena', 'L5', [queued])).status).toBe(200);
    expect(await one('SELECT shift_state, adjustment_direction FROM pos.shift_late_entry WHERE shift_id = $1', [shiftId])).toEqual({ shift_state: 'CLOSING', adjustment_direction: 'SHORT' });
    await step('manager');
    const signed = await post('manager', `/shifts/${shiftId}/approve-close`, { reason: 'Counted at the end of the day' });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    // The sign-off's expected cash leaves the late entry out: 20,000, so the count of 26,000 is over by 6,000.
    expect(await one('SELECT expected_cash_pesewas::text AS e, over_short_pesewas::text AS a, over_short_direction AS d FROM pos.shift WHERE id = $1', [shiftId])).toEqual({ e: '20000', a: '6000', d: 'OVER' });
    const documents = await shiftDocuments(shiftId);
    expect([await balance('6900', documents), await balance('1000', documents), await tillLedger('L5')]).toEqual([0, 0, 0]);
  });
});

describe('a late drop and a late sale on a force-closed shift', () => {
  it('records a drop made before the force close as a late entry: the count was short by it, the adjustment puts it right', async () => {
    const shiftId = shifts.get('L3')!.id;
    const drop = movement('CASH_DROP', 5_000, 'SAFE_DROP', ago(50 * MINUTE));
    await forceClose('L3');
    // The drawer is counted by a third person: 15,000, the dropped 5,000 already in the safe. Short 5,000 against 20,000.
    await countLate('L3', 15_000);
    expect(await balance('6900', [shiftId])).toBe(5_000);
    const closedAt = (await one<{ closed_at: Date }>('SELECT closed_at FROM pos.shift WHERE id = $1', [shiftId])).closed_at;
    clock.advanceBy(5 * MINUTE);

    const synced = await sync('esi', 'L3', [], [drop]);
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect(synced.body.cashMovementResults).toEqual([{ clientId: drop.id, outcome: 'APPLIED', reason: null }]);
    expect(await one('SELECT shift_id, kind, amount_pesewas::text AS amount, late_entry, actor_id FROM pos.cash_movement WHERE id = $1', [drop.id])).toEqual({ shift_id: shiftId, kind: 'CASH_DROP', amount: '5000', late_entry: true, actor_id: users.get('esi')!.principalId });
    expect(await one('SELECT source_kind, cash_movement_id, expected_effect, adjustment_direction, shift_state, severity FROM pos.shift_late_entry WHERE shift_id = $1', [shiftId])).toEqual({
      source_kind: 'CASH_DROP',
      cash_movement_id: drop.id,
      expected_effect: 'LOWERS',
      adjustment_direction: 'OVER',
      shift_state: 'FORCE_CLOSED',
      severity: 'REVIEW',
    });
    expect(await adjustmentLines(shiftId)).toEqual([
      { code: '1000', side: 'D', amount: '5000' },
      { code: '6900', side: 'C', amount: '5000' },
    ]);
    // Float Dr 1000 20,000; drop Cr 1000 5,000; count Cr 1000 20,000, Dr 1000... the till ends at 0, the shift exact, the safe whole.
    expect([await balance('6900', [shiftId]), await balance('1000', [shiftId]), await tillLedger('L3'), await balance('1010', [shiftId])]).toEqual([0, 0, 0, 0]);
    expect(new Date(drop.occurredAt).getTime()).toBeLessThan(closedAt.getTime());
    expect((await outbox('pos.OfflineCashMovementFlagged', drop.id)).map((r) => [r.payload['exceptionKind'], r.payload['severity']])).toEqual([['OFFLINE_LATE_CASH', 'REVIEW']]);
  });

  it('takes a sale made after the force close on that shift, URGENT, its adjustment posted before the count; the count then posts against the frozen figure', async () => {
    const shiftId = shifts.get('L4')!.id;
    await forceClose('L4');
    clock.advanceBy(10 * MINUTE);
    const afterClose = crates('L4', 1, ago(5 * MINUTE), 1);
    clock.advanceBy(5 * MINUTE);
    const synced = await sync('yaw', 'L4', [afterClose]);
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect(await one('SELECT shift_state, severity, adjustment_direction FROM pos.shift_late_entry WHERE shift_id = $1', [shiftId])).toEqual({ shift_state: 'FORCE_CLOSED', severity: 'URGENT', adjustment_direction: 'SHORT' });
    expect(await balance('6900', await shiftDocuments(shiftId))).toBe(6_000);
    // The cashier hands the 6,000 in with the drawer: counted 26,000 against the frozen 20,000, over 6,000; net exact.
    await countLate('L4', FLOAT + 6_000);
    expect(await one('SELECT expected_cash_pesewas::text AS e, over_short_direction AS d FROM pos.shift_late_count WHERE shift_id = $1', [shiftId])).toEqual({ e: '20000', d: 'OVER' });
    const documents = await shiftDocuments(shiftId);
    expect([await balance('6900', documents), await balance('1000', documents), await tillLedger('L4')]).toEqual([0, 0, 0]);
    expect((await outbox('pos.OfflineSaleFlagged', afterClose.id)).filter((r) => r.payload['exceptionKind'] === 'OFFLINE_LATE_CASH').map((r) => r.payload['severity'])).toEqual(['URGENT']);
  });

  it('refuses a late batch to a storekeeper and to another cashier, recording nothing', async () => {
    const before = await num('SELECT count(*)::text AS n FROM pos.shift_late_entry');
    const queued = crates('L1', 2, ago(2 * HOUR), 1);
    expect((await sync('storekeeper', 'L1', [queued])).status).toBe(403);
    expect((await sync('ama', 'L1', [queued])).status).toBe(403);
    expect(await num('SELECT count(*)::text AS n FROM pos.shift_late_entry')).toBe(before);
    expect(await num('SELECT count(*)::text AS n FROM pay.payment WHERE order_document_id = $1', [queued.id])).toBe(0);
  });
});

describe('a late entry is held by PAY and by the database', () => {
  const recordLate = (who: string, till: string, extra: object = {}) =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable' }, (tx) =>
      api.app.get(Payments).recordIn(tx, actorOf(who), {
        branchId: id('branch'),
        channel: 'POS',
        methodCode: 'CASH',
        amountPesewas: 1_000n,
        customerId: null,
        orderDocumentId: null,
        shiftDocumentId: shifts.get(till)!.id,
        register: { id: id(`till:${till}`), code: till },
        receivedAt: clock.now(),
        allocations: [],
        lateEntry: true,
        ...extra,
      }),
    );

  /** Kofi's next shift on L1, opened online now, still OPEN. */
  let current: string | null = null;
  const openNow = async (): Promise<string> => {
    if (current !== null) return current;
    const open = nextId();
    const opened = await consolePost(api.server, as('kofi'), '/v1/shifts', open).send({ id: open, registerId: id('till:L1'), openingFloatPesewas: FLOAT, openedAt: clock.now().toISOString() });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    current = open;
    return open;
  };

  it('refuses through PAY a late entry by anyone but the shift own cashier, on another till, and on a shift still open', async () => {
    const before = await num('SELECT count(*)::text AS n FROM pay.payment');
    await expect(recordLate('manager', 'L1')).rejects.toMatchObject({ details: [expect.objectContaining({ code: 'SHIFT_NOT_OWN' })] });
    await expect(recordLate('ama', 'L1')).rejects.toMatchObject({ details: [expect.objectContaining({ code: 'SHIFT_NOT_OWN' })] });
    await expect(recordLate('kofi', 'L1', { register: { id: id('till:L2'), code: 'L2' } })).rejects.toMatchObject({ details: [expect.objectContaining({ code: 'SHIFT_OTHER_REGISTER' })] });
    const open = await openNow();
    const stillOpen = await api.app.get(UnitOfWork).run({ isolation: 'serializable' }, (tx) =>
      api.app
        .get(Payments)
        .recordIn(tx, actorOf('kofi'), { branchId: id('branch'), channel: 'POS', methodCode: 'CASH', amountPesewas: 1_000n, customerId: null, orderDocumentId: null, shiftDocumentId: open, register: { id: id('till:L1'), code: 'L1' }, receivedAt: clock.now(), allocations: [], lateEntry: true })
        .then(
          () => null,
          (error: { details?: { code: string }[] }) => error.details?.[0]?.code,
        ),
    );
    expect(stillOpen).toBe('SHIFT_STILL_OPEN');
    expect(await num('SELECT count(*)::text AS n FROM pay.payment')).toBe(before);
  });

  it('refuses in the database a late payment on an open shift, by another person, and of another kind; and an ordinary one on a closed shift', async () => {
    const template = await one<Record<string, unknown>>('SELECT * FROM pay.payment WHERE late_entry LIMIT 1');
    const copy = async (changes: Record<string, unknown>) => {
      const row: Record<string, unknown> = { ...template, id: randomUUID(), ...changes };
      await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'PAYMENT', 'pay', $2, $3)", [row['id'], row['branch_id'], row['created_by']]);
      const columns = Object.keys(row);
      return admin().query(`INSERT INTO pay.payment (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, columns.map((c) => row[c]));
    };
    const openShiftId = await openNow();
    await expect(copy({ shift_document_id: openShiftId })).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_payment_till_shift', detail: 'SHIFT_STILL_OPEN' });
    await expect(copy({ created_by: users.get('manager')!.principalId, updated_by: users.get('manager')!.principalId })).rejects.toMatchObject({ constraint: 'ck_payment_till_shift', detail: 'SHIFT_NOT_OWN' });
    await expect(copy({ late_entry: false })).rejects.toMatchObject({ constraint: 'ck_payment_till_shift', detail: 'SHIFT_NOT_OPEN' });
    // The check itself, with the insert triggers set aside for this one transaction (they would refuse first).
    const client = await admin().connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL session_replication_role = 'replica'");
      const row: Record<string, unknown> = { ...template, id: randomUUID(), method_kind: 'MOBILE_MONEY' };
      const columns = Object.keys(row);
      await expect(client.query(`INSERT INTO pay.payment (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, columns.map((c) => row[c]))).rejects.toMatchObject({ code: '23514', constraint: 'ck_payment_late_entry' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('refuses in the database a late movement on an open shift or by another person, a late entry that does not match its movement, and any change', async () => {
    const openShiftId = await openNow();
    const insertMovement = (shiftId: string, actor: string, late: boolean) =>
      admin().query("INSERT INTO pos.cash_movement (id, shift_id, kind, amount_pesewas, reason_code, occurred_at, recorded_at, actor_id, late_entry, unwitnessed) VALUES ($1, $2, 'PAY_IN', 100, 'FLOAT_TOP_UP', $3, $3, $4, $5, false)", [randomUUID(), shiftId, clock.now(), actor, late]);
    await expect(insertMovement(openShiftId, users.get('kofi')!.principalId, true)).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_cash_movement_late_entry' });
    await expect(insertMovement(shifts.get('L3')!.id, users.get('manager')!.principalId, true)).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_cash_movement_own_shift' });
    await expect(insertMovement(shifts.get('L3')!.id, users.get('esi')!.principalId, false)).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_cash_movement_open_shift' });
    const entry = await one<Record<string, unknown>>("SELECT * FROM pos.shift_late_entry WHERE source_kind = 'CASH_DROP' LIMIT 1");
    const copyEntry = (changes: Record<string, unknown>) => {
      const row: Record<string, unknown> = { ...entry, id: randomUUID(), ...changes };
      const columns = Object.keys(row);
      return admin().query(`INSERT INTO pos.shift_late_entry (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, columns.map((c) => row[c]));
    };
    await expect(copyEntry({ order_document_id: shifts.get('L3')!.id })).rejects.toMatchObject({ constraint: 'ck_shift_late_entry_source' });
    await expect(copyEntry({ adjustment_direction: 'SHORT' })).rejects.toMatchObject({ constraint: 'ck_shift_late_entry_direction' });
    await expect(copyEntry({ amount_pesewas: 4_999 })).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_shift_late_entry_movement' });
    await expect(copyEntry({ shift_id: openShiftId })).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_shift_late_entry_shift' });
    await expect(copyEntry({})).rejects.toMatchObject({ code: '23505', constraint: 'uq_shift_late_entry_movement' });
    await expect(admin().query('UPDATE pos.shift_late_entry SET severity = $1 WHERE id = $2', ['URGENT', entry['id']])).rejects.toBeDefined();
    await expect(admin().query('DELETE FROM pos.shift_late_entry WHERE id = $1', [entry['id']])).rejects.toBeDefined();
  });

  it('posts each adjustment once: a second journal for the same late entry is refused by its unique index', async () => {
    const entry = await one<{ id: string }>("SELECT e.event_subject_id AS id FROM fin.journal_entry e WHERE e.event_code = 'pos.ShiftLateEntryPosted' LIMIT 1");
    const indexed = await one<{ n: string }>("SELECT count(*)::text AS n FROM pg_indexes WHERE indexname = 'uq_journal_entry_pos_late_entry'");
    expect([typeof entry.id, indexed.n]).toEqual(['string', '1']);
    expect(await num("SELECT count(*)::text AS n FROM fin.journal_entry WHERE event_code = 'pos.ShiftLateEntryPosted'")).toBe(await num('SELECT count(*)::text AS n FROM pos.shift_late_entry'));
  });
});
