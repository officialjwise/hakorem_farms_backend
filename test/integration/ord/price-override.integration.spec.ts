import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SalePosting, type SaleRequest } from '../../../src/modules/ord';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { journalOf, trialBalanceSum } from '../../support/pay';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { openTestShift } from '../../support/till';

/**
 * Price overrides and their approval by a different user (FR-ORD-003, ADR-0017, abuse case 3, A-230), on createOrder and
 * on the sale posting alike, and the proforma of an order (issueProforma, A-201). A price outside the band, or below
 * list beyond the seller's per-line limit, waits for a holder of `ord.price_override.approve` who is neither the person
 * who asked, the order's salesperson nor the poster: in IAM, in ORD and in the database. Nothing is reserved, issued or
 * paid on an override until it is approved. Every write refuses the wrong role and the wrong branch.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const sessions = new Map<string, TestSession>();
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const step = (who: string) => stepUp(api.server, as(who) as TotpSession, clock);
const decide = (who: string, approvalId: string, verb: 'approve' | 'reject') => post(who, `/iam/approvals/${approvalId}/${verb}`, { reason: 'Agreed with the buyer on the phone' });
const actorOf = (who: string): Actor => ({ principalId: id(`user:${who}`), kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });
let till = 0;
const nextTill = () => {
  till += 1;
  return { id: `019a8000-0000-7000-8000-0000000e${String(till).padStart(4, '0')}`, code: `P${till}` };
};

// Cabbage on the base list: floor 800, list 1,000, ceiling 1,200 a head.
const cabbage = (agreed: number | null, quantity = '2.000') => ({
  productId: id('cabbage'),
  quantity,
  ...(agreed === null ? {} : { agreedUnitPricePesewas: agreed, varianceReasonCode: 'REGULAR_CUSTOMER' }),
});
const order = (lines: object[], over: Record<string, unknown> = {}) => ({ channel: 'WHOLESALE', customerId: id('tema'), fulfilmentMode: 'COLLECTION', paymentTerms: 'COD', lines, ...over });
const create = (who: string, body: object, key: string = randomUUID()) => post(who, '/orders', body, key);
const confirm = (who: string, orderId: string) => post(who, `/orders/${orderId}/confirm`);
const lineOf = async (orderId: string) =>
  (
    await admin().query<{ id: string; variance: string; direction: string | null; requires: boolean; approval: string | null; approved_by: string | null }>(
      `SELECT id, variance_pesewas::text AS variance, variance_direction AS direction, variance_requires_approval AS requires, variance_approval_request_id AS approval,
              variance_approved_by AS approved_by FROM ord.sales_order_line WHERE sales_order_id = $1 ORDER BY line_no`,
      [orderId],
    )
  ).rows;
const statusOf = async (orderId: string) => (await admin().query<{ status: string }>('SELECT status FROM ord.sales_order WHERE id = $1', [orderId])).rows[0]?.status;
const reservedFor = async (orderId: string) => (await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM inv.stock_reservation WHERE holder_document_id = $1', [orderId])).rows[0]!.n;
const approvalOf = async (approvalId: string) =>
  (await admin().query<{ kind: string; status: string; amount: string; requested_by: string; decided_by: string | null }>(
    'SELECT kind, status, amount_pesewas::text AS amount, requested_by, decided_by FROM iam.approval_request WHERE id = $1',
    [approvalId],
  )).rows[0]!;
const setSalesLimit = async (pesewas: number | null) => {
  if (pesewas === null) {
    await admin().query(
      "UPDATE iam.role_limit SET deleted_at = now(), deleted_by = $1, delete_reason = 'test over', version = version + 1 WHERE limit_kind = 'PRICE_OVERRIDE_PER_LINE' AND role_id = (SELECT id FROM iam.role WHERE code = 'SALES') AND deleted_at IS NULL",
      [SYSTEM_PRINCIPAL],
    );
    return;
  }
  await admin().query(
    `INSERT INTO iam.role_limit (role_id, limit_kind, amount_pesewas, created_by, updated_by) SELECT id, 'PRICE_OVERRIDE_PER_LINE', $1, $2, $2 FROM iam.role WHERE code = 'SALES'
     ON CONFLICT (role_id, limit_kind) DO UPDATE SET amount_pesewas = EXCLUDED.amount_pesewas, deleted_at = NULL, deleted_by = NULL, delete_reason = NULL,
                                                   version = iam.role_limit.version + 1`,
    [pesewas, SYSTEM_PRINCIPAL],
  );
};

async function refusedBy(statements: readonly [string, unknown[]][]): Promise<string | undefined> {
  const client = await app().connect();
  try {
    await client.query('BEGIN');
    for (const [sql, values] of statements) await client.query(sql, values);
    await client.query('COMMIT');
    return undefined;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return `${(error as { code?: string }).code}:${(error as { constraint?: string }).constraint ?? ''}`;
  } finally {
    client.release();
  }
}

// The sale posting, as the selling command calls it (B9b's till, B11's dispatch): a wholesale goat at the counter.
// Wholesale GOAT-M: floor 36,000, list 58,500, ceiling 65,000.
const goatSale = (agreed: bigint, over: Partial<SaleRequest> = {}): SaleRequest => ({
  orderId: createUuidV7Generator(clock)(),
  channel: 'WHOLESALE',
  branchId,
  fulfilmentMode: 'COUNTER',
  taxInclusive: true,
  lines: [{ productId: id('goat'), stockUnitId: id('G-0142'), fromLocationId: id('PENS'), quantity: '1.000', agreedUnitPricePesewas: agreed, varianceReasonCode: 'REGULAR_CUSTOMER' }],
  tenders: [{ methodCode: 'CASH', amountPesewas: agreed, register: nextTill() }],
  ...over,
});
const inUnit = <T>(who: string, work: (sales: SalePosting, tx: Parameters<Parameters<UnitOfWork['run']>[1]>[0]) => Promise<T>) => {
  const uow = api.app.get(UnitOfWork);
  const sales = api.app.get(SalePosting);
  return runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'price override test', actor: actorOf(who) }, () =>
    uow.run({ isolation: 'serializable', seriesLocks: sales.locksFor(branchId) }, (tx) => work(sales, tx)),
  );
};
const postSale = (who: string, request: SaleRequest) => inUnit(who, async (sales, tx) => sales.postIn(tx, actorOf(who), { shiftDocumentId: await openTestShift(tx, actorOf(who).principalId, request.branchId), ...request }));
const askOverride = (who: string, request: SaleRequest) => inUnit(who, (sales, tx) => sales.requestOverrideIn(tx, actorOf(who), request));

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const code of ['SHOP', 'PENS']) ids.set(code, (await admin().query<{ id: string }>('SELECT id FROM mdm.location WHERE branch_id = $1 AND code = $2', [branchId, code])).rows[0]!.id);
  for (const [name, sku] of [['goat', 'LIV-0004'], ['cabbage', 'PRD-0002'], ['yam', 'PRD-0005']] as const) {
    ids.set(name, (await admin().query<{ id: string }>('SELECT id FROM mdm.product WHERE sku = $1', [sku])).rows[0]!.id);
  }
  ids.set('G-0142', (await admin().query<{ id: string }>("SELECT id FROM inv.stock_unit WHERE identifier = 'G-0142'")).rows[0]!.id);
  ids.set('tema', (await admin().query<{ id: string }>("SELECT id FROM mdm.customer WHERE name = 'Tema Cold Store Ltd (SEED)'")).rows[0]!.id);
  const other = await createBranch(database, 'KSI');
  const people: [string, string, RoleCode, string][] = [
    ['sales', 'Kojo Antwi', 'SALES', branchId],
    ['sales2', 'Efua Boateng', 'SALES', branchId],
    ['manager', 'Ama Owusu', 'MANAGER', branchId],
    ['owner', 'Kwame Mensah', 'OWNER', branchId],
    ['accountant', 'Akosua Frimpong', 'ACCOUNTANT', branchId],
    ['cashier', 'Adwoa Darko', 'CASHIER', branchId],
    ['storekeeper', 'Yaw Asante', 'STOREKEEPER', branchId],
    ['investor', 'Nana Ofori', 'INVESTOR', branchId],
    ['elsewhere', 'Kwesi Appiah', 'MANAGER', other.branchId],
  ];
  for (const [key, name, role, at] of people) {
    const user = await createUser(database, { name, grants: [{ role, branchId: at }] });
    ids.set(`user:${key}`, user.principalId);
    sessions.set(key, ['MANAGER', 'OWNER', 'ACCOUNTANT'].includes(role) ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('createOrder: a price below list or outside the band waits for a different user (FR-ORD-003, abuse case 3)', () => {
  it('enters the order PLACED with its line flagged and answers 202 under PRICE_OVERRIDE; nothing is reserved and it cannot be confirmed', async () => {
    const key = randomUUID();
    const placed = await create('sales', order([cabbage(950)]), key);
    expect(placed.status, JSON.stringify(placed.body)).toBe(202);
    expect(placed.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'PRICE_OVERRIDE', subject: { docType: 'SALES_ORDER', number: expect.stringMatching(/^SO-/) } });
    const orderId = placed.body.subject.id as string;
    // 2 heads at 950 against a list of 1,000: the line's whole variance is 100, below.
    expect(await lineOf(orderId)).toEqual([expect.objectContaining({ variance: '100', direction: 'BELOW', requires: true, approval: placed.body.approvalRequestId, approved_by: null })]);
    expect(await approvalOf(placed.body.approvalRequestId)).toMatchObject({ kind: 'PRICE_OVERRIDE', status: 'PENDING', amount: '100', requested_by: id('user:sales') });
    expect(await statusOf(orderId)).toBe('PLACED');
    const replay = await create('sales', order([cabbage(950)]), key);
    expect(replay.status).toBe(202);
    expect(replay.body.approvalRequestId).toBe(placed.body.approvalRequestId);

    const early = await confirm('sales', orderId);
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('PRICE_OVERRIDE_NEEDS_APPROVAL');
    expect(early.body.error.details).toEqual([expect.objectContaining({ field: '/lines/1/agreedUnitPricePesewas', code: 'APPROVAL_PENDING' })]);
    expect(await reservedFor(orderId)).toBe(0);
    expect((await get('sales', `/orders/${orderId}`)).body.lines[0]).toMatchObject({ agreedUnitPricePesewas: 950, variancePesewas: 100, varianceDirection: 'BELOW', varianceApprovalRequestId: placed.body.approvalRequestId });
  });

  it('asks for approval of a price outside the band whatever the limit, and names the 1,201 above the ceiling too', async () => {
    await setSalesLimit(1_000_000);
    try {
      for (const agreed of [799, 1_201]) {
        const placed = await create('sales', order([cabbage(agreed, '1.000')]));
        expect(placed.status, String(agreed)).toBe(202);
        expect(await lineOf(placed.body.subject.id)).toEqual([expect.objectContaining({ requires: true, direction: agreed < 1_000 ? 'BELOW' : 'ABOVE' })]);
      }
    } finally {
      await setSalesLimit(null);
    }
  });

  it('takes a price below list within the seller’s per-line limit with its reason alone, and asks at one pesewa a head beyond it', async () => {
    await setSalesLimit(100);
    try {
      const within = await create('sales', order([cabbage(950)]));
      expect(within.status, JSON.stringify(within.body)).toBe(201);
      expect(await lineOf(within.body.id)).toEqual([expect.objectContaining({ variance: '100', direction: 'BELOW', requires: false, approval: null })]);
      expect((await confirm('sales', within.body.id)).status).toBe(200);
      // 2 heads at 949: 102 off the line, 2 beyond the limit.
      const beyond = await create('sales', order([cabbage(949)]));
      expect(beyond.status).toBe(202);
      expect(await approvalOf(beyond.body.approvalRequestId)).toMatchObject({ amount: '102' });
      // A limit the role holds counts only for its holder: the Manager has none and asks too.
      const manager = await create('manager', order([cabbage(999, '1.000')]));
      expect(manager.status).toBe(202);
      // A limit counts only at the branch of the grant: Efua's Accountant role at the other branch, with a large limit,
      // gives her nothing here.
      await admin().query(
        `INSERT INTO iam.role_limit (role_id, limit_kind, amount_pesewas, created_by, updated_by) SELECT id, 'PRICE_OVERRIDE_PER_LINE', 1000000, $1, $1 FROM iam.role WHERE code = 'ACCOUNTANT'`,
        [SYSTEM_PRINCIPAL],
      );
      const elsewhere = await admin().query<{ branch_id: string }>("SELECT branch_id FROM iam.role_grant WHERE principal_id = $1", [id('user:elsewhere')]);
      await admin().query(
        "INSERT INTO iam.role_grant (id, principal_id, role_id, branch_id, created_by, updated_by) SELECT $1, $2, id, $3, $4, $4 FROM iam.role WHERE code = 'ACCOUNTANT'",
        [randomUUID(), id('user:sales2'), elsewhere.rows[0]!.branch_id, SYSTEM_PRINCIPAL],
      );
      const farAway = await create('sales2', order([cabbage(900)]));
      expect(farAway.status, JSON.stringify(farAway.body)).toBe(202);
    } finally {
      await setSalesLimit(null);
    }
    // Above list within the ceiling costs the farm nothing: its reason is enough, with no limit at all.
    const above = await create('sales', order([cabbage(1_100)]));
    expect(above.status).toBe(201);
  });

  it('refuses the decision to every role but the approvers, to the other branch, and to the person who asked', async () => {
    const placed = await create('manager', order([cabbage(900)]));
    expect(placed.status).toBe(202);
    for (const who of ['sales', 'sales2', 'cashier', 'storekeeper', 'accountant', 'investor', 'elsewhere']) {
      expect((await decide(who, placed.body.approvalRequestId, 'approve')).status, who).toBe(403);
    }
    await step('manager');
    const own = await decide('manager', placed.body.approvalRequestId, 'approve');
    expect(own.status).toBe(422);
    expect(own.body.error.code).toBe('MAKER_CANNOT_CHECK');
    expect(await approvalOf(placed.body.approvalRequestId)).toMatchObject({ status: 'PENDING' });
    expect(await lineOf(placed.body.subject.id)).toEqual([expect.objectContaining({ approved_by: null })]);
  });

  it('confirms once the Manager approves: the line names its approver, and the order then reserves its stock', async () => {
    const placed = await create('sales', order([cabbage(900)]));
    const orderId = placed.body.subject.id as string;
    await step('manager');
    const approved = await decide('manager', placed.body.approvalRequestId, 'approve');
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await lineOf(orderId)).toEqual([expect.objectContaining({ variance: '200', requires: true, approval: placed.body.approvalRequestId, approved_by: id('user:manager') })]);
    const confirmed = await confirm('sales', orderId);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.status).toBe('CONFIRMED');
    expect(await reservedFor(orderId)).toBe(1);
    const events = await admin().query<{ type: string; payload: Record<string, unknown> }>(
      "SELECT event_type AS type, payload FROM platform.outbox_message WHERE subject_id = $1 AND event_type LIKE 'ord.PriceOverride%' ORDER BY id",
      [orderId],
    );
    expect(events.rows.map((e) => e.type)).toEqual(['ord.PriceOverrideRequested', 'ord.PriceOverrideApproved']);
    expect(events.rows[1]!.payload).toMatchObject({ orderId, approvalRequestId: placed.body.approvalRequestId, requestedBy: id('user:sales'), approvedBy: id('user:manager'), variancePesewas: 200, abuseCases: [3] });
  });

  it('leaves a rejected override unconfirmable, and a cancelled order’s override can no longer be approved', async () => {
    const rejectedOrder = await create('sales', order([cabbage(900)]));
    await step('owner');
    expect((await decide('owner', rejectedOrder.body.approvalRequestId, 'reject')).status).toBe(200);
    const refused = await confirm('sales', rejectedOrder.body.subject.id);
    expect(refused.status).toBe(422);
    expect(refused.body.error.details).toEqual([expect.objectContaining({ code: 'APPROVAL_REJECTED' })]);
    expect(await statusOf(rejectedOrder.body.subject.id)).toBe('PLACED');

    const cancelled = await create('sales', order([cabbage(900)]));
    const cancel = await post('sales', `/orders/${cancelled.body.subject.id}/cancel`, { reasonCode: 'CUSTOMER_CANCELLED' });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(await approvalOf(cancelled.body.approvalRequestId)).toMatchObject({ status: 'CANCELLED' });
    const late = await decide('owner', cancelled.body.approvalRequestId, 'approve');
    expect(late.status).toBe(422);
    expect(late.body.error.code).toBe('APPROVAL_ALREADY_DECIDED');
  });

  it('refuses an approver who is the order’s salesperson, even when someone else asked (ORD and the database, each on its own)', async () => {
    const placed = await create('sales', order([cabbage(900)]));
    const orderId = placed.body.subject.id as string;
    // Credited to the Manager as salesperson, as B10's quotes and B9b's counter will make them, while Sales asked.
    await admin().query('UPDATE ord.sales_order SET salesperson_id = $2, version = version + 1 WHERE id = $1', [orderId, id('user:manager')]);
    await step('manager');
    const bySeller = await decide('manager', placed.body.approvalRequestId, 'approve');
    expect(bySeller.status).toBe(422);
    expect(bySeller.body.error.code).toBe('MAKER_CANNOT_CHECK');
    expect(await lineOf(orderId)).toEqual([expect.objectContaining({ approved_by: null })]);
    const line = (await lineOf(orderId))[0]!.id;
    // In SQL, without the application: the salesperson as approver, then the order's maker as approver, each refused.
    const approveAndConfirm = (approver: string): readonly [string, unknown[]][] => [
      ['UPDATE ord.sales_order_line SET variance_approved_by = $2, variance_approved_at = $3 WHERE id = $1', [line, approver, clock.now()]],
      ["UPDATE ord.sales_order SET status = 'CONFIRMED', credit_check = 'NOT_REQUIRED', version = version + 1 WHERE id = $1", [orderId]],
    ];
    expect(await refusedBy(approveAndConfirm(id('user:manager')))).toBe('HK010:ck_sales_order_settled_lines');
    expect(await refusedBy(approveAndConfirm(id('user:sales')))).toBe('HK010:ck_sales_order_settled_lines');
    // Nobody's approval at all: still refused once past PLACED.
    expect(await refusedBy([["UPDATE ord.sales_order SET status = 'CONFIRMED', credit_check = 'NOT_REQUIRED', version = version + 1 WHERE id = $1", [orderId]]])).toBe('HK010:ck_sales_order_settled_lines');
    // The Owner may: neither asked nor sold.
    await step('owner');
    expect((await decide('owner', placed.body.approvalRequestId, 'approve')).status).toBe(200);
    expect(await lineOf(orderId)).toEqual([expect.objectContaining({ approved_by: id('user:owner') })]);
  });

  it('holds the pricing record still once an approval is asked for, and an approver only on a line that asked', async () => {
    const placed = await create('sales', order([cabbage(900)]));
    const line = (await lineOf(placed.body.subject.id))[0]!.id;
    expect(await refusedBy([['UPDATE ord.sales_order_line SET agreed_unit_price_pesewas = 850, variance_pesewas = 300 WHERE id = $1', [line]]])).toBe('HK004:ck_sales_order_line_priced');
    expect(await refusedBy([['UPDATE ord.sales_order_line SET qty_ordered = 5 WHERE id = $1', [line]]])).toBe('HK004:ck_sales_order_line_priced');
    const plain = await create('sales', order([cabbage(1_100)]));
    const plainLine = (await lineOf(plain.body.id))[0]!.id;
    expect(await refusedBy([['UPDATE ord.sales_order_line SET variance_approved_by = $2, variance_approved_at = $3 WHERE id = $1', [plainLine, id('user:owner'), clock.now()]]])).toBe(
      '23514:ck_sales_order_line_approved',
    );
  });
});

describe('the sale posting: an override is approved before the sale posts, by someone who is not its seller', () => {
  it('refuses the sale while no approval exists, asks for one, and still posts nothing while it waits', async () => {
    const sale = goatSale(58_000n);
    await expect(postSale('cashier', sale)).rejects.toMatchObject({ code: 'PRICE_OVERRIDE_NEEDS_APPROVAL', details: [expect.objectContaining({ code: 'BEYOND_ROLE_LIMIT' })] });
    const pending = await askOverride('cashier', sale);
    expect(pending).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'PRICE_OVERRIDE', subject: { id: sale.orderId, docType: 'SALES_ORDER' } });
    expect(await approvalOf(pending.approvalRequestId)).toMatchObject({ status: 'PENDING', amount: '500', requested_by: id('user:cashier') });
    expect((await askOverride('cashier', sale)).approvalRequestId).toBe(pending.approvalRequestId);
    await expect(postSale('cashier', sale)).rejects.toMatchObject({ code: 'PRICE_OVERRIDE_NEEDS_APPROVAL', details: [expect.objectContaining({ code: 'APPROVAL_PENDING' })] });
    expect(await statusOf(sale.orderId)).toBeUndefined();
    for (const who of ['sales', 'cashier', 'accountant']) expect((await decide(who, pending.approvalRequestId, 'approve')).status, who).toBe(403);
  });

  it('posts the approved sale once, at 58,000 against a list of 58,500: the line names the Manager, and 4210 carries the 500', async () => {
    const sale = goatSale(58_000n);
    const pending = await askOverride('cashier', sale);
    await step('manager');
    expect((await decide('manager', pending.approvalRequestId, 'approve')).status).toBe(200);
    // Another seller cannot post it, and a different price cannot ride on it.
    await expect(postSale('sales', sale)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(postSale('cashier', { ...sale, lines: [{ ...sale.lines[0]!, agreedUnitPricePesewas: 57_000n }], tenders: [{ ...sale.tenders[0]!, amountPesewas: 57_000n }] })).rejects.toMatchObject({
      code: 'PRICE_OVERRIDE_NEEDS_APPROVAL',
      details: [expect.objectContaining({ code: 'APPROVAL_DIFFERS' })],
    });
    const posted = await postSale('cashier', sale);
    expect(posted.status).toBe('COMPLETED');
    expect(posted.lines.map((l) => [l.resolvedUnitPricePesewas, l.agreedUnitPricePesewas, l.variancePesewas, l.varianceDirection])).toEqual([[58_500, 58_000, 500, 'BELOW']]);
    expect(await lineOf(sale.orderId)).toEqual([expect.objectContaining({ requires: true, approval: pending.approvalRequestId, approved_by: id('user:manager') })]);
    const journal = await journalOf(database, posted.billingDocument!.id);
    expect(journal.map(([code, side, amount]) => `${code}:${side}:${amount}`).sort()).toEqual(['1200:D:58000', '4000:C:58500', '4210:D:500']);
    // A replay answers the first sale.
    expect((await postSale('cashier', sale)).id).toBe(posted.id);
    expect(await trialBalanceSum(database)).toBe('0');
  });

  it('refuses an approval asked for by one cashier and spent by another, and a second ask while one waits for a different sale', async () => {
    const yams = (agreed: bigint): SaleRequest => ({
      ...goatSale(agreed),
      lines: [{ productId: id('yam'), fromLocationId: id('SHOP'), quantity: '1.000', agreedUnitPricePesewas: agreed, varianceReasonCode: 'REGULAR_CUSTOMER' }],
    });
    const sale = yams(1_900n);
    const pending = await askOverride('sales', sale);
    await expect(askOverride('sales', { ...sale, lines: [{ ...sale.lines[0]!, agreedUnitPricePesewas: 1_800n }] })).rejects.toMatchObject({ code: 'SALE_INVALID', details: [expect.objectContaining({ code: 'OVERRIDE_PENDING' })] });
    await expect(askOverride('cashier', sale)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await step('owner');
    expect((await decide('owner', pending.approvalRequestId, 'approve')).status).toBe(200);
    await expect(postSale('cashier', sale)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(askOverride('sales', yams(2_000n))).rejects.toMatchObject({ code: 'SALE_INVALID', details: [expect.objectContaining({ code: 'NO_OVERRIDE_TO_APPROVE' })] });
    expect((await postSale('sales', sale)).status).toBe('COMPLETED');
    expect(await trialBalanceSum(database)).toBe('0');
  });
});

describe('issueProforma (A-201): a numbered proforma of the order’s own prices, which posts nothing', () => {
  it('refuses every role without bil.proforma.create, the other branch, and an order that does not exist', async () => {
    const placed = await create('sales', order([cabbage(null)]));
    for (const who of ['cashier', 'storekeeper', 'investor', 'accountant', 'elsewhere']) {
      expect((await post(who, `/orders/${placed.body.id}/proforma`)).status, who).toBe(403);
    }
    expect((await post('sales', `/orders/${randomUUID()}/proforma`)).status).toBe(404);
  });

  it('issues a PRO of 2,000 for 2 heads at list, posts no journal, answers a replay with the same proforma and refuses a second', async () => {
    const placed = await create('sales', order([cabbage(null)]));
    const before = (await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM fin.journal_entry')).rows[0]!.n;
    const key = randomUUID();
    const issued = await post('sales', `/orders/${placed.body.id}/proforma`, {}, key);
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    expect(issued.body).toMatchObject({ kind: 'PROFORMA', status: 'ISSUED', documentNo: expect.stringMatching(/^PRO-/), grossPesewas: 2_000, order: { id: placed.body.id, docType: 'SALES_ORDER' }, customer: { id: id('tema') } });
    expect(issued.body.lines).toEqual([expect.objectContaining({ quantity: '2.000', unitPricePesewas: 1_000, resolvedUnitPricePesewas: 1_000 })]);
    expect((await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM fin.journal_entry')).rows[0]!.n).toBe(before);
    expect((await post('sales', `/orders/${placed.body.id}/proforma`, {}, key)).body.id).toBe(issued.body.id);
    const second = await post('manager', `/orders/${placed.body.id}/proforma`);
    expect(second.status).toBe(422);
    expect(second.body.error.details).toEqual([expect.objectContaining({ code: 'PROFORMA_ISSUED' })]);
    // The proforma stays on the order once it is confirmed.
    expect((await confirm('sales', placed.body.id)).status).toBe(200);
  });

  it('prints an approved override at its agreed price, and refuses a proforma while the override waits or after the order is cancelled', async () => {
    const waiting = await create('sales', order([cabbage(900)]));
    const early = await post('sales', `/orders/${waiting.body.subject.id}/proforma`);
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('PRICE_OVERRIDE_NEEDS_APPROVAL');
    await step('manager');
    expect((await decide('manager', waiting.body.approvalRequestId, 'approve')).status).toBe(200);
    const issued = await post('sales', `/orders/${waiting.body.subject.id}/proforma`);
    expect(issued.status).toBe(201);
    expect(issued.body.grossPesewas).toBe(1_800);
    expect(issued.body.lines).toEqual([expect.objectContaining({ unitPricePesewas: 900, resolvedUnitPricePesewas: 1_000 })]);

    const gone = await create('sales', order([cabbage(null)]));
    expect((await post('sales', `/orders/${gone.body.id}/cancel`, { reasonCode: 'CUSTOMER_CANCELLED' })).status).toBe(200);
    const late = await post('sales', `/orders/${gone.body.id}/proforma`);
    expect(late.status).toBe(422);
    expect(late.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await trialBalanceSum(database)).toBe('0');
  });
});
