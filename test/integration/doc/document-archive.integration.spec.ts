import { createHash, randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Billing, type IssueRequest } from '../../../src/modules/bil';
import { Documents, type ArchivedRecord } from '../../../src/modules/doc';
import { Authoriser } from '../../../src/modules/iam';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { DomainEvents } from '../../../src/platform/events/domain-events';
import { Cursors } from '../../../src/platform/http/cursor';
import { FileStore } from '../../../src/platform/storage/file-store';
import { OBJECT_STORAGE, type ObjectStorage } from '../../../src/platform/storage/object-storage';
import { PgDocStore } from '../../../src/modules/doc/infrastructure/pg-doc-store';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { documentWorker, type DocumentWorker } from '../../support/documents';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Rendering after commit, the immutable archive, reprints and templates (FR-BIL-008 to FR-BIL-010, FR-DOC-001,
 * FR-DOC-003, FR-DOC-004, FR-DOC-007, the B08 continued 2b gate): an issued document is rendered by the worker after
 * its transaction commits and archived exactly once with the SHA-256 of its stored bytes, the archive refusing change
 * by trigger; a render that throws leaves the document and its number intact and is retried; a reprint is the
 * archived bytes with a marker, copies 1 and 2, no new number, and a tampered archive is never served; a new template
 * version changes the next document and no issued one, and a script or remote include is refused at save; every DOC
 * and reprint write refuses the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let billing: Billing;
let uow: UnitOfWork;
let worker: DocumentWorker;
let branchId: string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const actorOf = (who: string): Actor => ({ principalId: users.get(who)!.principalId, kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });
const ids = new Map<string, string>();
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function issue(who: string, request: IssueRequest) {
  return runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'archive test', actor: actorOf(who) }, () =>
    uow.run({ isolation: 'serializable', seriesLocks: billing.seriesLocksFor(request.kind, request.branchId) }, (tx) => billing.issueIn(tx, actorOf(who), request)),
  );
}

const receiptOf = (): IssueRequest => ({
  kind: 'RECEIPT',
  branchId,
  taxInclusive: true,
  lines: [{ lineKind: 'PRODUCT', productId: ids.get('eggs')!, quantity: '2.000', unitPricePesewas: 6_000n }],
});

const invoiceOf = (): IssueRequest => ({
  kind: 'INVOICE',
  branchId,
  customerId: ids.get('tema')!,
  dueDate: toBusinessDate(clock.now()),
  taxInclusive: true,
  lines: [{ lineKind: 'PRODUCT', productId: ids.get('meat')!, quantity: '1.000', uom: 'PACK', unitPricePesewas: 42_560n }],
});

async function archivedOf(documentId: string): Promise<ArchivedRecord[]> {
  return uow.run({ isolation: 'read committed' }, async (tx) => {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM doc.archived_document WHERE business_document_id = $1', [documentId]);
    return api.app.get(Documents).archivedIn(tx, rows.map((r) => r.id));
  });
}

async function storedBytes(fileId: string): Promise<Buffer> {
  const { rows } = await admin().query<{ bucket: string; object_key: string }>('SELECT bucket, object_key FROM platform.stored_file WHERE id = $1', [fileId]);
  return api.app.get<ObjectStorage>(OBJECT_STORAGE).get(rows[0]!.bucket, rows[0]!.object_key);
}

