import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Billing, type BillingDocumentView, type IssueRequest } from '../../../src/modules/bil';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * An invoice paid in cash at the till (the owner on A-212 (a), 2026-11-16: cash enters only through a till shift; A-285
 * (g), ADR-0077): the cashier takes it onto their own open shift from the till's enrolled device, it is allocated to the
 * invoice, posts Dr 1000 (the till) Cr 1200 (the customer), and is counted at the close. Cash outside an open shift is
 * refused, through the till and through PAY's own recordPayment. Every figure is read by SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let nextId: () => string;
const sessions = new Map<string, TestSession>();
const principals = new Map<string, string>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
let credential = '';
let shiftId = '';
const FLOAT = 20_000;
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const rows = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => (await admin().query(sql, values)).rows as T[];
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await rows<T>(sql, values))[0]!;
const pay = (who: string, shift: string, body: object, key: string = randomUUID(), device: string | null = credential) => {
  const call = consolePost(api.server, as(who), `/v1/shifts/${shift}/invoice-payments`, key);
  if (device !== null) call.set('X-Device-Credential', device);
  return call.send(body);
};
const payments = async () => (await one<{ n: number }>('SELECT count(*)::int AS n FROM pay.payment')).n;
const outstanding = async (documentId: string) => (await one<{ n: number }>('SELECT (d.gross_pesewas - s.allocated_pesewas)::int AS n FROM bil.billing_document d JOIN bil.document_settlement s ON s.billing_document_id = d.id WHERE d.id = $1', [documentId])).n;

/** Debits less credits on an account, against one till or one customer, over the journals one payment caused. */
async function balance(code: string, where: { register?: string; customer?: string; payment?: string }): Promise<number> {
  const row = await one<{ n: string }>(
    `SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS n
       FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
       LEFT JOIN fin.subledger_party p ON p.id = l.subledger_party_id
      WHERE a.code = $1 AND ($2::uuid IS NULL OR (p.kind = 'REGISTER' AND p.ref_id = $2)) AND ($3::uuid IS NULL OR (p.kind = 'CUSTOMER' AND p.ref_id = $3))
        AND ($4::uuid IS NULL OR e.source_document_id = $4)`,
    [code, where.register ?? null, where.customer ?? null, where.payment ?? null],
  );
  return Number(row.n);
}

