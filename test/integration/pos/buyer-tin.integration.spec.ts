import { createHash, randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OBJECT_STORAGE, type ObjectStorage } from '../../../src/platform/storage/object-storage';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { documentWorker, type DocumentWorker } from '../../support/documents';
import { stepUp, type TotpSession } from '../../support/fin';
import { consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { syncBatch, tillSale, type TillSale } from '../../support/offline';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The business buyer at the counter (the owner's addition (2) to A-200, A-285 (c) to (f), B09b continued 4b): a buyer
 * may have their name and TIN printed on the receipt without opening a customer account, so they can reclaim the input
 * tax. No customer is created and the walk-in party stays. Online, a name or TIN of a form that may not be printed is
 * refused before anything is posted; offline, the sale is always recorded, its receipt issued without them and the
 * refusal raised for review. The TIN is Restricted (DC-25, E-1): printed on the document, audited only masked, in no
 * event and no order. Every TIN here is invented, an obviously made-up run of zeros.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let nextId: () => string;
let worker: DocumentWorker;
const sessions = new Map<string, TestSession>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
let credential = '';
let shift = { id: '', seq: 0 };
let counter = 0;
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const rows = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => (await admin().query(sql, values)).rows as T[];
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await rows<T>(sql, values))[0]!;
const MINUTE = 60_000;
/** Invented TINs, all zeros but the last digits: a company's GRA TIN (not the seeded farm's own) and an individual's Ghana Card PIN. */
const COMPANY_TIN = `C${'0'.repeat(8)}42`;
const CARD_PIN = `GHA-${'0'.repeat(8)}2-0`;
const BUYER = 'Adom Catering Services';
const crate = { productId: '', quantity: '1.000', uom: 'CRATE', agreedUnitPricePesewas: 6_000 };

function sellOnline(body: Record<string, unknown>) {
  const saleId = nextId();
  clock.advanceBy(MINUTE);
  return {
    saleId,
    answer: consolePost(api.server, as('kwame'), '/v1/pos/sales', saleId)
      .set('X-Device-Credential', credential)
      .send({ id: saleId, shiftId: shift.id, occurredAt: clock.now().toISOString(), lines: [{ ...crate, productId: id('EGG-0003') }], tenders: [{ paymentMethodId: id('CASH'), amountPesewas: 6_000 }], ...body }),
  };
}

function queued(buyer: { name: string; tin: string } | undefined): TillSale {
  counter += 1;
  clock.advanceBy(MINUTE);
  const sale = tillSale({ till: 'T2', shiftSeq: shift.seq, counter, at: clock.now(), lines: [{ ...crate, productId: id('EGG-0003') }], tenders: [{ paymentMethodId: id('CASH'), amountPesewas: 6_000, tenderedPesewas: 6_000 }], ...(buyer === undefined ? {} : { buyer }) });
  return sale;
}

async function sync(sales: readonly TillSale[]) {
  const answer = await syncBatch(api.server, as('kwame'), credential, { deviceId: id('device'), shiftId: shift.id, sales });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body.results as { clientSaleId: string; outcome: string; receiptNo: string | null; exceptions: { kind: string; summary: string }[] }[];
}

const receiptOf = (saleId: string) =>
  one<{ id: string; customer_id: string | null; customer_name: string | null; customer_tin: string | null; gross: number }>(
    'SELECT id, customer_id, customer_name, customer_tin, gross_pesewas::int AS gross FROM bil.billing_document WHERE order_document_id = $1',
    [saleId],
  );
const customers = async () => (await one<{ n: number }>('SELECT count(*)::int AS n FROM mdm.customer')).n;
const footprint = async () => one<Record<string, number>>(
  `SELECT (SELECT count(*)::int FROM ord.sales_order) AS orders, (SELECT count(*)::int FROM bil.billing_document) AS documents,
          (SELECT count(*)::int FROM pay.payment) AS payments, (SELECT count(*)::int FROM inv.stock_movement) AS movements,
          (SELECT count(*)::int FROM fin.journal_entry) AS journals, (SELECT count(*)::int FROM mdm.customer) AS customers`,
);
/** The walk-in party on every journal line of the receipt that names a customer (FIN's WALK_IN_CUSTOMER). */
const partiesOf = async (receiptId: string) =>
  (await rows<{ ref: string }>(
    `SELECT DISTINCT p.ref_id AS ref FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id
       JOIN fin.subledger_party p ON p.id = l.subledger_party_id WHERE e.source_document_id = $1 AND p.kind = 'CUSTOMER'`,
    [receiptId],
  )).map((r) => r.ref);
const WALK_IN = '01900000-0000-7000-8500-000000000002';

/** Where a text is written outside the billing document and its render: audit rows, the outbox, orders, the sync log. */
async function writtenOutsideTheDocument(text: string): Promise<string[]> {
  const found = await rows<{ place: string }>(
    `SELECT 'platform.audit_event' AS place FROM platform.audit_event WHERE position(convert_to($1, 'UTF8') IN coalesce("after", ''::bytea) || coalesce("before", ''::bytea) || convert_to(coalesce(metadata::text, ''), 'UTF8')) > 0
     UNION ALL SELECT 'platform.outbox_message' FROM platform.outbox_message WHERE payload::text LIKE '%' || $1 || '%'
     UNION ALL SELECT 'ord.sales_order' FROM ord.sales_order o WHERE row_to_json(o)::text LIKE '%' || $1 || '%'
     UNION ALL SELECT 'pos.sale_sync' FROM pos.sale_sync s WHERE row_to_json(s)::text LIKE '%' || $1 || '%'`,
    [text],
  );
  return found.map((r) => r.place);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '172800', AUTH_STAFF_REFRESH_IDLE_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  worker = documentWorker(api, database, clock);
  for (const row of await rows<{ code: string; id: string }>(
    `SELECT 'branch' AS code, id FROM mdm.branch WHERE code = 'DDW'
     UNION ALL SELECT 'shop', l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = 'SHOP'
     UNION ALL SELECT sku, id FROM mdm.product WHERE sku = 'EGG-0003'
     UNION ALL SELECT 'customer', id FROM (SELECT id FROM mdm.customer ORDER BY id LIMIT 1) c
     UNION ALL SELECT code, id FROM mdm.payment_method`,
  )) {
    ids.set(row.code, row.id);
  }
  const manager = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId: id('branch') }] });
  sessions.set('manager', await enrolAndLogin(api.server, manager, () => clock.now()));
  const kwame = await createUser(database, { name: 'Kwame Asare', grants: [{ role: 'CASHIER', branchId: id('branch'), locationId: id('shop') }] });
  sessions.set('kwame', await login(api.server, kwame));
  const till = await consolePost(api.server, as('manager'), '/v1/registers').send({ branchId: id('branch'), locationId: id('shop'), code: 'T2', name: 'Shop floor till' });
  expect(till.status, JSON.stringify(till.body)).toBe(201);
  await stepUp(api.server, as('manager') as TotpSession, clock);
  const enrolled = await consolePost(api.server, as('manager'), `/v1/registers/${till.body.id as string}/devices`).send({ deviceLabel: 'Shop floor tablet' });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  credential = enrolled.body.deviceCredential as string;
  ids.set('device', enrolled.body.device.id as string);
  clock.advanceBy(10 * MINUTE);
  const shiftId = nextId();
  const opened = await consolePost(api.server, as('kwame'), '/v1/shifts', shiftId).send({ id: shiftId, registerId: till.body.id, openingFloatPesewas: 0, openedAt: clock.now().toISOString() });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  shift = { id: shiftId, seq: opened.body.shiftSeq as number };
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('a business buyer named at the counter, online (A-285 (c))', () => {
  it('prints the name and TIN on the receipt, creates no customer and posts against the walk-in party', async () => {
    const before = await customers();
    const { saleId, answer } = sellOnline({ buyer: { name: `  ${BUYER} `, tin: COMPANY_TIN.toLowerCase() } });
    const sold = await answer;
    expect(sold.status, JSON.stringify(sold.body)).toBe(201);
    expect(sold.body.receipt).toMatchObject({ kind: 'RECEIPT', customerName: BUYER, customerTin: COMPANY_TIN, grossPesewas: 6_000 });
    expect(sold.body.order.customerId ?? null).toBeNull();
    const receipt = await receiptOf(saleId);
    expect(receipt).toMatchObject({ customer_id: null, customer_name: BUYER, customer_tin: COMPANY_TIN, gross: 6_000 });
    expect(await one('SELECT customer_id FROM ord.sales_order WHERE id = $1', [saleId])).toEqual({ customer_id: null });
    expect(await customers()).toBe(before);
    expect(await partiesOf(receipt.id)).toEqual([WALK_IN]);

    // The archived receipt shows them, and the document's content hash is the SHA-256 of those very bytes.
    await worker.settle();
    const archived = await one<{ bucket: string; object_key: string; sha256: Buffer; content_hash: Buffer; render: Record<string, unknown> }>(
      `SELECT f.bucket, f.object_key, a.sha256, d.content_hash, a.render_data AS render FROM bil.billing_document d
         JOIN doc.archived_document a ON a.id = d.archived_document_id JOIN platform.stored_file f ON f.id = a.file_id WHERE d.id = $1`,
      [receipt.id],
    );
    const pdf = await api.app.get<ObjectStorage>(OBJECT_STORAGE).get(archived.bucket, archived.object_key);
    const text = pdf.toString('latin1');
    expect(text).toContain(`Bill to: ${BUYER}`);
    expect(text).toContain(`TIN ${COMPANY_TIN}`);
    expect(createHash('sha256').update(pdf).digest().equals(archived.sha256)).toBe(true);
    expect(archived.content_hash.equals(archived.sha256)).toBe(true);
    expect(archived.render).toMatchObject({ customer: { name: BUYER, tin: COMPANY_TIN } });

    // Restricted (DC-25, E-1): audited masked, never in an event, the order or the sync log.
    const leaks = await rows<{ module: string; action: string; after: string }>("SELECT module, action, convert_from(after, 'UTF8') AS after FROM platform.audit_event WHERE position(convert_to($1, 'UTF8') IN coalesce(after, ''::bytea)) > 0", [COMPANY_TIN]);
    expect(leaks.map((l) => `${l.module}.${l.action} ${l.after.slice(0, 2000)}`)).toEqual([]);
    expect(await writtenOutsideTheDocument(COMPANY_TIN)).toEqual([]);
    const audit = await one<{ after: Record<string, unknown> }>("SELECT convert_from(after, 'UTF8')::jsonb AS after FROM platform.audit_event WHERE module = 'bil' AND action = 'ISSUE' AND entity_id = $1", [receipt.id]);
    expect(audit.after).toMatchObject({ customerName: BUYER, customerTin: '*******0042' });
  });

  it('takes an individual by their Ghana Card PIN', async () => {
    const { saleId, answer } = sellOnline({ buyer: { name: 'Ama Owusu', tin: CARD_PIN } });
    expect((await answer).status).toBe(201);
    expect(await receiptOf(saleId)).toMatchObject({ customer_id: null, customer_name: 'Ama Owusu', customer_tin: CARD_PIN });
  });

  it('refuses a TIN or name of a form that may not be printed, and a buyer beside a customer, before anything is posted', async () => {
    const before = await footprint();
    const refusals: [Record<string, unknown>, { field: string; code: string }[]][] = [
      [{ buyer: { name: BUYER, tin: `C${'0'.repeat(9)}` } }, [{ field: '/buyer/tin', code: 'BUYER_TIN_INVALID' }]],
      [{ buyer: { name: BUYER, tin: `GHA-${'0'.repeat(8)}-0` } }, [{ field: '/buyer/tin', code: 'BUYER_TIN_INVALID' }]],
      [{ buyer: { name: '   ', tin: COMPANY_TIN } }, [{ field: '/buyer/name', code: 'BUYER_NAME_INVALID' }]],
      [{ buyer: { name: BUYER, tin: COMPANY_TIN }, customerId: id('customer') }, [{ field: '/buyer', code: 'BUYER_WITH_CUSTOMER' }]],
    ];
    for (const [body, details] of refusals) {
      const refused = await sellOnline(body).answer;
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body.error.code).toBe('COUNTER_SALE_INVALID');
      expect(refused.body.error.details.map((d: { field: string; code: string }) => ({ field: d.field, code: d.code }))).toEqual(details);
    }
    const missing = await sellOnline({ buyer: { name: BUYER } }).answer;
    expect(missing.status).toBe(400);
    expect(await footprint()).toEqual(before);
  });

  it('is held by the database too: a TIN of any other form is never stored (ck_billing_document_customer_tin_format)', async () => {
    const { saleId, answer } = sellOnline({});
    expect((await answer).status).toBe(201);
    const receipt = await receiptOf(saleId);
    // The issued document is frozen by its trigger; with triggers off for this transaction only the check is left to refuse.
    const client = await admin().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query('UPDATE bil.billing_document SET customer_tin = $2 WHERE id = $1', [receipt.id, CARD_PIN]);
      await client.query('SAVEPOINT bad');
      for (const tin of ['NOT-A-TIN', COMPANY_TIN.toLowerCase(), `C${'0'.repeat(11)}`]) {
        await expect(client.query('UPDATE bil.billing_document SET customer_tin = $2 WHERE id = $1', [receipt.id, tin]), tin).rejects.toMatchObject({ constraint: 'ck_billing_document_customer_tin_format' });
        await client.query('ROLLBACK TO SAVEPOINT bad');
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(await receiptOf(saleId)).toMatchObject({ customer_tin: null });
  });
});

