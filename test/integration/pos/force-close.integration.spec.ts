import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SalePosting, type SaleRequest } from '../../../src/modules/ord';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The force close (FR-POS-020, A-275): a manager who is not the cashier, with a fresh step-up and a reason, closes an
 * abandoned OPEN shift at the cash its records hold, flagged force-closed, posting nothing; the drawer is counted
 * later by a supervisor who neither ran the shift nor force-closed it, and that count posts the over or short. Every
 * figure is derived by SQL over pay.payment, pos.cash_movement and the journal lines, never from the code under test.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let nextId: () => string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const tills = new Map<string, { id: string; code: string }>();
let branchId: string;
let shopId: string;
let yamId: string;
let cashMethodId: string;
let kofiShift: string;
let amaShift: string;
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const idOf = (who: string) => users.get(who)!.principalId;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const one = async <T>(sql: string, values: unknown[]): Promise<T> => (await admin().query(sql, values)).rows[0] as T;
const step = (who: string) => stepUp(api.server, as(who) as TotpSession, clock);
const actorOf = (who: string): Actor => ({ principalId: idOf(who), kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });
const REASON = 'Till 1 tablet will not power on; Kofi has gone home';

function sell(who: string, shift: string, till: { id: string; code: string }, yams: number) {
  const posting = api.app.get(SalePosting);
  const request: SaleRequest = {
    orderId: nextId(),
    channel: 'POS',
    branchId,
    fulfilmentMode: 'COUNTER',
    taxInclusive: true,
    shiftDocumentId: shift,
    lines: [{ productId: yamId, fromLocationId: shopId, quantity: `${yams}.000` }],
    tenders: [{ methodCode: 'CASH', amountPesewas: BigInt(yams * 2_000), register: till }],
  };
  return runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'force close', actor: actorOf(who) }, () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable', seriesLocks: posting.locksFor(branchId) }, (tx) => posting.postIn(tx, actorOf(who), request)),
  );
}

/** The cash a shift's records say its drawer holds: cleared cash payments, less cash refunds paid out of it, plus its movements. */
async function cashBySql(shift: string): Promise<number> {
  const row = await one<{ n: string }>(
    `SELECT ((SELECT COALESCE(sum(amount_pesewas), 0) FROM pay.payment WHERE shift_document_id = $1 AND method_kind = 'CASH' AND status = 'CLEARED')
           - (SELECT COALESCE(sum(amount_pesewas), 0) FROM pay.refund WHERE paid_from_shift_id = $1 AND status = 'PAID')
           + (SELECT COALESCE(sum(CASE WHEN kind IN ('FLOAT_IN', 'PAY_IN') THEN amount_pesewas ELSE -amount_pesewas END), 0) FROM pos.cash_movement WHERE shift_id = $1))::text AS n`,
    [shift],
  );
  return Number(row.n);
}

/** Debits less credits on 1000 against one till. */
async function tillLedger(registerId: string): Promise<number> {
  const row = await one<{ n: string }>(
    `SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS n
       FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id JOIN fin.subledger_party p ON p.id = l.subledger_party_id
      WHERE a.code = '1000' AND p.kind = 'REGISTER' AND p.ref_id = $1`,
    [registerId],
  );
  return Number(row.n);
}

const closeJournal = (shift: string) =>
  one<{ lines: { code: string; side: string; amount: number }[] | null }>(
    `SELECT json_agg(json_build_object('code', a.code, 'side', l.side, 'amount', l.amount_pesewas) ORDER BY a.code, l.side) AS lines
       FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
      WHERE e.event_code = 'pos.ShiftClosed' AND e.source_document_id = $1`,
    [shift],
  );

async function openShift(who: string, till: string, float: number): Promise<string> {
  const id = nextId();
  const response = await post(who, '/shifts', { id, registerId: tills.get(till)!.id, openingFloatPesewas: float, openedAt: clock.now().toISOString() }, id);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return id;
}

