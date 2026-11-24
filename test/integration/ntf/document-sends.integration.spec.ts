import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Billing, type IssueRequest } from '../../../src/modules/bil';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { OBJECT_STORAGE, type ObjectStorage } from '../../../src/platform/storage/object-storage';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { SEED_TRANSPORT_INVOICE } from '../../../src/seed/farm-pur';
import { SEED_CREDIT_NOTE } from '../../../src/seed/farm-pur-credit';
import { documentWorker, type DocumentWorker } from '../../support/documents';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { FakeEmail, FakeSms, ntfHarness, SCHEDULER, type NtfHarness } from '../../support/ntf';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The document sends and the remittance advice (ADR-0062, ADR-0074, ADR-0084, ADR-0099; the B11 continued 13 gate's
 * first half): an issued billing document or statement sent on request goes, once per send, only to the document's own
 * customer, at the address MDM holds when the message goes, with a link of its own that opens exactly the archived
 * document; a typed recipient that is not the customer's is refused; a failed send is retried without a second archive
 * row or copy; a remittance advice goes once per payment to the payment's own supplier, waiting while its archive is
 * still on its way, never failing for it. The SMS and email providers are test doubles. Every figure is read by SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let uow: UnitOfWork;
let billing: Billing;
let worker: DocumentWorker;
let ntf: NtfHarness;
let branchId: string;
type Session = TestSession & { readonly secret?: Buffer };
const sessions = new Map<string, Session>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const shared = (token: string) => request(api.server).get(`/v1/shop/documents/${encodeURIComponent(token)}`);
/** An answer with its correlation id left out, so two refusals can be compared whole. */
const bare = (res: request.Response) => ({ status: res.status, error: { ...res.body.error, correlationId: undefined } });
const actorOf = (who: string): Actor => ({ principalId: users.get(who)!.principalId, kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const BASE = 'https://shop.hakorem.test';
const LINK = /https:\/\/shop\.hakorem\.test\/d\/(doc_[A-Za-z0-9_-]{43})/;
const TEMA_EMAIL = 'accounts@temacoldstore.example';
const SUPPLIER_PHONE = '+233244700457';
const SUPPLIER_EMAIL = 'kpone.traders@example.com';

function issue(who: string, request: IssueRequest) {
  return runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'document sends test', actor: actorOf(who) }, () =>
    uow.run({ isolation: 'serializable', seriesLocks: billing.seriesLocksFor(request.kind, request.branchId) }, (tx) => billing.issueIn(tx, actorOf(who), request)),
  );
}

const invoiceOf = (): IssueRequest => ({
  kind: 'INVOICE',
  branchId,
  customerId: id('tema'),
  dueDate: toBusinessDate(clock.now()),
  taxInclusive: true,
  lines: [{ lineKind: 'PRODUCT', productId: id('meat'), quantity: '1.000', uom: 'PACK', unitPricePesewas: 42_560n }],
});

async function counts(documentId: string): Promise<{ archived: number; jobs: number; copies: number; documents: number; numbers: number }> {
  const { rows } = await admin().query<{ archived: number; jobs: number; copies: number; documents: number; numbers: number }>(
    `SELECT (SELECT count(*)::int FROM doc.archived_document WHERE business_document_id = $1) AS archived,
            (SELECT count(*)::int FROM doc.render_job WHERE business_document_id = $1) AS jobs,
            (SELECT count(*)::int FROM bil.reprint_log WHERE billing_document_id = $1) AS copies,
            (SELECT count(*)::int FROM bil.billing_document) AS documents,
            (SELECT count(*)::int FROM platform.number_allocation) AS numbers`,
    [documentId],
  );
  return rows[0]!;
}

async function messagesOf(recordId: string) {
  const { rows } = await admin().query<{ id: string; status: string; channel: string; customer_id: string | null; supplier_id: string | null; recipient_kind: string; link_kind: string | null; link_record_id: string | null; rendered_body: string; rendered_subject: string | null; address_masked: string; attempts: number; failure_reason: string | null; code: string }>(
    `SELECT m.id, m.status, m.channel, m.customer_id, m.supplier_id, m.recipient_kind, m.link_kind, m.link_record_id, m.rendered_body, m.rendered_subject, m.address_masked, m.attempts, m.failure_reason, t.code
       FROM ntf.message m JOIN ntf.template t ON t.id = m.template_id WHERE m.record_id = $1 ORDER BY m.created_at`,
    [recordId],
  );
  return rows;
}