describe('a business buyer named on a queued sale (A-285 (e), ADR-0027: a synced sale is always recorded)', () => {
  it('prints valid details on the synced receipt, with no customer created', async () => {
    const before = await customers();
    const sale = queued({ name: BUYER, tin: CARD_PIN });
    const [result] = await sync([sale]);
    expect(result!.outcome, JSON.stringify(result)).toBe('APPLIED');
    const receipt = await receiptOf(sale.id);
    expect(receipt).toMatchObject({ customer_id: null, customer_name: BUYER, customer_tin: CARD_PIN, gross: 6_000 });
    expect(await customers()).toBe(before);
    expect(await partiesOf(receipt.id)).toEqual([WALK_IN]);
  });

  it('records a sale whose buyer cannot be printed, issues its receipt without them, and raises it once for review', async () => {
    const badTin = `P${'0'.repeat(7)}`;
    const sale = queued({ name: BUYER, tin: badTin });
    const [result] = await sync([sale]);
    expect(result!.outcome, JSON.stringify(result)).toBe('APPLIED_WITH_EXCEPTION');
    expect(result!.exceptions.map((e) => e.kind)).toEqual(['BUYER_DETAILS_REFUSED']);
    expect(result!.receiptNo).toMatch(/^RCP-/);
    expect(await receiptOf(sale.id)).toMatchObject({ customer_id: null, customer_name: null, customer_tin: null, gross: 6_000 });
    expect(await one('SELECT amount_pesewas::int AS amount FROM pay.payment WHERE order_document_id = $1', [sale.id])).toEqual({ amount: 6_000 });
    const raised = await rows<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pos.OfflineSaleFlagged' AND subject_id = $1 AND payload->>'exceptionKind' = 'BUYER_DETAILS_REFUSED'", [sale.id]);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.payload).toMatchObject({ severity: 'REVIEW', fact: { rules: ['BUYER_TIN_INVALID'], tinMasked: '****0000' } });
    expect(await writtenOutsideTheDocument(badTin)).toEqual([]);

    const [again] = await sync([sale]);
    expect(again!.outcome).toBe('DUPLICATE');
    expect(await rows("SELECT 1 FROM platform.outbox_message WHERE event_type = 'pos.OfflineSaleFlagged' AND subject_id = $1 AND payload->>'exceptionKind' = 'BUYER_DETAILS_REFUSED'", [sale.id])).toHaveLength(1);
  });

  it('keeps a refused sale’s evidence with the TIN masked', async () => {
    const sale = queued({ name: BUYER, tin: COMPANY_TIN });
    const tampered = { ...sale, payloadHash: '0'.repeat(64) };
    const [result] = await sync([tampered]);
    expect(result!.outcome).toBe('REJECTED_INTEGRITY');
    expect(await writtenOutsideTheDocument(COMPANY_TIN)).toEqual([]);
    const evidence = await one<{ payload: { submitted: Record<string, unknown> } }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pos.OfflineSaleRejected' ORDER BY id DESC LIMIT 1");
    expect(evidence.payload.submitted).toMatchObject({ buyer: { name: BUYER, tinMasked: '*******0042' } });
  });
});