async function seriesNext(kind: string): Promise<number> {
  const { rows } = await admin().query<{ next: number }>('SELECT max(next_value)::int AS next FROM platform.number_series WHERE doc_type = $1 AND branch_id = $2', [kind, branchId]);
  return rows[0]!.next;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  billing = api.app.get(Billing);
  uow = api.app.get(UnitOfWork);
  worker = documentWorker(api, database, clock);
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const [name, sql, value] of [
    ['tema', 'SELECT id FROM mdm.customer WHERE name = $1', 'Tema Cold Store Ltd (SEED)'],
    ['meat', 'SELECT id FROM mdm.product WHERE sku = $1', 'MEAT-0007'],
    ['eggs', 'SELECT id FROM mdm.product WHERE sku = $1', 'EGG-0003'],
  ] as const) {
    ids.set(name, (await admin().query<{ id: string }>(sql, [value])).rows[0]!.id);
  }
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
    users.set(who, user);
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  // The seeded day's documents are archived first, so each test below starts from a quiet outbox.
  await worker.settle();
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('a document is rendered after commit and archived exactly once (FR-DOC-001, FR-DOC-003, FR-BIL-008)', () => {
  it('queues the render in the issuing transaction, archives it once with the SHA-256 of the stored bytes, and links it', async () => {
    const receipt = await issue('cashier', receiptOf());
    expect(receipt.archivedDocumentId).toBeNull();
    const { rows: jobs } = await admin().query<{ status: string }>('SELECT status FROM doc.render_job WHERE business_document_id = $1', [receipt.id]);
    expect(jobs).toEqual([{ status: 'QUEUED' }]);
    expect(await archivedOf(receipt.id)).toEqual([]);

    await worker.settle();
    const [archived, ...more] = await archivedOf(receipt.id);
    expect(more).toEqual([]);
    const pdf = await storedBytes(archived!.fileId);
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(sha256(pdf)).toBe(archived!.sha256.toString('hex'));
    expect(archived!.thermal).not.toBeNull();
    expect(sha256(await storedBytes(archived!.thermal!.fileId))).toBe(archived!.thermal!.sha256.toString('hex'));
    expect(archived).toMatchObject({ docType: 'RECEIPT', documentNo: receipt.documentNo, branchId, revision: 1 });
    expect(pdf.toString('latin1')).toContain(`(Receipt ${receipt.documentNo}) Tj`);

    const read = await get('cashier', `/billing-documents/${receipt.id}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ archivedDocumentId: archived!.id, contentHash: archived!.sha256.toString('hex'), reprintCount: 0 });

    // A redelivery and a further pass change nothing: rendered once per requesting message.
    await worker.settle();
    expect(await archivedOf(receipt.id)).toHaveLength(1);
    const { rows: done } = await admin().query<{ status: string; attempts: number }>('SELECT status, attempts FROM doc.render_job WHERE business_document_id = $1', [receipt.id]);
    expect(done).toEqual([{ status: 'DONE', attempts: 1 }]);
  });

  it('refuses any change to the archive, for every role, and a second archive of the same document', async () => {
    const invoice = await issue('accountant', invoiceOf());
    await worker.settle();
    const [archived] = await archivedOf(invoice.id);
    for (const pool of [app(), admin()]) {
      expect(await sqlStateOf(pool.query("UPDATE doc.archived_document SET document_no = 'X' WHERE id = $1", [archived!.id]))).toMatch(/HK001|42501/);
      expect(await sqlStateOf(pool.query('DELETE FROM doc.archived_document WHERE id = $1', [archived!.id]))).toMatch(/HK001|42501/);
    }
    expect(await sqlStateOf(admin().query('TRUNCATE doc.archived_document CASCADE'))).toBe('HK001');
    const second = app().query(
      `INSERT INTO doc.archived_document (id, business_document_id, doc_type, document_no, branch_id, template_version_id, file_id, sha256, render_data, actor_id)
       SELECT $2, business_document_id, doc_type, document_no, branch_id, template_version_id, file_id, sha256, render_data, actor_id FROM doc.archived_document WHERE id = $1`,
      [archived!.id, randomUUID()],
    );
    expect(await sqlStateOf(second)).toBe('23505');
    const revision2 = app().query(
      `INSERT INTO doc.archived_document (id, business_document_id, doc_type, document_no, branch_id, template_version_id, file_id, sha256, render_data, revision, actor_id)
       SELECT $2, business_document_id, doc_type, document_no, branch_id, template_version_id, file_id, sha256, render_data, 2, actor_id FROM doc.archived_document WHERE id = $1`,
      [archived!.id, randomUUID()],
    );
    expect(await sqlStateOf(revision2)).toBe('23514');
    // The billing document's hash and archive are set once.
    expect(await sqlStateOf(app().query("UPDATE bil.billing_document SET content_hash = decode(repeat('00', 32), 'hex') WHERE id = $1", [invoice.id]))).toBe('HK004');
    expect(await sqlStateOf(app().query('UPDATE bil.billing_document SET archived_document_id = NULL, content_hash = NULL WHERE id = $1', [invoice.id]))).toBe('HK004');
  });

  it('keeps the issued document and its number when the renderer throws, and archives it once when it is retried', async () => {
    const failing = new Documents(
      uow,
      new PgDocStore(),
      api.app.get(FileStore),
      api.app.get(DomainEvents),
      api.app.get(Authoriser),
      api.app.get(Cursors),
      clock,
      300,
      api.logger,
      {
        pdf: () => {
          throw new Error('renderer down');
        },
        thermal: () => {
          throw new Error('renderer down');
        },
      },
    );
    const brokenEvents = new DomainEvents(clock);
    brokenEvents.registerConsumer(failing.renderConsumer);
    const brokenWorker = documentWorker(api, database, clock, brokenEvents);

    const before = await seriesNext('RECEIPT');
    const receipt = await issue('cashier', receiptOf());
    expect(await seriesNext('RECEIPT')).toBe(before + 1);
    expect(await brokenWorker.dispatch()).toMatchObject({ delivered: 0, failed: 1 });
    const { rows: failed } = await admin().query<{ status: string; attempts: number; last_error: string }>('SELECT status, attempts, last_error FROM doc.render_job WHERE business_document_id = $1', [receipt.id]);
    expect(failed).toEqual([{ status: 'FAILED', attempts: 1, last_error: 'Error: renderer down' }]);
    const { rows: delivery } = await admin().query<{ status: string }>(
      "SELECT d.status FROM platform.outbox_delivery d JOIN platform.outbox_message m ON m.id = d.message_id WHERE m.subject_id = $1 AND d.consumer = 'doc.render'",
      [receipt.id],
    );
    expect(delivery).toEqual([{ status: 'FAILED' }]);
    // The sale's document is untouched: issued, numbered, posted; it shows no archive yet.
    const { rows: document } = await admin().query<{ status: string; document_no: string; archived_document_id: string | null }>('SELECT status, document_no, archived_document_id FROM bil.billing_document WHERE id = $1', [receipt.id]);
    expect(document).toEqual([{ status: 'ISSUED', document_no: receipt.documentNo, archived_document_id: null }]);
    expect((await admin().query('SELECT 1 FROM fin.journal_entry WHERE source_document_id = $1', [receipt.id])).rowCount).toBe(1);
    expect((await post('cashier', `/billing-documents/${receipt.id}/reprint`, { channel: 'THERMAL' })).body.error).toMatchObject({ code: 'DOCUMENT_NOT_ARCHIVED', details: [{ code: 'RENDERING' }] });

    // The retry waits for its backoff, then the working renderer archives it once; the number never moved.
    clock.advanceBy(60_000);
    await worker.settle();
    expect(await archivedOf(receipt.id)).toHaveLength(1);
    expect(await seriesNext('RECEIPT')).toBe(before + 1);
    const { rows: job } = await admin().query<{ status: string; attempts: number }>('SELECT status, attempts FROM doc.render_job WHERE business_document_id = $1', [receipt.id]);
    expect(job).toEqual([{ status: 'DONE', attempts: 2 }]);
  });
});

describe('a reprint is the archived bytes with a marker, never a new document (FR-BIL-009)', () => {
  it('prints copies 1 and 2 byte-identical but for the marker, with no new number, and lists them', async () => {
    const invoice = await issue('accountant', invoiceOf());
    await worker.settle();
    const [archived] = await archivedOf(invoice.id);
    const original = await storedBytes(archived!.fileId);
    const before = await seriesNext('INVOICE');

    const firstKey = randomUUID();
    const one = await post('manager', `/billing-documents/${invoice.id}/reprint`, { channel: 'PDF' }, firstKey);
    const two = await post('cashier', `/billing-documents/${invoice.id}/reprint`, { channel: 'PDF' });
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(one.body).toMatchObject({ copyNo: 1, channel: 'PDF', url: null, escPosBase64: null, expiresAt: null });
    expect(two.body).toMatchObject({ copyNo: 2 });
    const first = Buffer.from(one.body.pdfBase64 as string, 'base64');
    const second = Buffer.from(two.body.pdfBase64 as string, 'base64');
    expect(first.subarray(0, original.length).equals(original)).toBe(true);
    expect(second.subarray(0, original.length).equals(original)).toBe(true);
    expect(first.subarray(original.length).toString('latin1')).toContain('(REPRINT 1) Tj');
    const differing = [...first].flatMap((byte, i) => (byte === second[i] ? [] : [i]));
    expect(first.length).toBe(second.length);
    expect(differing.map((i) => first.toString('latin1', i, i + 1) + second.toString('latin1', i, i + 1))).toEqual(['12']);
    expect(await seriesNext('INVOICE')).toBe(before);
    expect((await admin().query('SELECT 1 FROM bil.billing_document WHERE document_no = $1', [invoice.documentNo])).rowCount).toBe(1);
    // The archive and the document's hash are unchanged.
    expect(sha256(await storedBytes(archived!.fileId))).toBe(archived!.sha256.toString('hex'));

    // A replay of the first request answers copy 1 again and logs nothing.
    const replay = await post('manager', `/billing-documents/${invoice.id}/reprint`, { channel: 'PDF' }, firstKey);
    expect(replay.body.copyNo).toBe(1);
    const listed = await get('sales', `/billing-documents/${invoice.id}/reprints`);
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((r: { copyNo: number; channel: string; actor: { displayName: string } }) => [r.copyNo, r.channel, r.actor.displayName])).toEqual([
      [1, 'PDF', 'Akosua Boateng'],
      [2, 'PDF', 'Adwoa Darko'],
    ]);
    const read = await get('cashier', `/billing-documents/${invoice.id}`);
    expect(read.body.reprintCount).toBe(2);
    // Copy numbers run without a gap, held by the database.
    expect(await sqlStateOf(app().query("INSERT INTO bil.reprint_log (id, billing_document_id, copy_no, channel, actor_id) VALUES ($1, $2, 9, 'PDF', $3)", [randomUUID(), invoice.id, users.get('cashier')!.principalId]))).toBe('HK004');
    expect(await sqlStateOf(app().query('DELETE FROM bil.reprint_log WHERE billing_document_id = $1', [invoice.id]))).toMatch(/HK001|42501/);
  });

  it('reprints a receipt on thermal paper as the marker followed by the archived ESC/POS bytes', async () => {
    const receipt = await issue('cashier', receiptOf());
    await worker.settle();
    const [archived] = await archivedOf(receipt.id);
    const original = await storedBytes(archived!.thermal!.fileId);
    const reprint = await post('cashier', `/billing-documents/${receipt.id}/reprint`, { channel: 'THERMAL' });
    expect(reprint.status).toBe(200);
    const bytes = Buffer.from(reprint.body.escPosBase64 as string, 'base64');
    expect(bytes.subarray(bytes.length - original.length).equals(original)).toBe(true);
    expect(bytes.subarray(0, bytes.length - original.length).toString('latin1')).toContain('*** REPRINT 1 ***');
    expect(original.toString('latin1')).toContain(receipt.documentNo!);
    // An invoice has no thermal rendering.
    const invoice = await issue('accountant', invoiceOf());
    await worker.settle();
    expect((await post('manager', `/billing-documents/${invoice.id}/reprint`, { channel: 'THERMAL' })).body.error).toMatchObject({ code: 'DOCUMENT_NOT_ARCHIVED', details: [{ code: 'NO_THERMAL_RENDITION' }] });
  });

  it('never serves a tampered archive: the stored bytes must hash to the archived SHA-256', async () => {
    const invoice = await issue('accountant', invoiceOf());
    await worker.settle();
    const [archived] = await archivedOf(invoice.id);
    const { rows } = await admin().query<{ bucket: string; object_key: string }>('SELECT bucket, object_key FROM platform.stored_file WHERE id = $1', [archived!.fileId]);
    const original = await storedBytes(archived!.fileId);
    const forged = Buffer.from(original.toString('latin1').replace('GHS 425.60', 'GHS 125.60'), 'latin1');
    expect(forged.equals(original)).toBe(false);
    await api.app.get<ObjectStorage>(OBJECT_STORAGE).put(rows[0]!.bucket, rows[0]!.object_key, forged, { contentType: 'application/pdf' });
    const refused = await post('manager', `/billing-documents/${invoice.id}/reprint`, { channel: 'PDF' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('ARCHIVE_HASH_MISMATCH');
    expect((await admin().query('SELECT 1 FROM bil.reprint_log WHERE billing_document_id = $1', [invoice.id])).rowCount).toBe(0);
    expect(api.logLines().some((l) => l['msg'] === 'archived document does not match its SHA-256' && l['archivedDocumentId'] === archived!.id)).toBe(true);
  });

  it('refuses a reprint to every role but the Owner, the Manager and the Cashier, and writes nothing', async () => {
    const receipt = await issue('cashier', receiptOf());
    await worker.settle();
    for (const who of ['accountant', 'sales', 'storekeeper', 'farmHand', 'driver']) {
      const refused = await post(who, `/billing-documents/${receipt.id}/reprint`, { channel: 'PDF' });
      expect(refused.status, who).toBe(403);
    }
    expect((await admin().query('SELECT 1 FROM bil.reprint_log WHERE billing_document_id = $1', [receipt.id])).rowCount).toBe(0);
    expect((await post('owner', `/billing-documents/${receipt.id}/reprint`, { channel: 'PDF' })).status).toBe(200);
    expect((await get('storekeeper', `/billing-documents/${receipt.id}/reprints`)).status).toBe(403);
  });
});

describe('the archive is read by its readers only, by signed link (FR-DOC-007)', () => {
  it('lists, reads and links an archived document, each link logged; others are refused', async () => {
    const invoice = await issue('accountant', invoiceOf());
    await worker.settle();
    const [archived] = await archivedOf(invoice.id);
    const listed = await get('accountant', `/documents?businessDocumentId=${invoice.id}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0]).toMatchObject({
      id: archived!.id,
      businessDocument: { id: invoice.id, docType: 'INVOICE', number: invoice.documentNo },
      sha256: archived!.sha256.toString('hex'),
      revision: 1,
      file: { contentType: 'application/pdf', originalName: `${invoice.documentNo}.pdf` },
    });
    expect((await get('manager', `/documents/${archived!.id}`)).body.sha256).toBe(archived!.sha256.toString('hex'));
    const link = await post('owner', `/documents/${archived!.id}/download`, {});
    expect(link.status).toBe(200);
    expect(link.body.url).toContain(archived!.fileId);
    expect((await admin().query("SELECT 1 FROM platform.file_access_log WHERE file_id = $1 AND purpose = 'doc.archive.download'", [archived!.fileId])).rowCount).toBe(1);
    expect((await post('owner', `/documents/${archived!.id}/download`, { reprint: true })).body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ code: 'REPRINT_THROUGH_BILLING' }] });
    for (const who of ['cashier', 'sales', 'storekeeper', 'farmHand', 'driver']) {
      expect((await get(who, '/documents')).status, who).toBe(403);
      expect((await post(who, `/documents/${archived!.id}/download`, {})).status, who).toBe(403);
    }
  });
});

