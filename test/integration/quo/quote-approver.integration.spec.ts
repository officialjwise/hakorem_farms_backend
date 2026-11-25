import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Who approved a quote version (B12f, the owner, 2026-11-24, from the frontend's F10o, A-396, A-397): "say who approved
 * each version, so the console can hide 'Issue and send' from the approver instead of letting them be refused".
 * `QuoteVersion.approvedBy` names the person whose decision approved the version below the margin floor, read from the
 * decision QUO already records (`quo.quote_version.approved_by`, written from IAM's decision), and is null for every
 * version that did not go through approval and get approved: issued at once, still waiting, or rejected. The rule is
 * unchanged: the approver's issue is refused, another person's issues. The approver is a staff member, so the name is
 * shown only to callers who may already read the quote version, never on the buyer's views (the link, `listMyQuotes`).
 * Issuing an approved version holds what it quotes and names a single hold on its line, as a draft's issue does (0376).
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const one = async (sql: string, values: unknown[] = []) => (await admin().query(sql, values)).rows[0]!;
const principal = (who: string) => users.get(who)!.principalId;

/** A week from the start of the file, at the end of that Accra day. */
const validFor = (days: number) => new Date(Math.floor(clock.now().getTime() / 86_400_000) * 86_400_000 + days * 86_400_000 + 86_399_000).toISOString();
/** One goat at 64,000: below the margin floor over the seeded goats' cost, so its issue waits for a second person. */
const goatBelowFloor = () => ({ productId: id('goat'), description: 'One goat, West African Dwarf, for a naming ceremony', quantity: '1.000', priceBasis: 'PER_HEAD', unitPricePesewas: 64_000 });
/** A crate of big eggs at 6,000: above the floor, issued at once. */
const eggs = () => ({ productId: id('eggs'), description: 'Big eggs by the crate', quantity: '1.000', uom: 'CRATE', priceBasis: 'PER_UNIT', unitPricePesewas: 6_000 });
const draft = (lines: object[], extra: object = {}) =>
  post('sales', '/quotes', { contactName: 'Abena Kyei', contactPhone: '+233244519034', validUntil: validFor(7), taxInclusive: true, terms: 'Half the price as deposit (TEST)', lines, ...extra });
const issue = (who: string, versionId: string) => post(who, `/quote-versions/${versionId}/issue`, { channels: ['SMS'] });
async function decide(who: string, approvalRequestId: string, decision: 'approve' | 'reject') {
  await stepUp(api.server, as(who) as TotpSession, clock);
  return post(who, `/iam/approvals/${approvalRequestId}/${decision}`, { reason: 'Margin agreed for a returning buyer (TEST)' });
}
const currentVersion = async (quoteId: string) => (await get('sales', `/quotes/${quoteId}`)).body.currentVersion as Record<string, unknown>;

/** A quote below the floor, drafted by Sales, asked to issue (202) and approved by the Manager. */
async function approvedQuote(extra: object = {}): Promise<{ quoteId: string; versionId: string }> {
  const made = await draft([goatBelowFloor()], extra);
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const asked = await issue('sales', made.body.currentVersion.id);
  expect(asked.status, JSON.stringify(asked.body)).toBe(202);
  const approved = await decide('manager', asked.body.approvalRequestId, 'approve');
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return { quoteId: made.body.id, versionId: made.body.currentVersion.id };
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await one("SELECT id FROM mdm.branch WHERE code = 'DDW'"))['id'] as string;
  for (const [name, sku] of [['goat', 'LIV-0004'], ['eggs', 'EGG-0003']] as const) ids.set(name, (await one('SELECT id FROM mdm.product WHERE sku = $1', [sku]))['id'] as string);
  const tema = await createBranch(database, 'TMA');
  const people: [string, string, string, boolean, string?][] = [
    ['owner', 'Kwabena Owusu', 'OWNER', true],
    ['manager', 'Akosua Boateng', 'MANAGER', true],
    ['sales', 'Esi Appiah', 'SALES', false],
    ['cashier', 'Adwoa Darko', 'CASHIER', false],
    ['temaOwner', 'Yaa Asantewaa', 'OWNER', true, tema.branchId],
  ];
  for (const [who, name, role, privileged, at] of people) {
    const user = await createUser(database, { name, grants: [{ role: role as 'OWNER', branchId: at ?? branchId }] });
    users.set(who, user);
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  // A buyer with their own sign-in, linked to a seeded customer.
  const buyer = await createUser(database, { name: 'Abena Kyei', realm: 'CUSTOMER' });
  users.set('buyer', buyer);
  const customer = (await one("SELECT id FROM mdm.customer WHERE customer_no = 'C-00002'"))['id'] as string;
  await admin().query('UPDATE mdm.customer SET principal_id = $1, version = version + 1 WHERE id = $2', [buyer.principalId, customer]);
  ids.set('buyerCustomer', customer);
  sessions.set('buyer', await login(api.server, buyer));
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('an approved version is issued by another person and holds what it quotes (0376)', () => {
  it('holds the one goat of a version approved below the floor when Sales issues it, naming the hold on its line', async () => {
    const { quoteId, versionId } = await approvedQuote();
    const issued = await issue('sales', versionId);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.status).toBe('ISSUED');
    const held = await one("SELECT count(*)::int AS n, COALESCE(sum(qty), 0)::numeric(14,3)::text AS qty, min(id::text) AS id FROM inv.stock_reservation WHERE holder_document_id = $1 AND status = 'ACTIVE'", [quoteId]);
    expect([held['n'], held['qty']]).toEqual([1, '1.000']);
    const line = await one('SELECT reservation_id::text AS reservation FROM quo.quote_line WHERE quote_version_id = $1 AND NOT removed', [versionId]);
    expect(line['reservation']).toBe(held['id']);
    // The hold is named once: a further change to the issued version's line is still refused by the database.
    expect(await sqlStateOf(admin().query("UPDATE quo.quote_line SET description = 'changed' WHERE quote_version_id = $1", [versionId]))).toBe('HK004');
  });
});

describe('QuoteVersion.approvedBy: who approved a version below the margin floor (the owner, 2026-11-24, A-396)', () => {
  it('names the approver once approved, before and after another person issues it, and the approver is still refused the issue', async () => {
    const made = await draft([goatBelowFloor()]);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const versionId = made.body.currentVersion.id as string;
    expect(made.body.currentVersion.approvedBy).toBeNull();
    const asked = await issue('sales', versionId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    // Waiting for its approval: nobody has approved it.
    expect(await currentVersion(made.body.id)).toMatchObject({ status: 'PENDING_APPROVAL', approvedBy: null });
    expect((await decide('manager', asked.body.approvalRequestId, 'approve')).status).toBe(200);
    const manager = { id: principal('manager'), displayName: 'Akosua Boateng' };
    expect(await currentVersion(made.body.id)).toMatchObject({ status: 'APPROVED', approvedBy: manager, issuedBy: null });
    // Read from the decision QUO recorded, the very person IAM's decision names: stored once, never copied.
    const stored = await one('SELECT v.approved_by, r.decided_by FROM quo.quote_version v JOIN iam.approval_request r ON r.id = v.approval_request_id WHERE v.id = $1', [versionId]);
    expect([stored['approved_by'], stored['decided_by']]).toEqual([principal('manager'), principal('manager')]);
    // The rule is unchanged: the approver may not issue what they approved; another person issues it.
    const byApprover = await issue('manager', versionId);
    expect([byApprover.status, byApprover.body.error?.details?.[0]?.code]).toEqual([422, 'APPROVER_CANNOT_ISSUE']);
    expect((await currentVersion(made.body.id))['status']).toBe('APPROVED');
    const bySales = await issue('sales', versionId);
    expect(bySales.status, JSON.stringify(bySales.body)).toBe(200);
    expect([bySales.body.status, bySales.body.approvedBy, bySales.body.issuedBy.id]).toEqual(['ISSUED', manager, principal('sales')]);
    expect(await currentVersion(made.body.id)).toMatchObject({ status: 'ISSUED', approvedBy: manager });
    const versions = await get('owner', `/quotes/${made.body.id}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.body.data.map((v: { id: string; approvedBy: unknown }) => [v.id, v.approvedBy])).toEqual([[versionId, manager]]);
  });

  it('answers null for a version issued at once, for one still waiting and for one whose approval was rejected', async () => {
    const atOnce = await draft([eggs()]);
    expect(atOnce.status, JSON.stringify(atOnce.body)).toBe(201);
    const issued = await issue('sales', atOnce.body.currentVersion.id);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect([issued.body.status, issued.body.approvedBy]).toEqual(['ISSUED', null]);
    expect((await currentVersion(atOnce.body.id))['approvedBy']).toBeNull();

    const waiting = await draft([goatBelowFloor()]);
    expect((await issue('sales', waiting.body.currentVersion.id)).status).toBe(202);
    expect(await currentVersion(waiting.body.id)).toMatchObject({ status: 'PENDING_APPROVAL', approvedBy: null });

    const rejected = await draft([goatBelowFloor()]);
    const asked = await issue('sales', rejected.body.currentVersion.id);
    expect(asked.status).toBe(202);
    const no = await decide('owner', asked.body.approvalRequestId, 'reject');
    expect(no.status, JSON.stringify(no.body)).toBe(200);
    const after = await currentVersion(rejected.body.id);
    expect([after['status'], after['approvedBy']]).toEqual(['DRAFT', null]);
    expect((await one('SELECT approved_by FROM quo.quote_version WHERE id = $1', [rejected.body.currentVersion.id]))['approved_by']).toBeNull();
  });

  it("never names the approver on the buyer's views, through the link or in listMyQuotes, and to no caller who may not read the quote", async () => {
    const { quoteId, versionId } = await approvedQuote({ customerId: id('buyerCustomer') });
    const issued = await issue('sales', versionId);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.approvedBy).toEqual({ id: principal('manager'), displayName: 'Akosua Boateng' });
    const seen = [principal('manager'), 'Akosua Boateng', 'approvedBy'];
    const byLink = await request(api.server).get(`/v1/shop/quotes/${issued.body.acceptanceLinkToken as string}`);
    expect(byLink.status, JSON.stringify(byLink.body)).toBe(200);
    const mine = await consoleGet(api.server, as('buyer'), '/v1/me/quotes');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    const quoteNo = (await one('SELECT quote_no FROM quo.quote WHERE id = $1', [quoteId]))['quote_no'] as string;
    expect(mine.body.data.map((q: { quoteNo: string }) => q.quoteNo)).toContain(quoteNo);
    for (const text of [JSON.stringify(byLink.body), JSON.stringify(mine.body)]) for (const s of seen) expect(text).not.toContain(s);
    // Callers who may not read the quote learn nothing of it, the approver included.
    for (const [who, status] of [['cashier', 403], ['temaOwner', 403], ['buyer', 401]] as const) {
      for (const path of [`/quotes/${quoteId}`, `/quotes/${quoteId}/versions`]) {
        const answer = await get(who, path);
        expect([who, path, answer.status]).toEqual([who, path, status]);
        expect(JSON.stringify(answer.body)).not.toContain(principal('manager'));
      }
    }
    expect((await request(api.server).get(`/v1/quotes/${quoteId}`)).status).toBe(401);
  });
});