/** Runs SQL as the application role in a transaction that is always rolled back, and answers the constraint it broke. */
async function refusedAs(sql: string, values: unknown[]): Promise<string | undefined> {
  const client = await database.pool('app').connect();
  try {
    await client.query('BEGIN');
    await client.query(sql, values);
    return undefined;
  } catch (error) {
    const e = error as { constraint?: string; code?: string };
    return e.constraint ?? e.code;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await one<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'", [])).id;
  const elsewhere = (await one<{ id: string }>("SELECT id FROM mdm.branch WHERE code <> 'DDW' ORDER BY code LIMIT 1", [])).id;
  shopId = (await one<{ id: string }>("SELECT l.id FROM mdm.location l WHERE l.branch_id = $1 AND l.code = 'SHOP'", [branchId])).id;
  yamId = (await one<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'PRD-0005'", [])).id;
  cashMethodId = (await one<{ id: string }>("SELECT id FROM mdm.payment_method WHERE code = 'CASH'", [])).id;
  for (const [who, name, role, at, totp] of [
    ['owner', 'Esi Mensah', 'OWNER', branchId, true],
    ['manager', 'Kwabena Owusu', 'MANAGER', branchId, true],
    ['ama', 'Ama Asante', 'MANAGER', branchId, true],
    ['away', 'Yaa Boateng', 'MANAGER', elsewhere, true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', branchId, true],
    ['kofi', 'Kofi Boadu', 'CASHIER', branchId, false],
    ['nana', 'Nana Yeboah', 'CASHIER', branchId, false],
  ] as const) {
    const user = await createUser(database, { name, grants: [{ role, branchId: at, ...(role === 'CASHIER' ? { locationId: shopId } : {}) }] });
    users.set(who, user);
    sessions.set(who, totp ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  for (const code of ['T1', 'T2', 'T3']) {
    const created = await post('manager', '/registers', { branchId, locationId: shopId, code, name: `Force close till ${code}` });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    tills.set(code, { id: created.body.id as string, code });
  }
  // Kofi's shift on T1: float 20,000, yams for 6,000 and 4,000 in cash, a drop of 5,000 witnessed by the owner.
  kofiShift = await openShift('kofi', 'T1', 20_000);
  await sell('kofi', kofiShift, tills.get('T1')!, 3);
  await sell('kofi', kofiShift, tills.get('T1')!, 2);
  const drop = nextId();
  const dropped = await post('kofi', `/shifts/${kofiShift}/cash-movements`, { id: drop, kind: 'CASH_DROP', amountPesewas: 5_000, reasonCode: 'SAFE_DROP', witnessId: idOf('owner'), occurredAt: clock.now().toISOString() }, drop);
  expect(dropped.status, JSON.stringify(dropped.body)).toBe(201);
  // Ama, a manager, runs a shift of her own on T2.
  amaShift = await openShift('ama', 'T2', 0);
  await sell('ama', amaShift, tills.get('T2')!, 1);
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('forceCloseShift (FR-POS-020): a manager who is not the cashier', () => {
  it('derives the drawer by SQL before the close: 20,000 + 6,000 + 4,000 - 5,000 = 25,000, all of it on T1', async () => {
    expect(await cashBySql(kofiShift)).toBe(25_000);
    expect(await tillLedger(tills.get('T1')!.id)).toBe(25_000);
  });

  it('refuses the cashier, another cashier, the accountant and another branch manager, closing nothing', async () => {
    await step('accountant');
    await step('away');
    for (const who of ['kofi', 'nana', 'accountant', 'away']) {
      const refused = await post(who, `/shifts/${kofiShift}/force-close`, { reason: REASON });
      expect([who, refused.status]).toEqual([who, 403]);
    }
    expect(await one('SELECT status, force_closed FROM pos.shift WHERE id = $1', [kofiShift])).toEqual({ status: 'OPEN', force_closed: false });
  });

  it('refuses a manager with no fresh step-up, and one without a reason', async () => {
    clock.advanceBy(10 * 60_000);
    const stale = await post('manager', `/shifts/${kofiShift}/force-close`, { reason: REASON });
    expect([stale.status, stale.body.error.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    await step('manager');
    const none = await post('manager', `/shifts/${kofiShift}/force-close`, {});
    expect(none.status).toBe(400);
  });

  it('refuses a manager force-closing the shift she runs herself, in the handler and in the database', async () => {
    await step('ama');
    const own = await post('ama', `/shifts/${amaShift}/force-close`, { reason: 'Closing my own drawer' });
    expect([own.status, own.body.error.code, own.body.error.details]).toEqual([422, 'SHIFT_CLOSE_SAME_PERSON', [expect.objectContaining({ code: 'FORCE_CLOSER_IS_CASHIER' })]]);
    const direct = await refusedAs(
      `UPDATE pos.shift SET status = 'CLOSED', force_closed = true, force_close_reason = 'mine', expected_cash_pesewas = 2000, close_approved_by = cashier_id,
              closed_at = $2, posted_at = $2, posted_by = cashier_id, updated_by = cashier_id, version = version + 1 WHERE id = $1`,
      [amaShift, clock.now()],
    );
    expect(direct).toBe('ck_shift_close_checker');
    expect(await one('SELECT status FROM pos.shift WHERE id = $1', [amaShift])).toEqual({ status: 'OPEN' });
  });

  it('closes the shift at its expected cash, flagged force-closed with its reason, blind, posting nothing', async () => {
    const closed = await post('manager', `/shifts/${kofiShift}/force-close`, { reason: REASON });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toMatchObject({
      status: 'CLOSED',
      forceClosed: true,
      forceCloseReason: REASON,
      closeApprovedBy: { displayName: 'Kwabena Owusu' },
      declaredCashPesewas: null,
      expectedCashPesewas: null,
      overShortPesewas: null,
      countedBy: null,
      countedAt: null,
    });
    expect(await one('SELECT status, force_closed, expected_cash_pesewas::int AS expected, declared_cash_pesewas AS declared, close_approved_by AS closer FROM pos.shift WHERE id = $1', [kofiShift])).toEqual({
      status: 'CLOSED',
      force_closed: true,
      expected: await cashBySql(kofiShift),
      declared: null,
      closer: idOf('manager'),
    });
    expect((await closeJournal(kofiShift)).lines).toBeNull();
    expect(await tillLedger(tills.get('T1')!.id)).toBe(25_000);
    expect(await one('SELECT accepts_entries FROM platform.document_entry_state WHERE document_id = $1', [kofiShift])).toEqual({ accepts_entries: false });
    const event = await one<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pos.ShiftForceClosed' AND subject_id = $1", [kofiShift]);
    expect(event.payload).toMatchObject({ cashierId: idOf('kofi'), forceClosedBy: idOf('manager'), reason: REASON, expectedCashPesewas: 25_000, abuseCases: [17], exceptionKind: 'SHIFT_FORCE_CLOSED' });
    const audit = await one<{ actor: string; n: number }>("SELECT actor_id AS actor, count(*) OVER ()::int AS n FROM platform.audit_event WHERE action = 'FORCE_CLOSE' AND entity_id = $1", [kofiShift]);
    expect(audit).toEqual({ actor: idOf('manager'), n: 1 });
  });

  it('hides what it was closed at from its cashier too, and flags it on the X report', async () => {
    const read = await get('kofi', `/shifts/${kofiShift}`);
    expect(read.body).toMatchObject({ forceClosed: true, expectedCashPesewas: null });
    const x = await get('manager', `/shifts/${kofiShift}/x-report`);
    expect(x.body).toMatchObject({ kind: 'X', forceClosed: true });
  });

  it('replays the force close with its key and closes or publishes nothing more; a second force close is SHIFT_NOT_OPEN', async () => {
    const key = randomUUID();
    const t3Shift = await openShift('nana', 'T3', 0);
    const first = await post('manager', `/shifts/${t3Shift}/force-close`, { reason: 'Nana was taken ill' }, key);
    const again = await post('manager', `/shifts/${t3Shift}/force-close`, { reason: 'Nana was taken ill' }, key);
    expect([first.status, again.status, again.body.version]).toEqual([200, 200, first.body.version]);
    expect(await one("SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'pos.ShiftForceClosed' AND subject_id = $1", [t3Shift])).toEqual({ n: 1 });
    const second = await post('manager', `/shifts/${t3Shift}/force-close`, { reason: 'again' });
    expect([second.status, second.body.error.code]).toEqual([422, 'SHIFT_NOT_OPEN']);
  });

  it('takes no more cash on it: a sale, a cash movement and the cashier declaring a count are refused, the drawer unchanged', async () => {
    await expect(sell('kofi', kofiShift, tills.get('T1')!, 1)).rejects.toMatchObject({ code: 'PAYMENT_INVALID', details: [expect.objectContaining({ code: 'SHIFT_NOT_OPEN' })] });
    const id = nextId();
    const moved = await post('kofi', `/shifts/${kofiShift}/cash-movements`, { id, kind: 'PAY_OUT', amountPesewas: 100, reasonCode: 'FUEL_PAYOUT', occurredAt: clock.now().toISOString() }, id);
    expect([moved.status, moved.body.error.code]).toEqual([422, 'SHIFT_NOT_OPEN']);
    const declared = await post('kofi', `/shifts/${kofiShift}/close`, { declared: [{ paymentMethodId: cashMethodId, declaredPesewas: 25_000 }] });
    expect([declared.status, declared.body.error.code]).toEqual([422, 'SHIFT_NOT_OPEN']);
    expect(await cashBySql(kofiShift)).toBe(25_000);
  });

  it('refuses a CLOSING shift, whose declared count is signed off instead', async () => {
    const declared = await post('ama', `/shifts/${amaShift}/close`, { declared: [{ paymentMethodId: cashMethodId, declaredPesewas: 2_000 }] });
    expect(declared.status, JSON.stringify(declared.body)).toBe(200);
    const forced = await post('manager', `/shifts/${amaShift}/force-close`, { reason: REASON });
    expect([forced.status, forced.body.error.code]).toEqual([422, 'SHIFT_NOT_OPEN']);
  });

  it('refuses in the database a shift flagged force-closed outside a force close, and an OPEN shift closed without the flag', async () => {
    const t2 = await one<{ id: string }>("SELECT id FROM pos.shift WHERE id = $1", [amaShift]);
    expect(await refusedAs("UPDATE pos.shift SET force_closed = true, force_close_reason = 'x', version = version + 1 WHERE id = $1", [t2.id])).toBe('ck_shift_steps');
    const open = await openShift('nana', 'T3', 0);
    expect(
      await refusedAs(
        `UPDATE pos.shift SET status = 'CLOSED', expected_cash_pesewas = 0, close_approved_by = $2, closed_at = $3, posted_at = $3, posted_by = $2, updated_by = $2, version = version + 1 WHERE id = $1`,
        [open, idOf('manager'), clock.now()],
      ),
    ).toBe('ck_shift_steps');
    expect(await refusedAs("UPDATE pos.shift SET force_close_reason = 'changed', version = version + 1 WHERE id = $1", [kofiShift])).toBe('HK004');
  });
});

describe('countForceClosedShift (FR-POS-020, A-275): the drawer counted later by a third person', () => {
  it('refuses the manager who force-closed it and its cashier, in the handler and in the database', async () => {
    await step('manager');
    const closer = await post('manager', `/shifts/${kofiShift}/late-count`, { declaredCashPesewas: 24_750, reason: 'Counted' });
    expect([closer.status, closer.body.error.code, closer.body.error.details]).toEqual([422, 'SHIFT_CLOSE_SAME_PERSON', [expect.objectContaining({ code: 'COUNTER_IS_FORCE_CLOSER' })]]);
    const cashier = await post('kofi', `/shifts/${kofiShift}/late-count`, { declaredCashPesewas: 24_750, reason: 'Counted' });
    expect(cashier.status).toBe(403);
    const insert = (actor: string, expected: number, shift = kofiShift) =>
      refusedAs(
        `INSERT INTO pos.shift_late_count (shift_id, declared_cash_pesewas, expected_cash_pesewas, over_short_pesewas, over_short_direction, reason, counted_at, recorded_at, actor_id)
         VALUES ($1, 24750, $2::bigint, abs(24750 - $2::bigint), CASE WHEN 24750 < $2::bigint THEN 'SHORT' WHEN 24750 > $2::bigint THEN 'OVER' ELSE 'EXACT' END, 'direct', $3, $3, $4)`,
        [shift, expected, clock.now(), idOf(actor)],
      );
    expect(await insert('manager', 25_000)).toBe('ck_shift_late_count_not_closer');
    expect(await insert('kofi', 25_000)).toBe('ck_shift_late_count_not_cashier');
    expect(await insert('owner', 26_000)).toBe('ck_shift_late_count_expected');
    expect(await insert('accountant', 25_000)).toBe('ck_shift_late_count_supervisor');
    expect(await insert('owner', 2_000, amaShift)).toBe('ck_shift_late_count_forced');
    expect(await insert('owner', 25_000)).toBeUndefined();
  });

  it('refuses the cashier of a force-closed shift who holds the sign-off, the accountant and another branch', async () => {
    await step('owner');
    const signed = await post('owner', `/shifts/${amaShift}/approve-close`, { reason: 'Counted with Ama' });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    const t3 = (await one<{ id: string }>("SELECT id FROM pos.shift WHERE register_id = $1 AND status = 'OPEN'", [tills.get('T3')!.id])).id;
    const nanaForced = await post('owner', `/shifts/${t3}/force-close`, { reason: 'Nana left early' });
    expect(nanaForced.status, JSON.stringify(nanaForced.body)).toBe(200);
    const amaShift2 = await openShift('ama', 'T2', 0);
    const forced = await post('owner', `/shifts/${amaShift2}/force-close`, { reason: 'Ama called away to the farm' });
    expect(forced.status, JSON.stringify(forced.body)).toBe(200);
    await step('ama');
    const own = await post('ama', `/shifts/${amaShift2}/late-count`, { declaredCashPesewas: 0, reason: 'Mine' });
    expect([own.status, own.body.error.code, own.body.error.details]).toEqual([422, 'SHIFT_CLOSE_SAME_PERSON', [expect.objectContaining({ code: 'COUNTER_IS_CASHIER' })]]);
    await step('accountant');
    await step('away');
    for (const who of ['accountant', 'away', 'nana']) {
      expect([who, (await post(who, `/shifts/${kofiShift}/late-count`, { declaredCashPesewas: 24_750, reason: 'Counted' })).status]).toEqual([who, 403]);
    }
    const notForced = await post('manager', `/shifts/${amaShift}/late-count`, { declaredCashPesewas: 2_000, reason: 'Counted' });
    expect([notForced.status, notForced.body.error.details]).toEqual([422, [expect.objectContaining({ code: 'SHIFT_NOT_FORCE_CLOSED' })]]);
  });

  it('counts 24,750 against the 25,000 it was closed at: 250 short, Cr 1000 25,000, Dr 1010 24,750, Dr 6900 250, and T1 back to 0', async () => {
    await step('owner');
    const counted = await post('owner', `/shifts/${kofiShift}/late-count`, { declaredCashPesewas: 24_750, reason: 'Counted the drawer the morning after with Kwabena' });
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    expect(counted.body).toMatchObject({
      status: 'CLOSED',
      forceClosed: true,
      declaredCashPesewas: 24_750,
      expectedCashPesewas: 25_000,
      overShortPesewas: 250,
      overShortDirection: 'SHORT',
      countedBy: { displayName: 'Esi Mensah' },
      closeApprovedBy: { displayName: 'Kwabena Owusu' },
    });
    expect((await closeJournal(kofiShift)).lines).toEqual([{ code: '1000', side: 'C', amount: 25_000 }, { code: '1010', side: 'D', amount: 24_750 }, { code: '6900', side: 'D', amount: 250 }]);
    expect(await tillLedger(tills.get('T1')!.id)).toBe(0);
    expect(await one<{ n: string }>("SELECT COALESCE(sum(CASE side WHEN 'D' THEN amount_pesewas ELSE -amount_pesewas END), 0)::text AS n FROM fin.journal_line", [])).toEqual({ n: '0' });
    expect(await one('SELECT declared_cash_pesewas::int AS declared, expected_cash_pesewas::int AS expected, over_short_pesewas::int AS short, actor_id AS actor FROM pos.shift_late_count WHERE shift_id = $1', [kofiShift])).toEqual({
      declared: 24_750,
      expected: await cashBySql(kofiShift),
      short: 250,
      actor: idOf('owner'),
    });
    const event = await one<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pos.ShiftClosed' AND subject_id = $1", [kofiShift]);
    expect(event.payload).toMatchObject({ cashierId: idOf('kofi'), approvedBy: idOf('owner'), forceClosed: true, forceClosedBy: idOf('manager'), overShortPesewas: 250, overShortDirection: 'SHORT', abuseCases: [17] });
    const z = await get('manager', `/shifts/${kofiShift}/z-report`);
    expect(z.body).toMatchObject({ kind: 'Z', forceClosed: true });
    expect(await one("SELECT count(*)::int AS n FROM platform.audit_anchor_request WHERE reason = 'SHIFT_CLOSE' AND subject_id = $1", [kofiShift])).toEqual({ n: 1 });
  });

  it('counts once: a replay answers the first, a second count is SHIFT_ALREADY_COUNTED, and the count never changes', async () => {
    const second = await post('owner', `/shifts/${kofiShift}/late-count`, { declaredCashPesewas: 25_000, reason: 'Again' });
    expect([second.status, second.body.error.details]).toEqual([422, [expect.objectContaining({ code: 'SHIFT_ALREADY_COUNTED' })]]);
    // Insert-only: the application role may not update it at all, and no role may (platform.reject_change).
    expect(await refusedAs('UPDATE pos.shift_late_count SET declared_cash_pesewas = 25000 WHERE shift_id = $1', [kofiShift])).toBe('42501');
    expect(await one<{ n: number }>("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_shift_late_count_immutable'", [])).toEqual({ n: 1 });
    expect(await one("SELECT count(*)::int AS n FROM fin.journal_entry WHERE event_code = 'pos.ShiftClosed' AND source_document_id = $1", [kofiShift])).toEqual({ n: 1 });
  });
});