/** Every stored row a token could leak into: NTF's tables, DOC's links, the outbox, the audit trail and the keys. */
async function tokenStoredAnywhere(token: string): Promise<boolean> {
  const { rows } = await admin().query<{ n: number }>(
    `SELECT ((SELECT count(*) FROM ntf.message m WHERE m::text LIKE '%' || $1 || '%')
           + (SELECT count(*) FROM ntf.message_attempt a WHERE a::text LIKE '%' || $1 || '%')
           + (SELECT count(*) FROM doc.document_link l WHERE l::text LIKE '%' || $1 || '%')
           + (SELECT count(*) FROM platform.outbox_message o WHERE o::text LIKE '%' || $1 || '%')
           + (SELECT count(*) FROM platform.audit_event e WHERE e::text LIKE '%' || $1 || '%')
           + (SELECT count(*) FROM platform.idempotency_key k WHERE k::text LIKE '%' || $1 || '%'))::int AS n`,
    [token],
  );
  return rows[0]!.n > 0;
}

async function storedBytes(archivedId: string): Promise<Buffer> {
  const { rows } = await admin().query<{ bucket: string; object_key: string }>('SELECT f.bucket, f.object_key FROM platform.stored_file f JOIN doc.archived_document a ON a.file_id = f.id WHERE a.id = $1', [archivedId]);
  return api.app.get<ObjectStorage>(OBJECT_STORAGE).get(rows[0]!.bucket, rows[0]!.object_key);
}

