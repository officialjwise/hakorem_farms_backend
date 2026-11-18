import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { SalePosting, type SaleRequest } from '../../../src/modules/ord';
import { Payments } from '../../../src/modules/pay';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePatch, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { setTillPin, tillVerifier } from '../../support/till-pin';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The B9b gate's first fact: a shift close reconciles to the pesewa (FR-POS-015 to FR-POS-019, A-212 (a), A-273).
 *
 * Adwoa opens till T1 with a float of 50,000, sells 20 yams and 4 cabbages for 44,000 in cash, drops 30,000 to the safe
 * in front of Kwabena (a manager), and counts 63,500 blind. Kwabena signs it off: expected 64,000, short 500. The
 * figures the test asserts are derived independently, by SQL over `pos.cash_movement`, `pay.payment` and the journal
 * lines, never from the handler that computed them: the till's account (1000 against T1) comes back to exactly 0, 6900
 * carries the 500, the safe (1010) the rest, and the trial balance still sums to 0.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
type TotpSession = TestSession & { readonly secret: Buffer };
let manager: TotpSession;
let owner: TotpSession;
let cashier: TestSession;
let secondCashier: TestSession;
let storekeeper: TestSession;
let accountant: TestSession;
let cashierUser: TestUser;
let managerUser: TestUser;
let storekeeperUser: TestUser;
let otherOwner: TestSession;
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
let nextId: () => string;
const admin = () => database.pool('admin');
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const one = async <T>(sql: string, values: unknown[]): Promise<T> => (await admin().query(sql, values)).rows[0] as T;
const now = () => clock.now().toISOString();

