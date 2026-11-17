import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { SEED_TRANSPORT_INVOICE } from '../../../src/seed/farm-pur';
import { consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * A supplier payment is numbered from its `SPY` series when it is marked paid (A-205, ADR-0015): through
 * `platform.allocate_number` in the transaction that marks it paid, gap-free under concurrent payers, and held by the
 * database (`ck_supplier_payment_number`): a payment is PAID only with the number allocated to it. A role that may not
 * pay is refused and consumes no number.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let supplierId: string;
let invoiceId: string;
type Session = TestSession & { readonly secret?: Buffer };
const sessions = new Map<string, Session>();
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const year = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Accra', year: 'numeric' }).format(clock.now());

/** The SPY numbers allocated so far, each with its value, in order. */
async function spyNumbers(): Promise<Array<{ value: number; formatted: string; document_id: string }>> {
  const { rows } = await admin().query<{ value: number; formatted: string; document_id: string }>(
    `SELECT a.value::int AS value, a.formatted, a.document_id FROM platform.number_allocation a JOIN platform.number_series s ON s.id = a.series_id
      WHERE s.doc_type = 'SUPPLIER_PAYMENT' ORDER BY a.value`,
  );
  return rows;
}

/** A payment of `amount` pesewas against the seeded transport invoice, submitted by the Accountant and approved by the Manager. */
async function approvedPayment(amount: number): Promise<string> {
  const created = await post('accountant', '/supplier-payments', { supplierId, method: 'CASH', allocations: [{ supplierInvoiceId: invoiceId, amountPesewas: amount }] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const submitted = await post('accountant', `/supplier-payments/${created.body.id}/submit`);
  expect(submitted.status).toBe(202);
  clock.advanceBy(30_000);
  const step = await post('manager', '/auth/step-up', { code: totpAt(as('manager').secret!, Math.floor(clock.now().getTime() / 1000)) });
  expect(step.status).toBe(200);
  const approved = await post('manager', `/iam/approvals/${submitted.body.approvalRequestId}/approve`, { reason: 'Checked against the transport invoice' });
  expect(approved.status).toBe(200);
  return created.body.id as string;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  supplierId = (await admin().query<{ id: string }>('SELECT id FROM mdm.supplier WHERE name = $1', [SEED_TRANSPORT_INVOICE.supplier])).rows[0]!.id;
  invoiceId = (await admin().query<{ id: string }>('SELECT id FROM pur.supplier_invoice WHERE supplier_invoice_no = $1', [SEED_TRANSPORT_INVOICE.supplierInvoiceNo])).rows[0]!.id;
  const people: [string, string, string, boolean][] = [
    ['manager', 'Akosua Boateng', 'MANAGER', true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', false],
    ['cashier', 'Adwoa Darko', 'CASHIER', false],
  ];
  for (const [who, name, role, privileged] of people) {
    const user = await createUser(database, { name, grants: [{ role: role as 'OWNER', branchId }] });
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('a supplier payment is numbered from its SPY series when it is marked paid (A-205)', () => {
  const CONCURRENT = 8;
  let first: string;

  it('numbers eight payments marked paid at once densely, one number each, with no gap and no number twice', async () => {
    expect(await spyNumbers()).toEqual([]);
    const ids: string[] = [];
    for (let n = 0; n < CONCURRENT; n += 1) ids.push(await approvedPayment(1_000));
    const paid = await Promise.all(
      ids.map((id, n) => post('accountant', `/supplier-payments/${id}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: `CASH-VOUCHER-${String(200 + n)}` })),
    );
    expect(paid.map((r) => r.status)).toEqual(Array(CONCURRENT).fill(200));
    const numbers = await spyNumbers();
    expect(numbers.map((n) => n.value)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(numbers.map((n) => n.formatted)).toEqual(numbers.map((n) => `SPY-${year()}-DDW-${String(n.value).padStart(6, '0')}`));
    expect(new Set(numbers.map((n) => n.document_id))).toEqual(new Set(ids));
    // Each payment answers and stores the number allocated to it.
    for (const response of paid) expect(numbers.find((n) => n.document_id === response.body.id)!.formatted).toBe(response.body.paymentNo);
    const { rows } = await admin().query<{ id: string; payment_no: string }>('SELECT id, payment_no FROM pur.supplier_payment WHERE id = ANY($1::uuid[])', [ids]);
    expect(new Map(rows.map((r) => [r.id, r.payment_no]))).toEqual(new Map(numbers.map((n) => [n.document_id, n.formatted])));
    first = ids[0]!;
  });

  it('keeps the number on a replay and allocates none for a refused second payment of the same payment', async () => {
    const before = await spyNumbers();
    const again = await post('accountant', `/supplier-payments/${first}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'CASH-VOUCHER-0999' });
    expect(again.status).toBe(422);
    expect(await spyNumbers()).toEqual(before);
  });

  it('refuses the wrong roles to mark a payment paid, and the refusal consumes no number', async () => {
    const id = await approvedPayment(500);
    const before = await spyNumbers();
    for (const who of ['storekeeper', 'cashier', 'manager']) {
      const refused = await post(who, `/supplier-payments/${id}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: `CASH-VOUCHER-${who}` });
      expect(refused.status, who).toBe(403);
    }
    expect(await spyNumbers()).toEqual(before);
    const paid = await post('accountant', `/supplier-payments/${id}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'CASH-VOUCHER-0300' });
    expect(paid.status).toBe(200);
    expect(paid.body.paymentNo).toBe(`SPY-${year()}-DDW-${String(before.length + 1).padStart(6, '0')}`);
  });

  it('is held by the database: a payment is PAID only with the number allocated to it, and only a PAID payment has one', async () => {
    const id = await approvedPayment(500);
    const app = database.pool('app');
    const paidColumns = "version = version + 1, status = 'PAID', paid_at = now(), external_reference = 'CASH-VOUCHER-DB', posted_at = now(), posted_by = created_by";
    // Paid with no number.
    expect(await sqlStateOf(app.query(`UPDATE pur.supplier_payment SET ${paidColumns} WHERE id = $1`, [id]))).toBe('HK010');
    // Paid with a number that was never allocated to it, or that is another payment's.
    expect(await sqlStateOf(app.query(`UPDATE pur.supplier_payment SET ${paidColumns}, payment_no = $2 WHERE id = $1`, [id, `SPY-${year()}-DDW-999999`]))).toBe('HK010');
    const other = (await spyNumbers())[0]!.formatted;
    expect(await sqlStateOf(app.query(`UPDATE pur.supplier_payment SET ${paidColumns}, payment_no = $2 WHERE id = $1`, [id, other]))).toBe('HK010');
    // A number on a payment still waiting to be paid.
    const { rows } = await admin().query<{ id: string }>(
      `SELECT platform.allocate_number(platform.open_number_series('SUPPLIER_PAYMENT', $2, b.id, b.code, ''), $1) AS id FROM mdm.branch b WHERE b.code = 'DDW'`,
      [id, Number(year())],
    );
    expect(await sqlStateOf(app.query('UPDATE pur.supplier_payment SET version = version + 1, payment_no = $2 WHERE id = $1', [id, rows[0]!.id]))).toBe('HK010');
  });
});
