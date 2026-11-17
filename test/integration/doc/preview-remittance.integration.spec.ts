import { createHash, randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Documents, type ArchivedRecord } from '../../../src/modules/doc';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { OBJECT_STORAGE, type ObjectStorage } from '../../../src/platform/storage/object-storage';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { SEED_TRANSPORT_INVOICE } from '../../../src/seed/farm-pur';
import { SEED_CREDIT_NOTE } from '../../../src/seed/farm-pur-credit';
import { documentWorker, type DocumentWorker } from '../../support/documents';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The template preview and the supplier remittance advice (FR-DOC-004, FR-PUR-013, ADR-0062, the B08 continued 2c
 * gate): a preview renders any version with the data given or its sample data, between two specimen markers, and
 * writes nothing at all; a supplier payment marked paid has its remittance advice rendered after commit from the data
 * fixed with `pur.SupplierRemittanceReady`, archived exactly once with the SHA-256 of its stored bytes and linked from
 * the payment once; a replay or a redelivery makes no second advice; every preview and archive read refuses the wrong
 * role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let uow: UnitOfWork;
let worker: DocumentWorker;
let branchId: string;
type Session = TestSession & { readonly secret?: Buffer };
const sessions = new Map<string, Session>();
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const SEEDED_INVOICE_VERSION = '01900000-0000-7000-8000-000000000511';
const SEEDED_RECEIPT_THERMAL_VERSION = '01900000-0000-7000-8000-000000000516';
const REMITTANCE_VERSION = '01900000-0000-7000-8000-000000000517';
const INVOICE_TEMPLATE = '01900000-0000-7000-8000-000000000501';