function issue(request: IssueRequest): Promise<BillingDocumentView> {
  const actor: Actor = { principalId: principals.get('manager')!, kind: 'USER', displayName: 'Kwabena Owusu', realm: 'STAFF', sessionId: null, steppedUpAt: null };
  const billing = api.app.get(Billing);
  return runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'till invoice test', actor }, () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable', seriesLocks: billing.seriesLocksFor(request.kind, request.branchId) }, (tx) => billing.issueIn(tx, actor, request)),
  );
}
const invoiceOf = (pesewas: bigint, customer = id('customer')): IssueRequest => ({
  kind: 'INVOICE',
  branchId: id('branch'),
  customerId: customer,
  dueDate: toBusinessDate(clock.now()),
  taxInclusive: true,
  lines: [{ lineKind: 'PRODUCT', productId: id('EGG-0003'), quantity: '1.000', uom: 'CRATE', unitPricePesewas: pesewas }],
});

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
     UNION ALL SELECT 'customer', id FROM (SELECT id FROM mdm.customer WHERE deleted_at IS NULL ORDER BY id LIMIT 1) c
     UNION ALL SELECT code, id FROM mdm.payment_method`,
  )) {
    ids.set(row.code, row.id);
  }
  const people: [string, string, 'MANAGER' | 'CASHIER' | 'ACCOUNTANT'][] = [
    ['manager', 'Kwabena Owusu', 'MANAGER'],
    ['kwame', 'Kwame Asare', 'CASHIER'],
    ['akosua', 'Akosua Mensah', 'CASHIER'],
    ['accountant', 'Yaw Boateng', 'ACCOUNTANT'],
  ];
  for (const [who, name, role] of people) {
    const user = await createUser(database, { name, grants: [{ role, branchId: id('branch'), ...(role === 'CASHIER' ? { locationId: id('shop') } : {}) }] });
    principals.set(who, user.principalId);
    sessions.set(who, role === 'CASHIER' ? await login(api.server, user) : await enrolAndLogin(api.server, user, () => clock.now()));
  }
  const till = await post('manager', '/registers', { branchId: id('branch'), locationId: id('shop'), code: 'T2', name: 'Shop floor till' });
  expect(till.status, JSON.stringify(till.body)).toBe(201);
  ids.set('till', till.body.id as string);
  await stepUp(api.server, as('manager') as TotpSession, clock);
  const enrolled = await post('manager', `/registers/${id('till')}/devices`, { deviceLabel: 'Shop floor tablet' });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  credential = enrolled.body.deviceCredential as string;
  shiftId = nextId();
  const opened = await post('kwame', '/shifts', { id: shiftId, registerId: id('till'), openingFloatPesewas: FLOAT, openedAt: clock.now().toISOString() }, shiftId);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('a customer pays an invoice in cash at the till, on the cashier own open shift (A-212 (a))', () => {
  let invoice: BillingDocumentView;
  let paymentId = '';

  it('takes part of it with change, allocates it to the invoice and posts Dr 1000 the till, Cr 1200 the customer', async () => {
    invoice = await issue(invoiceOf(42_560n));
    expect(await outstanding(invoice.id)).toBe(42_560);
    const key = randomUUID();
    const paid = await pay('kwame', shiftId, { billingDocumentId: invoice.id, amountPesewas: 20_001, tenderedPesewas: 50_000 }, key);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body).toEqual({
      paymentId: expect.any(String),
      shiftId,
      billingDocument: { id: invoice.id, documentNo: invoice.documentNo },
      amountPesewas: 20_001,
      tenderedPesewas: 50_000,
      changeDuePesewas: 29_999,
      outstandingPesewas: 22_559,
      currency: 'GHS',
    });
    paymentId = paid.body.paymentId as string;
    expect(await one('SELECT method_kind AS kind, amount_pesewas::int AS amount, status, shift_document_id AS shift, register_ref AS till, customer_id AS customer, order_document_id AS "order", late_entry AS late FROM pay.payment WHERE id = $1', [paymentId])).toEqual({
      kind: 'CASH',
      amount: 20_001,
      status: 'CLEARED',
      shift: shiftId,
      till: id('till'),
      customer: id('customer'),
      order: null,
      late: false,
    });
    expect(await rows('SELECT billing_document_id AS document, amount_pesewas::int AS amount, direction FROM pay.payment_allocation WHERE payment_id = $1', [paymentId])).toEqual([{ document: invoice.id, amount: 20_001, direction: 'APPLY' }]);
    expect(await outstanding(invoice.id)).toBe(22_559);
    expect(await balance('1000', { register: id('till'), payment: paymentId })).toBe(20_001);
    expect(await balance('1200', { customer: id('customer'), payment: paymentId })).toBe(-20_001);

    const replay = await pay('kwame', shiftId, { billingDocumentId: invoice.id, amountPesewas: 20_001, tenderedPesewas: 50_000 }, key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(paid.body);
    expect(await rows('SELECT 1 FROM pay.payment_allocation WHERE billing_document_id = $1', [invoice.id])).toHaveLength(1);
  });

  it('refuses more than is outstanding, less handed over, a receipt, and an unknown document, recording nothing', async () => {
    const before = await payments();
    const refusals: [object, number, string][] = [
      [{ billingDocumentId: invoice.id, amountPesewas: 22_560 }, 422, 'AMOUNT_EXCEEDS_OUTSTANDING'],
      [{ billingDocumentId: invoice.id, amountPesewas: 10_000, tenderedPesewas: 9_999 }, 422, 'TENDERED_BELOW_AMOUNT'],
      [{ billingDocumentId: invoice.id, amountPesewas: 0 }, 422, 'AMOUNT_NOT_POSITIVE'],
    ];
    for (const [body, status, rule] of refusals) {
      const refused = await pay('kwame', shiftId, body);
      expect(refused.status, JSON.stringify(refused.body)).toBe(status);
      expect(refused.body.error).toMatchObject({ code: 'TILL_INVOICE_PAYMENT_INVALID', details: [expect.objectContaining({ code: rule })] });
    }
    const receipt = await issue({ kind: 'RECEIPT', branchId: id('branch'), taxInclusive: true, lines: [{ lineKind: 'PRODUCT', productId: id('EGG-0003'), quantity: '1.000', uom: 'CRATE', unitPricePesewas: 6_000n }] });
    const notInvoice = await pay('kwame', shiftId, { billingDocumentId: receipt.id, amountPesewas: 100 });
    expect(notInvoice.body.error).toMatchObject({ code: 'TILL_INVOICE_PAYMENT_INVALID', details: [expect.objectContaining({ code: 'NOT_AN_INVOICE' })] });
    expect((await pay('kwame', shiftId, { billingDocumentId: randomUUID(), amountPesewas: 100 })).status).toBe(404);
    expect(await payments()).toBe(before);
    expect(await outstanding(invoice.id)).toBe(22_559);
  });

  it('refuses the wrong role, another cashier on this shift and a call from no enrolled device (ADR-0035)', async () => {
    const before = await payments();
    const accountant = await pay('accountant', shiftId, { billingDocumentId: invoice.id, amountPesewas: 100 });
    expect(accountant.status, JSON.stringify(accountant.body)).toBe(403);
    const other = await pay('akosua', shiftId, { billingDocumentId: invoice.id, amountPesewas: 100 });
    expect(other.status, JSON.stringify(other.body)).toBe(403);
    const noDevice = await pay('kwame', shiftId, { billingDocumentId: invoice.id, amountPesewas: 100 }, randomUUID(), null);
    expect(noDevice.status).toBe(401);
    const anonymous = await request(api.server).post(`/v1/shifts/${shiftId}/invoice-payments`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send({ billingDocumentId: invoice.id, amountPesewas: 100 });
    expect([401, 403]).toContain(anonymous.status);
    expect(await payments()).toBe(before);
  });

  it('refuses cash for an invoice by PAY’s own recordPayment, with or without a shift: the till is the one path', async () => {
    const before = await payments();
    const body = { id: nextId(), paymentMethodId: id('CASH'), amountPesewas: 100, customerId: id('customer'), receivedAt: clock.now().toISOString(), allocations: [{ billingDocumentId: invoice.id, amountPesewas: 100 }] };
    const direct = await post('accountant', '/payments', body);
    expect(direct.status, JSON.stringify(direct.body)).toBe(422);
    expect(JSON.stringify(direct.body.error.details)).toContain('TENDER_NOT_AVAILABLE');
    const named = await post('accountant', '/payments', { ...body, id: nextId(), shiftId });
    expect(named.status, JSON.stringify(named.body)).toBe(422);
    expect(await payments()).toBe(before);
  });

  it('counts it at the close, and takes no more once the shift is closing or closed', async () => {
    const x = await consoleGet(api.server, as('manager'), `/v1/shifts/${shiftId}/x-report`);
    expect(x.status, JSON.stringify(x.body)).toBe(200);
    const expected = FLOAT + 20_001;
    const declared = await post('kwame', `/shifts/${shiftId}/close`, { declared: [{ paymentMethodId: id('CASH'), declaredPesewas: expected }] });
    expect(declared.status, JSON.stringify(declared.body)).toBe(200);
    const before = await payments();
    const closing = await pay('kwame', shiftId, { billingDocumentId: invoice.id, amountPesewas: 100 });
    expect(closing.status, JSON.stringify(closing.body)).toBe(422);
    expect(closing.body.error.code).toBe('SHIFT_NOT_OPEN');
    await stepUp(api.server, as('manager') as TotpSession, clock);
    const signed = await post('manager', `/shifts/${shiftId}/approve-close`, { reason: 'Counted together' });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body).toMatchObject({ status: 'CLOSED', expectedCashPesewas: expected, overShortDirection: 'EXACT' });
    expect(await one('SELECT expected_cash_pesewas::int AS expected, declared_cash_pesewas::int AS declared, over_short_pesewas::int AS over FROM pos.shift WHERE id = $1', [shiftId])).toEqual({ expected, declared: expected, over: 0 });
    expect(await balance('1000', { register: id('till') })).toBe(0);
    const closed = await pay('kwame', shiftId, { billingDocumentId: invoice.id, amountPesewas: 100 });
    expect(closed.status).toBe(422);
    expect(closed.body.error.code).toBe('SHIFT_NOT_OPEN');
    expect(await payments()).toBe(before);
    expect(await outstanding(invoice.id)).toBe(22_559);
  });
});
