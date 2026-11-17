import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainEvents } from '../../../src/platform/events/domain-events';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The counter sale (FR-POS-001 to FR-POS-006, B09b continued, A-274): taken on the cashier's own OPEN shift from an
 * enrolled device of the till, posted through ORD's one sale path in one transaction (stock, receipt, payment, journal
 * or nothing, proved by failure injection), change given from cash only, the per-shift override limit held, and a till
 * clock out of tolerance recorded, never refused. Every figure is derived by SQL over `pay.payment`, `inv.stock_movement`
 * and the journal lines.
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
let failAt: 'PAYMENT' | 'JOURNALS' | null = null;
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const step = (who: string) => stepUp(api.server, as(who) as TotpSession, clock);
const one = async <T>(sql: string, values: unknown[]): Promise<T> => (await admin().query(sql, values)).rows[0] as T;

/** A counter sale sent as a till sends it: its id is its idempotency key, with the device's credential. */
function sell(who: string, body: Record<string, unknown>, device: string | null = 'C1', key?: string) {
  const saleId = (body['id'] as string | undefined) ?? nextId();
  const request = consolePost(api.server, as(who), '/v1/pos/sales', key ?? saleId);
  if (device !== null) request.set('X-Device-Credential', credentials.get(device) ?? device);
  return request.send({ id: saleId, occurredAt: clock.now().toISOString(), ...body });
}
const yams = (n: number, agreed = 2_000, reason?: string) => ({ productId: id('yam'), quantity: `${n}.000`, agreedUnitPricePesewas: agreed, ...(reason === undefined ? {} : { varianceReasonCode: reason }) });
const cabbages = (n: number) => ({ productId: id('cabbage'), quantity: `${n}.000`, agreedUnitPricePesewas: 1_000 });
const cash = (amount: number, tendered?: number) => ({ paymentMethodId: id('CASH'), amountPesewas: amount, ...(tendered === undefined ? {} : { tenderedPesewas: tendered }) });

/** Debits less credits on an account against one till, or over the journals of one source document. */
async function balance(code: string, where: { register?: string; document?: string }): Promise<number> {
  const row = await one<{ n: string }>(
    `SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS n
       FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
       LEFT JOIN fin.subledger_party p ON p.id = l.subledger_party_id
      WHERE a.code = $1 AND ($2::uuid IS NULL OR (p.kind = 'REGISTER' AND p.ref_id = $2)) AND ($3::uuid IS NULL OR e.source_document_id = $3)`,
    [code, where.register ?? null, where.document ?? null],
  );
  return Number(row.n);
}