async function archiveOf(documentId: string): Promise<{ id: string; sha256: string }> {
  const { rows } = await admin().query<{ id: string; sha256: string }>("SELECT id, encode(sha256, 'hex') AS sha256 FROM doc.archived_document WHERE business_document_id = $1", [documentId]);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** Sends the due messages once, as the worker does, and answers the token each new SMS carries. */
async function sendNow(sms: FakeSms, others: readonly FakeEmail[] = []) {
  const before = sms.calls.length;
  const pass = await ntf.sender(sms, () => 0, others).run(SCHEDULER);
  return { pass, tokens: sms.calls.slice(before).map((c) => LINK.exec(c.text)?.[1] ?? null) };
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { RECEIPT_LINK_BASE_URL: BASE, AUTH_ACCESS_TTL_SECONDS: '172800', AUTH_STAFF_REFRESH_IDLE_SECONDS: '172800' } });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  uow = api.app.get(UnitOfWork);
  billing = api.app.get(Billing);
  worker = documentWorker(api, database, clock);
  ntf = ntfHarness(api.app, database, clock);
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const [name, sql, value] of [
    ['tema', 'SELECT id FROM mdm.customer WHERE name = $1', 'Tema Cold Store Ltd (SEED)'],
    ['meat', 'SELECT id FROM mdm.product WHERE sku = $1', 'MEAT-0007'],
    ['eggs', 'SELECT id FROM mdm.product WHERE sku = $1', 'EGG-0003'],
    ['kpone', 'SELECT id FROM mdm.supplier WHERE name = $1', SEED_TRANSPORT_INVOICE.supplier],
    ['statement', "SELECT s.id FROM whl.statement s JOIN mdm.customer c ON c.id = s.customer_id WHERE c.name = $1 AND s.status = 'ISSUED'", 'Tema Cold Store Ltd (SEED)'],
  ] as const) {
    ids.set(name, (await admin().query<{ id: string }>(sql, [value])).rows[0]!.id);
  }
  ids.set('otherCustomer', (await admin().query<{ id: string }>("SELECT id FROM mdm.customer WHERE id <> $1 AND phone_e164 IS NOT NULL AND status = 'ACTIVE' ORDER BY id LIMIT 1", [id('tema')])).rows[0]!.id);
  ids.set('otherSupplier', (await admin().query<{ id: string }>("SELECT id FROM mdm.supplier WHERE id <> $1 AND status = 'ACTIVE' ORDER BY id LIMIT 1", [id('kpone')])).rows[0]!.id);
  // The parties' own addresses, as MDM holds them (invented, SEED-free values; the hash pairs with the number).
  await admin().query('UPDATE mdm.customer SET email = $2, version = version + 1 WHERE id = $1', [id('tema'), TEMA_EMAIL]);
  await admin().query('UPDATE mdm.supplier SET phone_e164 = $2, phone_hash = $3, email = $4, version = version + 1 WHERE id = $1', [id('kpone'), SUPPLIER_PHONE, randomBytes(32), SUPPLIER_EMAIL]);
  const people: [string, string, string, boolean][] = [
    ['owner', 'Kwabena Owusu', 'OWNER', true],
    ['manager', 'Akosua Boateng', 'MANAGER', true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
    ['cashier', 'Adwoa Darko', 'CASHIER', false],
    ['sales', 'Esi Appiah', 'SALES', false],
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', false],
    ['driver', 'Selorm Agbeko', 'DRIVER', false],
  ];
  for (const [who, name, role, privileged] of people) {
    const user = await createUser(database, { name, grants: [{ role: role as 'OWNER', branchId }] });
    users.set(who, user);
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  // The seeded documents are archived and scanned first, so each test below starts from a quiet outbox.
  await worker.settle();
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('a billing document sent by SMS reaches only its own customer, with a link that opens exactly its archive', () => {
  let invoiceId: string;
  let firstToken: string;
  let messageId: string;

  it('logs a copy with its channel, queues one message for the customer and makes no document, number or rendering', async () => {
    const invoice = await issue('accountant', invoiceOf());
    invoiceId = invoice.id;
    ids.set('invoiceNo', invoice.documentNo!);
    await worker.settle();
    const before = await counts(invoiceId);
    expect(before).toMatchObject({ archived: 1, jobs: 1, copies: 0 });

    const key = randomUUID();
    const sent = await post('cashier', `/billing-documents/${invoiceId}/send`, { channels: ['SMS'] }, key);
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    expect(sent.body).toEqual({ status: 'QUEUED', message: expect.any(String) });
    // A replay with its key is answered from the stored response; a second copy is never logged for it.
    expect((await post('cashier', `/billing-documents/${invoiceId}/send`, { channels: ['SMS'] }, key)).status).toBe(202);
    expect(await counts(invoiceId)).toEqual({ ...before, copies: 1 });
    const copies = await get('cashier', `/billing-documents/${invoiceId}/reprints`);
    expect(copies.body.data).toEqual([{ copyNo: 1, channel: 'SMS', actor: expect.objectContaining({ id: users.get('cashier')!.principalId }), recordedAt: expect.any(String) }]);

    await worker.settle();
    const { rows: sends } = await admin().query<{ id: string }>('SELECT id FROM bil.reprint_log WHERE billing_document_id = $1', [invoiceId]);
    const messages = await messagesOf(sends[0]!.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ code: 'DOCUMENT_SENT', status: 'QUEUED', channel: 'SMS', recipient_kind: 'CUSTOMER', customer_id: id('tema'), supplier_id: null, link_kind: 'DOCUMENT', link_record_id: invoiceId });
    expect(messages[0]!.rendered_body).toBe(`HaKorem Farms: your invoice ${invoice.documentNo} for GHS 425.60. View it here: {{link}}`);
    messageId = messages[0]!.id;
    // Nothing more was rendered or archived for the send.
    expect(await counts(invoiceId)).toEqual({ ...before, copies: 1 });
  });

  it("sends it once to the customer's own number, with a fresh doc_ token kept nowhere but as its hash", async () => {
    const sms = new FakeSms();
    const { pass, tokens } = await sendNow(sms);
    expect(pass).toMatchObject({ sent: 1, failed: 0 });
    const { rows: tema } = await admin().query<{ phone_e164: string }>('SELECT phone_e164 FROM mdm.customer WHERE id = $1', [id('tema')]);
    expect(sms.calls.map((c) => c.to)).toEqual([tema[0]!.phone_e164]);
    expect(sms.calls[0]!.idempotencyKey).toBe(messageId);
    firstToken = tokens[0]!;
    expect(firstToken).toMatch(/^doc_[A-Za-z0-9_-]{43}$/);
    const archive = await archiveOf(invoiceId);
    const { rows: links } = await admin().query<{ archived_document_id: string; token_hash: Buffer; expires_at: Date; recorded_at: Date }>('SELECT archived_document_id, token_hash, expires_at, recorded_at FROM doc.document_link');
    expect(links).toHaveLength(1);
    expect(links[0]!.archived_document_id).toBe(archive.id);
    expect(links[0]!.token_hash.toString('hex')).toBe(sha256(Buffer.from(firstToken)));
    expect(links[0]!.expires_at.getTime() - links[0]!.recorded_at.getTime()).toBe(30 * 24 * 3_600_000);
    expect(await tokenStoredAnywhere(firstToken)).toBe(false);
    expect((await messagesOf((await admin().query<{ id: string }>('SELECT id FROM bil.reprint_log WHERE billing_document_id = $1', [invoiceId])).rows[0]!.id))[0]).toMatchObject({ status: 'SENT', attempts: 1 });
    // A second pass sends nothing more.
    expect((await sendNow(sms)).pass).toMatchObject({ claimed: 0, sent: 0 });
    expect(sms.calls).toHaveLength(1);
  });

  it('opens exactly the archived document by the token alone, the same bytes and SHA-256; anything else is the same 404', async () => {
    const archive = await archiveOf(invoiceId);
    const opened = await shared(firstToken);
    expect(opened.status).toBe(200);
    expect(opened.body).toEqual({ docType: 'INVOICE', documentNo: ids.get('invoiceNo'), issuedAt: expect.any(String), sha256: archive.sha256, url: expect.any(String), expiresAt: expect.any(String) });
    const served = Buffer.from(await (await fetch(opened.body.url as string)).arrayBuffer());
    expect(sha256(served)).toBe(archive.sha256);
    expect(sha256(await storedBytes(archive.id))).toBe(archive.sha256);
    // The opening is logged against the file, on behalf of the Storefront.
    const { rows: logged } = await admin().query("SELECT purpose FROM platform.file_access_log WHERE purpose = 'doc.link.open'");
    expect(logged).toHaveLength(1);

    const guess = bare(await shared(`doc_${randomBytes(32).toString('base64url')}`));
    expect(guess.status).toBe(404);
    expect(guess.error.code).toBe('NOT_FOUND');
    for (const other of [invoiceId, invoiceId.replaceAll('-', ''), archive.id, ids.get('invoiceNo')!, `doc_${invoiceId}`, firstToken.replace(/^doc_/, 'trk_'), `${firstToken}x`, firstToken.toLowerCase()]) {
      expect(bare(await shared(other)), other).toEqual(guess);
    }
  });

  it('refuses a typed recipient the customer does not hold, a document with no customer and the wrong roles, and sends nothing for them', async () => {
    const { rows: other } = await admin().query<{ phone_e164: string }>('SELECT phone_e164 FROM mdm.customer WHERE id = $1', [id('otherCustomer')]);
    const outbox = async () => Number((await admin().query<{ n: string }>("SELECT count(*) AS n FROM platform.outbox_message WHERE event_type = 'bil.DocumentSendRequested'")).rows[0]!.n);
    const before = { outbox: await outbox(), ...(await counts(invoiceId)) };
    for (const recipient of [other[0]!.phone_e164, 'someone@example.com', '0200000000']) {
      const refused = await post('manager', `/billing-documents/${invoiceId}/send`, { channels: ['SMS'], recipient });
      expect(refused.status, recipient).toBe(422);
      expect(refused.body.error).toMatchObject({ code: 'RECIPIENT_NOT_DOCUMENT_PARTY', details: [{ field: '/recipient', code: 'RECIPIENT_NOT_DOCUMENT_PARTY' }] });
    }
    const receipt = await issue('cashier', { kind: 'RECEIPT', branchId, taxInclusive: true, lines: [{ lineKind: 'PRODUCT', productId: id('eggs'), quantity: '2.000', unitPricePesewas: 6_000n }] });
    await worker.settle();
    const walkIn = await post('cashier', `/billing-documents/${receipt.id}/send`, { channels: ['SMS'] });
    expect(walkIn.status).toBe(422);
    expect(walkIn.body.error).toMatchObject({ code: 'RECIPIENT_NOT_DOCUMENT_PARTY', details: [{ code: 'DOCUMENT_HAS_NO_PARTY' }] });
    for (const who of ['sales', 'storekeeper', 'driver', 'accountant']) {
      expect((await post(who, `/billing-documents/${invoiceId}/send`, { channels: ['SMS'] })).status, who).toBe(403);
    }
    expect((await post('manager', `/billing-documents/${randomUUID()}/send`, { channels: ['SMS'] })).status).toBe(404);
    expect((await post('manager', `/billing-documents/${invoiceId}/send`, { channels: [] })).status).toBe(400);
    expect((await post('manager', `/billing-documents/${invoiceId}/send`, { channels: ['SMS', 'SMS'] })).status).toBe(400);
    expect((await post('manager', `/billing-documents/${invoiceId}/send`, { channels: ['SMS'], to: '0244000000' })).status).toBe(400);
    const after = { outbox: await outbox(), ...(await counts(invoiceId)) };
    expect({ outbox: after.outbox, archived: after.archived, jobs: after.jobs, copies: after.copies }).toEqual({ outbox: before.outbox, archived: before.archived, jobs: before.jobs, copies: before.copies });
    // The customer's own number, typed the local way, is accepted; the message still goes to the number MDM holds.
    const { rows: tema } = await admin().query<{ phone_e164: string }>('SELECT phone_e164 FROM mdm.customer WHERE id = $1', [id('tema')]);
    const local = `0${tema[0]!.phone_e164.slice(4)}`;
    expect((await post('owner', `/billing-documents/${invoiceId}/send`, { channels: ['SMS'], recipient: local })).status).toBe(202);
    expect((await post('owner', `/billing-documents/${invoiceId}/send`, { channels: ['EMAIL'], recipient: TEMA_EMAIL.toUpperCase() })).status).toBe(202);
    const { rows: audited } = await admin().query<{ after: Record<string, unknown> }>("SELECT after FROM platform.audit_event WHERE module = 'bil' AND action = 'SEND' AND entity_id = $1", [invoiceId]);
    expect(audited).toHaveLength(3);
    expect(JSON.stringify(audited)).not.toContain(local);
    expect(JSON.stringify(audited)).not.toContain(TEMA_EMAIL);
  });

  it("goes to the customer's address as it is when sent, never one an event carries (abuse case 57)", async () => {
    await worker.settle();
    const sms = new FakeSms();
    const email = new FakeEmail();
    // A forged request event naming another customer's document is read through BIL: it queues for that document's own
    // customer, never for whoever the payload names.
    await ntf.publish({ type: 'bil.DocumentSendRequested', subjectType: 'BillingDocument', subjectId: invoiceId, branchId, payload: { sendId: randomUUID(), billingDocumentId: invoiceId, copyNo: 99, channels: ['SMS'], customerId: id('otherCustomer'), to: '+233209999999' } });
    await worker.settle();
    const { pass } = await sendNow(sms, [email]);
    expect(pass).toMatchObject({ sent: 3, failed: 0 });
    const { rows: tema } = await admin().query<{ phone_e164: string }>('SELECT phone_e164 FROM mdm.customer WHERE id = $1', [id('tema')]);
    expect(sms.calls.map((c) => c.to)).toEqual([tema[0]!.phone_e164, tema[0]!.phone_e164]);
    expect(email.calls.map((c) => c.to)).toEqual([TEMA_EMAIL]);
  });
});

describe('an email carries the archived document itself, and fails visibly with no email adapter', () => {
  it('fails at once with no adapter, and on retry sends the archived PDF and a link, with no second archive row', async () => {
    const invoice = await issue('accountant', invoiceOf());
    await worker.settle();
    expect((await post('manager', `/billing-documents/${invoice.id}/send`, { channels: ['EMAIL'] })).status).toBe(202);
    await worker.settle();
    const sendId = (await admin().query<{ id: string }>('SELECT id FROM bil.reprint_log WHERE billing_document_id = $1', [invoice.id])).rows[0]!.id;
    const sms = new FakeSms();
    // The worker as production builds it: SMS only, so the email fails visibly, with no link made for it.
    expect((await sendNow(sms)).pass).toMatchObject({ failed: 1, sent: 0 });
    const [failed] = await messagesOf(sendId);
    expect(failed).toMatchObject({ status: 'FAILED', channel: 'EMAIL', failure_reason: 'no adapter sends EMAIL', address_masked: 'a***@temacoldstore.example' });
    expect(sms.calls).toHaveLength(0);
    const linksBefore = Number((await admin().query<{ n: string }>('SELECT count(*) AS n FROM doc.document_link')).rows[0]!.n);

    const retried = await post('manager', `/notifications/messages/${failed!.id}/retry`, {});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    const email = new FakeEmail();
    expect((await sendNow(sms, [email])).pass).toMatchObject({ sent: 1 });
    expect(email.calls).toHaveLength(1);
    const call = email.calls[0]!;
    expect(call.to).toBe(TEMA_EMAIL);
    expect(call.subject).toBe(`Your invoice ${invoice.documentNo} from HaKorem Farms`);
    expect(call.text).toMatch(new RegExp(`^Your invoice ${invoice.documentNo} for GHS 425.60 is attached. You can also view it here: ${LINK.source}$`));
    const archive = await archiveOf(invoice.id);
    expect(call.attachments).toHaveLength(1);
    expect(call.attachments![0]).toMatchObject({ fileName: `${invoice.documentNo}.pdf`, contentType: 'application/pdf' });
    expect(sha256(call.attachments![0]!.bytes)).toBe(archive.sha256);
    expect(Number((await admin().query<{ n: string }>('SELECT count(*) AS n FROM doc.document_link')).rows[0]!.n)).toBe(linksBefore + 1);
    expect(await counts(invoice.id)).toMatchObject({ archived: 1, jobs: 1, copies: 1 });
  });
});

describe('a failed send is retried without a second archive row (the gate)', () => {
  it('fails three times by SMS, is retried by the Manager and sent with a new token; both tokens open the one archive', async () => {
    const invoice = await issue('accountant', invoiceOf());
    await worker.settle();
    expect((await post('cashier', `/billing-documents/${invoice.id}/send`, { channels: ['SMS'] })).status).toBe(202);
    await worker.settle();
    const sendId = (await admin().query<{ id: string }>('SELECT id FROM bil.reprint_log WHERE billing_document_id = $1', [invoice.id])).rows[0]!.id;
    const before = await counts(invoice.id);
    const sms = new FakeSms();
    sms.failNext('TEMPORARY', 3);
    const tokens: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      tokens.push(...(await sendNow(sms)).tokens.filter((t): t is string => t !== null));
      clock.advanceBy(16 * 60_000);
    }
    const [failed] = await messagesOf(sendId);
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 3 });
    // Each attempt made a token of its own; the provider refused each one, and nothing new was archived.
    expect(new Set(tokens).size).toBe(3);
    expect(await counts(invoice.id)).toEqual(before);

    expect((await post('cashier', `/notifications/messages/${failed!.id}/retry`, {})).status).toBe(403);
    expect((await post('manager', `/notifications/messages/${failed!.id}/retry`, {})).status).toBe(200);
    const { tokens: last } = await sendNow(sms);
    expect(last).toHaveLength(1);
    const [sent] = await messagesOf(sendId);
    expect(sent).toMatchObject({ status: 'SENT', attempts: 4 });
    expect(await counts(invoice.id)).toEqual(before);
    const archive = await archiveOf(invoice.id);
    for (const token of [...tokens, last[0]!]) {
      const opened = await shared(token);
      expect(opened.status).toBe(200);
      expect(opened.body.sha256).toBe(archive.sha256);
    }
    ids.set('lastToken', last[0]!);
  });
});

