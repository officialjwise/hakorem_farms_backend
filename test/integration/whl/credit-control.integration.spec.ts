import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountHolds } from '../../../src/modules/whl';
import { runAsSystem, type Actor } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { addDays } from '../../../src/seed/seed-calendar';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePatch, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { issueInvoice } from '../../support/pay';
import { sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Credit control (FR-WHL-001, FR-WHL-006 to FR-WHL-008, CR-046, CR-048, A-212 (d), abuse case 14), the gate of B10
 * continued as split: a credit limit blocks with an audited override by a different person, exact to the pesewa at the
 * limit, one pesewa over and past the terms by one day; exposure ties to SQL sums taken straight from BIL's, PAY's and
 * ORD's own tables, never from the code under test; an account past its overdue threshold is held and released only by
 * an Owner or Manager who did not ask; every write refuses the wrong role, and the database refuses the second person
 * skipped.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
let orderTotal: number;
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
const actorOf = (who: string): Actor => ({ principalId: users.get(who)!.principalId, kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });
const today = () => toBusinessDate(clock.now());
const DAY = 86_400_000;
const CONFIRMED_UNINVOICED = ['CONFIRMED', 'PICKING', 'AWAITING_CUSTOMER', 'PACKED', 'READY_FOR_COLLECTION', 'DISPATCHED', 'DELIVERED', 'DELIVERY_FAILED'];
let customers = 0;
const SEED_PASSWORD = `Seed-${randomUUID()}`;

async function approve(who: string, approvalRequestId: string, reason = 'Checked') {
  await stepUp(api.server, as(who) as TotpSession, clock);
  return post(who, `/iam/approvals/${approvalRequestId}/approve`, { reason });
}

/** A business customer with an open account at Dodowa, its limit asked by the Owner and approved by the Manager. */
async function account(name: string, limit: number, terms = 30): Promise<string> {
  const customerId = randomUUID();
  await app().query(
    "INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by) VALUES ($1, $2, 'BUSINESS', $3, '01900000-0000-7000-8000-000000000302', 'ACTIVE', $4, $4)",
    [customerId, `C-9${String((customers += 1)).padStart(4, '0')}`, name, SYSTEM_PRINCIPAL],
  );
  const opened = await post('owner', '/business-accounts', { customerId, branchId, creditLimitPesewas: limit, paymentTermsDays: terms, reason: 'Opening terms (TEST)' });
  if (limit === 0) {
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    return customerId;
  }
  expect(opened.status, JSON.stringify(opened.body)).toBe(202);
  expect((await approve('manager', opened.body.approvalRequestId as string)).status).toBe(200);
  return customerId;
}

const invoice = (customerId: string, gross: number, dueDate = addDays(today(), 30)) => issueInvoice(api, actorOf('accountant'), clock, { branchId, customerId, productId: id('goat') }, BigInt(gross), dueDate);
const creditOrder = async (customerId: string, who = 'sales', terms = 'CREDIT') => {
  const made = await post(who, '/orders', { channel: 'WHOLESALE', customerId, fulfilmentMode: 'COLLECTION', paymentTerms: terms, lines: [{ productId: id('yam'), quantity: '2.000' }] });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.id as string;
};
const confirm = (who: string, orderId: string, body?: object) => consolePost(api.server, as(who), `/v1/orders/${orderId}/confirm`, randomUUID()).send(body);

/** Exposure straight from the owning tables: BIL's issued documents less PAY's net allocations, plus ORD's confirmed credit orders not invoiced. */
async function exposureTruth(customerId: string): Promise<number> {
  const { rows } = await admin().query<{ n: string }>(
    `SELECT ((SELECT COALESCE(sum(d.gross_pesewas), 0) FROM bil.billing_document d
               WHERE d.customer_id = $1 AND d.status = 'ISSUED' AND d.kind IN ('INVOICE', 'RECEIPT', 'DEBIT_NOTE'))
           - (SELECT COALESCE(sum(CASE a.direction WHEN 'APPLY' THEN a.amount_pesewas ELSE -a.amount_pesewas END), 0)
                FROM pay.payment_allocation a JOIN bil.billing_document d ON d.id = a.billing_document_id WHERE d.customer_id = $1)
           + (SELECT COALESCE(sum(o.estimated_total_pesewas), 0) FROM ord.sales_order o
               WHERE o.customer_id = $1 AND o.payment_terms = 'CREDIT' AND o.billing_document_id IS NULL AND o.status = ANY($2::text[])))::text AS n`,
    [customerId, CONFIRMED_UNINVOICED],
  );
  return Number(rows[0]!.n);
}
const orderStatus = async (orderId: string) => (await admin().query<{ status: string; credit_check: string | null }>('SELECT status, credit_check FROM ord.sales_order WHERE id = $1', [orderId])).rows[0]!;
const reserved = async (orderId: string) => Number((await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM inv.stock_reservation WHERE holder_document_id = $1 AND status = 'ACTIVE'", [orderId])).rows[0]!.n);

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  // The last describe moves the clock on by weeks: the sessions live long enough (test settings only).
  const long = String(90 * 86_400);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: long, AUTH_STAFF_REFRESH_IDLE_SECONDS: long, AUTH_STAFF_REFRESH_ABSOLUTE_SECONDS: long } });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: SEED_PASSWORD }));
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const [name, sku] of [['goat', 'LIV-0004'], ['yam', 'PRD-0005']] as const) ids.set(name, (await admin().query<{ id: string }>('SELECT id FROM mdm.product WHERE sku = $1', [sku])).rows[0]!.id);
  for (const [name, sql, value] of [
    ['gcb', 'SELECT id FROM fin.bank_account WHERE name = $1', 'GCB current account (SEED)'],
    ['CHEQUE', 'SELECT id FROM mdm.payment_method WHERE code = $1', 'CHEQUE'],
  ] as const) ids.set(name, (await admin().query<{ id: string }>(sql, [value])).rows[0]!.id);
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
  const shopper = await createUser(database, { name: 'Abena Kyei', realm: 'CUSTOMER' });
  sessions.set('customer', await login(api.server, shopper));
  // Cheques stay off in the seeded farm until the owner decides (A-115): the Owner turns them on for A-212 (d).
  const { rows } = await admin().query<{ version: number }>("SELECT version FROM mdm.payment_method WHERE code = 'CHEQUE'");
  expect((await patch('owner', `/payment-methods/${id('CHEQUE')}`, { version: rows[0]!.version, isEnabled: true })).status).toBe(200);
  // One order of two yams on credit, priced by the engine: every limit below is set around its exact total.
  const probe = await account('Probe Traders (TEST)', 0);
  const placed = await creditOrder(probe);
  orderTotal = Number((await admin().query<{ t: string }>('SELECT estimated_total_pesewas::text AS t FROM ord.sales_order WHERE id = $1', [placed])).rows[0]!.t);
  expect(orderTotal).toBeGreaterThan(0);
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('a business account (FR-WHL-001, CR-048)', () => {
  it('opens with a nil limit, the limit asked waiting for an Owner or Manager who did not ask; a second account is 409', async () => {
    const customerId = randomUUID();
    await app().query(
      "INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by) VALUES ($1, 'C-98001', 'BUSINESS', 'Caterers of Adenta (TEST)', '01900000-0000-7000-8000-000000000302', 'ACTIVE', $2, $2)",
      [customerId, SYSTEM_PRINCIPAL],
    );
    const opened = await post('owner', '/business-accounts', { customerId, branchId, creditLimitPesewas: 500_000, paymentTermsDays: 30, reason: 'Funeral catering account' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(202);
    expect(opened.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'CREDIT_LIMIT_CHANGE', subject: { docType: 'ACCOUNT_CHANGE' } });
    const waiting = await get('accountant', `/business-accounts/${customerId}`);
    expect(waiting.body).toMatchObject({ creditLimitPesewas: 0, pendingCreditLimitPesewas: 500_000, availableCreditPesewas: 0, exposurePesewas: 0, status: 'ACTIVE' });
    const own = await approve('owner', opened.body.approvalRequestId as string);
    expect([own.status, own.body.error.code]).toEqual([422, 'MAKER_CANNOT_CHECK']);
    expect((await post('accountant', `/iam/approvals/${opened.body.approvalRequestId as string}/approve`, { reason: 'Not mine' })).status).toBe(403);
    expect((await approve('manager', opened.body.approvalRequestId as string)).status).toBe(200);
    const read = await get('sales', `/business-accounts/${customerId}`);
    expect(read.body).toMatchObject({ creditLimitPesewas: 500_000, availableCreditPesewas: 500_000, exposurePesewas: 0, paymentTermsDays: 30, overdueHoldDays: 30, pendingCreditLimitPesewas: null, branch: { code: 'DDW' } });
    const change = (await admin().query<{ status: string; created_by: string; posted_by: string }>('SELECT status, created_by, posted_by FROM whl.account_change WHERE customer_id = $1', [customerId])).rows;
    expect(change).toEqual([{ status: 'APPLIED', created_by: users.get('owner')!.principalId, posted_by: users.get('manager')!.principalId }]);
    const listed = await post('manager', '/business-accounts', { customerId: randomUUID(), branchId, creditLimitPesewas: 0, paymentTermsDays: 30, priceListId: randomUUID() });
    expect([listed.status, listed.body.error.details[0].code]).toEqual([422, 'PRICE_LIST_THROUGH_MDM']);
    const twice = await post('manager', '/business-accounts', { customerId, branchId, creditLimitPesewas: 0, paymentTermsDays: 30 });
    expect([twice.status, twice.body.error.code]).toEqual([409, 'ACCOUNT_EXISTS']);
    ids.set('adenta', customerId);
  });

  it('changes the terms at once and every credit limit, down as well as up, only through a second person', async () => {
    const current = (await get('owner', `/business-accounts/${id('adenta')}`)).body;
    const changed = await patch('manager', `/business-accounts/${id('adenta')}`, { version: current.version, paymentTermsDays: 14, creditLimitPesewas: 400_000, reason: 'Late payer in October' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(202);
    expect(changed.body.kind).toBe('CREDIT_LIMIT_CHANGE');
    const after = (await get('owner', `/business-accounts/${id('adenta')}`)).body;
    expect([after.paymentTermsDays, after.creditLimitPesewas, after.pendingCreditLimitPesewas]).toEqual([14, 500_000, 400_000]);
    const own = await approve('manager', changed.body.approvalRequestId as string);
    expect(own.body.error.code).toBe('MAKER_CANNOT_CHECK');
    expect((await approve('owner', changed.body.approvalRequestId as string)).status).toBe(200);
    expect((await get('owner', `/business-accounts/${id('adenta')}`)).body).toMatchObject({ creditLimitPesewas: 400_000, availableCreditPesewas: 400_000, pendingCreditLimitPesewas: null });
    const stale = await patch('manager', `/business-accounts/${id('adenta')}`, { version: current.version, paymentTermsDays: 7 });
    expect(stale.status).toBe(409);
  });
});

describe('the credit limit at confirmation (FR-WHL-006, CR-046: exact pesewas)', () => {
  it('confirms an order that takes exposure exactly to the limit, the exposure equal to the SQL sum', async () => {
    const customerId = await account('Exactly At The Limit Ltd (TEST)', 500_000);
    await invoice(customerId, 500_000 - orderTotal);
    const orderId = await creditOrder(customerId);
    const check = await get('sales', `/orders/${orderId}/credit-check`);
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(check.body).toMatchObject({ outcome: 'PASSES', reasons: [], creditLimitPesewas: 500_000, exposurePesewas: 500_000 - orderTotal, orderPesewas: orderTotal, overLimitPesewas: 0, overduePesewas: 0, oldestOverdueDays: null, override: null });
    expect(check.body.exposurePesewas).toBe(await exposureTruth(customerId));
    const confirmed = await confirm('sales', orderId);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.creditCheck).toBe('PASSED');
    // Now the confirmed order is exposure too: the account is exactly at its limit, nothing available.
    const read = (await get('accountant', `/business-accounts/${customerId}`)).body;
    expect([read.exposurePesewas, read.availableCreditPesewas]).toEqual([500_000, 0]);
    expect(read.exposurePesewas).toBe(await exposureTruth(customerId));
  });

  it('refuses an order one pesewa over the limit, naming GHS 0.01, holding nothing and leaving it PLACED', async () => {
    const customerId = await account('One Pesewa Over Ltd (TEST)', 500_000);
    await invoice(customerId, 500_000 - orderTotal + 1);
    const orderId = await creditOrder(customerId);
    ids.set('overOrder', orderId);
    ids.set('overCustomer', customerId);
    const refused = await confirm('sales', orderId);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('CREDIT_LIMIT_EXCEEDED');
    expect(refused.body.error.details.map((d: { code: string }) => d.code)).toEqual(['OVER_LIMIT', 'OVERRIDE_REASON_REQUIRED']);
    expect(refused.body.error.details[0].message).toBe('This order would take One Pesewa Over Ltd (TEST) GHS 0.01 over its GHS 5,000.00 credit limit.');
    expect(await orderStatus(orderId)).toEqual({ status: 'PLACED', credit_check: null });
    expect(await reserved(orderId)).toBe(0);
    const check = (await get('sales', `/orders/${orderId}/credit-check`)).body;
    expect([check.outcome, check.overLimitPesewas, check.exposurePesewas]).toEqual(['OVER_LIMIT', 1, await exposureTruth(customerId)]);
  });

  it('asks an override with a written reason in place of the refusal, approved only by an Owner or Manager who did not ask, then confirms OVERRIDDEN', async () => {
    const orderId = id('overOrder');
    const blank = await confirm('sales', orderId, { creditOverrideReason: '   ' });
    expect(blank.status).toBe(400);
    const asked = await confirm('sales', orderId, { creditOverrideReason: 'Funeral order, paid Friday' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'CREDIT_OVERRIDE', subject: { id: orderId, docType: 'SALES_ORDER' }, creditCheck: { outcome: 'OVER_LIMIT', reasons: ['OVER_LIMIT'], overLimitPesewas: 1, creditLimitPesewas: 500_000 } });
    expect(await orderStatus(orderId)).toEqual({ status: 'PLACED', credit_check: null });
    const waiting = await confirm('sales', orderId);
    expect(waiting.body.error.details.map((d: { code: string }) => d.code)).toEqual(['OVER_LIMIT', 'APPROVAL_PENDING']);
    const again = await post('sales', `/orders/${orderId}/credit-override`, { reason: 'Again' });
    expect([again.status, again.body.error.details[0].code]).toEqual([422, 'APPROVAL_PENDING']);
    const approvalId = asked.body.approvalRequestId as string;
    expect((await post('sales', `/iam/approvals/${approvalId}/approve`, { reason: 'Mine' })).status).toBe(403);
    expect((await post('accountant', `/iam/approvals/${approvalId}/approve`, { reason: 'Not mine' })).status).toBe(403);
    const check = (await get('manager', `/orders/${orderId}/credit-check`)).body;
    expect(check.override).toMatchObject({ approvalRequestId: approvalId, status: 'PENDING_APPROVAL', reason: 'Funeral order, paid Friday', requestedBy: { displayName: 'Esi Appiah' }, decidedBy: null });
    expect((await approve('manager', approvalId, 'Known customer, paid Friday before')).status).toBe(200);
    const confirmed = await confirm('sales', orderId);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.creditCheck).toBe('OVERRIDDEN');
    expect(await orderStatus(orderId)).toEqual({ status: 'CONFIRMED', credit_check: 'OVERRIDDEN' });
    const listed = await get('accountant', `/credit-overrides?customerId=${id('overCustomer')}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0]).toMatchObject({
      order: { id: orderId },
      limitPesewas: 500_000,
      exposurePesewas: 500_001,
      orderPesewas: orderTotal,
      overLimitPesewas: 1,
      reasons: ['OVER_LIMIT'],
      reason: 'Funeral order, paid Friday',
      requestedBy: { id: users.get('sales')!.principalId },
      approvedBy: { id: users.get('manager')!.principalId },
    });
    const audit = await admin().query<{ action: string }>("SELECT action FROM platform.audit_event WHERE entity_id = $1 AND module = 'whl' ORDER BY occurred_at, id", [orderId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['CREDIT_OVERRIDE_REQUESTED', 'CREDIT_OVERRIDE_APPROVED']);
    const event = await admin().query<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'whl.CreditOverrideApproved' AND subject_id = $1", [orderId]);
    expect(event.rows).toHaveLength(1);
    // For the daily exception report (B12): abuse case 14, with who asked, who approved and the two figures.
    expect(event.rows[0]!.payload).toMatchObject({ abuseCases: [14], exceptionKind: 'CREDIT_OVERRIDE', limitPesewas: 500_000, exposurePesewas: 500_001, overLimitPesewas: 1, requestedBy: users.get('sales')!.principalId, approvedBy: users.get('manager')!.principalId });
  });

  it('covers only what was approved: once the customer is one pesewa further over, the order needs a new override', async () => {
    const customerId = await account('Covered Once Ltd (TEST)', 200_000);
    await invoice(customerId, 200_000 - orderTotal + 1);
    const orderId = await creditOrder(customerId);
    const asked = await post('sales', `/orders/${orderId}/credit-override`, { reason: 'School feeding contract, paid monthly' });
    expect([asked.status, asked.body.creditCheck.overLimitPesewas]).toEqual([202, 1]);
    expect((await approve('owner', asked.body.approvalRequestId as string)).status).toBe(200);
    await invoice(customerId, 1);
    const refused = await confirm('sales', orderId);
    expect([refused.status, refused.body.error.code, refused.body.error.details[1].code]).toEqual([422, 'CREDIT_LIMIT_EXCEEDED', 'OVERRIDE_REASON_REQUIRED']);
    expect(refused.body.error.details[0].message).toContain('GHS 0.02 over');
    expect(await orderStatus(orderId)).toEqual({ status: 'PLACED', credit_check: null });
    const again = await confirm('sales', orderId, { creditOverrideReason: 'Second invoice agreed with the head teacher' });
    expect([again.status, again.body.creditCheck.overLimitPesewas]).toEqual([202, 2]);
  });

  it('refuses the Owner approving the override the Owner asked for', async () => {
    const customerId = await account('Owner Asks Ltd (TEST)', 100);
    const orderId = await creditOrder(customerId, 'owner');
    const asked = await post('owner', `/orders/${orderId}/credit-override`, { reason: 'Owner vouches for them' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body.creditCheck.overLimitPesewas).toBe(orderTotal - 100);
    const own = await approve('owner', asked.body.approvalRequestId as string);
    expect([own.status, own.body.error.code]).toEqual([422, 'MAKER_CANNOT_CHECK']);
    expect(await orderStatus(orderId)).toEqual({ status: 'PLACED', credit_check: null });
    const notNeeded = await post('sales', `/orders/${id('overOrder')}/credit-override`, { reason: 'Already confirmed' });
    expect([notNeeded.status, notNeeded.body.error.details[0].code]).toEqual([422, 'ORDER_NOT_PLACED']);
  });

  it('counts a bounced cheque against the customer (A-212 (d)): the item it paid is open again and the order goes over', async () => {
    const customerId = await account('Bounced Cheque Traders (TEST)', 300_000);
    const owed = await invoice(customerId, 300_000 - orderTotal + 1);
    const cheque = { id: randomUUID(), paymentMethodId: id('CHEQUE'), amountPesewas: 300_000 - orderTotal + 1, customerId, bankAccountId: id('gcb'), externalReference: 'CHQ-004417', receivedAt: clock.now().toISOString(), allocations: [{ billingDocumentId: owed.id, amountPesewas: 300_000 - orderTotal + 1 }] };
    expect((await post('accountant', '/payments', cheque)).status).toBe(201);
    const orderId = await creditOrder(customerId);
    const before = (await get('sales', `/orders/${orderId}/credit-check`)).body;
    expect([before.outcome, before.exposurePesewas]).toEqual(['PASSES', 0]);
    expect(before.exposurePesewas).toBe(await exposureTruth(customerId));
    const reverse = await post('manager', `/payments/${cheque.id}/reverse`, { reasonCode: 'CHEQUE_DISHONOURED', note: 'Returned by the bank: insufficient funds' });
    expect(reverse.status, JSON.stringify(reverse.body)).toBe(202);
    expect((await approve('owner', reverse.body.approvalRequestId as string)).status).toBe(200);
    const after = (await get('sales', `/orders/${orderId}/credit-check`)).body;
    expect([after.outcome, after.exposurePesewas, after.overLimitPesewas]).toEqual(['OVER_LIMIT', 300_000 - orderTotal + 1, 1]);
    expect(after.exposurePesewas).toBe(await exposureTruth(customerId));
    expect((await confirm('sales', orderId)).body.error.code).toBe('CREDIT_LIMIT_EXCEEDED');
  });
});

describe('a hold, put on by the Accountant and released only by a second Owner or Manager (FR-WHL-008, CR-048)', () => {
  it('holds an account, refuses its credit orders and confirms its cash-on-delivery order; the release waits for an Owner or Manager who did not ask', async () => {
    const customerId = await account('Held By The Accountant Ltd (TEST)', 900_000);
    const held = await post('accountant', `/business-accounts/${customerId}/hold`, { reason: 'Two cheques returned this month' });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    expect(held.body).toMatchObject({ status: 'ON_HOLD', holdReason: 'Two cheques returned this month' });
    expect((await post('accountant', `/business-accounts/${customerId}/hold`, { reason: 'Again' })).body.error.details[0].code).toBe('ALREADY_ON_HOLD');
    const credit = await creditOrder(customerId);
    const refused = await confirm('sales', credit);
    expect([refused.status, refused.body.error.code, refused.body.error.details[0].code]).toEqual([422, 'ACCOUNT_ON_HOLD', 'ON_HOLD']);
    const cod = await creditOrder(customerId, 'sales', 'COD');
    expect((await confirm('sales', cod)).status).toBe(200);
    expect((await post('accountant', `/business-accounts/${customerId}/release`, { reason: 'Paid' })).status).toBe(403);
    expect((await post('sales', `/business-accounts/${customerId}/release`, { reason: 'Paid' })).status).toBe(403);
    const asked = await post('manager', `/business-accounts/${customerId}/release`, { reason: 'Both cheques replaced by bank transfer' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ kind: 'ACCOUNT_RELEASE', subject: { docType: 'ACCOUNT_CHANGE' } });
    expect((await get('accountant', `/business-accounts/${customerId}`)).body).toMatchObject({ status: 'ON_HOLD', pendingRelease: true });
    const own = await approve('manager', asked.body.approvalRequestId as string);
    expect(own.body.error.code).toBe('MAKER_CANNOT_CHECK');
    expect((await post('accountant', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'x' })).status).toBe(403);
    expect((await approve('owner', asked.body.approvalRequestId as string)).status).toBe(200);
    expect((await get('accountant', `/business-accounts/${customerId}`)).body).toMatchObject({ status: 'ACTIVE', holdReason: null, pendingRelease: false });
    expect((await confirm('sales', credit)).status).toBe(200);
    const actions = await admin().query<{ action: string }>("SELECT action FROM platform.audit_event WHERE entity_id = $1 AND module = 'whl' ORDER BY occurred_at, id", [customerId]);
    expect(actions.rows.map((r) => r.action)).toEqual(['OPEN_ACCOUNT', 'ASK_CREDIT_LIMIT', 'CHANGE_CREDIT_LIMIT', 'HOLD', 'ASK_RELEASE', 'RELEASE_HOLD']);
  });
});

describe('the database holds the second person (ADR-0017, migration 0257)', () => {
  it('refuses a credit limit or a release written without an approved change, and a change or an override decided by its asker', async () => {
    const customerId = id('adenta');
    expect(await sqlStateOf(app().query('UPDATE whl.business_account SET credit_limit_pesewas = 9000000, version = version + 1 WHERE customer_id = $1', [customerId]))).toBe('HK010');
    await app().query("UPDATE whl.business_account SET status = 'ON_HOLD', hold_reason = 'SQL test', held_at = now(), held_by = $2, version = version + 1 WHERE customer_id = $1", [customerId, SYSTEM_PRINCIPAL]);
    expect(await sqlStateOf(app().query("UPDATE whl.business_account SET status = 'ACTIVE', hold_reason = NULL, held_at = NULL, held_by = NULL, version = version + 1 WHERE customer_id = $1", [customerId]))).toBe('HK010');
    const other = randomUUID();
    await app().query("INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by) VALUES ($1, 'C-98002', 'BUSINESS', 'SQL Opened Ltd (TEST)', '01900000-0000-7000-8000-000000000302', 'ACTIVE', $2, $2)", [other, SYSTEM_PRINCIPAL]);
    expect(
      await sqlStateOf(
        app().query("INSERT INTO whl.business_account (customer_id, branch_id, credit_limit_pesewas, status, created_at, created_by, updated_at, updated_by) VALUES ($1, $2, 1, 'ACTIVE', now(), $3, now(), $3)", [other, branchId, SYSTEM_PRINCIPAL]),
      ),
    ).toBe('HK010');
    const change = (await admin().query<{ id: string }>("SELECT id FROM whl.account_change WHERE customer_id = $1 AND status = 'APPLIED' LIMIT 1", [customerId])).rows[0]!.id;
    expect(await sqlStateOf(app().query("UPDATE whl.account_change SET reason = 'Edited', version = version + 1 WHERE id = $1", [change]))).toBe('HK004');
    const pending = await post('owner', `/business-accounts/${customerId}/release`, { reason: 'SQL test release' });
    expect(pending.status).toBe(202);
    expect(await sqlStateOf(app().query("UPDATE whl.account_change SET status = 'APPLIED', posted_at = now(), posted_by = created_by, version = version + 1 WHERE id = $1", [pending.body.subject.id]))).toBe('23514');
    const request = (await admin().query<Record<string, unknown>>('SELECT * FROM whl.credit_override WHERE order_id = $1', [id('overOrder')])).rows[0]!;
    expect(
      await sqlStateOf(
        app().query(
          `INSERT INTO whl.credit_override (id, request_id, customer_id, order_id, branch_id, approval_request_id, reason, reasons, limit_pesewas, exposure_pesewas, order_pesewas, over_limit_pesewas, requested_by, approved_by, recorded_at, actor_id)
           SELECT gen_random_uuid(), request_id, customer_id, order_id, branch_id, approval_request_id, reason, reasons, limit_pesewas, exposure_pesewas, order_pesewas, over_limit_pesewas, requested_by, requested_by, recorded_at, actor_id
             FROM whl.credit_override WHERE id = $1`,
          [request['id']],
        ),
      ),
    ).toBe('23514');
    expect(await sqlStateOf(app().query("UPDATE whl.credit_override SET reason = 'Edited' WHERE id = $1", [request['id']]))).toBe('42501');
    expect(await sqlStateOf(admin().query("UPDATE whl.credit_override SET reason = 'Edited' WHERE id = $1", [request['id']]))).toBe('HK001');
  });
});

describe('every credit control operation refuses the wrong role (ADR-0035)', () => {
  it('refuses the Cashier and the Storekeeper everything, Sales and the Accountant what is not theirs, another branch and a customer', async () => {
    const c = id('overCustomer');
    const writes = (who: string) => [
      post(who, '/business-accounts', { customerId: randomUUID(), branchId, creditLimitPesewas: 0, paymentTermsDays: 0 }),
      patch(who, `/business-accounts/${c}`, { version: 1, paymentTermsDays: 7 }),
      post(who, `/business-accounts/${c}/hold`, { reason: 'x' }),
      post(who, `/business-accounts/${c}/release`, { reason: 'x' }),
    ];
    for (const who of ['cashier', 'storekeeper']) {
      expect((await get(who, '/business-accounts')).status, who).toBe(403);
      expect((await get(who, `/business-accounts/${c}`)).status, who).toBe(403);
      expect((await get(who, '/credit-overrides')).status, who).toBe(403);
      expect((await post(who, `/orders/${id('overOrder')}/credit-override`, { reason: 'x' })).status, who).toBe(403);
      for (const w of await Promise.all(writes(who))) expect(w.status, who).toBe(403);
    }
    expect((await get('storekeeper', `/orders/${id('overOrder')}/credit-check`)).status).toBe(403);
    expect((await Promise.all(writes('sales'))).map((r) => r.status)).toEqual([403, 403, 403, 403]);
    expect((await Promise.all(writes('accountant').slice(0, 2))).map((r) => r.status)).toEqual([403, 403]);
    expect((await get('temaOwner', `/business-accounts/${c}`)).status).toBe(403);
    expect((await get('temaOwner', '/business-accounts')).body.data).toEqual([]);
    expect((await get('temaOwner', `/orders/${id('overOrder')}/credit-check`)).status).toBe(403);
    expect((await post('temaOwner', `/business-accounts/${c}/hold`, { reason: 'x' })).status).toBe(403);
    expect((await get('customer', `/business-accounts/${c}`)).status).toBe(401);
    expect((await get('customer', `/orders/${id('overOrder')}/credit-check`)).status).toBe(401);
  });
});

describe('the seeded people: a second Owner or Manager at Dodowa for every release and limit change (CR-048)', () => {
  /** A seeded person's principal, to sign them in over the API with the seed's password and only their seeded grants. */
  async function seeded(email: string): Promise<Actor> {
    const row = (await admin().query<{ id: string; name: string }>("SELECT u.principal_id AS id, p.display_name AS name FROM iam.user_account u JOIN iam.principal p ON p.id = u.principal_id WHERE u.email = $1", [email])).rows[0]!;
    return { principalId: row.id, kind: 'USER', displayName: row.name, realm: 'STAFF', sessionId: null, steppedUpAt: clock.now() };
  }

  it('seeds every credit limit asked by one Owner or Manager and approved by another, and two release approvers besides the asker', async () => {
    const changes = await admin().query<{ name: string; asker: string; approver: string }>(
      `SELECT c.name, pa.display_name AS asker, pb.display_name AS approver FROM whl.account_change ch JOIN mdm.customer c ON c.id = ch.customer_id
         JOIN iam.principal pa ON pa.id = ch.created_by JOIN iam.principal pb ON pb.id = ch.posted_by WHERE c.name LIKE '%(SEED)' ORDER BY c.name`,
    );
    expect(changes.rows).toEqual([
      { name: 'Accra Event Caterers (SEED)', asker: 'Akosua Boateng', approver: 'Kwabena Owusu' },
      { name: 'Madina Market Traders (SEED)', asker: 'Efua Boakye', approver: 'Akosua Boateng' },
      { name: 'Tema Cold Store Ltd (SEED)', asker: 'Kwabena Owusu', approver: 'Efua Boakye' },
    ]);
    const holders = await admin().query<{ code: string; n: string }>(
      `SELECT rp.permission_code AS code, count(DISTINCT u.principal_id)::text AS n FROM iam.user_account u JOIN iam.role_grant g ON g.principal_id = u.principal_id
         JOIN iam.role_permission rp ON rp.role_id = g.role_id WHERE u.email LIKE '%@seed.hakoremfarms.invalid' AND g.branch_id = $1
          AND rp.permission_code IN ('whl.account.release', 'whl.account.manage', 'whl.credit.override') GROUP BY rp.permission_code ORDER BY 1`,
      [branchId],
    );
    expect(holders.rows).toEqual([
      { code: 'whl.account.manage', n: '3' },
      { code: 'whl.account.release', n: '3' },
      { code: 'whl.credit.override', n: '3' },
    ]);
  });

  it('lets the seeded Owner ask for Madina Market Traders\' release and the seeded second Manager approve it, never the Owner', async () => {
    const madina = (await admin().query<{ id: string }>("SELECT id FROM mdm.customer WHERE name = 'Madina Market Traders (SEED)'")).rows[0]!.id;
    for (const [who, email] of [['seedOwner', 'kwabena.owusu@seed.hakoremfarms.invalid'], ['seedManager2', 'efua.boakye@seed.hakoremfarms.invalid']] as const) {
      const actor = await seeded(email);
      sessions.set(who, await enrolAndLogin(api.server, { principalId: actor.principalId, identifier: email, password: SEED_PASSWORD, realm: 'STAFF' }, () => clock.now()));
    }
    expect((await get('seedOwner', `/business-accounts/${madina}`)).body).toMatchObject({ status: 'ON_HOLD', holdReason: 'Cheque returned unpaid by the bank (SEED)', creditLimitPesewas: 600_000 });
    const asked = await post('seedOwner', `/business-accounts/${madina}/release`, { reason: 'Cheque replaced by a bank transfer (TEST)' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const own = await approve('seedOwner', asked.body.approvalRequestId as string);
    expect([own.status, own.body.error.code]).toEqual([422, 'MAKER_CANNOT_CHECK']);
    expect((await approve('seedManager2', asked.body.approvalRequestId as string)).status).toBe(200);
    expect((await get('seedOwner', `/business-accounts/${madina}`)).body).toMatchObject({ status: 'ACTIVE', holdReason: null });
  });
});

// Last: these move the clock on by days.
describe('past the terms by one day, and the overdue hold (CR-046, FR-WHL-008)', () => {
  it('passes an order on the day an invoice is due and refuses one the day after, naming the day', async () => {
    const customerId = await account('Due Today Traders (TEST)', 900_000);
    await invoice(customerId, 1_000, today());
    const first = await creditOrder(customerId);
    expect((await get('sales', `/orders/${first}/credit-check`)).body).toMatchObject({ outcome: 'PASSES', overduePesewas: 0 });
    ids.set('dueToday', customerId);
    clock.advanceBy(DAY);
    const second = await creditOrder(customerId);
    const check = (await get('sales', `/orders/${second}/credit-check`)).body;
    expect(check).toMatchObject({ outcome: 'PAST_TERMS', reasons: ['PAST_TERMS'], overduePesewas: 1_000, oldestOverdueDays: 1, overLimitPesewas: 0 });
    const refused = await confirm('sales', second);
    expect([refused.status, refused.body.error.code]).toEqual([422, 'CREDIT_TERMS_EXCEEDED']);
    expect(refused.body.error.details[0].message).toBe('Due Today Traders (TEST) has GHS 10.00 past its payment terms, the oldest 1 day overdue.');
  });

  it('holds an account the day an invoice passes 30 days past due, not the day before, naming the invoice', async () => {
    const customerId = id('dueToday');
    const run = () => runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(AccountHolds).run({ kind: 'SYSTEM', principalId: SYSTEM_PRINCIPAL }));
    clock.advanceBy(29 * DAY);
    expect(await run()).not.toContain(customerId);
    expect((await get('accountant', `/business-accounts/${customerId}`)).body).toMatchObject({ status: 'ACTIVE', oldestOverdueDays: 30 });
    clock.advanceBy(DAY);
    expect(await run()).toContain(customerId);
    const read = (await get('accountant', `/business-accounts/${customerId}`)).body;
    expect(read).toMatchObject({ status: 'ON_HOLD', oldestOverdueDays: 31 });
    expect(read.holdReason).toMatch(/^Invoice INV-.* more than 30 days overdue \(31 days\)$/);
    expect(await run()).not.toContain(customerId);
  });
});