async function stepUp(session: TotpSession) {
  clock.advanceBy(30_000);
  expect((await post(session, '/auth/step-up', { code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
}

function actorOf(user: TestUser, displayName: string): Actor {
  return { principalId: user.principalId, kind: 'USER', displayName, realm: 'STAFF', sessionId: null, steppedUpAt: null };
}

/** A counter sale posted as POS posts it: on the shift, its cash into the shift's till, in one serializable transaction. */
async function sell(seller: Actor, shiftId: string, register: { id: string; code: string }, lines: SaleRequest['lines'], cash: bigint) {
  const posting = api.app.get(SalePosting);
  const request: SaleRequest = { orderId: nextId(), channel: 'POS', branchId: id('branch:DDW'), fulfilmentMode: 'COUNTER', taxInclusive: true, shiftDocumentId: shiftId, lines, tenders: [{ methodCode: 'CASH', amountPesewas: cash, register }] };
  return runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'shift close test', actor: seller }, () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable', seriesLocks: posting.locksFor(request.branchId) }, (tx) => posting.postIn(tx, seller, request)),
  );
}

/** Debits less credits on an account, over the lines of journals whose source is one of these documents, or against one till. */
async function balance(code: string, where: { documents?: readonly string[]; register?: string }): Promise<number> {
  const row = await one<{ n: string }>(
    `SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS n
       FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
       LEFT JOIN fin.subledger_party p ON p.id = l.subledger_party_id
      WHERE a.code = $1 AND ($2::uuid[] IS NULL OR e.source_document_id = ANY($2::uuid[])) AND ($3::uuid IS NULL OR (p.kind = 'REGISTER' AND p.ref_id = $3))`,
    [code, where.documents ?? null, where.register ?? null],
  );
  return Number(row.n);
}

async function openRegister(code: string): Promise<{ id: string; code: string }> {
  const created = await post(manager, '/registers', { branchId: id('branch:DDW'), locationId: id('location:SHOP'), code, name: `Shop till ${code.slice(1)}` });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { id: created.body.id as string, code };
}

async function openShift(session: TestSession, registerId: string, floatPesewas: number) {
  const shiftId = nextId();
  return { shiftId, response: await post(session, '/shifts', { id: shiftId, registerId, openingFloatPesewas: floatPesewas, openedAt: now() }, shiftId) };
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'method:' || code, id FROM mdm.payment_method`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  const shop = id('location:SHOP');
  managerUser = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId }] });
  manager = await enrolAndLogin(api.server, managerUser, () => clock.now());
  // The witness confirms a drop with their till PIN (B09b continued 3): the manager's PIN is version 1.
  expect((await setTillPin(api.server, manager, await tillVerifier('554031'))).status).toBe(200);
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Esi Mensah', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  cashierUser = await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: shop }] });
  cashier = await login(api.server, cashierUser);
  secondCashier = await login(api.server, await createUser(database, { name: 'Nana Yeboah', grants: [{ role: 'CASHIER', branchId, locationId: shop }] }));
  storekeeperUser = await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId, locationId: shop }] });
  storekeeper = await login(api.server, storekeeperUser);
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  const elsewhere = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code <> 'DDW' ORDER BY code LIMIT 1")).rows[0];
  otherOwner = await login(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'CASHIER', branchId: elsewhere?.id ?? branchId }] }));
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('a short shift on T1: float 50,000, cash sales 44,000, a drop of 30,000, counted 63,500 blind', () => {
  let till: { id: string; code: string };
  let shiftId: string;
  let saleId: string;

  beforeAll(async () => {
    till = await openRegister('T1');
  });

  it('opens with the float moved from the safe to the till, numbered, and nothing expected shown', async () => {
    const opened = await openShift(cashier, till.id, 50_000);
    shiftId = opened.shiftId;
    expect(opened.response.status, JSON.stringify(opened.response.body)).toBe(201);
    expect(opened.response.body).toMatchObject({
      id: shiftId,
      shiftNo: expect.stringMatching(/^SHF-\d{4}-DDW-\d+$/),
      status: 'OPEN',
      register: { id: till.id, code: 'T1', name: 'Shop till 1' },
      cashier: { displayName: 'Adwoa Darko' },
      shiftSeq: 1,
      openingFloatPesewas: 50_000,
      declaredCashPesewas: null,
      expectedCashPesewas: null,
      overShortPesewas: null,
      salesCount: 0,
      tenders: [],
      currency: 'GHS',
    });
    expect(await balance('1000', { register: till.id })).toBe(50_000);
    expect(await balance('1010', { documents: [shiftId] })).toBe(-50_000);
    const registers = await get(manager, `/registers?branchId=${id('branch:DDW')}`);
    expect(registers.body.data.find((r: { id: string }) => r.id === till.id)).toMatchObject({ openShift: { id: shiftId, cashier: { displayName: 'Adwoa Darko' } }, deviceCount: 0 });
  });

  it('replays the open with the same key and opens nothing more', async () => {
    const replay = await post(cashier, '/shifts', { id: shiftId, registerId: till.id, openingFloatPesewas: 50_000, openedAt: now() }, shiftId);
    expect(replay.status).toBe(201);
    expect(await one<{ n: number }>('SELECT count(*)::int AS n FROM pos.shift WHERE register_id = $1', [till.id])).toEqual({ n: 1 });
  });

  it('allows one open shift per register and per cashier, in the handler and in the database', async () => {
    const onTill = await openShift(secondCashier, till.id, 10_000);
    expect(onTill.response.status).toBe(422);
    expect(onTill.response.body.error).toMatchObject({ code: 'SHIFT_ALREADY_OPEN', details: [{ code: 'REGISTER_HAS_OPEN_SHIFT' }] });
    const t2 = await openRegister('T2');
    const sameCashier = await openShift(cashier, t2.id, 10_000);
    expect(sameCashier.response.status).toBe(422);
    expect(sameCashier.response.body.error).toMatchObject({ code: 'SHIFT_ALREADY_OPEN', details: [{ code: 'CASHIER_HAS_OPEN_SHIFT' }] });
    const docId = randomUUID();
    await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'SHIFT', 'pos', $2, $3)", [docId, id('branch:DDW'), cashierUser.principalId]);
    await expect(
      admin().query(
        `INSERT INTO pos.shift (id, shift_no, register_id, cashier_id, shift_seq, opened_at, opening_float_pesewas, status, branch_id, created_at, created_by, updated_at, updated_by)
         VALUES ($1, 'SHF-X-1', $2, $3, 99, $4, 0, 'OPEN', $5, $4, $3, $4, $3)`,
        [docId, till.id, storekeeperUser.principalId, clock.now(), id('branch:DDW')],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'uq_shift_open_register' });
  });

  it('takes 44,000 of cash sales into the shift, and refuses cash into a till with no shift (A-212 (a))', async () => {
    const lines: SaleRequest['lines'] = [
      { productId: id('product:PRD-0005'), fromLocationId: id('location:SHOP'), quantity: '20.000' },
      { productId: id('product:PRD-0002'), fromLocationId: id('location:SHOP'), quantity: '4.000' },
    ];
    const sale = await sell(actorOf(cashierUser, 'Adwoa Darko'), shiftId, till, lines, 44_000n);
    saleId = sale.id;
    expect(sale).toMatchObject({ channel: 'POS', status: 'COMPLETED', finalTotalPesewas: 44_000 });
    expect(await one('SELECT shift_document_id AS shift FROM ord.sales_order WHERE id = $1', [saleId])).toEqual({ shift: shiftId });
    await expect(sell(actorOf(cashierUser, 'Adwoa Darko'), null as unknown as string, till, lines, 44_000n)).rejects.toMatchObject({ code: 'SALE_INVALID', details: [expect.objectContaining({ code: 'SHIFT_REQUIRED' })] });
    const cashierActor = actorOf(cashierUser, 'Adwoa Darko');
    await expect(
      runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'shift close test', actor: cashierActor }, () =>
        api.app.get(UnitOfWork).run({ isolation: 'serializable' }, (tx) =>
          api.app.get(Payments).recordIn(tx, cashierActor, { branchId: id('branch:DDW'), channel: 'WHOLESALE', methodCode: 'CASH', amountPesewas: 1_000n, customerId: null, orderDocumentId: null, register: till, receivedAt: clock.now(), allocations: [] }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_INVALID', details: [expect.objectContaining({ field: '/register', code: 'SHIFT_REQUIRED' })] });
  });

  it('refuses in the database a cash payment into a till that names no shift', async () => {
    const insert = (shift: string | null) =>
      admin().query(
        `INSERT INTO pay.payment (id, payment_method_id, method_kind, amount_pesewas, shift_document_id, register_ref, register_code, verification, status, received_at, cleared_at, branch_id, created_by, updated_by)
         VALUES ($1, $2, 'CASH', 1000, $3, $4, 'T1', 'NOT_REQUIRED', 'CLEARED', $5, $5, $6, $7, $7)`,
        [randomUUID(), id('method:CASH'), shift, till.id, clock.now(), id('branch:DDW'), cashierUser.principalId],
      );
    await expect(insert(null)).rejects.toMatchObject({ code: '23514', constraint: 'ck_payment_cash_shift' });
  });

  it('refuses a drop witnessed by the cashier, by someone who is not a supervisor, or with no reason', async () => {
    const drop = (body: object) => post(cashier, `/shifts/${shiftId}/cash-movements`, { id: nextId(), kind: 'CASH_DROP', amountPesewas: 30_000, occurredAt: now(), ...body });
    expect((await drop({ reasonCode: 'SAFE_DROP', witnessId: cashierUser.principalId })).body.error).toMatchObject({ code: 'CASH_MOVEMENT_INVALID', details: [{ code: 'WITNESS_IS_MAKER' }] });
    expect((await drop({ reasonCode: 'SAFE_DROP', witnessId: storekeeperUser.principalId })).body.error).toMatchObject({ code: 'CASH_MOVEMENT_INVALID', details: [{ code: 'WITNESS_NOT_SUPERVISOR' }] });
    expect((await drop({ witnessId: managerUser.principalId })).body.error).toMatchObject({ code: 'CASH_MOVEMENT_INVALID', details: [{ code: 'REASON_REQUIRED' }] });
    expect((await drop({ reasonCode: 'SAFE_DROP', witnessId: managerUser.principalId, amountPesewas: 94_001 })).body.error).toMatchObject({ code: 'CASH_MOVEMENT_INVALID', details: [{ code: 'TILL_OVERDRAWN' }] });
    expect(await one<{ n: number }>("SELECT count(*)::int AS n FROM pos.cash_movement WHERE shift_id = $1 AND kind <> 'FLOAT_IN'", [shiftId])).toEqual({ n: 0 });
  });

  it('refuses in the database a drop witnessed by the shift\'s own cashier', async () => {
    await expect(
      admin().query(
        `INSERT INTO pos.cash_movement (id, shift_id, kind, amount_pesewas, reason_code, witness_id, occurred_at, recorded_at, actor_id)
         VALUES ($1, $2, 'CASH_DROP', 100, 'SAFE_DROP', $3, $4, $4, $5)`,
        [randomUUID(), shiftId, cashierUser.principalId, clock.now(), managerUser.principalId],
      ),
    ).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_cash_movement_witness' });
  });

  it('drops 30,000 to the safe in front of the manager, once for a replayed key', async () => {
    const movementId = nextId();
    const body = { id: movementId, kind: 'CASH_DROP', amountPesewas: 30_000, reasonCode: 'SAFE_DROP', witnessId: managerUser.principalId, witnessPinVersion: 1, occurredAt: now() };
    const dropped = await post(cashier, `/shifts/${shiftId}/cash-movements`, body, movementId);
    expect(dropped.status, JSON.stringify(dropped.body)).toBe(201);
    expect(dropped.body).toMatchObject({ id: movementId, kind: 'CASH_DROP', amountPesewas: 30_000, reasonCode: 'SAFE_DROP', witness: { displayName: 'Kwabena Owusu' }, actor: { displayName: 'Adwoa Darko' } });
    expect((await post(cashier, `/shifts/${shiftId}/cash-movements`, body, movementId)).status).toBe(201);
    expect(await one<{ n: number }>("SELECT count(*)::int AS n FROM pos.cash_movement WHERE shift_id = $1 AND kind = 'CASH_DROP'", [shiftId])).toEqual({ n: 1 });
    const listed = await get(cashier, `/shifts/${shiftId}/cash-movements`);
    expect(listed.body.data.map((m: { kind: string; amountPesewas: number }) => [m.kind, m.amountPesewas]).sort()).toEqual([['CASH_DROP', 30_000], ['FLOAT_IN', 50_000]]);
  });

  it('reads an X report whose tenders add to the sales exactly, with no expected cash', async () => {
    const x = await get(cashier, `/shifts/${shiftId}/x-report`);
    expect(x.status, JSON.stringify(x.body)).toBe(200);
    expect(x.body).toEqual({
      kind: 'X',
      shift: { id: shiftId, code: expect.stringMatching(/^SHF-/), name: 'Shop till 1, Adwoa Darko' },
      generatedAt: now(),
      salesCount: 1,
      grossSalesPesewas: 44_000,
      voidsCount: 0,
      voidsPesewas: 0,
      overridesCount: 0,
      overridesPesewas: 0,
      refundsPesewas: 0,
      byMethod: [{ paymentMethod: { id: id('method:CASH'), code: 'CASH', name: 'Cash', kind: 'CASH' }, count: 1, amountPesewas: 44_000 }],
      cashMovements: [{ kind: 'FLOAT_IN', amountPesewas: 50_000 }, { kind: 'CASH_DROP', amountPesewas: 30_000 }],
      unwitnessedDropsCount: 0,
      unwitnessedDropsPesewas: 0,
      forceClosed: false,
      currency: 'GHS',
      documentId: null,
    });
    expect((await get(cashier, `/shifts/${shiftId}/z-report`)).status).toBe(404);
  });

  it('hides expected cash from everyone until the count is declared', async () => {
    expect((await get(cashier, `/shifts/${shiftId}`)).body).toMatchObject({ status: 'OPEN', expectedCashPesewas: null, overShortPesewas: null, salesCount: 1 });
    expect((await get(manager, `/shifts/${shiftId}`)).body).toMatchObject({ status: 'OPEN', expectedCashPesewas: null });
  });

  it('refuses another cashier, a storekeeper and the accountant at the till\'s writes, and another cashier at its reads', async () => {
    expect((await post(secondCashier, `/shifts/${shiftId}/close`, { declared: [{ paymentMethodId: id('method:CASH'), declaredPesewas: 0 }] })).status).toBe(403);
    expect((await post(storekeeper, `/shifts/${shiftId}/cash-movements`, { id: nextId(), kind: 'PAY_IN', amountPesewas: 100, reasonCode: 'FLOAT_TOP_UP', occurredAt: now() })).status).toBe(403);
    expect((await post(accountant, `/shifts/${shiftId}/cash-movements`, { id: nextId(), kind: 'PAY_IN', amountPesewas: 100, reasonCode: 'FLOAT_TOP_UP', occurredAt: now() })).status).toBe(403);
    expect((await post(secondCashier, `/shifts/${shiftId}/cash-movements`, { id: nextId(), kind: 'PAY_IN', amountPesewas: 100, reasonCode: 'FLOAT_TOP_UP', occurredAt: now() })).status).toBe(403);
    expect((await get(secondCashier, `/shifts/${shiftId}`)).status).toBe(403);
    expect((await get(secondCashier, `/shifts/${shiftId}/x-report`)).status).toBe(403);
    expect((await get(otherOwner, `/shifts/${shiftId}`)).status).toBe(403);
    expect((await get(secondCashier, '/shifts')).body.data.some((s: { id: string }) => s.id === shiftId)).toBe(false);
    expect((await post(cashier, '/registers', { branchId: id('branch:DDW'), locationId: id('location:SHOP'), code: 'T9', name: 'Shop till 9' })).status).toBe(403);
    expect((await openShift(storekeeper, till.id, 0)).response.status).toBe(403);
    expect(await one<{ n: number }>('SELECT count(*)::int AS n FROM pos.cash_movement WHERE shift_id = $1', [shiftId])).toEqual({ n: 2 });
  });

  it('declares 63,500 blind, then shows expected 64,000 and short 500, and moves nothing more on the shift', async () => {
    const declared = await post(cashier, `/shifts/${shiftId}/close`, { declared: [{ paymentMethodId: id('method:CASH'), declaredPesewas: 63_500 }] });
    expect(declared.status, JSON.stringify(declared.body)).toBe(200);
    expect(declared.body).toMatchObject({ status: 'CLOSING', declaredCashPesewas: 63_500, expectedCashPesewas: 64_000, overShortPesewas: 500, overShortDirection: 'SHORT', closeApprovedBy: null });
    // Derived independently: the float and drops from pos.cash_movement, the cash taken from pay.payment.
    const records = await one<{ n: string }>(
      `SELECT ((SELECT COALESCE(sum(CASE kind WHEN 'FLOAT_IN' THEN amount_pesewas WHEN 'PAY_IN' THEN amount_pesewas ELSE -amount_pesewas END), 0) FROM pos.cash_movement WHERE shift_id = $1)
             + (SELECT COALESCE(sum(amount_pesewas - refunded_pesewas), 0) FROM pay.payment WHERE shift_document_id = $1 AND method_kind = 'CASH' AND status = 'CLEARED'))::text AS n`,
      [shiftId],
    );
    expect(Number(records.n)).toBe(64_000);
    expect(await balance('1000', { register: till.id })).toBe(64_000);
    const late = await post(cashier, `/shifts/${shiftId}/cash-movements`, { id: nextId(), kind: 'PAY_IN', amountPesewas: 100, reasonCode: 'FLOAT_TOP_UP', occurredAt: now() });
    expect(late.body.error).toMatchObject({ code: 'SHIFT_NOT_OPEN' });
    await expect(
      admin().query(
        `INSERT INTO pos.cash_movement (id, shift_id, kind, amount_pesewas, reason_code, occurred_at, recorded_at, actor_id) VALUES ($1, $2, 'PAY_IN', 100, 'FLOAT_TOP_UP', $3, $3, $4)`,
        [randomUUID(), shiftId, clock.now(), cashierUser.principalId],
      ),
    ).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_cash_movement_open_shift' });
    await expect(admin().query('UPDATE pos.shift SET version = version + 1, declared_cash_pesewas = 64000 WHERE id = $1', [shiftId])).rejects.toMatchObject({ code: 'HK004' });
  });

  it('refuses the cashier signing off, with or without the permission, in the handler and in the database', async () => {
    expect((await post(cashier, `/shifts/${shiftId}/approve-close`, { reason: 'Counted with me' })).status).toBe(403);
    await expect(admin().query('UPDATE pos.shift SET version = version + 1, close_approved_by = cashier_id WHERE id = $1', [shiftId])).rejects.toMatchObject({ code: '23514', constraint: 'ck_shift_close_checker' });
  });

  it('signs off: posts 1010 Dr 63,500, 6900 Dr 500, 1000 Cr 64,000, so the till comes back to exactly 0', async () => {
    await stepUp(manager);
    const signed = await post(manager, `/shifts/${shiftId}/approve-close`, { reason: 'Counted the drawer with Adwoa; the drop is in the safe' });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body).toMatchObject({
      status: 'CLOSED',
      declaredCashPesewas: 63_500,
      expectedCashPesewas: 64_000,
      overShortPesewas: 500,
      overShortDirection: 'SHORT',
      closeApprovedBy: { displayName: 'Kwabena Owusu' },
      tenders: [{ paymentMethod: { code: 'CASH' }, declaredPesewas: 63_500, expectedPesewas: 64_000, variancePesewas: 500, varianceDirection: 'SHORT' }],
    });
    const closing = await one<{ lines: { code: string; side: string; amount: number }[] }>(
      `SELECT json_agg(json_build_object('code', a.code, 'side', l.side, 'amount', l.amount_pesewas) ORDER BY a.code, l.side) AS lines
         FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
        WHERE e.event_code = 'pos.ShiftClosed' AND e.source_document_id = $1`,
      [shiftId],
    );
    expect(closing.lines).toEqual([{ code: '1000', side: 'C', amount: 64_000 }, { code: '1010', side: 'D', amount: 63_500 }, { code: '6900', side: 'D', amount: 500 }]);
    expect(await balance('1000', { register: till.id })).toBe(0);
    expect(await balance('6900', { documents: [shiftId] })).toBe(500);
    expect(await balance('1010', { documents: [shiftId] })).toBe(-50_000 + 30_000 + 63_500);
    expect(await one<{ n: string }>("SELECT COALESCE(sum(CASE side WHEN 'D' THEN amount_pesewas ELSE -amount_pesewas END), 0)::text AS n FROM fin.journal_line", [])).toEqual({ n: '0' });
    const event = await one<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pos.ShiftClosed' AND subject_id = $1", [shiftId]);
    expect(event.payload).toMatchObject({ cashierId: cashierUser.principalId, approvedBy: managerUser.principalId, overShortPesewas: 500, overShortDirection: 'SHORT', abuseCases: [17] });
    // The sign-off asks the worker to anchor the audit chain once it is sealed (ADR-0006, A-275), in its own transaction.
    expect(await one("SELECT reason, subject_type AS type, actor_id AS actor FROM platform.audit_anchor_request WHERE subject_id = $1", [shiftId])).toEqual({ reason: 'SHIFT_CLOSE', type: 'Shift', actor: managerUser.principalId });
  });

  it('freezes the Z report and the closed shift, and replays the sign-off without posting twice', async () => {
    const z = await get(manager, `/shifts/${shiftId}/z-report`);
    expect(z.status).toBe(200);
    expect(z.body).toMatchObject({ kind: 'Z', salesCount: 1, grossSalesPesewas: 44_000, byMethod: [{ count: 1, amountPesewas: 44_000 }], cashMovements: [{ kind: 'FLOAT_IN', amountPesewas: 50_000 }, { kind: 'CASH_DROP', amountPesewas: 30_000 }] });
    await expect(admin().query("UPDATE pos.shift_report SET totals = '{}' WHERE shift_id = $1", [shiftId])).rejects.toThrow();
    await expect(admin().query('UPDATE pos.shift SET version = version + 1, over_short_pesewas = 0, over_short_direction = $2, declared_cash_pesewas = expected_cash_pesewas WHERE id = $1', [shiftId, 'EXACT'])).rejects.toMatchObject({ code: 'HK004' });
    expect((await post(manager, `/shifts/${shiftId}/approve-close`, { reason: 'Again' })).body.error).toMatchObject({ code: 'SHIFT_INVALID', details: [{ code: 'SHIFT_NOT_CLOSING' }] });
    expect(await one<{ n: number }>("SELECT count(*)::int AS n FROM fin.journal_entry WHERE event_code = 'pos.ShiftClosed' AND source_document_id = $1", [shiftId])).toEqual({ n: 1 });
  });
});

describe('an over shift on T2: float 20,000, a fuel pay-out of 1,250 and the float topped up by 5,000, counted 24,000', () => {
  it('expects 23,750 and posts the 250 over to 6900 as a credit, the pay-out to 6800', async () => {
    const t2 = (await get(manager, `/registers?branchId=${id('branch:DDW')}`)).body.data.find((r: { code: string }) => r.code === 'T2');
    const { shiftId, response } = await openShift(secondCashier, t2.id, 20_000);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const move = (body: object) => post(secondCashier, `/shifts/${shiftId}/cash-movements`, { id: nextId(), occurredAt: now(), ...body });
    expect((await move({ kind: 'PAY_OUT', amountPesewas: 1_250, reasonCode: 'FUEL_PAYOUT' })).body.error).toMatchObject({ code: 'CASH_MOVEMENT_INVALID', details: [{ code: 'NOTE_REQUIRED' }] });
    expect((await move({ kind: 'PAY_OUT', amountPesewas: 1_250, reasonCode: 'FLOAT_TOP_UP' })).body.error).toMatchObject({ code: 'CASH_MOVEMENT_INVALID', details: [{ code: 'REASON_NOT_FOR_KIND' }] });
    expect((await move({ kind: 'PAY_OUT', amountPesewas: 1_250, reasonCode: 'FUEL_PAYOUT', note: 'Motorbike fuel for the egg run, receipt kept' })).status).toBe(201);
    expect((await move({ kind: 'PAY_IN', amountPesewas: 5_000, reasonCode: 'FLOAT_TOP_UP' })).status).toBe(201);
    expect((await post(secondCashier, `/shifts/${shiftId}/close`, { declared: [{ paymentMethodId: id('method:MOMO'), declaredPesewas: 0 }] })).body.error).toMatchObject({ code: 'SHIFT_INVALID', details: [{ code: 'CASH_NOT_DECLARED' }] });
    expect((await post(secondCashier, `/shifts/${shiftId}/close`, { declared: [{ paymentMethodId: id('method:CASH'), declaredPesewas: 24_000 }] })).status).toBe(200);
    await stepUp(owner);
    const signed = await post(owner, `/shifts/${shiftId}/approve-close`, { reason: 'Counted, 250 over, a customer left change' });
    expect(signed.body).toMatchObject({ status: 'CLOSED', expectedCashPesewas: 23_750, overShortPesewas: 250, overShortDirection: 'OVER' });
    expect(await balance('1000', { register: t2.id })).toBe(0);
    expect(await balance('6900', { documents: [shiftId] })).toBe(-250);
    expect(await balance('6800', { documents: [shiftId] })).toBe(1_250);
    expect(await balance('1010', { documents: [shiftId] })).toBe(-20_000 - 5_000 + 24_000);
  });
});

describe('maker and checker on the sign-off', () => {
  it('refuses a manager who ran the shift signing off their own count, with 422 SHIFT_CLOSE_SAME_PERSON', async () => {
    const t3 = await openRegister('T3');
    const { shiftId, response } = await openShift(manager, t3.id, 0);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect((await post(manager, `/shifts/${shiftId}/close`, { declared: [{ paymentMethodId: id('method:CASH'), declaredPesewas: 0 }] })).status).toBe(200);
    await stepUp(manager);
    const own = await post(manager, `/shifts/${shiftId}/approve-close`, { reason: 'Mine' });
    expect(own.status).toBe(422);
    expect(own.body.error.code).toBe('SHIFT_CLOSE_SAME_PERSON');
    expect(await one('SELECT status FROM pos.shift WHERE id = $1', [shiftId])).toEqual({ status: 'CLOSING' });
    await stepUp(owner);
    expect((await post(owner, `/shifts/${shiftId}/approve-close`, { reason: 'Empty till, nothing taken' })).body).toMatchObject({ status: 'CLOSED', overShortDirection: 'EXACT', overShortPesewas: 0 });
  });

  it('refuses retiring a till with a shift open or taking a code already used at the branch, and retires a closed till', async () => {
    const t4 = await openRegister('T4');
    const { response } = await openShift(cashier, t4.id, 0);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const patch = (registerId: string, body: object) => consolePatch(api.server, manager, `/v1/registers/${registerId}`).send(body);
    expect((await patch(t4.id, { version: 1, status: 'RETIRED' })).body.error).toMatchObject({ code: 'REGISTER_INVALID', details: [{ code: 'SHIFT_OPEN' }] });
    expect((await post(manager, '/registers', { branchId: id('branch:DDW'), locationId: id('location:SHOP'), code: 'T1', name: 'Again' })).body.error).toMatchObject({ code: 'REGISTER_INVALID', details: [{ code: 'REGISTER_CODE_TAKEN' }] });
    const t1 = (await get(manager, `/registers?branchId=${id('branch:DDW')}`)).body.data.find((r: { code: string }) => r.code === 'T1');
    expect((await patch(t1.id, { version: t1.version + 1, status: 'RETIRED' })).status).toBe(409);
    const retired = await patch(t1.id, { version: t1.version, status: 'RETIRED' });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body).toMatchObject({ status: 'RETIRED', openShift: null, version: t1.version + 1 });
    expect((await openShift(secondCashier, t1.id, 0)).response.body.error).toMatchObject({ code: 'SHIFT_INVALID', details: [{ code: 'REGISTER_RETIRED' }] });
  });
});
