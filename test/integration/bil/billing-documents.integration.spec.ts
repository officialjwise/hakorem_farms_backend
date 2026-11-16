import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Billing, type IssueRequest } from '../../../src/modules/bil';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { NumberSeries } from '../../../src/platform/documents/number-series';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Billing documents over the seeded farm (FR-BIL-001, FR-BIL-004, FR-BIL-006, FR-BIL-007, ADR-0015, ADR-0020, the
 * B08 continued 2 gate): `Billing.issueIn` issues in its caller's serializable transaction and a rollback gives the
 * number back; numbers stay gap-free under concurrent issue with rollbacks; an invoice, a credit note and a debit note
 * each store a levy row per line and levy and post exact debit and credit amounts per levy through the ledger
 * (ADR-0003's three new rows), compared with the journal lines in SQL; an issued document never changes and its totals
 * are its lines', held by the database; a credit note waits for a different person and never exceeds the original;
 * and every operation refuses the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let billing: Billing;
let uow: UnitOfWork;
let branchId: string;
let testBranchId: string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const actorOf = (who: string): Actor => ({ principalId: users.get(who)!.principalId, kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;

/** The lines the ledger posted for a billing document, straight from the journal. */
async function linesOf(documentId: string): Promise<{ code: string; side: string; amount: number; party: string | null }[]> {
  const { rows } = await admin().query<{ code: string; side: string; amount: string; party: string | null }>(
    `SELECT a.code, l.side, l.amount_pesewas::text AS amount, s.display_name AS party
       FROM fin.journal_entry e JOIN fin.journal_line l ON l.journal_entry_id = e.id JOIN fin.account a ON a.id = l.account_id
       LEFT JOIN fin.subledger_party s ON s.id = l.subledger_party_id
      WHERE e.source_document_id = $1 ORDER BY l.line_no`,
    [documentId],
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

const invoiceOf = (overrides: Partial<IssueRequest> = {}): IssueRequest => ({
  kind: 'INVOICE',
  branchId,
  customerId: id('tema'),
  dueDate: toBusinessDate(clock.now()),
  taxInclusive: true,
  lines: [
    // FR-BIL-004's inclusive 42,560: net 35,467, VAT 5,320, NHIL 887, GETFund 886.
    { lineKind: 'PRODUCT', productId: id('meat'), quantity: '1.000', uom: 'PACK', unitPricePesewas: 42_560n },
    // A goat resolved at 85,000 sold at 80,000, zero-rated.
    { lineKind: 'PRODUCT', productId: id('goat'), quantity: '1.000', unitPricePesewas: 80_000n, resolvedUnitPricePesewas: 85_000n },
  ],
  ...overrides,
});

/** Runs `work` as `who` in a request context of its own, as a selling module's command would. */
function asActor<T>(who: string, work: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'billing test', actor: actorOf(who) }, work);
}

async function issue(who: string, request: IssueRequest) {
  return asActor(who, () => uow.run({ isolation: 'serializable', seriesLocks: billing.seriesLocksFor(request.kind, request.branchId) }, (tx) => billing.issueIn(tx, actorOf(who), request)));
}

async function seriesState(kind: string, branch = branchId): Promise<{ next: number; allocations: number; numbers: string[] }> {
  const { rows } = await admin().query<{ next: string; allocations: string; numbers: string[] | null }>(
    `SELECT s.next_value::text AS next, count(a.value)::text AS allocations, array_agg(a.formatted ORDER BY a.value) FILTER (WHERE a.value IS NOT NULL) AS numbers
       FROM platform.number_series s LEFT JOIN platform.number_allocation a ON a.series_id = s.id
      WHERE s.doc_type = $1 AND s.branch_id = $2 GROUP BY s.id`,
    [kind, branch],
  );
  const row = rows[0];
  return row === undefined ? { next: 1, allocations: 0, numbers: [] } : { next: Number(row.next), allocations: Number(row.allocations), numbers: row.numbers ?? [] };
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  billing = api.app.get(Billing);
  uow = api.app.get(UnitOfWork);
  const branches = new Map((await admin().query<{ code: string; id: string }>('SELECT code, id FROM mdm.branch')).rows.map((r) => [r.code, r.id] as const));
  branchId = branches.get('DDW')!;
  testBranchId = branches.get('TST')!;
  for (const [name, sql, value] of [
    ['tema', 'SELECT id FROM mdm.customer WHERE name = $1', 'Tema Cold Store Ltd (SEED)'],
    ['meat', 'SELECT id FROM mdm.product WHERE sku = $1', 'MEAT-GOAT-15KG'],
    ['goat', 'SELECT id FROM mdm.product WHERE sku = $1', 'LIV-GOAT'],
    ['eggs', 'SELECT id FROM mdm.product WHERE sku = $1', 'EGG-CRATE-BIG'],
    ['otherGoods', 'SELECT id FROM mdm.tax_category WHERE code = $1', 'OTHER_GOODS'],
  ] as const) {
    ids.set(name, (await admin().query<{ id: string }>(sql, [value])).rows[0]!.id);
  }
  const people: [string, string, string, string, boolean][] = [
    ['owner', 'Kwabena Owusu', 'OWNER', branchId, true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', branchId, true],
    ['otherAccountant', 'Ama Mensah', 'ACCOUNTANT', testBranchId, true],
    ['manager', 'Akosua Boateng', 'MANAGER', branchId, true],
    ['otherManager', 'Kojo Asamoah', 'MANAGER', branchId, true],
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', branchId, false],
    ['cashier', 'Adwoa Darko', 'CASHIER', branchId, false],
    ['sales', 'Esi Appiah', 'SALES', branchId, false],
    ['farmHand', 'Abdul-Rahman Iddrisu', 'FARM_HAND', branchId, false],
    ['driver', 'Selorm Agbeko', 'DRIVER', branchId, false],
  ];
  for (const [who, name, role, branch, privileged] of people) {
    const user = await createUser(database, { name, grants: [{ role: role as 'OWNER', branchId: branch }] });
    users.set(who, user);
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('issueIn issues in its caller’s transaction, and a rollback gives the number back (FR-BIL-001, ADR-0015)', () => {
  it('issues INV-<year>-DDW-<n> with its levy rows, and a caller that rolls back leaves the series contiguous', async () => {
    const before = await seriesState('INVOICE');
    const year = toBusinessDate(clock.now()).slice(0, 4);
    await expect(
      asActor('accountant', () =>
        uow.run({ isolation: 'serializable', seriesLocks: billing.seriesLocksFor('INVOICE', branchId) }, async (tx) => {
          const issued = await billing.issueIn(tx, actorOf('accountant'), invoiceOf());
          expect(issued.documentNo).toBe(`INV-${year}-DDW-${String(before.next).padStart(6, '0')}`);
          throw new Error('the sale failed after billing');
        }),
      ),
    ).rejects.toThrow('the sale failed after billing');
    expect(await seriesState('INVOICE')).toEqual(before);
    const issued = await issue('accountant', invoiceOf());
    expect(issued.documentNo).toBe(`INV-${year}-DDW-${String(before.next).padStart(6, '0')}`);
    const after = await seriesState('INVOICE');
    expect(after.allocations).toBe(after.next - 1);
    expect(await uow.run({ isolation: 'read committed' }, (tx) => api.app.get(NumberSeries).gapsIn(tx))).toEqual([]);
    ids.set('invoice', issued.id);
  });

  it('stores one levy row per line and levy, zero-rated rows included, with totals that are the sums of the lines', async () => {
    const doc = await get('accountant', `/billing-documents/${id('invoice')}`);
    expect(doc.status, JSON.stringify(doc.body)).toBe(200);
    const [meat, goat] = doc.body.lines;
    expect([meat.lineNetPesewas, meat.lineTaxPesewas, meat.lineGrossPesewas]).toEqual([35_467, 7_093, 42_560]);
    expect(meat.levies.map((l: { levyCode: string; amountPesewas: number; treatment: string; ratePercent: string }) => [l.levyCode, l.treatment, l.ratePercent, l.amountPesewas])).toEqual([
      ['VAT', 'STANDARD', '15.00', 5_320],
      ['NHIL', 'STANDARD', '2.50', 887],
      ['GETFUND', 'STANDARD', '2.50', 886],
    ]);
    expect(goat.levies.map((l: { treatment: string; amountPesewas: number }) => [l.treatment, l.amountPesewas])).toEqual([
      ['ZERO_RATED', 0],
      ['ZERO_RATED', 0],
      ['ZERO_RATED', 0],
    ]);
    expect([doc.body.netPesewas, doc.body.taxPesewas, doc.body.grossPesewas]).toEqual([115_467, 7_093, 122_560]);
    expect(doc.body.levyTotals).toEqual([
      { levyCode: 'VAT', levyName: expect.any(String), amountPesewas: 5_320 },
      { levyCode: 'NHIL', levyName: expect.any(String), amountPesewas: 887 },
      { levyCode: 'GETFUND', levyName: expect.any(String), amountPesewas: 886 },
    ]);
    expect(doc.body.settlement).toMatchObject({ allocatedPesewas: 0, creditedPesewas: 0, outstandingPesewas: 122_560, paymentStatus: 'UNPAID' });
    expect(doc.body.customer).toMatchObject({ id: id('tema'), name: 'Tema Cold Store Ltd (SEED)' });
    expect(doc.body.customerName).toBe('Tema Cold Store Ltd (SEED)');
  });

  it('posts bil.InvoiceIssued exactly: 1200 at the agreed gross, sales at resolved by GL group, each levy on 2100 against itself, the variance on 4210', async () => {
    expect(await linesOf(id('invoice'))).toEqual([
      { code: '1200', side: 'D', amount: 122_560, party: 'Tema Cold Store Ltd (SEED)' },
      { code: '4010', side: 'C', amount: 35_467, party: null },
      { code: '4000', side: 'C', amount: 85_000, party: null },
      { code: '2100', side: 'C', amount: 5_320, party: 'VAT' },
      { code: '2100', side: 'C', amount: 887, party: 'NHIL' },
      { code: '2100', side: 'C', amount: 886, party: 'GETFUND' },
      { code: '4210', side: 'D', amount: 5_000, party: null },
    ]);
  });

  it('refuses a request no rule allows, and an issue outside a serializable transaction', async () => {
    await expect(issue('accountant', invoiceOf({ customerId: null }))).rejects.toMatchObject({ code: 'BILLING_DOCUMENT_INVALID' });
    await expect(issue('accountant', invoiceOf({ lines: [{ lineKind: 'PRODUCT', productId: id('eggs'), quantity: '1.000', unitPricePesewas: 6_000n, discountPesewas: 6_001n }] }))).rejects.toMatchObject({
      code: 'BILLING_DOCUMENT_INVALID',
      details: [expect.objectContaining({ code: 'DISCOUNT_EXCEEDS_LINE' })],
    });
    await expect(issue('accountant', invoiceOf({ lines: [{ lineKind: 'PRODUCT', productId: randomUUID(), quantity: '1.000', unitPricePesewas: 6_000n }] }))).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
    await expect(asActor('accountant', () => uow.run({ isolation: 'read committed' }, (tx) => billing.issueIn(tx, actorOf('accountant'), invoiceOf())))).rejects.toThrow(/serializable/);
  });

  it('issues a proforma from its own series and posts nothing (FR-BIL-006)', async () => {
    const proforma = await issue('manager', invoiceOf({ kind: 'PROFORMA', dueDate: null }));
    expect(proforma.documentNo).toMatch(/^PRO-\d{4}-DDW-\d{6}$/);
    expect(proforma.settlement.paymentStatus).toBe('NOT_APPLICABLE');
    expect(await linesOf(proforma.id)).toEqual([]);
  });
});

describe('billing numbers stay gap-free under concurrent issue (FR-BIL-001, the gate)', () => {
  it('issues gap-free numbers under concurrent load with rollbacks: 200 issues from eight issuers at once, 25 rolled back, leave 175 receipts numbered consecutively', async () => {
    const before = await seriesState('RECEIPT');
    const request: IssueRequest = { kind: 'RECEIPT', branchId, taxInclusive: true, lines: [{ lineKind: 'PRODUCT', productId: id('eggs'), quantity: '1.000', unitPricePesewas: 6_000n }] };
    // Eight issuers at once (the pool's share a test may hold), 25 issues each; every eighth issue rolls back.
    const one = (n: number) =>
      asActor('manager', () =>
        uow.run({ isolation: 'serializable', seriesLocks: billing.seriesLocksFor('RECEIPT', branchId) }, async (tx) => {
          const issued = await billing.issueIn(tx, actorOf('manager'), request);
          if (n % 8 === 0) throw new Error(`rolled back ${issued.documentNo}`);
          return issued.documentNo;
        }),
      );
    const results = (
      await Promise.all(
        Array.from({ length: 8 }, async (_, worker) => {
          const settled: PromiseSettledResult<string | null>[] = [];
          for (let k = 0; k < 25; k += 1) settled.push(...(await Promise.allSettled([one(worker * 25 + k)])));
          return settled;
        }),
      )
    ).flat();
    const issued = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    expect(results.flatMap((r) => (r.status === 'rejected' && !String((r.reason as Error).message).startsWith('rolled back') ? [String((r.reason as Error).message)] : [])).slice(0, 3)).toEqual([]);
    expect(issued).toHaveLength(175);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(25);
    const after = await seriesState('RECEIPT');
    expect(after.next - before.next).toBe(175);
    expect(after.allocations).toBe(after.next - 1);
    const sequence = after.numbers.map((n) => Number(n.slice(-6)));
    expect(sequence).toEqual(Array.from({ length: after.next - 1 }, (_, i) => i + 1));
    expect(new Set(issued).size).toBe(175);
    const { rows } = await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM bil.billing_document WHERE kind = 'RECEIPT' AND status = 'ISSUED' AND branch_id = $1", [branchId]);
    expect(rows[0]!.n).toBe(after.next - 1);
    const journals = await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM fin.journal_entry WHERE event_code = 'bil.InvoiceIssued' AND source_document_id IN (SELECT id FROM bil.billing_document WHERE kind = 'RECEIPT')");
    expect(journals.rows[0]!.n).toBe(after.next - 1);
  });
});

describe('an issued document never changes, and its totals are its lines’, held by the database (FR-BIL-004, FR-BIL-008)', () => {
  it('refuses an update of an issued document outside its listed columns, and any change to its lines or levy rows', async () => {
    expect(await sqlStateOf(app().query('UPDATE bil.billing_document SET gross_pesewas = gross_pesewas + 1 WHERE id = $1', [id('invoice')]))).toBe('HK004');
    expect(await sqlStateOf(app().query('UPDATE bil.billing_document SET customer_name = $2 WHERE id = $1', [id('invoice'), 'Someone else']))).toBe('HK004');
    expect(await sqlStateOf(app().query("UPDATE bil.billing_document SET status = 'DRAFT' WHERE id = $1", [id('invoice')]))).toBe('HK004');
    expect(await sqlStateOf(app().query('UPDATE bil.billing_document_line SET line_net_pesewas = line_net_pesewas WHERE billing_document_id = $1', [id('invoice')]))).toBe('HK004');
    expect(await sqlStateOf(app().query('UPDATE bil.billing_document_line_tax SET amount_pesewas = 0 WHERE billing_document_line_id IN (SELECT id FROM bil.billing_document_line WHERE billing_document_id = $1)', [id('invoice')]))).toBe('HK004');
    expect(await sqlStateOf(app().query('DELETE FROM bil.billing_document WHERE id = $1', [id('invoice')]))).toBe('42501');
  });

  it('refuses a content hash without its archived document (B08 continued 2b sets both once, doc/document-archive)', async () => {
    expect(await sqlStateOf(app().query('UPDATE bil.billing_document SET content_hash = $2 WHERE id = $1', [id('invoice'), Buffer.alloc(32, 7)]))).toBe('23514');
  });

  it('refuses at commit an issue whose totals are not the sums of its lines, or whose number was not allocated to it', async () => {
    const client = await app().connect();
    try {
      const draft = randomUUID();
      const version = (await client.query<{ tax_scheme_version_id: string }>('SELECT tax_scheme_version_id FROM bil.billing_document WHERE id = $1', [id('invoice')])).rows[0]!.tax_scheme_version_id;
      const actor = users.get('accountant')!.principalId;
      const attempt = async (documentNo: string, gross: number) => {
        await client.query('BEGIN');
        try {
          await client.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'INVOICE', 'bil', $2, $3)", [draft, branchId, actor]);
          await client.query(
            `INSERT INTO bil.billing_document (id, kind, status, branch_id, customer_id, issue_date, tax_inclusive, tax_scheme_version_id, created_by, updated_by)
             VALUES ($1, 'INVOICE', 'DRAFT', $2, $3, current_date, false, $4, $5, $5)`,
            [draft, branchId, id('tema'), version, actor],
          );
          await client.query(
            `INSERT INTO bil.billing_document_line (id, billing_document_id, line_no, line_kind, product_id, description, qty, uom, unit_price_pesewas, resolved_unit_price_pesewas,
                                                    tax_category_id, line_net_pesewas, line_tax_pesewas, line_gross_pesewas, gl_group)
             SELECT $1, $2, 1, 'PRODUCT', p.id, 'Eggs', 1, 'CRATE', 6000, 6000, p.tax_category_id, 6000, 0, 6000, 'PRODUCE_EGGS' FROM mdm.product p WHERE p.id = $3`,
            [randomUUID(), draft, id('eggs')],
          );
          await client.query("UPDATE bil.billing_document SET status = 'ISSUED', document_no = $2, net_pesewas = $3, gross_pesewas = $3, issued_at = now(), issued_by = $4 WHERE id = $1", [draft, documentNo, gross, actor]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      };
      await expect(attempt('INV-HAND-0001', 6_000)).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_billing_document_number' });
      await expect(attempt('INV-HAND-0002', 6_001)).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_billing_document_totals' });
    } finally {
      client.release();
    }
  });
});

describe('a credit note waits for a different person and never exceeds the original (FR-BIL-007, ADR-0017)', () => {
  it('drafts a credit of 30,000 (net, tax-exclusive) against an invoice of 86,240 and waits for approval, issuing nothing', async () => {
    const original = await issue('accountant', {
      kind: 'INVOICE',
      branchId,
      customerId: id('tema'),
      dueDate: toBusinessDate(clock.now()),
      taxInclusive: false,
      lines: [{ lineKind: 'PRODUCT', productId: id('eggs'), description: 'Eggs, 30.800 crate-equivalents', quantity: '30.800', uom: 'CRATE', unitPricePesewas: 2_800n }],
    });
    expect(original.grossPesewas).toBe(86_240);
    ids.set('zeroRated', original.id);
    const asked = await post('accountant', `/billing-documents/${original.id}/credit-notes`, { reasonCode: 'QUALITY_COMPLAINT', note: 'Cracked crates', lines: [{ lineId: original.lines[0]!.id, amountPesewas: 30_000 }] });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'CREDIT_NOTE', subject: { docType: 'CREDIT_NOTE', number: null } });
    ids.set('creditApproval', asked.body.approvalRequestId);
    ids.set('credit', asked.body.subject.id);
    const draft = await get('accountant', `/billing-documents/${id('credit')}`);
    expect(draft.body).toMatchObject({ status: 'DRAFT', documentNo: null, grossPesewas: 0 });
    expect(await linesOf(id('credit'))).toEqual([]);
  });

  it('refuses the maker approving it, and lets the Manager approve: then it is numbered, issued and posted, and the original has 56,240 left', async () => {
    await stepUp(api.server, as('accountant') as TotpSession, clock);
    expect((await post('accountant', `/iam/approvals/${id('creditApproval')}/approve`, { reason: 'My own' })).status).toBe(403);
    await stepUp(api.server, as('manager') as TotpSession, clock);
    const approved = await post('manager', `/iam/approvals/${id('creditApproval')}/approve`, { reason: 'Photographs checked' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const credit = await get('accountant', `/billing-documents/${id('credit')}`);
    expect(credit.body).toMatchObject({ kind: 'CREDIT_NOTE', status: 'ISSUED', grossPesewas: 30_000, reasonCode: 'QUALITY_COMPLAINT', originalDocument: { id: id('zeroRated') } });
    expect(credit.body.documentNo).toMatch(/^CRN-\d{4}-DDW-\d{6}$/);
    expect(await linesOf(id('credit'))).toEqual([
      { code: '4200', side: 'D', amount: 30_000, party: null },
      { code: '1200', side: 'C', amount: 30_000, party: 'Tema Cold Store Ltd (SEED)' },
    ]);
    const event = await admin().query<{ payload: { approvalRequestId: string; abuseCases: number[]; grossPesewas: number } }>(
      "SELECT payload FROM platform.outbox_message WHERE event_type = 'bil.CreditNoteIssued' AND subject_id = $1",
      [id('credit')],
    );
    expect(event.rows[0]!.payload).toMatchObject({ approvalRequestId: id('creditApproval'), abuseCases: [31], grossPesewas: 30_000 });
    const original = await get('accountant', `/billing-documents/${id('zeroRated')}`);
    expect(original.body.settlement).toMatchObject({ creditedPesewas: 30_000, outstandingPesewas: 56_240, paymentStatus: 'PART_PAID' });
    expect(original.body.grossPesewas).toBe(86_240);
  });

  it('refuses a further 60,000, by the handler and by the database', async () => {
    const original = await get('accountant', `/billing-documents/${id('zeroRated')}`);
    const refused = await post('accountant', `/billing-documents/${id('zeroRated')}/credit-notes`, { reasonCode: 'QUALITY_COMPLAINT', note: 'More', lines: [{ lineId: original.body.lines[0].id, amountPesewas: 60_000 }] });
    expect(refused.status).toBe(422);
    expect(refused.body.error.details).toEqual([expect.objectContaining({ field: '/lines/0', code: 'LINE_ALREADY_CREDITED' })]);
    expect(await sqlStateOf(app().query('UPDATE bil.billing_document SET credited_pesewas = gross_pesewas + 1 WHERE id = $1', [id('zeroRated')]))).toBe('23514');
    const raised = await app().query('UPDATE bil.billing_document SET credited_pesewas = 31000 WHERE id = $1', [id('zeroRated')]).catch((error: unknown) => error);
    expect(raised).toMatchObject({ code: 'HK010', constraint: 'ck_billing_document_credit_cap' });
  });

  it('lets a Manager raise a credit note but never approve it herself; another Manager, or the Owner, approves (the owner, 2026-11-16)', async () => {
    const lineId = (await get('accountant', `/billing-documents/${id('zeroRated')}`)).body.lines[0].id as string;
    const cashier = await post('cashier', `/billing-documents/${id('zeroRated')}/credit-notes`, { reasonCode: 'QUALITY_COMPLAINT', note: 'At the counter', lines: [{ lineId, amountPesewas: 1_000 }] });
    expect([cashier.status, cashier.body.error.code]).toEqual([403, 'FORBIDDEN']);
    const raised = await post('manager', `/billing-documents/${id('zeroRated')}/credit-notes`, { reasonCode: 'QUALITY_COMPLAINT', note: 'Two trays short on delivery', lines: [{ lineId, amountPesewas: 2_000 }] });
    expect(raised.status, JSON.stringify(raised.body)).toBe(202);
    await stepUp(api.server, as('manager') as TotpSession, clock);
    const own = await post('manager', `/iam/approvals/${raised.body.approvalRequestId as string}/approve`, { reason: 'My own' });
    expect([own.status, own.body.error.code]).toEqual([422, 'MAKER_CANNOT_CHECK']);
    await stepUp(api.server, as('otherManager') as TotpSession, clock);
    const approved = await post('otherManager', `/iam/approvals/${raised.body.approvalRequestId as string}/approve`, { reason: 'Delivery note checked' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await get('accountant', `/billing-documents/${raised.body.subject.id as string}`)).body).toMatchObject({ status: 'ISSUED', grossPesewas: 2_000 });
    const second = await post('manager', `/billing-documents/${id('zeroRated')}/credit-notes`, { reasonCode: 'OVERCHARGED', note: 'One crate priced twice', lines: [{ lineId, amountPesewas: 1_000 }] });
    expect(second.status, JSON.stringify(second.body)).toBe(202);
    await stepUp(api.server, as('owner') as TotpSession, clock);
    expect((await post('owner', `/iam/approvals/${second.body.approvalRequestId as string}/approve`, { reason: 'Agreed' })).status).toBe(200);
    expect((await get('accountant', `/billing-documents/${id('zeroRated')}`)).body.settlement).toMatchObject({ creditedPesewas: 33_000, outstandingPesewas: 53_240 });
  });

  it('credits the levies back exactly on a standard-rated line: Dr 4200 net, Dr 2100 per levy, Cr 1200 gross', async () => {
    const meatLine = (await get('accountant', `/billing-documents/${id('invoice')}`)).body.lines[0];
    const asked = await post('accountant', `/billing-documents/${id('invoice')}/credit-notes`, { reasonCode: 'RETURN_QUALITY', note: 'One pack returned', lines: [{ lineId: meatLine.id, quantity: '1.000' }] });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    await stepUp(api.server, as('owner') as TotpSession, clock);
    expect((await post('owner', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Pack seen' })).status).toBe(200);
    expect(await linesOf(asked.body.subject.id)).toEqual([
      { code: '4200', side: 'D', amount: 35_467, party: null },
      { code: '2100', side: 'D', amount: 5_320, party: 'VAT' },
      { code: '2100', side: 'D', amount: 887, party: 'NHIL' },
      { code: '2100', side: 'D', amount: 886, party: 'GETFUND' },
      { code: '1200', side: 'C', amount: 42_560, party: 'Tema Cold Store Ltd (SEED)' },
    ]);
  });
});

describe('a debit note adds a charge and posts it exactly (FR-BIL-007, bil.DebitNoteIssued)', () => {
  it('issues a debit note of 10,000 net at OTHER_GOODS (inclusive original: gross 10,000) and posts Dr 1200, Cr 4030 and each levy', async () => {
    const issued = await post('accountant', `/billing-documents/${id('invoice')}/debit-notes`, {
      reasonCode: 'UNDERCHARGED',
      note: 'Second pack weighed heavier',
      lines: [{ description: 'Weight difference on the pack', amountPesewas: 10_000, taxCategoryId: id('otherGoods') }],
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    expect(issued.body.documentNo).toMatch(/^DBN-\d{4}-DDW-\d{6}$/);
    // Inclusive 10,000 at 15, 2.5 and 2.5: net 8,334, VAT 1,250, NHIL 208, GETFund 208 (ADR-0020's tie-break).
    expect([issued.body.netPesewas, issued.body.taxPesewas, issued.body.grossPesewas]).toEqual([8_334, 1_666, 10_000]);
    expect(await linesOf(issued.body.id)).toEqual([
      { code: '1200', side: 'D', amount: 10_000, party: 'Tema Cold Store Ltd (SEED)' },
      { code: '4030', side: 'C', amount: 8_334, party: null },
      { code: '2100', side: 'C', amount: 1_250, party: 'VAT' },
      { code: '2100', side: 'C', amount: 208, party: 'NHIL' },
      { code: '2100', side: 'C', amount: 208, party: 'GETFUND' },
    ]);
  });

  it('refuses a reason of the wrong domain, and a note against a proforma or a credit note', async () => {
    const wrong = await post('accountant', `/billing-documents/${id('invoice')}/debit-notes`, { reasonCode: 'QUALITY_COMPLAINT', lines: [{ description: 'x', amountPesewas: 1, taxCategoryId: id('otherGoods') }] });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.details).toEqual([expect.objectContaining({ field: '/reasonCode', code: 'REASON_NOT_ALLOWED' })]);
    const againstCredit = await post('accountant', `/billing-documents/${id('credit')}/debit-notes`, { reasonCode: 'UNDERCHARGED', note: 'x', lines: [{ description: 'x', amountPesewas: 1, taxCategoryId: id('otherGoods') }] });
    expect(againstCredit.status).toBe(422);
    expect(againstCredit.body.error.details).toEqual([expect.objectContaining({ code: 'ORIGINAL_NOT_CORRECTABLE' })]);
  });
});

describe('every billing operation refuses the wrong role (ADR-0035)', () => {
  it('refuses the Storekeeper, Farm hand and Driver every read and write, and writes nothing', async () => {
    const before = (await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM bil.billing_document')).rows[0]!.n;
    for (const who of ['storekeeper', 'farmHand', 'driver']) {
      expect((await get(who, '/billing-documents')).status, who).toBe(403);
      expect((await get(who, `/billing-documents/${id('invoice')}`)).status, who).toBe(403);
      expect((await post(who, `/billing-documents/${id('invoice')}/credit-notes`, { reasonCode: 'OVERCHARGED', note: 'x', lines: [{ lineId: randomUUID(), amountPesewas: 1 }] })).status, who).toBe(403);
      expect((await post(who, `/billing-documents/${id('invoice')}/debit-notes`, { reasonCode: 'UNDERCHARGED', note: 'x', lines: [{ description: 'x', amountPesewas: 1, taxCategoryId: id('otherGoods') }] })).status, who).toBe(403);
    }
    expect((await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM bil.billing_document')).rows[0]!.n).toBe(before);
  });

  it('lets the Cashier and Sales read but neither raise a credit note nor issue a debit note, nor the Manager issue a debit note', async () => {
    for (const who of ['cashier', 'sales']) {
      expect((await get(who, `/billing-documents/${id('invoice')}`)).status, who).toBe(200);
      expect((await post(who, `/billing-documents/${id('invoice')}/credit-notes`, { reasonCode: 'OVERCHARGED', note: 'x', lines: [{ lineId: randomUUID(), amountPesewas: 1 }] })).status, who).toBe(403);
      expect((await post(who, `/billing-documents/${id('invoice')}/debit-notes`, { reasonCode: 'UNDERCHARGED', note: 'x', lines: [{ description: 'x', amountPesewas: 1, taxCategoryId: id('otherGoods') }] })).status, who).toBe(403);
    }
    expect((await post('manager', `/billing-documents/${id('invoice')}/debit-notes`, { reasonCode: 'UNDERCHARGED', note: 'x', lines: [{ description: 'x', amountPesewas: 1, taxCategoryId: id('otherGoods') }] })).status).toBe(403);
  });

  it('refuses an Accountant of another branch reading or correcting a Dodowa document, and lists none of them to that Accountant', async () => {
    expect((await get('otherAccountant', `/billing-documents/${id('invoice')}`)).status).toBe(403);
    expect((await post('otherAccountant', `/billing-documents/${id('invoice')}/debit-notes`, { reasonCode: 'UNDERCHARGED', note: 'x', lines: [{ description: 'x', amountPesewas: 1, taxCategoryId: id('otherGoods') }] })).status).toBe(403);
    const listed = await get('otherAccountant', '/billing-documents?limit=100');
    expect(listed.status).toBe(200);
    expect(listed.body.data.filter((d: { branchId: string }) => d.branchId === branchId)).toEqual([]);
  });

  it('lists a branch’s documents newest first, by kind and number, and finds one by its number', async () => {
    const page = await get('accountant', '/billing-documents?kind=CREDIT_NOTE&limit=1');
    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.page.hasMore).toBe(true);
    const next = await get('accountant', `/billing-documents?kind=CREDIT_NOTE&limit=1&cursor=${encodeURIComponent(page.body.page.nextCursor as string)}`);
    expect(next.body.data[0].id).not.toBe(page.body.data[0].id);
    const invoice = await get('accountant', `/billing-documents/${id('invoice')}`);
    const found = await get('accountant', `/billing-documents?documentNo=${invoice.body.documentNo as string}`);
    expect(found.body.data.map((d: { id: string }) => d.id)).toEqual([id('invoice')]);
  });
});