async function footprint(): Promise<Record<string, string>> {
  const counts: Record<string, string> = {};
  for (const table of ['ord.sales_order', 'pay.payment', 'inv.stock_movement', 'bil.billing_document', 'fin.journal_entry', 'platform.number_allocation', 'platform.business_document']) {
    counts[table] = (await one<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`, [])).n;
  }
  for (const s of (await admin().query<{ doc_type: string; next: string }>("SELECT doc_type, next_value::text AS next FROM platform.number_series WHERE doc_type IN ('SALES_ORDER', 'RECEIPT') ORDER BY doc_type, branch_id")).rows) {
    counts[`series:${s.doc_type}`] = s.next;
  }
  return counts;
}

async function enrol(till: string, label: string): Promise<string> {
  await step('manager');
  const enrolled = await post('manager', `/registers/${id(`till:${till}`)}/devices`, { deviceLabel: label });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  return enrolled.body.deviceCredential as string;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch' AS code, id FROM mdm.branch WHERE code = 'DDW'
       UNION ALL SELECT 'shop', l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = 'SHOP'
       UNION ALL SELECT 'yam', id FROM mdm.product WHERE sku = 'PRD-0005'
       UNION ALL SELECT 'cabbage', id FROM mdm.product WHERE sku = 'PRD-0002'
       UNION ALL SELECT code, id FROM mdm.payment_method`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  for (const [who, name, role, totp] of [
    ['manager', 'Kwabena Owusu', 'MANAGER', true],
    ['adwoa', 'Adwoa Darko', 'CASHIER', false],
    ['nana', 'Nana Yeboah', 'CASHIER', false],
    ['storekeeper', 'Kofi Mensah', 'STOREKEEPER', false],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
  ] as const) {
    const user = await createUser(database, { name, grants: [{ role, branchId: id('branch'), ...(role === 'CASHIER' || role === 'STOREKEEPER' ? { locationId: id('shop') } : {}) }] });
    users.set(who, user);
    sessions.set(who, totp ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  for (const code of ['C1', 'C2']) {
    const till = await post('manager', '/registers', { branchId: id('branch'), locationId: id('shop'), code, name: `Counter till ${code}` });
    expect(till.status, JSON.stringify(till.body)).toBe(201);
    ids.set(`till:${code}`, till.body.id as string);
  }
  credentials.set('C1', await enrol('C1', 'Counter tablet 1'));
  credentials.set('C2', await enrol('C2', 'Counter tablet 2'));
  credentials.set('lost', await enrol('C1', 'Lost tablet'));
  const lost = (await one<{ id: string }>("SELECT id FROM pos.device_enrolment WHERE device_label = 'Lost tablet'", [])).id;
  await step('manager');
  expect((await post('manager', `/devices/${lost}/revoke`, { reason: 'Left on the trotro' })).status).toBe(200);
  const shift = nextId();
  expect((await post('adwoa', '/shifts', { id: shift, registerId: id('till:C1'), openingFloatPesewas: 50_000, openedAt: clock.now().toISOString() }, shift)).status).toBe(201);
  ids.set('shift:adwoa', shift);

  const events = api.app.get(DomainEvents);
  events.subscribeInTransaction('pay.PaymentCleared', async () => {
    if (failAt === 'PAYMENT') throw new Error('injected failure after the payment');
  });
  events.subscribeInTransaction('ord.OrderCompleted', async () => {
    if (failAt === 'JOURNALS') throw new Error('injected failure after every journal');
  });
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('a counter sale on the cashier own open shift (FR-POS-001, FR-POS-005)', () => {
  let saleId: string;

  it('posts 3 yams and 2 cabbages for 8,000, cash 10,000 handed over, change 2,000: stock, receipt, payment and journal at once', async () => {
    saleId = nextId();
    const sold = await sell('adwoa', { id: saleId, shiftId: id('shift:adwoa'), lines: [yams(3), cabbages(2)], tenders: [cash(8_000, 10_000)] });
    expect(sold.status, JSON.stringify(sold.body)).toBe(201);
    expect(sold.body).toMatchObject({
      order: { id: saleId, channel: 'POS', status: 'COMPLETED', shiftId: id('shift:adwoa'), finalTotalPesewas: 8_000, paymentStatus: 'PAID' },
      receipt: { kind: 'RECEIPT', status: 'ISSUED', grossPesewas: 8_000 },
      changeDuePesewas: 2_000,
      currency: 'GHS',
      escPosBase64: null,
    });
    expect(sold.body.receipt.documentNo).toMatch(/^RCP-/);
    // Derived independently: the payment, the stock issued and the till's account.
    expect(await one('SELECT method_kind AS kind, amount_pesewas::int AS amount, shift_document_id AS shift, register_ref AS till FROM pay.payment WHERE order_document_id = $1', [saleId])).toEqual({
      kind: 'CASH',
      amount: 8_000,
      shift: id('shift:adwoa'),
      till: id('till:C1'),
    });
    const issued = await admin().query<{ product: string; qty: string }>("SELECT product_id AS product, sum(qty_base)::text AS qty FROM inv.stock_movement WHERE source_document_id = $1 GROUP BY product_id ORDER BY 1", [saleId]);
    expect(Object.fromEntries(issued.rows.map((r) => [r.product, Number(r.qty)]))).toEqual({ [id('yam')]: 3, [id('cabbage')]: 2 });
    expect(await balance('1000', { register: id('till:C1') })).toBe(50_000 + 8_000);
    const x = await get('adwoa', `/shifts/${id('shift:adwoa')}/x-report`);
    expect(x.body).toMatchObject({ salesCount: 1, grossSalesPesewas: 8_000, byMethod: [{ count: 1, amountPesewas: 8_000 }] });
  });

  it('answers a resubmission with the first sale and posts nothing twice', async () => {
    const before = await footprint();
    const again = await sell('adwoa', { id: saleId, shiftId: id('shift:adwoa'), lines: [yams(3), cabbages(2)], tenders: [cash(8_000, 10_000)] });
    expect(again.status).toBe(201);
    expect(again.body.order.id).toBe(saleId);
    expect(await footprint()).toEqual(before);
  });

  it('gives change from cash only, and refuses a short, an over or an unverified tender, recording nothing', async () => {
    const before = await footprint();
    const base = { shiftId: id('shift:adwoa'), lines: [yams(1)] };
    const refusals: [object[], number, string, string][] = [
      [[{ paymentMethodId: id('MOMO'), amountPesewas: 2_000, tenderedPesewas: 3_000 }], 422, 'COUNTER_SALE_INVALID', 'CHANGE_ONLY_FROM_CASH'],
      [[cash(2_000, 1_999)], 422, 'COUNTER_SALE_INVALID', 'TENDERED_BELOW_AMOUNT'],
      [[{ paymentMethodId: id('MOMO'), amountPesewas: 2_000 }], 422, 'PAYMENT_METHOD_REQUIRES_VERIFICATION', ''],
      [[{ paymentMethodId: id('MOMO'), amountPesewas: 2_000, paymentId: randomUUID() }], 422, 'COUNTER_SALE_INVALID', 'PROVIDER_PAYMENT_NOT_AVAILABLE'],
      [[cash(1_999)], 422, 'SALE_INVALID', 'TENDER_SHORT'],
      [[cash(2_001)], 422, 'SALE_INVALID', 'TENDER_OVER'],
    ];
    for (const [tenders, status, code, detail] of refusals) {
      const refused = await sell('adwoa', { ...base, tenders });
      expect([refused.status, refused.body.error?.code], JSON.stringify(refused.body)).toEqual([status, code]);
      if (detail !== '') expect(refused.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ code: detail })]));
    }
    expect(await footprint()).toEqual(before);
  });

  it('refuses a sale whose idempotency key is not its id', async () => {
    const refused = await sell('adwoa', { id: nextId(), shiftId: id('shift:adwoa'), lines: [yams(1)], tenders: [cash(2_000)] }, 'C1', nextId());
    expect([refused.status, refused.body.error.details[0].code]).toEqual([422, 'ID_DIFFERS_FROM_KEY']);
  });
});

describe('the device the sale comes from (ADR-0016)', () => {
  it('refuses no credential, an unknown one, a revoked device and another till device, recording nothing', async () => {
    const before = await footprint();
    const body = { shiftId: id('shift:adwoa'), lines: [yams(1)], tenders: [cash(2_000)] };
    expect([(await sell('adwoa', body, null)).status, (await sell('adwoa', body, null)).body.error.code]).toEqual([401, 'DEVICE_CREDENTIAL_INVALID']);
    expect((await sell('adwoa', body, 'hkdev_C1.not-a-credential')).body.error.code).toBe('DEVICE_CREDENTIAL_INVALID');
    const revoked = await sell('adwoa', body, 'lost');
    expect([revoked.status, revoked.body.error.code]).toEqual([403, 'DEVICE_REVOKED']);
    expect((await sell('adwoa', body, 'C2')).status).toBe(403);
    expect(await footprint()).toEqual(before);
  });
});

describe('only on the cashier own open shift', () => {
  it('refuses another cashier, a closed shift, and the roles that do not sell', async () => {
    const body = { shiftId: id('shift:adwoa'), lines: [yams(1)], tenders: [cash(2_000)] };
    const before = await footprint();
    expect((await sell('nana', body)).status).toBe(403);
    expect((await sell('storekeeper', body)).status).toBe(403);
    expect((await sell('accountant', body)).status).toBe(403);
    // Nana's own shift on C2, counted and so CLOSING: nothing more is sold on it.
    const shift = nextId();
    expect((await post('nana', '/shifts', { id: shift, registerId: id('till:C2'), openingFloatPesewas: 0, openedAt: clock.now().toISOString() }, shift)).status).toBe(201);
    expect((await post('nana', `/shifts/${shift}/close`, { declared: [{ paymentMethodId: id('CASH'), declaredPesewas: 0 }] })).status).toBe(200);
    const closingBefore = await footprint();
    const closing = await sell('nana', { ...body, shiftId: shift }, 'C2');
    expect([closing.status, closing.body.error.code]).toEqual([422, 'SHIFT_NOT_OPEN']);
    expect(await footprint()).toEqual(closingBefore);
    expect(Number(before['ord.sales_order'])).toBe(Number(closingBefore['ord.sales_order']));
  });
});

describe('one transaction or nothing (failure injection)', () => {
  for (const at of ['PAYMENT', 'JOURNALS'] as const) {
    it(`leaves nothing behind when it fails after ${at.toLowerCase()}, and the receipt number goes back to its series`, async () => {
      const before = await footprint();
      const till = await balance('1000', { register: id('till:C1') });
      failAt = at;
      try {
        const failed = await sell('adwoa', { shiftId: id('shift:adwoa'), lines: [yams(2)], tenders: [cash(4_000, 5_000)] });
        expect(failed.status).toBe(500);
      } finally {
        failAt = null;
      }
      expect(await footprint()).toEqual(before);
      expect(await balance('1000', { register: id('till:C1') })).toBe(till);
    });
  }
});

describe('the per-shift override limit (FR-POS-004, abuse case 3)', () => {
  beforeAll(async () => {
    // The owner sets the cashier's limits: 300 a line and 500 a shift (none is seeded, A-230).
    for (const [kind, amount] of [['PRICE_OVERRIDE_PER_LINE', 300], ['PRICE_OVERRIDE_PER_SHIFT', 500]] as const) {
      await admin().query(
        `INSERT INTO iam.role_limit (role_id, limit_kind, amount_pesewas, created_by, updated_by)
         SELECT id, $1, $2, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001' FROM iam.role WHERE code = 'CASHIER'`,
        [kind, amount],
      );
    }
  });

  it('takes 200 then 300 below list (the shift at its 500), posts each to 4210, and refuses one pesewa more until approved', async () => {
    const first = await sell('adwoa', { shiftId: id('shift:adwoa'), lines: [yams(1, 1_800, 'REGULAR_CUSTOMER')], tenders: [cash(1_800)] });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await sell('adwoa', { shiftId: id('shift:adwoa'), lines: [yams(1, 1_700, 'REGULAR_CUSTOMER')], tenders: [cash(1_700)] });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect((await balance('4210', { document: first.body.receipt.id })) + (await balance('4210', { document: second.body.receipt.id }))).toBe(500);
    const before = await footprint();
    const third = await sell('adwoa', { shiftId: id('shift:adwoa'), lines: [yams(1, 1_999, 'REGULAR_CUSTOMER')], tenders: [cash(1_999)] });
    expect([third.status, third.body.error.code], JSON.stringify(third.body)).toEqual([422, 'PRICE_OVERRIDE_NEEDS_APPROVAL']);
    expect(third.body.error.details).toEqual([expect.objectContaining({ field: '/lines/0/agreedUnitPricePesewas', code: 'BEYOND_SHIFT_LIMIT' })]);
    expect(await footprint()).toEqual(before);
    // At list price the shift's room is no matter.
    expect((await sell('adwoa', { shiftId: id('shift:adwoa'), lines: [yams(1)], tenders: [cash(2_000)] })).status).toBe(201);
  });

  it('refuses a line beyond the per-line limit whatever the shift has left', async () => {
    const refused = await sell('adwoa', { shiftId: id('shift:adwoa'), lines: [yams(2, 1_800, 'REGULAR_CUSTOMER')], tenders: [cash(3_600)] });
    expect([refused.status, refused.body.error.details[0].code]).toEqual([422, 'BEYOND_ROLE_LIMIT']);
  });
});

describe('a till clock out of tolerance (the owner on A-273 (g))', () => {
  it('records the sale at the server time, never refused, and sends the difference to the exception report source', async () => {
    const tillTime = new Date(clock.now().getTime() - 3_600_000).toISOString();
    const sold = await sell('adwoa', { shiftId: id('shift:adwoa'), lines: [yams(1)], tenders: [cash(2_000)], occurredAt: tillTime });
    expect(sold.status, JSON.stringify(sold.body)).toBe(201);
    expect(sold.body.order.placedAt).toBe(clock.now().toISOString());
    const event = await one<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pos.TillClockOutOfTolerance' AND subject_id = $1", [sold.body.order.id]);
    expect(event.payload).toMatchObject({ tillTime, serverTime: clock.now().toISOString(), differenceSeconds: -3_600, toleranceSeconds: 300, cashierId: users.get('adwoa')!.principalId, exceptionKind: 'TILL_CLOCK_OUT_OF_TOLERANCE' });
  });
});

describe('the shift reconciles to the pesewa after its counter sales', () => {
  it('signs off EXACT at float plus the cash the sales applied, by SQL, and the till returns to 0', async () => {
    const taken = await one<{ n: string }>("SELECT COALESCE(sum(amount_pesewas), 0)::text AS n FROM pay.payment WHERE shift_document_id = $1 AND method_kind = 'CASH' AND status = 'CLEARED'", [id('shift:adwoa')]);
    const expected = 50_000 + Number(taken.n);
    expect(Number(taken.n)).toBe(8_000 + 1_800 + 1_700 + 2_000 + 2_000);
    expect((await post('adwoa', `/shifts/${id('shift:adwoa')}/close`, { declared: [{ paymentMethodId: id('CASH'), declaredPesewas: expected }] })).status).toBe(200);
    await step('manager');
    const signed = await post('manager', `/shifts/${id('shift:adwoa')}/approve-close`, { reason: 'Counted together' });
    expect(signed.body).toMatchObject({ status: 'CLOSED', expectedCashPesewas: expected, overShortDirection: 'EXACT' });
    expect(await balance('1000', { register: id('till:C1') })).toBe(0);
  });
});
