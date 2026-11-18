import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consolePost, createUser, enrolAndLogin, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * A supplier payment names the farm's own account it leaves from (B08 continued 1b2 gate, A-185, A-194): PUR accepts
 * only an active account of the method's kind through FIN's public door, the payment answers the account by its last
 * four digits, `pur.SupplierPaymentMade` carries it, and the ledger credits that account's own subledger party to the
 * pesewa; a payment naming none still posts to "Bank account not yet named". The database keeps the account a payment
 * names and refuses one on a cash payment. Over the seeded farm: Awutu Poultry Farm is paid by bank transfer, Kpone
 * Livestock Traders by MTN mobile money.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
type TotpSession = TestSession & { readonly secret: Buffer };
const sessions = new Map<string, TestSession>();
const ids = new Map<string, string>();

const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, sessions.get(who)!, `/v1${path}`, key).send(body);
const patch = (who: string, path: string, body: object, key: string = randomUUID()) => {
  const session = sessions.get(who)!;
  return request(api.server).patch(`/v1${path}`).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).send(body);
};
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const id = (code: string) => ids.get(code)!;
const today = () => toBusinessDate(clock.now());

async function stepUp(who: string): Promise<void> {
  clock.advanceBy(30_000);
  const session = sessions.get(who) as TotpSession;
  expect((await post(who, '/auth/step-up', { code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
}

/** An approved expense invoice (transport) from a seeded supplier, needing no match, for a payment to allocate to. */
async function approvedExpenseInvoice(supplier: string, amount: number): Promise<string> {
  const created = await post('accountant', '/supplier-invoices', {
    kind: 'INVOICE',
    supplierId: id(`supplier:${supplier} (SEED)`),
    supplierInvoiceNo: `INV-${randomUUID().slice(0, 8)}`,
    invoiceDate: today(),
    branchId: id('branch:DDW'),
    lines: [{ description: 'Transport of livestock to Dodowa', qty: '1.000', unitPricePesewas: amount, taxCategoryId: id('tax:LIVE_ANIMALS') }],
  });
  expect(created.status).toBe(201);
  expect((await post('accountant', `/supplier-invoices/${created.body.id}/match`)).body.matchStatus).toBe('NOT_REQUIRED');
  expect((await post('owner', `/supplier-invoices/${created.body.id}/approve`)).status).toBe(200);
  return created.body.id as string;
}

/** Prepares, submits, has the Manager approve and marks paid a payment; answers the ledger lines posted for it. */
async function pay(body: Record<string, unknown>): Promise<{ payment: Record<string, unknown>; lines: [string, string, number, string | null][] }> {
  const created = await post('accountant', '/supplier-payments', body);
  expect(created.status).toBe(201);
  const submitted = await post('accountant', `/supplier-payments/${created.body.id}/submit`);
  expect(submitted.status).toBe(202);
  await stepUp('manager');
  expect((await post('manager', `/iam/approvals/${submitted.body.approvalRequestId}/approve`, { reason: 'Checked against the invoice' })).status).toBe(200);
  const paid = await post('accountant', `/supplier-payments/${created.body.id}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: `REF-${randomUUID().slice(0, 8)}` });
  expect(paid.status).toBe(200);
  const { rows } = await admin().query<{ code: string; side: string; amount: string; party: string | null }>(
    `SELECT a.code, l.side, l.amount_pesewas::text AS amount, p.kind || ':' || p.display_name AS party
       FROM fin.journal_entry e JOIN fin.journal_line l ON l.journal_entry_id = e.id JOIN fin.account a ON a.id = l.account_id
       LEFT JOIN fin.subledger_party p ON p.id = l.subledger_party_id
      WHERE e.source_document_id = $1 ORDER BY l.line_no`,
    [created.body.id],
  );
  return { payment: paid.body as Record<string, unknown>, lines: rows.map((r) => [r.code, r.side, Number(r.amount), r.party]) };
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier
       UNION ALL SELECT 'tax:' || code, id FROM mdm.tax_category`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  for (const [who, name, role] of [
    ['owner', 'Kwabena Owusu', 'OWNER'],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT'],
    ['manager', 'Akosua Boateng', 'MANAGER'],
  ] as const) {
    sessions.set(who, await enrolAndLogin(api.server, await createUser(database, { name, grants: [{ role, branchId }] }), () => clock.now()));
  }
  await stepUp('owner');
  for (const [code, body] of [
    ['bank:GCB', { kind: 'BANK', name: 'GCB current account', institution: 'GCB Bank', accountNo: '2040016620' }],
    ['bank:MOMO', { kind: 'MOBILE_MONEY', name: 'MTN MoMo merchant wallet', institution: 'MTN Mobile Money', accountNo: '+233244127310' }],
  ] as const) {
    const created = await post('owner', '/finance/bank-accounts', body);
    expect(created.status).toBe(201);
    ids.set(code, created.body.id as string);
  }
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('a supplier payment names the account it leaves from (A-185, A-194)', () => {
  it('credits the named account\'s own party with the exact amount, by bank transfer from GCB', async () => {
    const invoice = await approvedExpenseInvoice('Awutu Poultry Farm', 1_000_001);
    const { payment, lines } = await pay({
      supplierId: id('supplier:Awutu Poultry Farm (SEED)'),
      method: 'BANK',
      bankAccountId: id('bank:GCB'),
      allocations: [{ supplierInvoiceId: invoice, amountPesewas: 1_000_001 }],
    });
    expect(payment).toMatchObject({ status: 'PAID', amountPesewas: 1_000_001, bankAccount: { id: id('bank:GCB'), name: 'GCB current account', kind: 'BANK', last4: '6620' } });
    expect(lines).toEqual([
      ['2000', 'D', 1_000_001, 'SUPPLIER:Awutu Poultry Farm (SEED)'],
      ['1100', 'C', 1_000_001, 'BANK_ACCOUNT:GCB current account'],
    ]);
    const outbox = await admin().query<{ bank: string | null }>("SELECT payload->>'bankAccountId' AS bank FROM platform.outbox_message WHERE event_type = 'pur.SupplierPaymentMade' AND subject_id = $1", [
      payment['id'],
    ]);
    expect(outbox.rows).toEqual([{ bank: id('bank:GCB') }]);
  });

  it('still posts a payment naming no account to "Bank account not yet named" (A-185)', async () => {
    const invoice = await approvedExpenseInvoice('Kpone Livestock Traders', 40_050);
    const { payment, lines } = await pay({ supplierId: id('supplier:Kpone Livestock Traders (SEED)'), method: 'MOBILE_MONEY', allocations: [{ supplierInvoiceId: invoice, amountPesewas: 40_050 }] });
    expect(payment['bankAccount']).toBeNull();
    expect(lines).toEqual([
      ['2000', 'D', 40_050, 'SUPPLIER:Kpone Livestock Traders (SEED)'],
      ['1110', 'C', 40_050, 'BANK_ACCOUNT:Bank account not yet named'],
    ]);
  });

  it('refuses an account of another kind, one for cash, an unknown one and a deactivated one with BANK_ACCOUNT_NOT_AVAILABLE', async () => {
    const invoice = await approvedExpenseInvoice('Kpone Livestock Traders', 10_000);
    const allocations = [{ supplierInvoiceId: invoice, amountPesewas: 10_000 }];
    const kpone = id('supplier:Kpone Livestock Traders (SEED)');
    await stepUp('accountant');
    const inactive = await patch('accountant', `/finance/bank-accounts/${id('bank:MOMO')}`, { version: 1, isActive: false });
    expect(inactive.body).toMatchObject({ isActive: false, version: 2 });
    for (const [method, bankAccountId] of [
      ['MOBILE_MONEY', id('bank:GCB')],
      ['CASH', id('bank:GCB')],
      ['BANK', id('bank:MOMO')],
      ['MOBILE_MONEY', randomUUID()],
      ['MOBILE_MONEY', id('bank:MOMO')],
    ] as const) {
      const refused = await post('accountant', '/supplier-payments', { supplierId: kpone, method, bankAccountId, allocations });
      expect([refused.status, refused.body.error.code, refused.body.error.details[0].code], `${method} ${bankAccountId}`).toEqual([422, 'SUPPLIER_PAYMENT_INVALID', 'BANK_ACCOUNT_NOT_AVAILABLE']);
    }
  });

  it('keeps the account a payment names, and refuses one on a cash payment, in the database', async () => {
    const { rows } = await admin().query<{ id: string; branch_id: string; supplier_id: string }>('SELECT id, branch_id, supplier_id FROM pur.supplier_payment WHERE bank_account_id IS NOT NULL LIMIT 1');
    const named = rows[0]!;
    expect(await sqlStateOf(app().query('UPDATE pur.supplier_payment SET bank_account_id = NULL WHERE id = $1', [named.id]))).toBe(SQLSTATE.documentFrozen);
    const client = await app().connect();
    try {
      await client.query('BEGIN');
      const docId = randomUUID();
      await client.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'SUPPLIER_PAYMENT', 'pur', $2, $3)", [docId, named.branch_id, SYSTEM_PRINCIPAL]);
      const state = await sqlStateOf(
        client.query(
          `INSERT INTO pur.supplier_payment (id, supplier_id, method, amount_pesewas, status, branch_id, bank_account_id, created_by, updated_by)
           VALUES ($1, $2, 'CASH', 100, 'DRAFT', $3, $4, $5, $5)`,
          [docId, named.supplier_id, named.branch_id, id('bank:GCB'), SYSTEM_PRINCIPAL],
        ),
      );
      expect(state).toBe(SQLSTATE.checkViolation);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