describe('a statement is sent to its own customer, and waits while it is still being archived', () => {
  it('sends the seeded issued statement with a link to its archive, and refuses a draft', async () => {
    const statementId = id('statement');
    const sent = await post('accountant', `/statements/${statementId}/send`, { channels: ['SMS'] });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    for (const who of ['cashier', 'storekeeper', 'driver']) expect((await post(who, `/statements/${statementId}/send`, { channels: ['SMS'] })).status, who).toBe(403);
    const { rows: other } = await admin().query<{ phone_e164: string }>('SELECT phone_e164 FROM mdm.customer WHERE id = $1', [id('otherCustomer')]);
    const refused = await post('accountant', `/statements/${statementId}/send`, { channels: ['SMS'], recipient: other[0]!.phone_e164 });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('RECIPIENT_NOT_DOCUMENT_PARTY');
    expect((await post('accountant', `/statements/${randomUUID()}/send`, { channels: ['SMS'] })).status).toBe(404);
    await worker.settle();
    const { rows } = await admin().query<{ record_id: string; status: string; rendered_body: string; customer_id: string; link_record_id: string }>(
      "SELECT m.record_id, m.status, m.rendered_body, m.customer_id, m.link_record_id FROM ntf.message m WHERE m.source_event_type = 'whl.StatementSendRequested'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'QUEUED', customer_id: id('tema'), link_record_id: statementId });
    expect(rows[0]!.rendered_body).toMatch(/^HaKorem Farms: your statement STM-\d{4}-DDW-\d{6} for GHS [\d,]+\.\d{2}( in credit)?\. View it here: \{\{link\}\}$/);
    const sms = new FakeSms();
    const { tokens } = await sendNow(sms);
    const opened = await shared(tokens[0]!);
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ docType: 'STATEMENT', sha256: (await archiveOf(statementId)).sha256 });
  });
});