async function approve(checker: string, approvalRequestId: string) {
  clock.advanceBy(30_000);
  const step = await post(checker, '/auth/step-up', { code: totpAt(as(checker).secret!, Math.floor(clock.now().getTime() / 1000)) });
  expect(step.status).toBe(200);
  return post(checker, `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Checked against the transport invoice' });
}

/** Every row a preview could write, if it wrote anything: the archive, render jobs, files, numbers, the outbox, audit. */
async function writeCounts(): Promise<Record<string, number>> {
  const { rows } = await admin().query<Record<string, number>>(
    `SELECT (SELECT count(*)::int FROM doc.archived_document) AS archived,
            (SELECT count(*)::int FROM doc.render_job) AS jobs,
            (SELECT count(*)::int FROM platform.stored_file) AS files,
            (SELECT count(*)::int FROM platform.number_allocation) AS numbers,
            (SELECT count(*)::int FROM platform.business_document) AS documents,
            (SELECT count(*)::int FROM platform.outbox_message) AS outbox,
            (SELECT count(*)::int FROM platform.audit_event) AS audit,
            (SELECT count(*)::int FROM platform.idempotency_key) AS keys`,
  );
  return rows[0]!;
}

async function storedBytes(fileId: string): Promise<Buffer> {
  const { rows } = await admin().query<{ bucket: string; object_key: string }>('SELECT bucket, object_key FROM platform.stored_file WHERE id = $1', [fileId]);
  return api.app.get<ObjectStorage>(OBJECT_STORAGE).get(rows[0]!.bucket, rows[0]!.object_key);
}

async function archivedOf(documentId: string): Promise<ArchivedRecord[]> {
  return uow.run({ isolation: 'read committed' }, async (tx) => {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM doc.archived_document WHERE business_document_id = $1', [documentId]);
    return api.app.get(Documents).archivedIn(tx, rows.map((r) => r.id));
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  uow = api.app.get(UnitOfWork);
  worker = documentWorker(api, database, clock);
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  const people: [string, string, string, boolean][] = [
    ['owner', 'Kwabena Owusu', 'OWNER', true],
    ['manager', 'Akosua Boateng', 'MANAGER', true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
    ['cashier', 'Adwoa Darko', 'CASHIER', false],
    ['sales', 'Esi Appiah', 'SALES', false],
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', false],
    ['farmHand', 'Abdul-Rahman Iddrisu', 'FARM_HAND', false],
    ['driver', 'Selorm Agbeko', 'DRIVER', false],
  ];
  for (const [who, name, role, privileged] of people) {
    const user = await createUser(database, { name, grants: [{ role: role as 'OWNER', branchId }] });
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  await worker.settle();
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('a template preview renders a specimen and writes nothing (FR-DOC-004, ADR-0062)', () => {
  const invoiceData = {
    title: 'Invoice',
    documentNo: 'INV-2026-DDW-999999',
    issueDate: '2026-11-16',
    branch: { name: 'Dodowa' },
    customer: { name: 'Royal Palm Hotel Ltd' },
    lines: [{ description: 'Goat meat, 15 kg pack', quantity: '1.000', uom: 'PACK', unitPrice: 'GHS 425.60', gross: 'GHS 425.60', levies: [] }],
    net: 'GHS 354.67',
    levyTotals: [],
    gross: 'GHS 425.60',
    pricing: 'include tax',
  };

  it('renders an A4 version with the data given, marked as a specimen first and last, and stores, numbers or audits nothing', async () => {
    const before = await writeCounts();
    const response = await post('manager', `/template-versions/${SEEDED_INVOICE_VERSION}/preview`, { data: invoiceData });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ templateVersionId: SEEDED_INVOICE_VERSION, output: 'PDF_A4', escPosBase64: null, url: null, expiresAt: null });
    const pdf = Buffer.from(response.body.pdfBase64 as string, 'base64');
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    const text = pdf.toString('latin1');
    expect(text.split('SPECIMEN PREVIEW - NOT A VALID DOCUMENT').length - 1).toBe(2);
    expect(text).toContain('INV-2026-DDW-999999');
    expect(text).toContain('Royal Palm Hotel Ltd');
    expect(await writeCounts()).toEqual(before);
    // The same version and data give the same bytes: nothing in a preview depends on the moment it was made.
    const again = await post('accountant', `/template-versions/${SEEDED_INVOICE_VERSION}/preview`, { data: invoiceData });
    expect(again.body.pdfBase64).toBe(response.body.pdfBase64);
  });

  it('previews a draft with its own sample data, a thermal version as ESC/POS, and refuses a version with no data to render', async () => {
    const draft = await post('manager', `/document-templates/${INVOICE_TEMPLATE}/versions`, {
      body: '<h1>HaKorem Farms</h1><p>{{title}} {{documentNo}}</p><footer>Draft footer</footer>',
      sampleData: { title: 'Invoice', documentNo: 'SAMPLE-1' },
    });
    expect(draft.status).toBe(201);
    const before = await writeCounts();
    const sample = await post('owner', `/template-versions/${draft.body.id}/preview`, {});
    expect(sample.status).toBe(200);
    const text = Buffer.from(sample.body.pdfBase64 as string, 'base64').toString('latin1');
    expect(text).toContain('SAMPLE-1');
    expect(text).toContain('Draft footer');
    expect((await get('owner', `/template-versions/${draft.body.id}`)).body.status).toBe('DRAFT');

    const thermal = await post('manager', `/template-versions/${SEEDED_RECEIPT_THERMAL_VERSION}/preview`, { data: { title: 'Receipt', documentNo: 'RCP-X', lines: [], levyTotals: [], net: 'GHS 1.00', gross: 'GHS 1.00' } });
    expect(thermal.status).toBe(200);
    expect(thermal.body).toMatchObject({ output: 'THERMAL_80MM', pdfBase64: null });
    const escPos = Buffer.from(thermal.body.escPosBase64 as string, 'base64');
    expect(escPos.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
    expect(escPos.toString('latin1')).toContain('SPECIMEN PREVIEW');

    const remittance = await post('accountant', `/template-versions/${REMITTANCE_VERSION}/preview`, {});
    expect(remittance.status).toBe(200);
    expect(Buffer.from(remittance.body.pdfBase64 as string, 'base64').toString('latin1')).toContain('Sample Supplier Ltd');

    const none = await post('manager', `/template-versions/${SEEDED_INVOICE_VERSION}/preview`, {});
    expect(none.status).toBe(422);
    expect(none.body.error).toMatchObject({ code: 'PREVIEW_DATA_REQUIRED' });
    expect((await post('manager', `/template-versions/${randomUUID()}/preview`, { data: {} })).status).toBe(404);
    expect((await post('manager', `/template-versions/${SEEDED_INVOICE_VERSION}/preview`, { data: [], extra: 1 })).status).toBe(400);
    expect(await writeCounts()).toEqual(before);
  });

  it('refuses the preview to every role without doc.template.read, and renders nothing for them', async () => {
    for (const who of ['cashier', 'sales', 'storekeeper', 'farmHand', 'driver']) {
      const response = await post(who, `/template-versions/${SEEDED_INVOICE_VERSION}/preview`, { data: invoiceData });
      expect(response.status, who).toBe(403);
      expect(response.body.pdfBase64, who).toBeUndefined();
    }
  });
});

describe('a supplier remittance advice is rendered from the remittance data and archived once (FR-PUR-013, ADR-0062)', () => {
  let paymentId: string;
  let paidKey: string;
  let remittanceId: string;

  // The seeded transport invoice, GHS 150.00, less the seeded credit note of GHS 15.00 approved against it.
  const OWED = SEED_TRANSPORT_INVOICE.amountPesewas - SEED_CREDIT_NOTE.amountPesewas;

  it('renders after commit, archives once with the SHA-256 of its stored bytes, and links the archive from the payment once', async () => {
    const supplierId = (await admin().query<{ id: string }>('SELECT id FROM mdm.supplier WHERE name = $1', [SEED_TRANSPORT_INVOICE.supplier])).rows[0]!.id;
    const invoice = (await admin().query<{ id: string; gross: number; status: string }>('SELECT id, gross_pesewas::int AS gross, status FROM pur.supplier_invoice WHERE supplier_invoice_no = $1', [SEED_TRANSPORT_INVOICE.supplierInvoiceNo])).rows[0]!;
    expect(invoice).toMatchObject({ gross: SEED_TRANSPORT_INVOICE.amountPesewas, status: 'APPROVED' });
    const created = await post('accountant', '/supplier-payments', { supplierId, method: 'CASH', allocations: [{ supplierInvoiceId: invoice.id, amountPesewas: OWED }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    paymentId = created.body.id;
    const submitted = await post('accountant', `/supplier-payments/${paymentId}/submit`);
    expect((await approve('manager', submitted.body.approvalRequestId)).status).toBe(200);
    paidKey = randomUUID();
    const paid = await post('accountant', `/supplier-payments/${paymentId}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'CASH-VOUCHER-0091' }, paidKey);
    expect(paid.status).toBe(200);
    expect(paid.body.remittanceDocumentId).toBeNull();

    remittanceId = (await admin().query<{ id: string }>('SELECT id FROM pur.supplier_remittance WHERE supplier_payment_id = $1', [paymentId])).rows[0]!.id;
    const { rows: registered } = await admin().query('SELECT doc_type, owner_module, branch_id FROM platform.business_document WHERE id = $1', [remittanceId]);
    expect(registered).toEqual([{ doc_type: 'REMITTANCE_ADVICE', owner_module: 'pur', branch_id: branchId }]);
    const { rows: jobs } = await admin().query<{ status: string; template_version_id: string }>('SELECT status, template_version_id FROM doc.render_job WHERE business_document_id = $1', [remittanceId]);
    expect(jobs).toEqual([{ status: 'QUEUED', template_version_id: REMITTANCE_VERSION }]);
    // The render was asked for by the event that fixed the data, in the same transaction.
    const { rows: chain } = await admin().query<{ ready: string; caused: string | null }>(
      `SELECT r.id AS ready, q.causation_id AS caused FROM platform.outbox_message r
         JOIN platform.outbox_message q ON q.event_type = 'doc.RenderRequested' AND q.subject_id = $2
        WHERE r.event_type = 'pur.SupplierRemittanceReady' AND r.subject_id = $1`,
      [paymentId, remittanceId],
    );
    expect(chain).toHaveLength(1);
    expect(chain[0]!.caused).toBe(chain[0]!.ready);
    expect(await archivedOf(remittanceId)).toEqual([]);

    await worker.settle();
    const [archived, ...more] = await archivedOf(remittanceId);
    expect(more).toEqual([]);
    expect(archived!.docType).toBe('REMITTANCE_ADVICE');
    expect(archived!.documentNo).toBeNull();
    const pdf = await storedBytes(archived!.fileId);
    expect(sha256(pdf)).toBe(archived!.sha256.toString('hex'));
    const text = pdf.toString('latin1');
    // The payment is numbered from its SPY series when it is marked paid (A-205), and the advice prints that number in
    // place of the payment's id.
    const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Accra', year: 'numeric' }).format(clock.now());
    expect(paid.body.paymentNo).toMatch(new RegExp(`^SPY-${year}-DDW-\\d{6}$`));
    const { rows: allocated } = await admin().query('SELECT a.formatted, s.doc_type FROM platform.number_allocation a JOIN platform.number_series s ON s.id = a.series_id WHERE a.document_id = $1', [paymentId]);
    expect(allocated).toEqual([{ formatted: paid.body.paymentNo, doc_type: 'SUPPLIER_PAYMENT' }]);
    expect(text).toContain(paid.body.paymentNo);
    expect(text).not.toContain(paymentId);
    expect(text).toContain('KLT-T-0457');
    expect(OWED).toBe(13_500);
    expect(text).toContain('Total paid GHS 135.00');
    expect(text).not.toContain('SPECIMEN');
    expect(archived!.renderData).toMatchObject({ paymentNo: paid.body.paymentNo, amount: 'GHS 135.00', method: 'CASH', payee: null, externalReference: 'CASH-VOUCHER-0091' });
    expect(archived!.renderData['lines']).toEqual([{ supplierInvoiceNo: 'KLT-T-0457', invoiceDate: expect.any(String), gross: 'GHS 150.00', credited: 'GHS 15.00', amount: 'GHS 135.00', outstandingAfter: 'GHS 0.00' }]);

    const payment = await get('accountant', `/supplier-payments/${paymentId}`);
    expect(payment.body.remittanceDocumentId).toBe(archived!.id);
    expect((await get('manager', `/supplier-payments/${paymentId}/remittance`)).body.remittanceDocumentId).toBe(archived!.id);
    const view = await get('accountant', `/documents/${archived!.id}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ docType: 'REMITTANCE_ADVICE', businessDocument: { id: remittanceId, docType: 'REMITTANCE_ADVICE' }, sha256: archived!.sha256.toString('hex') });
  });

  it('makes no second advice on a replay, a repeat or a redelivery, and the link never changes', async () => {
    const replay = await post('accountant', `/supplier-payments/${paymentId}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'CASH-VOUCHER-0091' }, paidKey);
    expect(replay.status).toBe(200);
    expect((await post('accountant', `/supplier-payments/${paymentId}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'CASH-VOUCHER-0092' })).status).toBe(422);
    // Every delivery of the archive event, to both of its consumers, made again: nothing moves.
    await admin().query(
      `UPDATE platform.outbox_delivery d SET status = 'PENDING', next_attempt_at = now() - interval '1 minute', delivered_at = NULL
         FROM platform.outbox_message m WHERE m.id = d.message_id AND m.event_type IN ('doc.RenderRequested', 'doc.DocumentArchived') AND m.subject_id = $1`,
      [remittanceId],
    );
    await worker.settle();
    const counts = await admin().query<{ archived: number; jobs: number; remittances: number }>(
      `SELECT (SELECT count(*)::int FROM doc.archived_document WHERE business_document_id = $1) AS archived,
              (SELECT count(*)::int FROM doc.render_job WHERE business_document_id = $1) AS jobs,
              (SELECT count(*)::int FROM pur.supplier_remittance WHERE supplier_payment_id = $2) AS remittances`,
      [remittanceId, paymentId],
    );
    expect(counts.rows[0]).toMatchObject({ archived: 1, jobs: 1, remittances: 1 });
    const { rows: link } = await admin().query<{ remittance_document_id: string }>('SELECT remittance_document_id FROM pur.supplier_payment WHERE id = $1', [paymentId]);
    const other = (await admin().query<{ id: string }>('SELECT id FROM doc.archived_document WHERE business_document_id <> $1 LIMIT 1', [remittanceId])).rows[0]!.id;
    for (const pool of [database.pool('app'), admin()]) {
      expect(await sqlStateOf(pool.query('UPDATE pur.supplier_payment SET remittance_document_id = $2, version = version + 1 WHERE id = $1', [paymentId, other]))).toBe(SQLSTATE.documentFrozen);
      expect(await sqlStateOf(pool.query('UPDATE pur.supplier_payment SET remittance_document_id = NULL, version = version + 1 WHERE id = $1', [paymentId]))).toBe(SQLSTATE.documentFrozen);
    }
    expect((await admin().query('SELECT remittance_document_id FROM pur.supplier_payment WHERE id = $1', [paymentId])).rows).toEqual(link);
    // A payment that is not paid cannot name an advice: the guard refuses it before any other rule is checked.
    const early = admin().query(
      `INSERT INTO pur.supplier_payment (id, supplier_id, method, amount_pesewas, status, branch_id, created_by, updated_by, remittance_document_id)
       SELECT gen_random_uuid(), supplier_id, method, amount_pesewas, 'DRAFT', branch_id, created_by, updated_by, $2 FROM pur.supplier_payment WHERE id = $1`,
      [paymentId, other],
    );
    expect(await sqlStateOf(early)).toBe(SQLSTATE.documentFrozen);
  });

  it('serves the advice only to the roles that read the archive', async () => {
    const archivedId = (await admin().query<{ id: string }>('SELECT id FROM doc.archived_document WHERE business_document_id = $1', [remittanceId])).rows[0]!.id;
    for (const who of ['owner', 'manager', 'accountant']) {
      expect((await get(who, `/documents/${archivedId}`)).status, who).toBe(200);
    }
    for (const who of ['cashier', 'sales', 'storekeeper', 'farmHand', 'driver']) {
      expect((await get(who, `/documents/${archivedId}`)).status, who).toBe(403);
      expect((await post(who, `/documents/${archivedId}/download`, {})).status, who).toBe(403);
    }
  });
});
