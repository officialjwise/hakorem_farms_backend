import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { PurchaseOrders } from '../../../src/modules/pur';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { addDays } from '../../../src/seed/seed-calendar';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The supplier register and requisitions over the seeded farm (FR-PUR-001 to FR-PUR-004, ADR-0022, ADR-0035, A-166), the
 * B07 continued gate's first part: a payout detail change returns 202 and the old details stay in force until a
 * different person approves, with only ciphertext stored; a document whose bytes are not what its name says is refused;
 * a rejected requisition cannot be converted and a converted one links its order; every write refuses the wrong role.
 * Account numbers are examples only and obviously not real accounts.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
type TotpSession = TestSession & { readonly secret: Buffer };
let manager: TotpSession;
let owner: TotpSession;
let secondOwner: TotpSession;
let accountant: TotpSession;
let pensStorekeeper: TestSession;
let farmHand: TestSession;
let cashier: TestSession;
let sales: TestSession;
let driver: TestSession;
let investor: TestSession;
const ids = new Map<string, string>();

const id = (code: string) => ids.get(code)!;
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const send = (method: 'put' | 'patch', session: TestSession, path: string, body: object, key: string = randomUUID()) =>
  request(api.server)[method](`/v1${path}`).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).send(body);
const put = (session: TestSession, path: string, body: object, key?: string) => send('put', session, path, body, key);
const patch = (session: TestSession, path: string, body: object, key?: string) => send('patch', session, path, body, key);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');
const today = () => toBusinessDate(clock.now());
const supplier = (name: string) => id(`supplier:${name} (SEED)`);
const count = async (sql: string, values: unknown[]) => (await admin().query<{ n: number }>(sql, values)).rows[0]!.n;

const OLD_WALLET = { method: 'MOBILE_MONEY', momoNetwork: 'MTN', momoNumber: '+233240000014' };
const NEW_WALLET = { method: 'MOBILE_MONEY', momoNetwork: 'TELECEL', momoNumber: '+233200000777' };
const pdf = (size = 4_096) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(size - 9, 0x20)]);
/** A Windows executable's first bytes: what a disguised "certificate" really is. */
const executable = () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4_094, 0x90)]);

async function stepUp(session: TotpSession): Promise<void> {
  clock.advanceBy(30_000);
  const response = await post(session, '/auth/step-up', { code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) });
  expect(response.status).toBe(200);
}