describe('templates are versioned data, sandboxed at save (FR-DOC-004, FR-BIL-010)', () => {
  const footerBody = '<header><h1>HaKorem Farms</h1></header><h2>{{title}} {{documentNo}}</h2>{{#each lines}}<row><cell>{{description}}</cell><cell>{{gross}}</cell></row>{{/each}}<h2>Total {{gross}}</h2><footer>Version two footer: thank you.</footer>';

  it('refuses a script or a remote include at save, writing nothing', async () => {
    const templates = await get('manager', '/document-templates');
    const invoiceTemplate = (templates.body.data as { id: string; docType: string; output: string }[]).find((t) => t.docType === 'INVOICE' && t.output === 'PDF_A4')!;
    for (const [body, code] of [
      ['<p>{{documentNo}}</p><script>fetch("x")</script>', 'SCRIPT_NOT_ALLOWED'],
      ['<p>https://cdn.example/logo.png</p>', 'REMOTE_INCLUDE_NOT_ALLOWED'],
      ['<img>', 'TAG_NOT_ALLOWED'],
      ['<p style="x">a</p>', 'ATTRIBUTE_NOT_ALLOWED'],
    ] as const) {
      const refused = await post('manager', `/document-templates/${invoiceTemplate.id}/versions`, { body });
      expect(refused.status, body).toBe(422);
      expect(refused.body.error.code).toBe('TEMPLATE_BODY_INVALID');
      expect(refused.body.error.details.map((d: { code: string }) => d.code)).toContain(code);
    }
    expect((await get('manager', `/document-templates/${invoiceTemplate.id}/versions`)).body.data).toHaveLength(1);
  });

  it('a new active version changes the next invoice and no issued one', async () => {
    const earlier = await issue('accountant', invoiceOf());
    await worker.settle();
    const [earlierArchive] = await archivedOf(earlier.id);
    const earlierBytes = await storedBytes(earlierArchive!.fileId);
    const templates = await get('owner', '/document-templates');
    expect(templates.status).toBe(200);
    const invoiceTemplate = (templates.body.data as { id: string; docType: string; output: string; activeVersion: { id: string; versionNo: number } }[]).find((t) => t.docType === 'INVOICE' && t.output === 'PDF_A4')!;
    expect(invoiceTemplate.activeVersion.versionNo).toBe(1);

    const drafted = await post('manager', `/document-templates/${invoiceTemplate.id}/versions`, { body: footerBody, sampleData: { documentNo: 'INV-SAMPLE' } });
    expect(drafted.status).toBe(201);
    expect(drafted.body).toMatchObject({ versionNo: 2, status: 'DRAFT', body: footerBody, activatedAt: null, activatedBy: null, createdBy: { displayName: 'Akosua Boateng' } });
    const activated = await post('owner', `/template-versions/${drafted.body.id}/activate`);
    expect(activated.status).toBe(200);
    expect(activated.body).toMatchObject({ status: 'ACTIVE', activatedBy: { displayName: 'Kwabena Owusu' }, body: null });
    expect((await post('owner', `/template-versions/${drafted.body.id}/activate`)).body.error.code).toBe('INVALID_STATE_TRANSITION');
    const versions = await get('accountant', `/document-templates/${invoiceTemplate.id}/versions`);
    expect(versions.body.data.map((v: { versionNo: number; status: string }) => [v.versionNo, v.status])).toEqual([
      [2, 'ACTIVE'],
      [1, 'RETIRED'],
    ]);
    expect((await get('accountant', `/template-versions/${drafted.body.id}`)).body.body).toBe(footerBody);
    const { rows: audit } = await admin().query("SELECT 1 FROM platform.audit_event WHERE entity_type = 'DocumentTemplate' AND entity_id = $1 AND action = 'ACTIVATE'", [invoiceTemplate.id]);
    expect(audit).toHaveLength(1);

    const later = await issue('accountant', invoiceOf());
    await worker.settle();
    const [laterArchive] = await archivedOf(later.id);
    expect(laterArchive!.templateVersionId).toBe(drafted.body.id);
    expect((await storedBytes(laterArchive!.fileId)).toString('latin1')).toContain('(Version two footer: thank you.) Tj');
    // The earlier invoice keeps its version, its bytes and its hash; its reprint still has the version 1 footer.
    expect(earlierArchive!.templateVersionId).toBe(invoiceTemplate.activeVersion.id);
    expect((await storedBytes(earlierArchive!.fileId)).equals(earlierBytes)).toBe(true);
    const reprint = Buffer.from((await post('manager', `/billing-documents/${earlier.id}/reprint`, { channel: 'PDF' })).body.pdfBase64 as string, 'base64');
    expect(reprint.toString('latin1')).toContain('(Thank you for buying from HaKorem Farms.) Tj');
    expect(reprint.toString('latin1')).not.toContain('Version two footer');
    // A version's body never changes, also by SQL.
    expect(await sqlStateOf(app().query("UPDATE doc.template_version SET body = '<p>x</p>' WHERE id = $1", [drafted.body.id]))).toBe('HK004');
    expect(await sqlStateOf(app().query("UPDATE doc.template_version SET status = 'DRAFT', activated_at = NULL, activated_by = NULL WHERE id = $1", [drafted.body.id]))).toBe('HK004');
  });

  it('refuses template writes to every role but the Owner and the Manager, and reads to the roles without the read', async () => {
    const templates = await get('accountant', '/document-templates');
    const template = (templates.body.data as { id: string; activeVersion: { id: string } }[])[0]!;
    for (const who of ['accountant', 'cashier', 'sales', 'storekeeper', 'farmHand', 'driver']) {
      expect((await post(who, `/document-templates/${template.id}/versions`, { body: '<p>a</p>' })).status, who).toBe(403);
      expect((await post(who, `/template-versions/${template.activeVersion.id}/activate`)).status, who).toBe(403);
    }
    for (const who of ['cashier', 'sales', 'storekeeper', 'farmHand', 'driver']) {
      expect((await get(who, '/document-templates')).status, who).toBe(403);
      expect((await get(who, `/template-versions/${template.activeVersion.id}`)).status, who).toBe(403);
    }
    const { rows } = await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM doc.template_version WHERE body = '<p>a</p>'");
    expect(rows[0]!.n).toBe(0);
  });
});
