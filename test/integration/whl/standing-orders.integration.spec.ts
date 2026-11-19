import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StandingOrders } from '../../../src/modules/whl';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { addDays } from '../../../src/seed/seed-calendar';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePatch, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Standing orders (FR-WHL-004, A-320), the gate of B10 continued 3: one order per standing order and date however often
 * the job runs, twice in turn or twice at once; a run stopped midway leaves each standing order done for the date or
 * untouched, and the next run finishes it once; a held account's run is recorded as skipped; an order the credit check
 * refuses is made, left PLACED and recorded HELD_FOR_CREDIT, never confirmed by the job; a paused order makes nothing.
 * Every figure is read back from WHL's and ORD's own tables in SQL. Every write refuses the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
let yamTotal: number;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const patch = (who: string, path: string, body: object) => consolePatch(api.server, as(who), `/v1${path}`).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const today = () => toBusinessDate(clock.now());
const DAY = 86_400_000;
const weekdayOf = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
let customers = 0;
const SEED_PASSWORD = `Seed-${randomUUID()}`;
const job = () => runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(StandingOrders).run({ kind: 'SYSTEM', principalId: SYSTEM_PRINCIPAL }));

async function approve(who: string, approvalRequestId: string) {
  await stepUp(api.server, as(who) as TotpSession, clock);
  return post(who, `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Checked' });
}

/** A business customer with an open account at Dodowa; a limit above nil asked by the Owner and approved by the Manager. */
async function account(name: string, limit: number): Promise<string> {
  const customerId = randomUUID();
  await app().query(
    "INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by) VALUES ($1, $2, 'BUSINESS', $3, '01900000-0000-7000-8000-000000000302', 'ACTIVE', $4, $4)",
    [customerId, `C-7${String((customers += 1)).padStart(4, '0')}`, name, SYSTEM_PRINCIPAL],
  );
  const opened = await post('owner', '/business-accounts', { customerId, branchId, creditLimitPesewas: limit, paymentTermsDays: 30, reason: 'Opening terms (TEST)' });
  if (limit > 0) {
    expect(opened.status, JSON.stringify(opened.body)).toBe(202);
    expect((await approve('manager', opened.body.approvalRequestId as string)).status).toBe(200);
  } else expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  return customerId;
}

const weekly = (customerId: string, extra: object = {}) => ({ customerId, frequency: 'WEEKLY', weekdays: [weekdayOf(today())], startsOn: today(), lines: [{ productId: id('yam'), quantity: '2.000' }], ...extra });
async function standing(who: string, body: object): Promise<string> {
  const made = await post(who, '/standing-orders', body);
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.id as string;
}
const runRows = async (standingOrderId: string) =>
  (await admin().query<{ run_date: string; outcome: string; order_id: string | null; reason: string | null }>(
    'SELECT run_date::text, outcome, order_id, reason FROM whl.standing_order_run WHERE standing_order_id = $1 ORDER BY run_date',
    [standingOrderId],
  )).rows;
const ordersOf = async (standingOrderId: string) =>
  (await admin().query<{ id: string; status: string; payment_terms: string; channel: string; credit_check: string | null; estimated: string; salesperson_id: string }>(
    'SELECT id, status, payment_terms, channel, credit_check, estimated_total_pesewas::text AS estimated, salesperson_id FROM ord.sales_order WHERE source_document_id = $1 ORDER BY placed_at',
    [standingOrderId],
  )).rows;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  const long = String(90 * 86_400);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: long, AUTH_STAFF_REFRESH_IDLE_SECONDS: long, AUTH_STAFF_REFRESH_ABSOLUTE_SECONDS: long } });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: SEED_PASSWORD }));
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const [name, sku] of [['goat', 'LIV-0004'], ['yam', 'PRD-0005']] as const) ids.set(name, (await admin().query<{ id: string }>('SELECT id FROM mdm.product WHERE sku = $1', [sku])).rows[0]!.id);
  const tema = await createBranch(database, 'TMA');
  const people: [string, string, string, boolean, string?][] = [
    ['owner', 'Kwabena Owusu', 'OWNER', true],
    ['manager', 'Akosua Boateng', 'MANAGER', true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
    ['sales', 'Esi Appiah', 'SALES', false],
    ['cashier', 'Adwoa Darko', 'CASHIER', false],
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', false],
    ['temaOwner', 'Yaa Asantewaa', 'OWNER', true, tema.branchId],
  ];
  for (const [who, name, role, privileged, at] of people) {
    const user = await createUser(database, { name, grants: [{ role: role as 'OWNER', branchId: at ?? branchId }] });
    users.set(who, user);
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  sessions.set('customer', await login(api.server, await createUser(database, { name: 'Abena Kyei', realm: 'CUSTOMER' })));
  // Two yams on credit priced by the engine: each limit below is set around this exact total.
  const probe = await account('Probe Hotel (TEST)', 0);
  const placed = await post('sales', '/orders', { channel: 'WHOLESALE', customerId: probe, fulfilmentMode: 'COLLECTION', paymentTerms: 'CREDIT', lines: [{ productId: id('yam'), quantity: '2.000' }] });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  yamTotal = placed.body.estimatedTotalPesewas as number;
  expect(yamTotal).toBeGreaterThan(0);
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('one order per standing order and date (FR-WHL-004)', () => {
  it('makes one order today however often the job runs, in turn or at once, and none on a day it does not fall on', async () => {
    const customerId = await account('Royal Palm Kitchen (TEST)', yamTotal * 10);
    const standingId = await standing('sales', weekly(customerId));
    const read = (await get('sales', `/standing-orders/${standingId}`)).body;
    expect(read).toMatchObject({ status: 'ACTIVE', frequency: 'WEEKLY', weekdays: [weekdayOf(today())], weekday: weekdayOf(today()), nextRunOn: today(), deliveryAddress: null, intervalDays: null, dayOfMonth: null });
    expect(read.lines).toEqual([expect.objectContaining({ lineNo: 1, quantity: '2.000', uom: expect.any(String), product: expect.objectContaining({ id: id('yam') }) })]);

    await job();
    await job();
    await Promise.all([job(), job()]);
    expect(await runRows(standingId)).toEqual([{ run_date: today(), outcome: 'CREATED', order_id: expect.any(String), reason: null }]);
    const made = await ordersOf(standingId);
    expect(made).toEqual([{ id: (await runRows(standingId))[0]!.order_id, status: 'PLACED', payment_terms: 'CREDIT', channel: 'WHOLESALE', credit_check: null, estimated: String(yamTotal), salesperson_id: users.get('sales')!.principalId }]);
    expect((await get('sales', `/standing-orders/${standingId}`)).body.nextRunOn).toBe(addDays(today(), 7));
    const runs = (await get('accountant', `/standing-orders/${standingId}/runs`)).body;
    expect(runs.data).toEqual([{ runDate: today(), outcome: 'CREATED', reason: null, order: { id: made[0]!.id, docType: 'SALES_ORDER', number: expect.stringMatching(/^SO-/) }, recordedAt: clock.now().toISOString() }]);
    // The order made is confirmed by staff like any other: it passes the credit check within the limit.
    const confirmed = await consolePost(api.server, as('sales'), `/v1/orders/${made[0]!.id}/confirm`, randomUUID()).send();
    expect([confirmed.status, confirmed.body.creditCheck], JSON.stringify(confirmed.body)).toEqual([200, 'PASSED']);
    // The next day is not a run day; a week on is, and makes exactly one more.
    clock.set(new Date(clock.now().getTime() + DAY));
    await job();
    expect(await runRows(standingId)).toHaveLength(1);
    clock.set(new Date(clock.now().getTime() + 6 * DAY));
    await job();
    await job();
    expect((await runRows(standingId)).map((r) => [r.run_date, r.outcome])).toEqual([
      [addDays(today(), -7), 'CREATED'],
      [today(), 'CREATED'],
    ]);
    expect(await ordersOf(standingId)).toHaveLength(2);
  });

  it('records a held account’s run as skipped with the reason, makes no order, and records it once', async () => {
    const customerId = await account('Held Guest House (TEST)', yamTotal * 10);
    const standingId = await standing('sales', weekly(customerId));
    expect((await post('accountant', `/business-accounts/${customerId}/hold`, { reason: 'Two cheques returned this month' })).status).toBe(200);
    await job();
    await job();
    expect(await runRows(standingId)).toEqual([{ run_date: today(), outcome: 'SKIPPED_ON_HOLD', order_id: null, reason: 'The account is on hold: Two cheques returned this month' }]);
    expect(await ordersOf(standingId)).toEqual([]);
  });

  it('makes an order the credit check refuses, leaves it PLACED as HELD_FOR_CREDIT, and confirming it is refused without an override', async () => {
    const customerId = await account('Over Limit Canteen (TEST)', yamTotal - 1);
    const standingId = await standing('manager', weekly(customerId));
    await job();
    const [run] = await runRows(standingId);
    expect(run).toEqual({ run_date: today(), outcome: 'HELD_FOR_CREDIT', order_id: expect.any(String), reason: expect.stringContaining('over the credit limit by GHS 0.01') });
    expect(await ordersOf(standingId)).toEqual([expect.objectContaining({ id: run!.order_id, status: 'PLACED', credit_check: null })]);
    const refused = await consolePost(api.server, as('sales'), `/v1/orders/${run!.order_id!}/confirm`, randomUUID()).send();
    expect([refused.status, refused.body.error?.code]).toEqual([422, 'CREDIT_LIMIT_EXCEEDED']);
    expect((await ordersOf(standingId))[0]!.status).toBe('PLACED');
    // Exactly at the limit passes (one pesewa more limit would have made it CREATED): the boundary is the order's total.
    const atLimit = await account('At Limit Canteen (TEST)', yamTotal);
    const atLimitId = await standing('manager', weekly(atLimit));
    await job();
    expect((await runRows(atLimitId)).map((r) => r.outcome)).toEqual(['CREATED']);
  });

  it('makes nothing while paused, does not make up the paused dates on resume, and ends for good', async () => {
    const customerId = await account('Paused Restaurant (TEST)', yamTotal * 10);
    const standingId = await standing('sales', weekly(customerId, { startsOn: addDays(today(), 1), weekdays: [weekdayOf(addDays(today(), 1))] }));
    let version = (await get('sales', `/standing-orders/${standingId}`)).body.version as number;
    const paused = await post('sales', `/standing-orders/${standingId}/pause`, { reason: 'Closed for renovation (TEST)' });
    expect([paused.status, paused.body.status, paused.body.nextRunOn]).toEqual([200, 'PAUSED', null]);
    expect(paused.body.version).toBe(version + 1);
    clock.set(new Date(clock.now().getTime() + DAY));
    await job();
    expect(await runRows(standingId)).toEqual([]);
    clock.set(new Date(clock.now().getTime() + DAY));
    const resumed = await post('sales', `/standing-orders/${standingId}/resume`, { reason: 'Reopened (TEST)' });
    expect([resumed.status, resumed.body.status, resumed.body.nextRunOn]).toEqual([200, 'ACTIVE', addDays(today(), 6)]);
    await job();
    expect(await runRows(standingId)).toEqual([]);
    expect((await post('sales', `/standing-orders/${standingId}/resume`, { reason: 'Again' })).body.error.details).toEqual([expect.objectContaining({ code: 'NOT_PAUSED' })]);
    version = resumed.body.version as number;
    const ended = await post('manager', `/standing-orders/${standingId}/end`, { reason: 'Contract over (TEST)' });
    expect([ended.status, ended.body.status, ended.body.nextRunOn, ended.body.version]).toEqual([200, 'ENDED', null, version + 1]);
    expect((await post('sales', `/standing-orders/${standingId}/pause`, { reason: 'x' })).body.error.details).toEqual([expect.objectContaining({ code: 'NOT_ACTIVE' })]);
    // The database: an ended order never changes again.
    expect(await sqlStateOf(admin().query("UPDATE whl.standing_order SET status = 'ACTIVE', version = version + 1 WHERE id = $1", [standingId]))).toBe('HK004');
  });

  it('records the dates the job missed as MISSED and makes only today’s order, every n days', async () => {
    const customerId = await account('Every Three Days Bakery (TEST)', yamTotal * 10);
    const standingId = await standing('sales', { customerId, frequency: 'EVERY_N_DAYS', intervalDays: 3, startsOn: today(), lines: [{ productId: id('yam'), quantity: '2.000' }] });
    const start = today();
    clock.set(new Date(clock.now().getTime() + 6 * DAY));
    await job();
    await job();
    expect(await runRows(standingId)).toEqual([
      { run_date: start, outcome: 'MISSED', order_id: null, reason: 'The scheduler did not run on this date; no order was made for it' },
      { run_date: addDays(start, 3), outcome: 'MISSED', order_id: null, reason: 'The scheduler did not run on this date; no order was made for it' },
      { run_date: addDays(start, 6), outcome: 'CREATED', order_id: expect.any(String), reason: null },
    ]);
    expect(await ordersOf(standingId)).toHaveLength(1);
    expect((await get('sales', `/standing-orders/${standingId}`)).body.nextRunOn).toBe(addDays(start, 9));
  });

  it('survives a crash mid-run: the first is done with its order, the second untouched, and the next two runs finish it once', async () => {
    const first = await standing('sales', weekly(await account('Crash First Inn (TEST)', yamTotal * 10)));
    const second = await standing('sales', weekly(await account('Crash Second Inn (TEST)', yamTotal * 10)));
    expect(first < second).toBe(true);
    await admin().query(`CREATE FUNCTION whl.test_crash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.standing_order_id = '${second}' THEN RAISE EXCEPTION 'the worker died'; END IF; RETURN NEW; END $$`);
    await admin().query('CREATE TRIGGER trg_test_crash BEFORE INSERT ON whl.standing_order_run FOR EACH ROW EXECUTE FUNCTION whl.test_crash()');
    try {
      await expect(job()).rejects.toThrow(/the worker died/);
    } finally {
      await admin().query('DROP TRIGGER trg_test_crash ON whl.standing_order_run');
      await admin().query('DROP FUNCTION whl.test_crash()');
    }
    expect((await runRows(first)).map((r) => r.outcome)).toEqual(['CREATED']);
    expect(await ordersOf(first)).toHaveLength(1);
    expect(await runRows(second)).toEqual([]);
    expect(await ordersOf(second)).toEqual([]);
    await job();
    await job();
    expect((await runRows(first)).map((r) => r.outcome)).toEqual(['CREATED']);
    expect((await runRows(second)).map((r) => r.outcome)).toEqual(['CREATED']);
    expect(await ordersOf(first)).toHaveLength(1);
    expect(await ordersOf(second)).toHaveLength(1);
  });
});

describe('keeping a standing order (FR-WHL-004)', () => {
  it('refuses a schedule, customer or line it cannot keep, naming each rule', async () => {
    const customerId = await account('Rules Chop Bar (TEST)', 0);
    const refused = async (body: object) => {
      const answer = await post('sales', '/standing-orders', body);
      expect(answer.status, JSON.stringify(answer.body)).toBe(422);
      expect(answer.body.error.code).toBe('STANDING_ORDER_INVALID');
      return (answer.body.error.details as { field: string; code: string }[]).map((d) => `${d.field}:${d.code}`);
    };
    expect(await refused(weekly(customerId, { weekdays: [] }))).toEqual(['/weekdays:WEEKDAYS_REQUIRED']);
    expect(await refused(weekly(customerId, { startsOn: addDays(today(), -1) }))).toEqual(['/startsOn:STARTS_IN_PAST']);
    expect(await refused(weekly(customerId, { deliveryAddressId: randomUUID() }))).toEqual(['/deliveryAddressId:FULFILMENT_NOT_AVAILABLE']);
    expect(await refused(weekly(customerId, { lines: [{ productId: id('goat'), quantity: '1.000' }] }))).toEqual(['/lines/0/productId:PRODUCT_SERIAL']);
    expect(await refused(weekly(customerId, { lines: [] }))).toEqual(['/lines:NO_LINES']);
    expect(await refused(weekly(customerId, { lines: [{ productId: id('yam'), quantity: '1.000' }, { productId: id('yam'), quantity: '2.000' }] }))).toEqual(['/lines/1/productId:PRODUCT_REPEATED']);
    const noAccount = randomUUID();
    await app().query(
      "INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by) VALUES ($1, 'C-79999', 'BUSINESS', 'No Account Ltd (TEST)', '01900000-0000-7000-8000-000000000302', 'ACTIVE', $2, $2)",
      [noAccount, SYSTEM_PRINCIPAL],
    );
    expect(await refused(weekly(noAccount))).toEqual(['/customerId:NO_BUSINESS_ACCOUNT']);
  });

  it('replaces its lines and days at the version read, refusing a stale version; replays a create by its key', async () => {
    const customerId = await account('Update Lodge (TEST)', 0);
    const key = randomUUID();
    const once = await post('sales', '/standing-orders', weekly(customerId, { startsOn: addDays(today(), 1), weekdays: [1] }), key);
    const twice = await post('sales', '/standing-orders', weekly(customerId, { startsOn: addDays(today(), 1), weekdays: [1] }), key);
    expect([once.status, twice.status, twice.body.id]).toEqual([201, 201, once.body.id]);
    const changed = await patch('sales', `/standing-orders/${once.body.id as string}`, { version: once.body.version, weekdays: [3, 5], lines: [{ productId: id('yam'), quantity: '5.000' }] });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ weekdays: [3, 5], weekday: 3, version: once.body.version + 1, lines: [expect.objectContaining({ lineNo: 1, quantity: '5.000' })] });
    expect((await patch('sales', `/standing-orders/${once.body.id as string}`, { version: once.body.version, endsOn: addDays(today(), 30) })).status).toBe(409);
    const lines = await admin().query<{ n: string; live: string }>('SELECT count(*)::text AS n, count(*) FILTER (WHERE retired_at IS NULL)::text AS live FROM whl.standing_order_line WHERE standing_order_id = $1', [once.body.id]);
    expect(lines.rows[0]).toEqual({ n: '2', live: '1' });
  });

  it('refuses every write to the wrong role, and reads only at the reader’s branches', async () => {
    const customerId = await account('Roles Hostel (TEST)', 0);
    const standingId = await standing('owner', weekly(customerId, { startsOn: addDays(today(), 1), weekdays: [2] }));
    for (const who of ['accountant', 'cashier', 'storekeeper']) {
      expect((await post(who, '/standing-orders', weekly(customerId))).status, who).toBe(403);
      for (const action of ['pause', 'resume', 'end']) expect((await post(who, `/standing-orders/${standingId}/${action}`, { reason: 'x' })).status, `${who} ${action}`).toBe(403);
      expect((await patch(who, `/standing-orders/${standingId}`, { version: 1 })).status, who).toBe(403);
    }
    for (const who of ['cashier', 'storekeeper']) {
      expect((await get(who, '/standing-orders')).status).toBe(403);
      expect((await get(who, `/standing-orders/${standingId}`)).status).toBe(403);
    }
    expect((await get('customer', '/standing-orders')).status).toBe(401);
    expect((await get('accountant', `/standing-orders/${standingId}`)).status).toBe(200);
    // The Owner of another branch: nothing of Dodowa's, and its id opens nothing.
    expect((await get('temaOwner', '/standing-orders')).body.data).toEqual([]);
    expect((await get('temaOwner', `/standing-orders/${standingId}`)).status).toBe(404);
    expect((await get('temaOwner', `/standing-orders/${standingId}/runs`)).status).toBe(404);
    expect((await post('temaOwner', `/standing-orders/${standingId}/pause`, { reason: 'x' })).status).toBe(404);
  });

  it('holds the run in the database: a date once, insert-only', async () => {
    const customerId = await account('Ledger Lodge (TEST)', yamTotal * 10);
    const standingId = await standing('sales', weekly(customerId));
    await job();
    const [run] = await runRows(standingId);
    expect(await sqlStateOf(app().query("UPDATE whl.standing_order_run SET reason = 'x' WHERE standing_order_id = $1", [standingId]))).toBe('42501');
    expect(await sqlStateOf(admin().query("UPDATE whl.standing_order_run SET reason = 'x' WHERE standing_order_id = $1", [standingId]))).toBe('HK001');
    expect(await sqlStateOf(admin().query('DELETE FROM whl.standing_order_run WHERE standing_order_id = $1', [standingId]))).toBe('HK001');
    expect(
      await sqlStateOf(
        app().query("INSERT INTO whl.standing_order_run (standing_order_id, run_date, outcome, reason, recorded_at, actor_id) VALUES ($1, $2::date, 'FAILED', 'again', now(), $3)", [standingId, run!.run_date, SYSTEM_PRINCIPAL]),
      ),
    ).toBe('23505');
    expect(
      await sqlStateOf(app().query("INSERT INTO whl.standing_order_run (standing_order_id, run_date, outcome, recorded_at, actor_id) VALUES ($1, $2::date, 'CREATED', now(), $3)", [standingId, addDays(today(), 1), SYSTEM_PRINCIPAL])),
    ).toBe('23514');
  });
});