describe('the remittance advice goes once per payment to its own supplier (the gate)', () => {
  const OWED = SEED_TRANSPORT_INVOICE.amountPesewas - SEED_CREDIT_NOTE.amountPesewas;
  let paymentId: string;
  let remittanceId: string;
  let paidKey: string;
  let paidAt: string;

  async function approve(checker: string, approvalRequestId: string) {
    clock.advanceBy(30_000);
    const step = await post(checker, '/auth/step-up', { code: totpAt(as(checker).secret!, Math.floor(clock.now().getTime() / 1000)) });
    expect(step.status).toBe(200);
    return post(checker, `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Checked against the transport invoice' });
  }

  it('is queued when the payment is marked paid, waits while its archive is not yet scanned, then goes once', async () => {
    const invoice = (await admin().query<{ id: string }>('SELECT id FROM pur.supplier_invoice WHERE supplier_invoice_no = $1', [SEED_TRANSPORT_INVOICE.supplierInvoiceNo])).rows[0]!;
    const created = await post('accountant', '/supplier-payments', { supplierId: id('kpone'), method: 'CASH', allocations: [{ supplierInvoiceId: invoice.id, amountPesewas: OWED }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    paymentId = created.body.id;
    const submitted = await post('accountant', `/supplier-payments/${paymentId}/submit`);
    expect((await approve('manager', submitted.body.approvalRequestId)).status).toBe(200);
    paidKey = randomUUID();
    paidAt = clock.now().toISOString();
    const paid = await post('accountant', `/supplier-payments/${paymentId}/mark-paid`, { paidAt, externalReference: 'CASH-VOUCHER-0093' }, paidKey);
    expect(paid.status).toBe(200);
    remittanceId = (await admin().query<{ id: string }>('SELECT id FROM pur.supplier_remittance WHERE supplier_payment_id = $1', [paymentId])).rows[0]!.id;

    // The outbox is delivered (the advice is rendered and the message queued) but the file is not yet scanned.
    for (let pass = 0; pass < 10; pass++) if ((await worker.dispatch()).delivered === 0) break;
    const [queued] = await messagesOf(remittanceId);
    expect(queued).toMatchObject({ code: 'REMITTANCE_ADVICE', status: 'QUEUED', recipient_kind: 'SUPPLIER', supplier_id: id('kpone'), customer_id: null, link_kind: 'DOCUMENT', link_record_id: remittanceId, channel: 'SMS' });
    const paidOn = toBusinessDate(clock.now());
    expect(queued!.rendered_body).toBe(`HaKorem Farms paid ${SEED_TRANSPORT_INVOICE.supplier} GHS 135.00 on ${paidOn}. Remittance advice: {{link}}`);

    const sms = new FakeSms();
    const waiting = await sendNow(sms);
    expect(waiting.pass).toMatchObject({ claimed: 1, sent: 0, failed: 0, retrying: 1 });
    expect(sms.calls).toHaveLength(0);
    const [held] = await messagesOf(remittanceId);
    // Waiting is no attempt: it can wait as long as the archive takes and never fails for it.
    expect(held).toMatchObject({ status: 'QUEUED', attempts: 0, failure_reason: 'the document is not archived yet' });
    expect(Number((await admin().query<{ n: string }>('SELECT count(*) AS n FROM doc.document_link')).rows[0]!.n)).toBeGreaterThan(0);
    const linksBefore = Number((await admin().query<{ n: string }>('SELECT count(*) AS n FROM doc.document_link')).rows[0]!.n);
    // Too soon: still waiting.
    expect((await sendNow(sms)).pass).toMatchObject({ claimed: 0 });

    await worker.scan();
    clock.advanceBy(61_000);
    const { pass, tokens } = await sendNow(sms);
    expect(pass).toMatchObject({ sent: 1 });
    expect(sms.calls.map((c) => c.to)).toEqual([SUPPLIER_PHONE]);
    expect(Number((await admin().query<{ n: string }>('SELECT count(*) AS n FROM doc.document_link')).rows[0]!.n)).toBe(linksBefore + 1);
    const opened = await shared(tokens[0]!);
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ docType: 'REMITTANCE_ADVICE', documentNo: null, sha256: (await archiveOf(remittanceId)).sha256 });
    expect(await tokenStoredAnywhere(tokens[0]!)).toBe(false);
  });

  it("sends no second advice on a replay or a redelivery, and never to another supplier whatever an event says", async () => {
    expect((await post('accountant', `/supplier-payments/${paymentId}/mark-paid`, { paidAt, externalReference: 'CASH-VOUCHER-0093' }, paidKey)).status).toBe(200);
    await admin().query(
      `UPDATE platform.outbox_delivery d SET status = 'PENDING', next_attempt_at = now() - interval '1 minute', delivered_at = NULL
         FROM platform.outbox_message m WHERE m.id = d.message_id AND m.event_type = 'pur.SupplierRemittanceReady' AND m.subject_id = $1`,
      [paymentId],
    );
    // Forged: another supplier on this payment's advice, and this supplier on an advice that is not this payment's.
    await ntf.publish({ type: 'pur.SupplierRemittanceReady', subjectType: 'SupplierPayment', subjectId: paymentId, branchId, payload: { remittanceId, supplierPaymentId: paymentId, supplierId: id('otherSupplier'), amountPesewas: 999_999, paidAt: clock.now().toISOString(), externalReference: 'FORGED' } });
    await ntf.publish({ type: 'pur.SupplierRemittanceReady', subjectType: 'SupplierPayment', subjectId: paymentId, branchId, payload: { remittanceId: randomUUID(), supplierPaymentId: paymentId, supplierId: id('kpone'), amountPesewas: 1, paidAt: clock.now().toISOString(), externalReference: 'FORGED' } });
    await worker.settle();
    const sms = new FakeSms();
    await sendNow(sms);
    // A redelivery, a replay and both forged events queue nothing: one advice for the payment, ever, to its own supplier.
    const { rows } = await admin().query<{ supplier_id: string; record_id: string }>("SELECT supplier_id, record_id FROM ntf.message WHERE source_event_type = 'pur.SupplierRemittanceReady'");
    expect(rows).toEqual([{ supplier_id: id('kpone'), record_id: remittanceId }]);
    expect(sms.calls).toHaveLength(0);
  });
});

describe('the database holds a document link and what a message is about', () => {
  it('keeps a link insert-only, unique and at most thirty days long, and a message its supplier and record fixed', async () => {
    const { rows } = await admin().query<{ id: string; archived_document_id: string; actor_id: string }>('SELECT id, archived_document_id, actor_id FROM doc.document_link LIMIT 1');
    const link = rows[0]!;
    const at = clock.now();
    const insert = (hash: Buffer, expires: Date) =>
      app().query('INSERT INTO doc.document_link (id, archived_document_id, token_hash, expires_at, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, $6)', [randomUUID(), link.archived_document_id, hash, expires, at, link.actor_id]);
    expect(await sqlStateOf(insert(randomBytes(32), new Date(at.getTime() + 31 * 24 * 3_600_000)))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(insert(randomBytes(32), at))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(insert(randomBytes(16), new Date(at.getTime() + 60_000)))).toBe(SQLSTATE.checkViolation);
    const hash = (await admin().query<{ token_hash: Buffer }>('SELECT token_hash FROM doc.document_link WHERE id = $1', [link.id])).rows[0]!.token_hash;
    expect(await sqlStateOf(insert(hash, new Date(at.getTime() + 60_000)))).toBe(SQLSTATE.uniqueViolation);
    expect(await sqlStateOf(app().query("UPDATE doc.document_link SET expires_at = expires_at + interval '1 day' WHERE id = $1", [link.id]))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(admin().query('DELETE FROM doc.document_link WHERE id = $1', [link.id]))).toBe('HK001');

    const { rows: messages } = await admin().query<{ id: string }>("SELECT id FROM ntf.message WHERE recipient_kind = 'SUPPLIER' LIMIT 1");
    expect(await sqlStateOf(app().query('UPDATE ntf.message SET supplier_id = $2 WHERE id = $1', [messages[0]!.id, id('otherSupplier')]))).toBe('HK004');
    expect(await sqlStateOf(app().query('UPDATE ntf.message SET record_id = $2 WHERE id = $1', [messages[0]!.id, randomUUID()]))).toBe('HK004');
    expect(await sqlStateOf(app().query("UPDATE ntf.message SET supplier_id = NULL, recipient_kind = 'SUPPLIER' WHERE id = $1", [messages[0]!.id]))).toMatch(/HK004|23514/);
  });
});

describe('a document link expires', () => {
  it('reads as a guess thirty days after it was made', async () => {
    expect((await shared(ids.get('lastToken')!)).status).toBe(200);
    clock.advanceBy(31 * 24 * 3_600_000);
    const expired = bare(await shared(ids.get('lastToken')!));
    expect(expired).toEqual(bare(await shared(`doc_${randomBytes(32).toString('base64url')}`)));
  });
});
