import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExceptionProjector, ExceptionSweep } from '../../../src/modules/rpt';
import { AuditTrail } from '../../../src/platform/audit/audit-trail';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { documentWorker, type DocumentWorker } from '../../support/documents';
import { exceptionSources } from '../../support/exception-sources';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The daily exception report (FR-RPT-007 to FR-RPT-009, CR-059, ADR-0026, ADR-0103) on the seeded farm: every source the
 * projector reads is written into the outbox for the projector alone, as the outbox delivers it, and every record the
 * sweep reads is made as its module or the platform makes it (a refused request, an export, a failed audit
 * verification, a stock exception, a break, three split purchase orders through PUR's own API). The report answers an
 * item kind for every abuse case 1 to 18 and every later source, each item with its abuse cases, actor, amount and
 * subject document; an item is reviewed once, never by the person it names; the projection rebuilds to the same items.
 */
/** An exception item as the API answers it, the fields this spec reads. */
interface Item {
  readonly id: string;
  readonly kind: string;
  readonly sourceKind: string | null;
  readonly severity: string;
  readonly abuseCases: number[];
  readonly actor: { readonly id: string; readonly displayName: string } | null;
  readonly amountPesewas: number | null;
  readonly raisedAt: string;
  readonly details: { readonly sourceEvent?: { readonly id: string } | null; readonly breakId?: string; readonly partyId?: string; readonly addressHash?: string } & Record<string, unknown>;
  readonly [field: string]: unknown;
}
interface Report {
  readonly items: Item[];
  readonly counts: { readonly kind: string; readonly count: number; readonly amountPesewas: number }[];
  readonly approvalPairs: { readonly maker: { readonly id: string }; readonly checker: { readonly id: string } }[];
}

let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let worker: DocumentWorker;
let branchId: string;
let otherBranchId: string;
let owner: TestSession;
let manager: TestSession;
let accountant: TestSession;
let cashier: TestSession;
let storekeeper: TestSession;
let otherManager: TestSession;
const people = new Map<string, string>();
const ids = new Map<string, string>();
const admin = () => database.pool('admin');
const get = (who: TestSession, path: string) => consoleGet(api.server, who, `/v1${path}`);
const post = (who: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, who, `/v1${path}`, key).send(body);
const today = () => toBusinessDate(clock.now());
let nextId: () => string;

/** An event in the outbox for the exception projector alone, as the outbox would hold and deliver it. */
async function outbox(type: string, payload: Record<string, unknown>, actorId: string, branch: string | null = branchId): Promise<string> {
  clock.advanceBy(1_000);
  const id = nextId();
  await admin().query(
    `INSERT INTO platform.outbox_message (id, event_type, event_version, subject_type, subject_id, branch_id, actor_id, correlation_id, causation_id, payload, occurred_at, recorded_at)
     VALUES ($1, $2, 1, 'Test', $3, $4, $5, $6, NULL, $7, $8, $8)`,
    [id, type, randomUUID(), branch, actorId, randomUUID(), payload, clock.now()],
  );
  await admin().query("INSERT INTO platform.outbox_delivery (message_id, consumer, subject_id, status, next_attempt_at) VALUES ($1, 'rpt.exception-items', $2, 'PENDING', $3)", [id, id, clock.now()]);
  return id;
}

const sweep = () => api.app.get(ExceptionSweep).sweepDay(today());

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  worker = documentWorker(api, database, clock);
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  await worker.settle();
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  otherBranchId = (await createBranch(database, 'OXB')).branchId;
  for (const [key, sql, value] of [
    ['location:PENS', "SELECT id FROM mdm.location WHERE code = $1 AND branch_id = (SELECT id FROM mdm.branch WHERE code = 'DDW')", 'PENS'],
    ['product:LIV-0001', 'SELECT id FROM mdm.product WHERE sku = $1', 'LIV-0001'],
    ['supplier', 'SELECT id FROM mdm.supplier WHERE name = $1', 'Awutu Poultry Farm (SEED)'],
  ] as const) {
    ids.set(key, (await admin().query<{ id: string }>(sql, [value])).rows[0]!.id);
  }
  const make = async (name: string, role: 'OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'CASHIER' | 'STOREKEEPER', branch: string, privileged: boolean, locationId?: string) => {
    const user = await createUser(database, { name, grants: [{ role, branchId: branch, ...(locationId === undefined ? {} : { locationId }) }] });
    people.set(name, user.principalId);
    return privileged ? enrolAndLogin(api.server, user, () => clock.now()) : login(api.server, user);
  };
  owner = await make('Kwabena Owusu', 'OWNER', branchId, true);
  manager = await make('Abena Quaye', 'MANAGER', branchId, true);
  accountant = await make('Efua Asante', 'ACCOUNTANT', branchId, true);
  cashier = await make('Adwoa Darko', 'CASHIER', branchId, false);
  storekeeper = await make('Yaw Sarpong', 'STOREKEEPER', branchId, false, ids.get('location:PENS'));
  otherManager = await make('Kojo Antwi', 'MANAGER', otherBranchId, true);
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('the daily exception report covers every abuse case through its kind (FR-RPT-007, the B12 gate)', () => {
  const messages = new Map<string, string>();
  let report: Report;
  let actor: string;
  let other: string;

  beforeAll(async () => {
    actor = people.get('Adwoa Darko')!;
    other = people.get('Abena Quaye')!;
    const sources = exceptionSources({ branch: branchId, actor, other, doc: randomUUID(), at: clock.now().toISOString() });
    for (const [type, payload] of Object.entries(sources)) {
      // A company-wide event carries no branch: the item is kept at the head office.
      messages.set(type, await outbox(type, payload, type.startsWith('iam.') || type.startsWith('pur.') ? other : actor, type.startsWith('pur.') || type === 'pay.WebhookRejected' ? null : branchId));
    }
    // The sweep's records, as their modules and the platform write them.
    expect((await get(cashier, `/exceptions/daily-report?date=${today()}`)).status).toBe(403);
    await runAsSystem({ principalId: other, displayName: 'Abena Quaye' }, randomUUID(), () =>
      api.app.get(UnitOfWork).run({ isolation: 'read committed' }, (tx) =>
        api.app.get(AuditTrail).record(tx, { module: 'mdm', action: 'EXPORT', entityType: 'ImportJob', entityId: randomUUID(), branchId, after: { entity: 'CUSTOMERS', format: 'XLSX', rowCount: 412, bulk: true }, actorId: other }),
      ),
    );
    await admin().query("INSERT INTO platform.job_run (id, job_name, started_at, finished_at, outcome, summary, actor_id) VALUES ($1, 'audit-verify', $2, $2, 'DRIFT', $3, $4)", [randomUUID(), clock.now(), { tamperedSeqs: ['41'] }, SYSTEM_PRINCIPAL]);
    for (const kind of ['TRANSFER_VARIANCE', 'SERIAL_CONFLICT']) {
      await admin().query(`INSERT INTO inv.stock_exception (kind, branch_id, product_id, qty, details, raised_at) VALUES ($1, $2, $3, 2, '{}', $4)`, [kind, branchId, ids.get('product:LIV-0001'), clock.now()]);
    }
    // A reused till receipt token (abuse case 37) beside the negative stock the full payload names.
    messages.set('pos.OfflineSaleFlagged:RECEIPT_TOKEN_REFUSED', await outbox('pos.OfflineSaleFlagged', { ...sources['pos.OfflineSaleFlagged'], exceptionKind: 'RECEIPT_TOKEN_REFUSED', severity: 'URGENT', summary: 'A receipt token the till printed was used before', fact: {}, abuseCases: [37] }, actor));
    ids.set('break', randomUUID());
    await admin().query(
      `INSERT INTO pay.reconciliation_break (id, branch_id, kind, provider, reference, amount_pesewas, details, raised_at, created_by, updated_by)
       VALUES ($1, $2, 'PROVIDER_REFERENCE_UNKNOWN', 'PAYSTACK', 'T0000000042', 7500, '{}', $3, $4, $4)`,
      [ids.get('break'), branchId, clock.now(), SYSTEM_PRINCIPAL],
    );
    for (let i = 0; i < 3; i += 1) {
      const created = await post(storekeeper, '/purchase-orders', { supplierId: ids.get('supplier'), deliverToLocationId: ids.get('location:PENS'), orderDate: today(), lines: [{ productId: ids.get('product:LIV-0001'), qtyOrdered: '38.000', unitPricePesewas: 5_000 }] });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect((await post(storekeeper, `/purchase-orders/${created.body.id}/submit`)).body.status).toBe('APPROVED');
    }
    await worker.settle();
    await sweep();
    const response = await get(owner, `/exceptions/daily-report?date=${today()}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    report = response.body;
  });

  it('answers every one of the eighteen abuse cases under its kind, and case 15 under both AUDIT_INTEGRITY and RECONCILIATION_BREAK', () => {
    const items = report.items as Item[];
    const casesOf = (kind: string) => new Set(items.filter((i) => i.kind === kind).flatMap((i) => i.abuseCases as number[]));
    const primary: [number, string][] = [
      [1, 'SALE_VOID'], [2, 'MORTALITY'], [3, 'PRICE_OVERRIDE'], [4, 'UNMATCHED_PAYMENT'], [5, 'WEBHOOK_REJECTED'], [6, 'DRIVER_VARIANCE'],
      [7, 'STOCK_ADJUSTMENT'], [8, 'AUTHORISATION_FAILURE'], [9, 'BULK_EXPORT'], [10, 'DEVICE_COUNTER_GAP'], [10, 'SYNC_REJECTED'], [11, 'STOCK_EXCEPTION'],
      [12, 'REFUND'], [13, 'PAYOUT_DETAIL_CHANGE'], [14, 'CREDIT_OVERRIDE'], [15, 'AUDIT_INTEGRITY'], [15, 'RECONCILIATION_BREAK'], [16, 'PERMISSION_CHANGE'],
      [17, 'SHIFT_OVER_SHORT'], [18, 'YIELD_VARIANCE'],
    ];
    for (const [abuseCase, kind] of primary) expect(casesOf(kind).has(abuseCase), `case ${abuseCase} under ${kind}`).toBe(true);
    const all = new Set(items.flatMap((i) => i.abuseCases as number[]));
    for (let n = 1; n <= 18; n += 1) expect(all.has(n), `abuse case ${n}`).toBe(true);
  });

  it('answers every later source the opener names, each with its own kind and case numbers (cases 19 to 73)', () => {
    const items = report.items as Item[];
    const has = (kind: string, abuseCase: number) => items.some((i) => i.kind === kind && (i.abuseCases as number[]).includes(abuseCase));
    const later: [string, number][] = [
      ['GOODS_RECEIPT_UNMATCHED', 19], ['STOCK_EXCEPTION', 20], ['STOCK_ADJUSTMENT', 21], ['STOCK_EXCEPTION', 24], ['STOCK_ADJUSTMENT', 26],
      ['ORDER_SPLITTING', 27], ['SUPPLIER_VARIANCE', 28], ['SUPPLIER_CREDIT_NOTE', 28], ['PROCESSING_REVERSAL', 29], ['ASSET_DISPOSAL', 30],
      ['CREDIT_NOTE', 31], ['PAYMENT_REVERSAL', 32], ['RECONCILIATION_BREAK', 33], ['RECEIPT_CLAIM', 34], ['AUTHORISATION_FAILURE', 35],
      ['NEGATIVE_STOCK', 36], ['QUOTE_ACCEPTED_BY_STAFF', 40], ['BAD_DEBT_WRITE_OFF', 41], ['WRITTEN_OFF_CUSTOMER_PAID', 41],
      ['CONSENT_RECORDED_BY_STAFF', 42], ['DRIVER_VARIANCE', 43], ['DELIVERY_PHOTO_REUSED', 44], ['DRIVER_VARIANCE', 47], ['DELIVERY_FAILURE', 48],
      ['DELIVERY_WRITE_OFF', 49], ['DELIVERY_REASSIGNED', 50], ['PART_DELIVERY', 51], ['DELIVERY_CANCELLED', 51], ['BACKORDER_HELD', 53],
      ['CREDIT_OVERRIDE', 54], ['STOCK_ADJUSTMENT', 55], ['SALE_RETURN', 56], ['MESSAGE_REPORT_REJECTED', 57], ['MESSAGE_SUPPRESSED', 58],
      ['MESSAGE_FAILED', 62], ['DOCUMENT_SENT', 62], ['QUOTE_HOLD', 64], ['QUOTE_WITHDRAWN', 65], ['ACCEPTED_QUOTE_LAPSED', 66], ['BACKORDER_HELD', 67],
      ['CAPITAL_WITHDRAWAL', 68], ['DISTRIBUTION', 68], ['BACKDATED_CONTRIBUTION', 69], ['RETENTION_RATE', 69], ['PAYOUT_DETAIL_CHANGE', 70],
      ['LOAN_OR_GRANT', 71], ['ACCRUAL_BLOCKED', 71], ['OVERHEAD_ALLOCATION', 72], ['PROJECTION_DRIFT', 72], ['RECONCILIATION_BREAK', 73],
      ['CASH_DROP', 17], ['MORTALITY_PHOTO_REUSED', 2], ['CASH_HANDED_IN_LATE', 17], ['RECEIPT_TOKEN_REFUSED', 37], ['LATE_POSTING', 10],
    ];
    for (const [kind, abuseCase] of later) expect(has(kind, abuseCase), `${kind} with case ${abuseCase}`).toBe(true);
  });

  it('raises an item from every event written, each with its actor, its amount where it has one and its subject document', () => {
    const items = report.items as Item[];
    const bySource = new Map<string, Item[]>();
    for (const i of items) if (i.details?.sourceEvent?.id !== undefined) bySource.set(i.details.sourceEvent.id, [...(bySource.get(i.details.sourceEvent.id) ?? []), i]);
    const none = ['pay.ReconciliationBreakRaised', 'pay.WebhookRejected', 'fin.TrialBalanceDriftDetected', 'cst.ProjectionDriftDetected', 'ntf.MessageFailed', 'ntf.DeliveryReportRejected', 'ntf.MessageSuppressed', 'whl.WrittenOffCustomerPaid', 'pay.UnverifiedPaymentOverdue', 'cap.FinancingAccrualBlocked'];
    for (const [type, id] of messages) {
      const raised = bySource.get(id) ?? [];
      expect(raised.length, type).toBeGreaterThan(0);
      for (const i of raised) {
        expect(i.abuseCases.length, `${type} names its abuse cases`).toBeGreaterThan(0);
        if (!none.includes(type)) expect(i.actor, `${type} names its actor`).toMatchObject({ id: expect.any(String), displayName: expect.any(String) });
        expect(i).toHaveProperty('subjectDocument');
        expect(i).toHaveProperty('amountPesewas');
        expect(i.currency).toBe('GHS');
      }
    }
    const voided = bySource.get(messages.get('ord.OrderVoided')!)![0];
    expect(voided).toMatchObject({ kind: 'SALE_VOID', abuseCases: [1], actor: { id: actor, displayName: 'Adwoa Darko' }, amountPesewas: 127_500, subjectDocument: { docType: 'SALES_ORDER' }, branchId });
    const supplierChange = bySource.get(messages.get('pur.SupplierPayoutChanged')!)![0];
    expect(supplierChange, 'a company-wide item is kept at the head office branch').toMatchObject({ kind: 'PAYOUT_DETAIL_CHANGE', branchId, severity: 'URGENT' });
  });

  it('reads the records the sweep finds: a refused request, a bulk export, a failed verification, a variance, a break with its state and age, and order splitting', () => {
    const items = report.items as Item[];
    expect(items.find((i) => i.kind === 'AUTHORISATION_FAILURE' && i.sourceKind === 'IAM_REFUSAL')).toMatchObject({ abuseCases: [8], actor: { id: people.get('Adwoa Darko') }, details: { permission: 'rpt.exceptions.read' } });
    expect(items.find((i) => i.kind === 'BULK_EXPORT')).toMatchObject({ severity: 'REVIEW', abuseCases: [9], actor: { id: people.get('Abena Quaye') }, summary: 'customers exported: 412 rows' });
    expect(items.find((i) => i.kind === 'AUDIT_INTEGRITY' && i.sourceKind === 'AUDIT_CHAIN_DRIFT')).toMatchObject({ severity: 'URGENT', abuseCases: [15] });
    expect(items.find((i) => i.kind === 'STOCK_EXCEPTION' && i.sourceKind === 'TRANSFER_VARIANCE')).toMatchObject({ abuseCases: [20] });
    expect(items.find((i) => i.details?.breakId === ids.get('break'))).toMatchObject({ kind: 'RECONCILIATION_BREAK', sourceKind: 'PROVIDER_REFERENCE_UNKNOWN', amountPesewas: 7_500, details: { reference: 'T0000000042', breakState: { status: 'OPEN', ageDays: 0 } } });
    expect(items.find((i) => i.kind === 'ORDER_SPLITTING')).toMatchObject({ abuseCases: [27], actor: { displayName: 'Yaw Sarpong' }, amountPesewas: 570_000, subjectDocument: { docType: 'PURCHASE_ORDER' }, details: { supplierId: ids.get('supplier') } });
  });

  it('puts urgent items first, counts every kind with its total, and a second sweep raises nothing new', async () => {
    const severities = (report.items as Item[]).map((i) => i.severity);
    const rank = { URGENT: 0, REVIEW: 1, INFO: 2 } as Record<string, number>;
    expect(severities).toEqual([...severities].sort((a, b) => rank[a]! - rank[b]!));
    const counts = new Map(report.counts.map((c) => [c.kind, c]));
    const voids = (report.items as Item[]).filter((i) => i.kind === 'SALE_VOID');
    expect(counts.get('SALE_VOID')).toEqual({ kind: 'SALE_VOID', count: voids.length, amountPesewas: voids.reduce((s, i) => s + (i.amountPesewas ?? 0), 0) });
    expect((await sweep()).raised).toBe(0);
  });

  it('shows the investor books only to their readers: the Owner and the Accountant see them, the Manager does not', async () => {
    const investorKinds = ['CAPITAL_WITHDRAWAL', 'DISTRIBUTION', 'RETENTION_RATE', 'BACKDATED_CONTRIBUTION', 'LOAN_OR_GRANT', 'ACCRUAL_BLOCKED'];
    expect((report.items as Item[]).filter((i) => investorKinds.includes(i.kind)).length).toBeGreaterThanOrEqual(investorKinds.length);
    const byManager = await get(manager, `/exceptions/daily-report?date=${today()}`);
    expect(byManager.status).toBe(200);
    expect((byManager.body.items as Item[]).filter((i) => investorKinds.includes(i.kind) || i.sourceKind?.startsWith('INVESTOR'))).toEqual([]);
    expect(byManager.body.items.length).toBeGreaterThan(0);
    const byAccountant = await get(accountant, `/exceptions/daily-report?date=${today()}`);
    expect((byAccountant.body.items as Item[]).some((i) => i.kind === 'CAPITAL_WITHDRAWAL')).toBe(true);
  });

  it("refuses the wrong role and the wrong branch alike, a real or made-up branch, and shows another branch's manager nothing of this one", async () => {
    expect((await get(cashier, `/exceptions?date=${today()}`)).status).toBe(403);
    expect((await get(storekeeper, `/exceptions/daily-report?date=${today()}`)).status).toBe(403);
    for (const branch of [branchId, randomUUID()]) expect((await get(otherManager, `/exceptions/daily-report?date=${today()}&branchId=${branch}`)).status).toBe(403);
    const theirs = await get(otherManager, `/exceptions/daily-report?date=${today()}`);
    expect(theirs.status).toBe(200);
    expect(theirs.body.items).toEqual([]);
  });

  it('lists items newest first in pages, by kind, severity, actor and whether reviewed (CR-059 point 3)', async () => {
    const first = await get(owner, `/exceptions?date=${today()}&limit=5`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data).toHaveLength(5);
    expect(first.body.page.hasMore).toBe(true);
    const next = await get(owner, `/exceptions?date=${today()}&limit=5&cursor=${encodeURIComponent(first.body.page.nextCursor)}`);
    expect(next.body.data.map((i: Item) => i.id)).not.toContain(first.body.data[0].id);
    const raised = [...first.body.data, ...next.body.data].map((i: Item) => Date.parse(i.raisedAt));
    expect(raised).toEqual([...raised].sort((a, b) => b - a));
    const urgent = await get(owner, `/exceptions?date=${today()}&severity=URGENT&limit=100`);
    expect((urgent.body.data as Item[]).every((i) => i.severity === 'URGENT')).toBe(true);
    const voids = await get(owner, `/exceptions?date=${today()}&kind=SALE_VOID&actorId=${actor}&limit=100`);
    expect((voids.body.data as Item[]).map((i) => i.kind)).toEqual(['SALE_VOID', 'SALE_VOID']);
    expect((await get(owner, `/exceptions?from=${today()}&to=2020-01-01`)).body.error.code).toBe('REPORT_PERIOD_INVALID');
  });

  it('marks an item reviewed with a note once, never by the person it names; the second review is 409; the unreviewed list drops it', async () => {
    const item = report.items.find((i) => i.kind === 'SALE_VOID' && i.sourceKind === 'VOIDED')!;
    const note = { note: 'Checked the void slip with Adwoa: a wrong goat was rung up.' };
    const byCashier = await post(cashier, `/exceptions/${item.id}/review`, note);
    expect(byCashier.status, JSON.stringify(byCashier.body)).toBe(403);
    expect((await post(otherManager, `/exceptions/${item.id}/review`, note)).status, "another branch's item answers as one that does not exist").toBe(404);
    expect((await post(manager, `/exceptions/${randomUUID()}/review`, note)).status).toBe(404);
    expect((await post(manager, `/exceptions/${item.id}/review`, { note: '' })).status).toBe(400);
    const key = randomUUID();
    const reviewed = await post(manager, `/exceptions/${item.id}/review`, note, key);
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    expect(reviewed.body).toMatchObject({ id: item.id, review: { reviewedBy: { id: people.get('Abena Quaye'), displayName: 'Abena Quaye' }, note: note.note } });
    expect((await post(manager, `/exceptions/${item.id}/review`, note, key)).body).toEqual(reviewed.body);
    const again = await post(owner, `/exceptions/${item.id}/review`, note);
    expect([again.status, again.body.error.code]).toEqual([409, 'ALREADY_REVIEWED']);
    const own = report.items.find((i) => i.actor?.id === people.get('Abena Quaye'))!;
    const refused = await post(manager, `/exceptions/${own.id}/review`, note);
    expect([refused.status, refused.body.error.code]).toEqual([422, 'REVIEWER_IS_ACTOR']);
    const open = await get(owner, `/exceptions?date=${today()}&reviewed=false&limit=100`);
    expect((open.body.data as Item[]).map((i) => i.id)).not.toContain(item.id);
    const done = await get(owner, `/exceptions?date=${today()}&reviewed=true&limit=100`);
    expect((done.body.data as Item[]).map((i) => i.id)).toEqual([item.id]);
    const audit = await admin().query("SELECT count(*)::int AS n FROM platform.audit_event WHERE module = 'rpt' AND action = 'REVIEW' AND entity_id = $1", [item.id]);
    expect(audit.rows[0]!.n).toBe(1);
  });

  it('the database keeps a review once and insert-only, and refuses one by the person the item names', async () => {
    const app = database.pool('app');
    const review = (await admin().query<{ id: string }>('SELECT id FROM rpt.exception_review LIMIT 1')).rows[0]!.id;
    expect(await sqlStateOf(app.query("UPDATE rpt.exception_review SET note = 'changed' WHERE id = $1", [review])), 'the application may only insert').toBe('42501');
    expect(await sqlStateOf(admin().query("UPDATE rpt.exception_review SET note = 'changed' WHERE id = $1", [review])), 'and no role may change one').toBe('HK001');
    expect(await sqlStateOf(admin().query('DELETE FROM rpt.exception_review WHERE id = $1', [review]))).toBe('HK001');
    const me = people.get('Kwabena Owusu')!;
    expect(await sqlStateOf(app.query("INSERT INTO rpt.exception_review (id, exception_item_id, item_actor_ref, note, actor_id) VALUES ($1, $2, $3, 'mine', $3)", [randomUUID(), randomUUID(), me]))).toBe('23514');
    expect(await sqlStateOf(app.query("UPDATE rpt.exception_item SET severity = 'INFO'")), 'the application only reads the projection').toBe('42501');
  });

  it('rebuilds the projection from the outbox to the same items with the same ids, keeping the review (FR-RPT-009)', async () => {
    const before = (await admin().query<{ id: string; kind: string; amount: string | null }>("SELECT id, kind, amount_pesewas::text AS amount FROM rpt.exception_item WHERE event_ref IS NOT NULL ORDER BY id")).rows;
    const rebuilt = await api.app.get(ExceptionProjector).rebuild();
    expect(rebuilt.events).toBeGreaterThan(messages.size);
    const after = (await admin().query<{ id: string; kind: string; amount: string | null }>("SELECT id, kind, amount_pesewas::text AS amount FROM rpt.exception_item WHERE event_ref IS NOT NULL ORDER BY id")).rows;
    expect(after).toEqual(before);
    await sweep();
    const response = await get(owner, `/exceptions?date=${today()}&reviewed=true&limit=100`);
    expect(response.body.data).toHaveLength(1);
    const checkpoint = await admin().query("SELECT last_message_id IS NOT NULL AS read, rebuilt_at IS NOT NULL AS rebuilt FROM rpt.projection_checkpoint WHERE projector = 'rpt.exception-items'");
    expect(checkpoint.rows[0]).toEqual({ read: true, rebuilt: true });
  });

  it('the reporting role reads the projection and never a transactional table (FR-RPT-009)', async () => {
    const report = database.pool('report');
    expect((await report.query('SELECT count(*)::int AS n FROM rpt.exception_item')).rows[0]!.n).toBeGreaterThan(0);
    expect(await sqlStateOf(report.query('SELECT count(*) FROM ord.sales_order'))).toBe('42501');
    expect(await sqlStateOf(report.query('SELECT count(*) FROM pay.payment'))).toBe('42501');
  });
});

describe("till sales that sent no receipt token are counted, and only a refused token listed (the owner, 2026-11-25, A-400)", () => {
  const unlinked = (salesOrderId: string, messageId: string = randomUUID()) =>
    outbox('ntf.MessageSuppressed', { messageId, templateCode: 'SALE_RECEIPT', channel: 'SMS', reason: 'NO_LINK', salesOrderId, sourceEventType: 'ord.OrderCompleted', abuseCases: [60] }, SYSTEM_PRINCIPAL, otherBranchId);
  const sales: string[] = Array.from({ length: 5 }, () => randomUUID());
  const refusedSale: string = randomUUID();
  let report: Report & { readonly countLines: unknown[] };

  beforeAll(async () => {
    const cashierId = people.get('Adwoa Darko')!;
    // Five live sales whose till sent no token: no link, so each receipt text is held back NO_LINK; one held back twice.
    const twice = randomUUID();
    for (const [n, sale] of sales.entries()) await unlinked(sale, n === 0 ? twice : randomUUID());
    await unlinked(sales[0]!, twice);
    // One sale whose token was sent and refused: its refusal, and its receipt text held back for want of a link.
    await outbox(
      'pos.CounterSaleFlagged',
      { saleId: refusedSale, shiftId: randomUUID(), branchId: otherBranchId, register: { id: randomUUID(), code: 'T1' }, deviceId: randomUUID(), cashierId, occurredAt: clock.now().toISOString(), recordedAt: clock.now().toISOString(), exceptionKind: 'RECEIPT_TOKEN_REFUSED', severity: 'URGENT', summary: 'The receipt token the till sent is already bound to another sale', amountPesewas: 6_000, claim: {}, fact: { firstSaleId: randomUUID() }, abuseCases: [37] },
      cashierId,
      otherBranchId,
    );
    await unlinked(refusedSale);
    await worker.settle();
    const response = await get(otherManager, `/exceptions/daily-report?date=${today()}&branchId=${otherBranchId}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    report = response.body;
  });

  it('shows one count line of 5 for the branch and day, abuse case 60, and the refused token as its one item', () => {
    expect(report.countLines).toEqual([{ code: 'TILL_SALES_WITHOUT_RECEIPT_TOKEN', branchId: otherBranchId, count: 5, abuseCases: [60], summary: '5 till sales sent no receipt token' }]);
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({ kind: 'RECEIPT_TOKEN_REFUSED', severity: 'URGENT', abuseCases: [37], actor: { id: people.get('Adwoa Darko'), displayName: 'Adwoa Darko' }, amountPesewas: 6_000, subjectDocument: { id: refusedSale, docType: 'SALES_ORDER' } });
    expect(report.items.filter((i) => i.kind === 'MESSAGE_SUPPRESSED')).toEqual([]);
    expect(report.counts).toEqual([{ kind: 'RECEIPT_TOKEN_REFUSED', count: 1, amountPesewas: 6_000 }]);
  });

  it("keeps the count to its branch: the head office's report has no line for it, and its list no item", async () => {
    const own = await get(owner, `/exceptions/daily-report?date=${today()}`);
    expect(own.status).toBe(200);
    expect(own.body.countLines).toEqual([]);
    const listed = (await get(otherManager, `/exceptions?date=${today()}&kind=MESSAGE_SUPPRESSED&limit=100`)).body.data as Item[];
    expect(listed.filter((i) => [...sales, refusedSale].includes((i['subjectDocument'] as { id: string } | null)?.id ?? ''))).toEqual([]);
  });

  it('counts the same after a rebuild of the projection from the outbox (FR-RPT-009)', async () => {
    await api.app.get(ExceptionProjector).rebuild();
    const rebuilt = await get(otherManager, `/exceptions/daily-report?date=${today()}&branchId=${otherBranchId}`);
    expect(rebuilt.body.countLines).toEqual(report.countLines);
    expect((rebuilt.body.items as Item[]).map((i) => i.id)).toEqual(report.items.map((i) => i.id));
  });
});

describe('the items that need more than one event (SA-17, abuse cases 13 and 70, R18, R1)', () => {
  const dayItems = async (kind: string) => {
    const response = await get(owner, `/exceptions?date=${today()}&kind=${kind}&limit=100`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.data as Item[];
  };

  it('raises one item for an address that let three checkouts end unpaid in a day, and none for one that paid', async () => {
    const hash = 'a'.repeat(64);
    const paying = 'b'.repeat(64);
    for (const address of [hash, paying]) {
      for (let i = 0; i < 3; i += 1) {
        const checkoutId = randomUUID();
        await outbox('shp.CheckoutStarted', { checkoutId, cartId: randomUUID(), reservedUntil: clock.now().toISOString(), estimatedTotalPesewas: 22_000, lineCount: 1, clientAddressHash: address }, SYSTEM_PRINCIPAL);
        await outbox(address === paying && i === 0 ? 'shp.CheckoutCompleted' : 'shp.CheckoutExpired', { checkoutId, cartId: randomUUID(), reservedUntil: clock.now().toISOString(), reason: 'EXPIRED', orderId: randomUUID() }, SYSTEM_PRINCIPAL);
      }
    }
    await worker.settle();
    const items = (await dayItems('CHECKOUT_HOLDING')).filter((i) => [hash, paying].includes(i.details.addressHash ?? ''));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ severity: 'REVIEW', abuseCases: [], details: { residualRisk: 'R18', addressHash: hash, started: 3, unpaid: 3, completed: 0 } });
  });

  it('shows two people approving each other 9 times of 10 as a pair at 90.00 percent with the value (FR-RPT-008)', async () => {
    const maker = people.get('Adwoa Darko')!;
    const checker = people.get('Kwabena Owusu')!;
    const third = people.get('Efua Asante')!;
    for (let i = 0; i < 10; i += 1) {
      await outbox('iam.ApprovalDecided', { kind: 'PRICE_OVERRIDE', decision: 'APPROVED', requestedBy: maker, decidedBy: i < 9 ? checker : third, subjectDocumentId: randomUUID(), amountPesewas: 1_000 }, i < 9 ? checker : third);
    }
    await worker.settle();
    const pairs = (await get(owner, `/exceptions/daily-report?date=${today()}`)).body.approvalPairs as Report['approvalPairs'];
    expect(pairs.find((p) => p.maker.id === maker && p.checker.id === checker)).toEqual({ maker: { id: maker, displayName: 'Adwoa Darko' }, checker: { id: checker, displayName: 'Kwabena Owusu' }, count: 9, amountPesewas: 9_000, frequencyPercent: '90.00' });
  });

  it("raises a supplier payment made within 24 hours after the supplier's payout details changed, and not one made later", async () => {
    const supplierId = randomUUID();
    const other = people.get('Abena Quaye')!;
    await outbox('pur.SupplierPayoutChanged', { payoutChangeId: randomUUID(), supplierId, method: 'BANK', previousPayoutMasked: '****1234', payoutMasked: '****9876', requestedBy: other, approvedBy: people.get('Kwabena Owusu'), abuseCase: 13 }, other, null);
    clock.advanceBy(2 * 3_600_000);
    const soon = randomUUID();
    await outbox('pur.SupplierPaymentMade', { supplierPaymentId: soon, supplierId, method: 'BANK', amountPesewas: 190_000, paidAt: clock.now().toISOString(), approvalRequestId: randomUUID(), allocations: [] }, other, null);
    clock.advanceBy(23 * 3_600_000);
    await outbox('pur.SupplierPaymentMade', { supplierPaymentId: randomUUID(), supplierId, method: 'BANK', amountPesewas: 50_000, paidAt: clock.now().toISOString(), approvalRequestId: randomUUID(), allocations: [] }, other, null);
    await worker.settle();
    // Read from the projection itself: a day on, the test's sessions have ended.
    const found = await admin().query<{ severity: string; abuse_cases: number[]; amount: string; subject: string; hours: number }>(
      "SELECT severity, abuse_cases, amount_pesewas::text AS amount, subject_document_ref AS subject, (details ->> 'hoursAfterChange')::int AS hours FROM rpt.exception_item WHERE kind = 'PAYMENT_AFTER_PAYOUT_CHANGE' AND details ->> 'partyId' = $1",
      [supplierId],
    );
    expect(found.rows).toEqual([{ severity: 'URGENT', abuse_cases: [13], amount: '190000', subject: soon, hours: 2 }]);
  });
});