async function approve(checker: TotpSession, approvalRequestId: string) {
  await stepUp(checker);
  return post(checker, `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Confirmed with the supplier by phone' });
}

async function profileVersion(supplierId: string): Promise<number> {
  return (await get(accountant, `/suppliers/${supplierId}/profile`)).body.version as number;
}

/** Payout details asked for by one Owner and approved by another: what a supplier is paid by (A-169). */
async function payoutInForce(supplierId: string, details: object): Promise<void> {
  const asked = await put(owner, `/suppliers/${supplierId}/profile`, { version: await profileVersion(supplierId), payoutDetails: details });
  expect(asked.status, JSON.stringify(asked.body)).toBe(202);
  expect((await approve(secondOwner, asked.body.approvalRequestId)).status).toBe(200);
}

/** An approved expense invoice (transport) of `amount` from a supplier, needing no match, for a payment. */
async function approvedExpenseInvoice(supplierId: string, amount: number): Promise<string> {
  const created = await post(accountant, '/supplier-invoices', {
    kind: 'INVOICE',
    supplierId,
    supplierInvoiceNo: `TR-${randomUUID().slice(0, 6)}`,
    invoiceDate: today(),
    branchId: id('branch:DDW'),
    lines: [{ description: 'Transport of feed from Kasoa', qty: '1.000', unitPricePesewas: amount, taxCategoryId: id('tax:LIVE_ANIMALS') }],
  });
  expect(created.status).toBe(201);
  expect((await post(accountant, `/supplier-invoices/${created.body.id}/match`)).body.matchStatus).toBe('NOT_REQUIRED');
  expect((await post(accountant, `/supplier-invoices/${created.body.id}/approve`)).status).toBe(200);
  return created.body.id as string;
}

async function uploaded(session: TestSession, content: Buffer, name: string, clean = true): Promise<string> {
  const response = await consolePost(api.server, session, '/v1/files').field('purpose', 'SUPPLIER_DOCUMENT').attach('file', content, name);
  expect(response.status).toBe(201);
  // The scanner's verdict, as the worker records it (hk_worker is the only role that may).
  if (clean) await database.pool('worker').query("UPDATE platform.stored_file SET scan_status = 'CLEAN', scanned_at = now(), version = version + 1 WHERE id = $1", [response.body.id]);
  return response.body.id as string;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier
       UNION ALL SELECT 'tax:' || code, id FROM mdm.tax_category`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  secondOwner = await enrolAndLogin(api.server, await createUser(database, { name: 'Adjoa Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  pensStorekeeper = await login(api.server, await createUser(database, { name: 'Kwesi Ofori', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:PENS') }] }));
  farmHand = await login(api.server, await createUser(database, { name: 'Abdul-Rahman Iddrisu', grants: [{ role: 'FARM_HAND', branchId, locationId: id('location:PENS') }] }));
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: id('location:SHOP') }] }));
  sales = await login(api.server, await createUser(database, { name: 'Esi Appiah', grants: [{ role: 'SALES', branchId }] }));
  driver = await login(api.server, await createUser(database, { name: 'Selorm Agbeko', grants: [{ role: 'DRIVER', branchId }] }));
  investor = await login(api.server, await createUser(database, { name: 'Nana Ama Ofori', grants: [{ role: 'INVESTOR', branchId }] }));
  // Three more suppliers registered through MDM, each of which gets its profile in its registration's transaction.
  for (const [name, phone] of [
    ['Agrivet Ghana Ltd', '+233200000301'],
    ['Tema Packaging Supplies', '+233200000302'],
    ['Dodowa Vegetable Growers Cooperative', '+233200000303'],
  ] as const) {
    const created = await post(manager, '/suppliers', { name: `${name} (SEED)`, phone });
    expect(created.status).toBe(201);
    ids.set(`supplier:${name} (SEED)`, created.body.id as string);
  }
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('wrong roles are refused on every supplier register and requisition write (ADR-0035)', () => {
  it('refuses profile, payout and document writes to the Storekeeper, Farm hand, Cashier, Sales, Driver and Investor', async () => {
    const awutu = supplier('Awutu Poultry Farm');
    for (const session of [pensStorekeeper, farmHand, cashier, sales, driver, investor]) {
      expect((await put(session, `/suppliers/${awutu}/profile`, { version: 1, paymentTermsDays: 7 })).status).toBe(403);
      expect((await put(session, `/suppliers/${awutu}/profile`, { version: 1, payoutDetails: NEW_WALLET })).status).toBe(403);
      expect((await post(session, `/suppliers/${awutu}/documents`, { kind: 'CONTRACT', fileId: randomUUID() })).status).toBe(403);
      expect((await get(session, `/suppliers/${awutu}/profile`)).status).toBe(403);
      expect((await get(session, `/suppliers/${awutu}/payout-details`)).status).toBe(403);
    }
    expect(await count("SELECT count(*)::int AS n FROM pur.supplier_payout_change WHERE supplier_id = $1 AND status = 'PENDING_APPROVAL'", [awutu])).toBe(0);
  });

  it('refuses the full payout details to the Storekeeper, who holds no payout permission', async () => {
    expect((await get(pensStorekeeper, `/suppliers/${supplier('Awutu Poultry Farm')}/payout-details`)).status).toBe(403);
  });

  it('refuses a payout change to the Storekeeper (A-169, A-171)', async () => {
    const ashaiman = supplier('Ashaiman Cold Store Ltd');
    for (const session of [pensStorekeeper]) {
      const refused = await put(session, `/suppliers/${ashaiman}/profile`, { version: await profileVersion(ashaiman), payoutDetails: NEW_WALLET });
      expect(refused.status).toBe(403);
    }
    expect(await count("SELECT count(*)::int AS n FROM pur.supplier_payout_change WHERE supplier_id = $1", [ashaiman])).toBe(0);
  });

  it('refuses requisition writes to the Accountant, Cashier, Sales, Driver and Investor, and rejection or conversion to the Storekeeper and Farm hand', async () => {
    const body = { lines: [{ productId: id('product:LIV-0001'), qty: '20.000' }] };
    for (const session of [accountant, cashier, sales, driver, investor]) {
      expect((await post(session, '/purchase-requisitions', body)).status).toBe(403);
      expect((await post(session, `/purchase-requisitions/${randomUUID()}/submit`)).status).toBe(403);
      expect((await get(session, '/purchase-requisitions')).status).toBe(403);
    }
    const raised = await post(farmHand, '/purchase-requisitions', body);
    expect(raised.status).toBe(201);
    const submittedOnce = await post(farmHand, `/purchase-requisitions/${raised.body.id}/submit`);
    expect(submittedOnce.status, JSON.stringify(submittedOnce.body)).toBe(200);
    for (const session of [pensStorekeeper, farmHand]) {
      expect((await post(session, `/purchase-requisitions/${raised.body.id}/reject`, { reason: 'Refused' })).status).toBe(403);
      expect(
        (await post(session, `/purchase-requisitions/${raised.body.id}/convert`, { supplierId: supplier('Awutu Poultry Farm'), deliverToLocationId: id('location:PENS'), lines: [{ lineId: raised.body.lines[0].id, unitPricePesewas: 5_500 }] }))
          .status,
      ).toBe(403);
    }
    expect((await get(farmHand, `/purchase-requisitions/${raised.body.id}`)).body.status).toBe('SUBMITTED');
  });
});

