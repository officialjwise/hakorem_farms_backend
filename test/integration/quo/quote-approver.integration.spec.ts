import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * An approved quote version is issued by someone other than its approver and holds what it quotes (B12f, 0376): a
 * single hold is named on its line, as a draft's issue does; the lines of the issued version stay frozen.
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
const one = async (sql: string, values: unknown[] = []) => (await admin().query(sql, values)).rows[0]!;

/** A week from the start of the file, at the end of that Accra day. */
const validFor = (days: number) => new Date(Math.floor(clock.now().getTime() / 86_400_000) * 86_400_000 + days * 86_400_000 + 86_399_000).toISOString();
/** One goat at 64,000: below the margin floor over the seeded goats' cost, so its issue waits for a second person. */
const goatBelowFloor = () => ({ productId: id('goat'), description: 'One goat, West African Dwarf, for a naming ceremony', quantity: '1.000', priceBasis: 'PER_HEAD', unitPricePesewas: 64_000 });
const draft = (lines: object[], extra: object = {}) =>
  post('sales', '/quotes', { contactName: 'Abena Kyei', contactPhone: '+233244519034', validUntil: validFor(7), taxInclusive: true, terms: 'Half the price as deposit (TEST)', lines, ...extra });
const issue = (who: string, versionId: string) => post(who, `/quote-versions/${versionId}/issue`, { channels: ['SMS'] });
async function decide(who: string, approvalRequestId: string, decision: 'approve' | 'reject') {
  await stepUp(api.server, as(who) as TotpSession, clock);
  return post(who, `/iam/approvals/${approvalRequestId}/${decision}`, { reason: 'Margin agreed for a returning buyer (TEST)' });
}

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