describe('a supplier profile (FR-PUR-001)', () => {
  it('opens a profile for every supplier, stores terms of 14 days as 14, and dates an invoice due 14 days on', async () => {
    const kpone = supplier('Ashaiman Cold Store Ltd');
    const opened = await get(manager, `/suppliers/${kpone}/profile`);
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ supplierId: kpone, paymentTermsDays: 0, payoutMethod: null, payoutDetailsMasked: null, pendingPayoutChangeApprovalId: null });
    const changed = await put(manager, `/suppliers/${kpone}/profile`, { version: opened.body.version, paymentTermsDays: 14, leadTimeDays: 3, notes: 'Delivers frozen chicken on Tuesdays' });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ paymentTermsDays: 14, leadTimeDays: 3, notes: 'Delivers frozen chicken on Tuesdays', version: opened.body.version + 1 });
    expect((await put(manager, `/suppliers/${kpone}/profile`, { version: opened.body.version, paymentTermsDays: 30 })).status).toBe(409);
    // Dated today by the application clock, so the test reads the same in any month; due 14 calendar days on.
    const invoiceDate = today();
    const invoice = await post(accountant, '/supplier-invoices', {
      kind: 'INVOICE',
      supplierId: kpone,
      supplierInvoiceNo: `ACS-${randomUUID().slice(0, 6)}`,
      invoiceDate,
      branchId: id('branch:DDW'),
      lines: [{ description: 'Cold store rent, November', qty: '1.000', unitPricePesewas: 15_000, taxCategoryId: id('tax:LIVE_ANIMALS') }],
    });
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(201);
    expect(invoice.body.dueDate).toBe(new Date(Date.parse(`${invoiceDate}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10));
  });

  it('shows the seeded terms and wallet of Kpone, made by the Owner and approved by the Manager', async () => {
    const kpone = await get(manager, `/suppliers/${supplier('Kpone Livestock Traders')}/profile`);
    expect(kpone.body).toMatchObject({ paymentTermsDays: 14, leadTimeDays: 3, payoutMethod: 'MOBILE_MONEY', payoutDetailsMasked: 'MTN MoMo, ****0211', pendingPayoutChangeApprovalId: null });
    const { rows } = await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM pur.supplier_payout_change WHERE status = 'APPROVED' AND posted_by <> created_by");
    expect(rows[0]!.n).toBe(2);
  });

  it('shows bank details only as the bank, the account name and the last four characters', async () => {
    const agrivet = supplier('Agrivet Ghana Ltd');
    await payoutInForce(agrivet, { method: 'BANK', bankName: 'Ecobank Ghana', accountName: 'Agrivet Ghana Ltd', accountNumber: '0000000003381', bankBranch: 'Adum' });
    const profile = await get(manager, `/suppliers/${agrivet}/profile`);
    expect(profile.body).toMatchObject({ payoutMethod: 'BANK', payoutDetailsMasked: 'Ecobank Ghana, Agrivet Ghana Ltd, ****3381', pendingPayoutChangeApprovalId: null });
    expect(JSON.stringify(profile.body)).not.toContain('0000000003381');
  });
});

describe('payout details are encrypted and a change needs a second person (FR-PUR-002)', () => {
  it('keeps the old wallet in force for a payment prepared while a change waits, and puts the new one in force only when a different person approves', async () => {
    const awutu = supplier('Awutu Poultry Farm');
    await payoutInForce(awutu, OLD_WALLET);
    const invoice = await approvedExpenseInvoice(awutu, 40_000);

    const asked = await put(owner, `/suppliers/${awutu}/profile`, { version: await profileVersion(awutu), paymentTermsDays: 7, payoutDetails: NEW_WALLET });
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'SUPPLIER_PAYOUT_CHANGE', subject: { docType: 'SUPPLIER_PAYOUT_CHANGE' } });
    const waiting = await get(accountant, `/suppliers/${awutu}/profile`);
    expect(waiting.body).toMatchObject({ payoutDetailsMasked: 'MTN MoMo, ****0014', paymentTermsDays: 0, pendingPayoutChangeApprovalId: asked.body.approvalRequestId });

    const prepared = await post(accountant, '/supplier-payments', { supplierId: awutu, method: 'MOBILE_MONEY', allocations: [{ supplierInvoiceId: invoice, amountPesewas: 40_000 }] });
    expect(prepared.status).toBe(201);
    expect(prepared.body.payeeDetailsMasked).toBe('MTN MoMo, ****0014');

    // A second change cannot be asked for while one waits.
    const second = await put(secondOwner, `/suppliers/${awutu}/profile`, { version: waiting.body.version, payoutDetails: OLD_WALLET });
    expect(second.status).toBe(422);
    expect(second.body.error).toMatchObject({ code: 'SUPPLIER_PROFILE_INVALID', details: [{ field: '/payoutDetails', code: 'PAYOUT_CHANGE_PENDING' }] });

    // The maker (an Owner) cannot approve their own change; another Owner can. The Storekeeper holds no approver permission.
    const own = await approve(owner, asked.body.approvalRequestId);
    expect(own.status).toBe(422);
    expect(own.body.error.code).toBe('MAKER_CANNOT_CHECK');
    expect((await post(pensStorekeeper, `/iam/approvals/${asked.body.approvalRequestId}/approve`, { reason: 'Looks right' })).status).toBe(403);
    expect((await get(accountant, `/suppliers/${awutu}/profile`)).body.payoutDetailsMasked).toBe('MTN MoMo, ****0014');

    expect((await approve(secondOwner, asked.body.approvalRequestId)).status).toBe(200);
    const approved = await get(accountant, `/suppliers/${awutu}/profile`);
    expect(approved.body).toMatchObject({ payoutMethod: 'MOBILE_MONEY', payoutDetailsMasked: 'TELECEL MoMo, ****0777', paymentTermsDays: 7, pendingPayoutChangeApprovalId: null });

    // The payment prepared before approval still pays the old wallet; a new one pays the new.
    expect((await get(accountant, `/supplier-payments/${prepared.body.id}`)).body.payeeDetailsMasked).toBe('MTN MoMo, ****0014');
    const later = await post(accountant, '/supplier-payments', { supplierId: awutu, method: 'MOBILE_MONEY', allocations: [{ supplierInvoiceId: await approvedExpenseInvoice(awutu, 5_000), amountPesewas: 5_000 }] });
    expect(later.body.payeeDetailsMasked).toBe('TELECEL MoMo, ****0777');
    expect(
      await count("SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type IN ('pur.SupplierPayoutChangeRequested', 'pur.SupplierPayoutChanged') AND subject_id = $1", [
        asked.body.subject.id,
      ]),
    ).toBe(2);
  });

  it('stores only ciphertext: no number appears in the table, the audit trail or the outbox', async () => {
    const tema = supplier('Tema Packaging Supplies');
    await payoutInForce(tema, { method: 'BANK', bankName: 'GCB Bank', accountName: 'Tema Packaging Supplies', accountNumber: '0000000091180' });
    const { rows } = await admin().query<{ enc: Buffer }>('SELECT payout_details_enc AS enc FROM pur.supplier_payout_change WHERE supplier_id = $1', [tema]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enc.includes(Buffer.from('0000000091180'))).toBe(false);
    expect(rows[0]!.enc.includes(Buffer.from('GCB Bank'))).toBe(false);
    for (const sql of [
      "SELECT count(*)::int AS n FROM pur.supplier_payout_change WHERE payout_masked LIKE '%0000000091180%'",
      `SELECT count(*)::int AS n FROM platform.audit_event
        WHERE position(convert_to('0000000091180', 'UTF8') IN coalesce("before", ''::bytea)) > 0 OR position(convert_to('0000000091180', 'UTF8') IN coalesce("after", ''::bytea)) > 0
           OR metadata::text LIKE '%0000000091180%'`,
      "SELECT count(*)::int AS n FROM platform.outbox_message WHERE payload::text LIKE '%0000000091180%'",
      "SELECT count(*)::int AS n FROM iam.approval_request WHERE summary LIKE '%0000000091180%'",
    ]) {
      expect(await count(sql, [])).toBe(0);
    }
  });

  it('refuses a bank payment to a supplier with no approved bank details, and keeps cash payable', async () => {
    const dodowa = supplier('Dodowa Vegetable Growers Cooperative');
    const invoice = await approvedExpenseInvoice(dodowa, 12_000);
    const bank = await post(accountant, '/supplier-payments', { supplierId: dodowa, method: 'BANK', allocations: [{ supplierInvoiceId: invoice, amountPesewas: 12_000 }] });
    expect(bank.status).toBe(422);
    expect(bank.body.error).toMatchObject({ code: 'SUPPLIER_PAYMENT_INVALID', details: [{ field: '/method', code: 'PAYOUT_DETAILS_MISSING' }] });
    const cash = await post(accountant, '/supplier-payments', { supplierId: dodowa, method: 'CASH', allocations: [{ supplierInvoiceId: invoice, amountPesewas: 12_000 }] });
    expect(cash.status).toBe(201);
    expect(cash.body.payeeDetailsMasked).toBeNull();
  });

  it('rejects a change without moving the details in force', async () => {
    const tema = supplier('Tema Packaging Supplies');
    const asked = await put(owner, `/suppliers/${tema}/profile`, { version: await profileVersion(tema), payoutDetails: { method: 'MOBILE_MONEY', momoNetwork: 'MTN', momoNumber: '+233550000999' } });
    expect(asked.status).toBe(202);
    await stepUp(secondOwner);
    expect((await post(secondOwner, `/iam/approvals/${asked.body.approvalRequestId}/reject`, { reason: 'The supplier says it did not ask' })).status).toBe(200);
    expect((await get(accountant, `/suppliers/${tema}/profile`)).body).toMatchObject({ payoutDetailsMasked: 'GCB Bank, Tema Packaging Supplies, ****1180', pendingPayoutChangeApprovalId: null });
    expect((await admin().query<{ status: string }>('SELECT status FROM pur.supplier_payout_change WHERE id = $1', [asked.body.subject.id])).rows[0]!.status).toBe('REJECTED');
  });

  it('names every broken payout rule', async () => {
    const tema = supplier('Tema Packaging Supplies');
    const refused = await put(owner, `/suppliers/${tema}/profile`, { version: await profileVersion(tema), payoutDetails: { method: 'BANK', bankName: 'GCB Bank', accountNumber: '12-34', momoNumber: '+233240000014' } });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('SUPPLIER_PROFILE_INVALID');
    expect(refused.body.error.details.map((d: { field: string; code: string }) => `${d.field} ${d.code}`)).toEqual([
      '/payoutDetails/accountName REQUIRED',
      '/payoutDetails/accountNumber ACCOUNT_NUMBER_INVALID',
      '/payoutDetails/momoNumber NOT_FOR_METHOD',
    ]);
  });

  it('is held by the database: only an approved change of the supplier goes into force, never one its maker approved, and a payment pays the details in force', async () => {
    const awutu = supplier('Awutu Poultry Farm');
    const tema = supplier('Tema Packaging Supplies');
    const temaChange = (await admin().query<{ id: string }>("SELECT id FROM pur.supplier_payout_change WHERE supplier_id = $1 AND status = 'APPROVED'", [tema])).rows[0]!.id;
    expect(await sqlStateOf(database.pool('app').query('UPDATE pur.supplier_profile SET version = version + 1, payout_change_id = $2 WHERE supplier_id = $1', [awutu, temaChange]))).toBe('HK010');
    const rejected = (await admin().query<{ id: string }>("SELECT id FROM pur.supplier_payout_change WHERE supplier_id = $1 AND status = 'REJECTED'", [tema])).rows[0]!.id;
    expect(await sqlStateOf(database.pool('app').query('UPDATE pur.supplier_profile SET version = version + 1, payout_change_id = $2 WHERE supplier_id = $1', [tema, rejected]))).toBe('HK010');
    expect(await sqlStateOf(database.pool('app').query("UPDATE pur.supplier_payout_change SET version = version + 1, payout_masked = 'Cash' WHERE id = $1", [temaChange]))).toBe('HK004');
    const payment = (await admin().query<{ id: string }>("SELECT id FROM pur.supplier_payment WHERE supplier_id = $1 AND method = 'MOBILE_MONEY' ORDER BY id LIMIT 1", [awutu])).rows[0]!.id;
    expect(await sqlStateOf(database.pool('app').query('UPDATE pur.supplier_payment SET version = version + 1, payout_change_id = NULL WHERE id = $1', [payment]))).toBe('HK004');
  });

  it('refuses a maker approving their own change on the row itself', async () => {
    const kpone = supplier('Kpone Livestock Traders');
    const asked = await put(owner, `/suppliers/${kpone}/profile`, { version: await profileVersion(kpone), payoutDetails: { method: 'CHEQUE' } });
    expect(asked.status).toBe(202);
    const refused = database.pool('app').query("UPDATE pur.supplier_payout_change SET version = version + 1, status = 'APPROVED', posted_at = now(), posted_by = created_by WHERE id = $1", [asked.body.subject.id]);
    expect(await sqlStateOf(refused)).toBe(SQLSTATE.checkViolation);
  });
});

describe('supplier documents (FR-PUR-003)', () => {
  it('refuses an executable named as a PDF at upload, so it can never be filed', async () => {
    const response = await consolePost(api.server, manager, '/v1/files').field('purpose', 'SUPPLIER_DOCUMENT').attach('file', executable(), 'health-certificate.pdf');
    expect(response.status).toBe(415);
    expect(response.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('files a scanned PDF privately, lists it, links it for 5 minutes, and refuses an unscanned file, another purpose and a second filing', async () => {
    const kpone = supplier('Kpone Livestock Traders');
    const fileId = await uploaded(manager, pdf(), 'vet-health-cert-kpone.pdf');
    // A certificate good for a hundred days from today, whatever day the suite runs on (B09t2).
    const expiresOn = addDays(toBusinessDate(clock.now()), 100);
    const filed = await post(manager, `/suppliers/${kpone}/documents`, { kind: 'HEALTH_CERTIFICATE', fileId, expiresOn });
    expect(filed.status).toBe(201);
    expect(filed.body).toMatchObject({ kind: 'HEALTH_CERTIFICATE', expiresOn, file: { id: fileId, originalName: 'vet-health-cert-kpone.pdf', contentType: 'application/pdf' } });
    const listed = await get(accountant, `/suppliers/${kpone}/documents`);
    expect(listed.body.data.map((d: { id: string }) => d.id)).toContain(filed.body.id);
    const link = await request(api.server).post(`/v1/files/${fileId}/signed-url`).set('Cookie', accountant.jar.header()).set('X-CSRF-Token', accountant.csrfToken).set('Origin', TEST_ORIGIN);
    expect(link.status).toBe(200);
    expect(new Date(link.body.expiresAt as string).getTime() - clock.now().getTime()).toBe(300_000);

    const again = await post(manager, `/suppliers/${kpone}/documents`, { kind: 'CONTRACT', fileId });
    expect(again.body.error).toMatchObject({ code: 'SUPPLIER_DOCUMENT_INVALID', details: [{ field: '/fileId', code: 'FILE_ALREADY_FILED' }] });
    const pending = await uploaded(manager, pdf(), 'contract.pdf', false);
    expect((await post(manager, `/suppliers/${kpone}/documents`, { kind: 'CONTRACT', fileId: pending })).body.error.details).toEqual([expect.objectContaining({ field: '/fileId', code: 'FILE_NOT_USABLE' })]);
    const invoiceScan = await consolePost(api.server, manager, '/v1/files').field('purpose', 'SUPPLIER_INVOICE').attach('file', pdf(), 'invoice.pdf');
    expect((await post(manager, `/suppliers/${kpone}/documents`, { kind: 'OTHER', fileId: invoiceScan.body.id })).body.error.details[0].code).toBe('FILE_NOT_USABLE');
    const expired = await uploaded(manager, pdf(), 'tax-clearance-2025.pdf');
    expect((await post(manager, `/suppliers/${kpone}/documents`, { kind: 'TAX_CLEARANCE', fileId: expired, expiresOn: '2025-12-31' })).body.error.details[0].code).toBe('EXPIRED');
  });
});

describe('purchase requisitions (FR-PUR-004)', () => {
  async function submitted(session: TestSession, qty = '20.000') {
    const raised = await post(session, '/purchase-requisitions', { neededBy: today(), justification: 'Brooder pen 2 is empty', lines: [{ productId: id('product:LIV-0001'), qty }] });
    expect(raised.status).toBe(201);
    expect((await post(session, `/purchase-requisitions/${raised.body.id}/submit`)).status).toBe(200);
    return raised.body as { id: string; lines: { id: string }[] };
  }

  it('raises 20 broilers at the farm hand\'s pen, converts it into a draft order linked to it, and orders 20 at 5,500 (110,000)', async () => {
    const raised = await post(farmHand, '/purchase-requisitions', { neededBy: today(), lines: [{ productId: id('product:LIV-0001'), qty: '20.000', note: 'Day-old chicks are not wanted' }] });
    expect(raised.status).toBe(201);
    expect(raised.body).toMatchObject({ status: 'DRAFT', location: { code: 'PENS' }, lines: [{ lineNo: 1, qty: '20.000', uom: 'HEAD' }], purchaseOrder: null, rejectReason: null });
    const changed = await patch(farmHand, `/purchase-requisitions/${raised.body.id}`, { version: raised.body.version, justification: 'Brooder pen 2 is empty' });
    expect(changed.status).toBe(200);
    expect((await post(farmHand, `/purchase-requisitions/${raised.body.id}/submit`)).body.status).toBe('SUBMITTED');
    expect((await patch(farmHand, `/purchase-requisitions/${raised.body.id}`, { version: changed.body.version + 1, justification: 'Too late' })).status).toBe(422);

    const converted = await post(manager, `/purchase-requisitions/${raised.body.id}/convert`, {
      supplierId: supplier('Awutu Poultry Farm'),
      deliverToLocationId: id('location:PENS'),
      lines: [{ lineId: raised.body.lines[0].id, unitPricePesewas: 5_500 }],
    });
    expect(converted.status).toBe(201);
    expect(converted.body).toMatchObject({ status: 'DRAFT', grossPesewas: 110_000, lines: [{ qtyOrdered: '20.000', unitPricePesewas: 5_500, lineNetPesewas: 110_000 }] });
    const requisition = await get(manager, `/purchase-requisitions/${raised.body.id}`);
    expect(requisition.body).toMatchObject({ status: 'CONVERTED', purchaseOrder: { id: converted.body.id, docType: 'PURCHASE_ORDER' } });
    expect((await post(manager, `/purchase-requisitions/${raised.body.id}/convert`, { supplierId: supplier('Awutu Poultry Farm'), deliverToLocationId: id('location:PENS'), lines: [{ lineId: raised.body.lines[0].id, unitPricePesewas: 5_500 }] })).status).toBe(422);
  });

  it('cannot convert a rejected requisition', async () => {
    const raised = await submitted(pensStorekeeper);
    const rejected = await post(manager, `/purchase-requisitions/${raised.id}/reject`, { reason: 'Bought at the market last week' });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ status: 'REJECTED', rejectReason: 'Bought at the market last week' });
    const refused = await post(manager, `/purchase-requisitions/${raised.id}/convert`, { supplierId: supplier('Awutu Poultry Farm'), deliverToLocationId: id('location:PENS'), lines: [{ lineId: raised.lines[0]!.id, unitPricePesewas: 5_500 }] });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await count("SELECT count(*)::int AS n FROM pur.purchase_requisition WHERE id = $1 AND purchase_order_id IS NULL AND status = 'REJECTED'", [raised.id])).toBe(1);
  });

  it('refuses a line not on the requisition, a past needed-by date and no lines', async () => {
    const raised = await submitted(farmHand);
    const stray = await post(manager, `/purchase-requisitions/${raised.id}/convert`, { supplierId: supplier('Awutu Poultry Farm'), deliverToLocationId: id('location:PENS'), lines: [{ lineId: randomUUID(), unitPricePesewas: 5_500 }] });
    expect(stray.body.error).toMatchObject({ code: 'PURCHASE_REQUISITION_INVALID', details: [{ field: '/lines/0/lineId', code: 'LINE_NOT_ON_REQUISITION' }] });
    const past = await post(farmHand, '/purchase-requisitions', { neededBy: '2025-01-01', lines: [] });
    expect(past.body.error.details.map((d: { code: string }) => d.code).sort()).toEqual(['NEEDED_BY_PAST', 'NO_LINES']);
  });

  it('shows the Farm hand only requisitions at the pens, and needs a location from a reader of several', async () => {
    const listed = await get(farmHand, '/purchase-requisitions');
    expect(listed.status).toBe(200);
    expect(listed.body.data.every((r: { location: { code: string } | null }) => r.location?.code === 'PENS')).toBe(true);
    const shop = await post(manager, '/purchase-requisitions', { locationId: id('location:SHOP'), lines: [{ productId: id('product:LIV-0001'), qty: '5.000' }] });
    expect(shop.status).toBe(201);
    expect((await get(farmHand, `/purchase-requisitions/${shop.body.id}`)).status).toBe(403);
  });

  it('is held by the database: a converted requisition names its order, a submitted one keeps its lines', async () => {
    const raised = await submitted(pensStorekeeper);
    expect(await sqlStateOf(database.pool('app').query("UPDATE pur.purchase_requisition SET version = version + 1, status = 'CONVERTED', posted_at = now(), posted_by = created_by WHERE id = $1", [raised.id]))).toBe(
      SQLSTATE.checkViolation,
    );
    expect(await sqlStateOf(database.pool('app').query("UPDATE pur.purchase_requisition_line SET qty = 40 WHERE requisition_id = $1", [raised.id]))).toBe('HK004');
    expect(await sqlStateOf(database.pool('app').query("UPDATE pur.purchase_requisition SET version = version + 1, status = 'DRAFT' WHERE id = $1", [raised.id]))).toBe('HK004');
  });
});

describe('the first payment after a payout change waits for a second person whatever the amount (owner, 2026-11-15, A-170)', () => {
  it('holds a 500-pesewa payment right after a change for a second person, and the next one follows the payment policy', async () => {
    const dodowa = supplier('Dodowa Vegetable Growers Cooperative');
    await payoutInForce(dodowa, { method: 'MOBILE_MONEY', momoNetwork: 'MTN', momoNumber: '+233240000303' });
    const pay = async (amount: number) => {
      const created = await post(accountant, '/supplier-payments', { supplierId: dodowa, method: 'MOBILE_MONEY', allocations: [{ supplierInvoiceId: await approvedExpenseInvoice(dodowa, amount), amountPesewas: amount }] });
      expect(created.status).toBe(201);
      return created.body.id as string;
    };
    const flag = async (paymentId: string) => (await admin().query<{ f: boolean }>('SELECT payout_first_use AS f FROM pur.supplier_payment WHERE id = $1', [paymentId])).rows[0]!.f;

    const first = await pay(500);
    expect(await flag(first)).toBe(true);
    expect((await post(accountant, `/supplier-payments/${first}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: `MOMO-${randomUUID().slice(0, 8)}` })).status).toBe(422);
    const held = await post(accountant, `/supplier-payments/${first}/submit`);
    expect(held.status).toBe(202);
    expect(held.body.summary).toMatch(/^First payment since the payout details changed: /);
    expect((await approve(manager, held.body.approvalRequestId)).status).toBe(200);
    expect((await post(accountant, `/supplier-payments/${first}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: `MOMO-${randomUUID().slice(0, 8)}` })).status).toBe(200);

    const next = await pay(500);
    expect(await flag(next)).toBe(false);
    const normal = await post(accountant, `/supplier-payments/${next}/submit`);
    expect(normal.status).toBe(202);
    expect(normal.body.summary).toMatch(/^Pay /);
    // The database decides the flag and never lets it change.
    expect(await sqlStateOf(database.pool('app').query('UPDATE pur.supplier_payment SET version = version + 1, payout_first_use = true WHERE id = $1', [next]))).toBe('HK004');
  });

  it('counts a rejected first payment as never made, so the one after it is the first again', async () => {
    const dodowa = supplier('Dodowa Vegetable Growers Cooperative');
    await payoutInForce(dodowa, { method: 'MOBILE_MONEY', momoNetwork: 'MTN', momoNumber: '+233240000304' });
    const created = await post(accountant, '/supplier-payments', { supplierId: dodowa, method: 'MOBILE_MONEY', allocations: [{ supplierInvoiceId: await approvedExpenseInvoice(dodowa, 700), amountPesewas: 700 }] });
    const held = await post(accountant, `/supplier-payments/${created.body.id}/submit`);
    await stepUp(manager);
    expect((await post(manager, `/iam/approvals/${held.body.approvalRequestId}/reject`, { reason: 'Not the wallet on the letter' })).status).toBe(200);
    const again = await post(accountant, '/supplier-payments', { supplierId: dodowa, method: 'MOBILE_MONEY', allocations: [{ supplierInvoiceId: await approvedExpenseInvoice(dodowa, 700), amountPesewas: 700 }] });
    expect((await admin().query<{ f: boolean }>('SELECT payout_first_use AS f FROM pur.supplier_payment WHERE id = $1', [again.body.id])).rows[0]!.f).toBe(true);
  });
});

describe('cross-approval of payout changes and the person-level bar on the first payment (owner, 2026-11-15, A-171)', () => {
  // Fresh sessions: the approvals here step up often, and the sessions opened at the start would lapse.
  let owner: TotpSession;
  let manager: TotpSession;
  let accountant: TotpSession;

  beforeAll(async () => {
    const branchId = id('branch:DDW');
    owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kofi Owusu-Ansah', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
    manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Ama Boakye', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
    accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwame Asare', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  });

  async function invoiceOf(supplierId: string, amount: number): Promise<string> {
    const created = await post(accountant, '/supplier-invoices', {
      kind: 'INVOICE',
      supplierId,
      supplierInvoiceNo: `TR-${randomUUID().slice(0, 6)}`,
      invoiceDate: today(),
      branchId: id('branch:DDW'),
      lines: [{ description: 'Transport of produce from the farm gate', qty: '1.000', unitPricePesewas: amount, taxCategoryId: id('tax:LIVE_ANIMALS') }],
    });
    expect(created.status).toBe(201);
    await post(accountant, `/supplier-invoices/${created.body.id}/match`);
    expect((await post(accountant, `/supplier-invoices/${created.body.id}/approve`)).status).toBe(200);
    return created.body.id as string;
  }

  /** A new supplier, its first payout details made by `maker` and approved by `checker`, and an approved invoice of `amount`. */
  async function supplierWithWallet(name: string, phone: string, maker: TotpSession, checker: TotpSession, amount: number) {
    const created = await post(manager, '/suppliers', { name: `${name} (SEED)`, phone });
    expect(created.status).toBe(201);
    const supplierId = created.body.id as string;
    const version = (await get(accountant, `/suppliers/${supplierId}/profile`)).body.version as number;
    const asked = await put(maker, `/suppliers/${supplierId}/profile`, { version, payoutDetails: { method: 'MOBILE_MONEY', momoNetwork: 'MTN', momoNumber: phone } });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect((await approve(checker, asked.body.approvalRequestId)).status).toBe(200);
    return { supplierId, invoice: await invoiceOf(supplierId, amount) };
  }

  async function prepared(session: TestSession, supplierId: string, invoice: string, amount: number) {
    const payment = await post(session, '/supplier-payments', { supplierId, method: 'MOBILE_MONEY', allocations: [{ supplierInvoiceId: invoice, amountPesewas: amount }] });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);
    const submitted = await post(session, `/supplier-payments/${payment.body.id}/submit`);
    expect(submitted.status).toBe(202);
    return { id: payment.body.id as string, approvalRequestId: submitted.body.approvalRequestId as string };
  }

  it('lets the smallest team pay: the Owner makes the change, the Manager approves it, the Owner prepares the first payment and the Manager approves it', async () => {
    const { supplierId, invoice } = await supplierWithWallet('Nsawam Egg Farm', '+233240000401', owner, manager, 3_000);
    const payment = await prepared(owner, supplierId, invoice, 3_000);
    expect((await approve(manager, payment.approvalRequestId)).status).toBe(200);
    expect((await get(accountant, `/supplier-payments/${payment.id}`)).body.status).toBe('APPROVED');
  });

  it('refuses the Owner who made the change approving the first payment after it, with PAYOUT_MAKER_CANNOT_APPROVE', async () => {
    const { supplierId, invoice } = await supplierWithWallet('Akuse Fish Ponds', '+233240000402', owner, manager, 2_500);
    const payment = await prepared(accountant, supplierId, invoice, 2_500);
    const refused = await approve(owner, payment.approvalRequestId);
    expect([refused.status, refused.body.error.code]).toEqual([422, 'PAYOUT_MAKER_CANNOT_APPROVE']);
    expect((await get(accountant, `/supplier-payments/${payment.id}`)).body.status).toBe('PENDING_APPROVAL');
    // The change's approver is not barred.
    expect((await approve(manager, payment.approvalRequestId)).status).toBe(200);
  });

  it('works the mirror way: the Manager makes the change and the Owner approves it, the Manager prepares and the Owner approves; the Manager approving their own change\'s first payment is refused', async () => {
    const mirror = await supplierWithWallet('Somanya Mango Growers', '+233240000403', manager, owner, 4_000);
    const payment = await prepared(manager, mirror.supplierId, mirror.invoice, 4_000);
    expect((await approve(owner, payment.approvalRequestId)).status).toBe(200);

    const barred = await supplierWithWallet('Asutsuare Rice Mill', '+233240000404', manager, owner, 1_000);
    const first = await prepared(accountant, barred.supplierId, barred.invoice, 1_000);
    const refused = await approve(manager, first.approvalRequestId);
    expect([refused.status, refused.body.error.code]).toEqual([422, 'PAYOUT_MAKER_CANNOT_APPROVE']);
  });

  it('lets the Accountant make a change the Owner approves', async () => {
    await supplierWithWallet('Adidome Cassava Traders', '+233240000405', accountant, owner, 1_000);
  });

  it('is held by the database: the first payment after a change is never approved by the change\'s maker', async () => {
    const { supplierId, invoice } = await supplierWithWallet('Kasoa Feed Mill', '+233240000406', owner, manager, 1_500);
    const payment = await prepared(accountant, supplierId, invoice, 1_500);
    const maker = (await admin().query<{ id: string }>("SELECT created_by AS id FROM pur.supplier_payout_change WHERE supplier_id = $1 AND status = 'APPROVED'", [supplierId])).rows[0]!.id;
    expect(await sqlStateOf(database.pool('app').query("UPDATE pur.supplier_payment SET version = version + 1, status = 'APPROVED', updated_by = $2 WHERE id = $1", [payment.id, maker]))).toBe('HK010');
  });
});

// Last: it moves the clock past the step-up window, which the sessions above would not survive for long.
describe('reading payout details in full (FR-PUR-002, ADR-0022)', () => {
  it('decrypts in full only for the payout permission with a fresh step-up, and audits each read', async () => {
    const tema = supplier('Tema Packaging Supplies');
    const fresh = await enrolAndLogin(api.server, await createUser(database, { name: 'Ama Serwaa', grants: [{ role: 'ACCOUNTANT', branchId: id('branch:DDW') }] }), () => clock.now());
    // A login counts as a step-up; five minutes later it no longer does.
    clock.advanceBy(301_000);
    const refused = await get(fresh, `/suppliers/${tema}/payout-details`);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('STEP_UP_REQUIRED');
    await stepUp(fresh);
    const before = await count("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'DECRYPT' AND entity_id = $1", [tema]);
    const read = await get(fresh, `/suppliers/${tema}/payout-details`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      supplierId: tema,
      inForce: { method: 'BANK', bankName: 'GCB Bank', accountName: 'Tema Packaging Supplies', accountNumber: '0000000091180', bankBranch: null, momoNetwork: null, momoNumber: null },
      pending: null,
    });
    expect(await count("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'DECRYPT' AND entity_id = $1", [tema])).toBe(before + 1);
  });
});

// After the step-up window moved: fresh sessions, a limit the owner sets, and orders judged by it.
describe('the purchase order approval limit is a setting, and order splitting is flagged (owner, 2026-11-15, A-168)', () => {
  const LIMIT = 'pur.purchase_order.approval_limit_pesewas';
  let storekeeper: TestSession;
  let boss: TotpSession;
  let lateManager: TestSession;

  beforeAll(async () => {
    const branchId = id('branch:DDW');
    storekeeper = await login(api.server, await createUser(database, { name: 'Yaw Sarpong', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:PENS') }] }));
    boss = await enrolAndLogin(api.server, await createUser(database, { name: 'Akua Mensah', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
    lateManager = await enrolAndLogin(api.server, await createUser(database, { name: 'Kofi Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  });

  async function submittedOrder(supplierName: string, qty: string, unitPricePesewas: number) {
    const created = await post(storekeeper, '/purchase-orders', { supplierId: supplier(supplierName), deliverToLocationId: id('location:PENS'), orderDate: today(), lines: [{ productId: id('product:LIV-0001'), qtyOrdered: qty, unitPricePesewas }] });
    expect(created.status).toBe(201);
    return { id: created.body.id as string, submitted: await post(storekeeper, `/purchase-orders/${created.body.id}/submit`) };
  }

  it('flags three orders of 190,000 to one supplier by one maker in three days, and not three spread ten days apart', async () => {
    const run = [];
    for (let day = 0; day < 3; day += 1) run.push(await submittedOrder('Awutu Poultry Farm', '38.000', 5_000));
    expect(run.map((o) => o.submitted.body.status)).toEqual(['APPROVED', 'APPROVED', 'APPROVED']);
    const spread = [];
    for (let i = 0; i < 3; i += 1) spread.push(await submittedOrder('Kpone Livestock Traders', '38.000', 5_000));
    // Two days between the run's orders, and ten days between the spread ones, as the record of when each was submitted.
    for (const [i, o] of run.entries()) await admin().query("UPDATE pur.purchase_order SET posted_at = posted_at - make_interval(days => $2), version = version + 1 WHERE id = $1", [o.id, 2 - i]);
    for (const [i, o] of spread.entries()) await admin().query("UPDATE pur.purchase_order SET posted_at = posted_at - make_interval(days => $2), version = version + 1 WHERE id = $1", [o.id, 20 - 10 * i]);
    const suspects = await api.app.get(UnitOfWork).run({ isolation: 'read committed' }, (tx) =>
      api.app.get(PurchaseOrders).splitSuspectsIn(tx, new Date(clock.now().getTime() - 30 * 86_400_000), new Date(clock.now().getTime() + 86_400_000)),
    );
    const maker = (await admin().query<{ id: string }>("SELECT created_by AS id FROM pur.purchase_order WHERE id = $1", [run[0]!.id])).rows[0]!.id;
    expect(suspects.filter((s) => s.makerId === maker).map((s) => [s.supplierId, [...s.orderIds].sort(), s.totalPesewas])).toEqual([[supplier('Awutu Poultry Farm'), run.map((o) => o.id).sort(), 570_000n]]);
  });

  it('changes the limit only for the setting permission with a fresh step-up, audits 200,000 to 100,000, and judges the next order by it', async () => {
    expect((await put(lateManager, `/admin/settings/${LIMIT}`, { value: 100_000, version: 0 })).status).toBe(403);
    clock.advanceBy(301_000);
    const stale = await put(boss, `/admin/settings/${LIMIT}`, { value: 100_000, version: 0 });
    expect([stale.status, stale.body.error.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    await stepUp(boss);
    expect((await put(boss, `/admin/settings/${LIMIT}`, { value: -5, version: 0 })).body.error).toMatchObject({ code: 'SETTING_INVALID', details: [{ field: '/value', code: 'OUT_OF_RANGE' }] });
    expect((await put(boss, '/admin/settings/pur.no_such_setting', { value: 1, version: 0 })).status).toBe(404);
    const later = await put(boss, `/admin/settings/${LIMIT}`, { value: 50_000, version: 0, validFrom: new Date(clock.now().getTime() + 7 * 86_400_000).toISOString() });
    expect(later.status).toBe(200);
    const changed = await put(boss, `/admin/settings/${LIMIT}`, { value: 100_000, version: 0 });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ key: LIMIT, branchId: null, value: 100_000, valueType: 'PESEWAS', version: 1 });
    expect((await put(boss, `/admin/settings/${LIMIT}`, { value: 120_000, version: 0 })).status).toBe(409);
    const { rows } = await admin().query<{ before: string; after: string }>(
      `SELECT convert_from("before", 'UTF8') AS before, convert_from("after", 'UTF8') AS after FROM platform.audit_event
        WHERE entity_type = 'Setting' AND action = 'UPDATE' AND convert_from("after", 'UTF8') LIKE '%100000%'`,
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.before)).toMatchObject({ key: LIMIT, value: 200_000, isDefault: true });
    expect(JSON.parse(rows[0]!.after)).toMatchObject({ key: LIMIT, value: 100_000 });
    // 20 broilers at 5,500 is 110,000: within the old limit, above the new one, which the far-off 50,000 does not yet replace.
    const order = await submittedOrder('Awutu Poultry Farm', '20.000', 5_500);
    expect(order.submitted.status).toBe(202);
    const atLimit = await submittedOrder('Awutu Poultry Farm', '20.000', 5_000);
    expect(atLimit.submitted.body).toMatchObject({ status: 'APPROVED' });
  });
});
