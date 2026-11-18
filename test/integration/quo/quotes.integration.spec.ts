import { createHash, randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QuoteExpiry } from '../../../src/modules/quo';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, consolePut, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Quotes (FR-QUO-003 to FR-QUO-012, CR-045, CR-047), the gate of B10 as split (A-309): a quote is made of versions,
 * every issued one immutable (also to direct SQL), a change a new version with its author, time and totals; a version
 * below the margin floor is issued only once a different person approves it, held by the database; a line in a crate or
 * a single egg is priced by that unit's own entry and reserved in the base unit; the acceptance link is a random token
 * stored only as its hash, opening the live version only, accepted once; and an accepted quote converts to exactly one
 * order that keeps every link (quote, version, line, request and the order's billing document). Every money figure is
 * an exact integer; costs and reservations are asserted against SQL sums straight from INV's tables.
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
const app = () => database.pool('app');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const put = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePut(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const publicPost = (path: string, body: object, key: string = randomUUID(), ip = '198.51.100.7') =>
  request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).set('X-Forwarded-For', ip).send(body);
const publicGet = (path: string) => request(api.server).get(`/v1${path}`);
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();
const one = async (sql: string, values: unknown[] = []) => (await admin().query(sql, values)).rows[0]!;

/** A week from the start of the file, at the end of that Accra day. */
const validFor = (days: number) => new Date(Math.floor(clock.now().getTime() / 86_400_000) * 86_400_000 + days * 86_400_000 + 86_399_000).toISOString();

const goatLine = (unitPricePesewas: number, quantity = '4.000') => ({ productId: id('goat'), description: 'Goats, West African Dwarf, for a naming ceremony', quantity, priceBasis: 'PER_HEAD', unitPricePesewas });
const draft = (who: string, lines: object[], extra: object = {}) =>
  post(who, '/quotes', { contactName: 'Kofi Mensah', contactPhone: '+233244512876', validUntil: validFor(7), taxInclusive: true, terms: 'Half the price as deposit (TEST)', lines, ...extra });

async function issue(who: string, versionId: string, key: string = randomUUID()) {
  return post(who, `/quote-versions/${versionId}/issue`, { channels: ['SMS'] }, key);
}

async function approve(who: string, approvalRequestId: string) {
  await stepUp(api.server, as(who) as TotpSession, clock);
  return post(who, `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Margin agreed for a returning buyer (TEST)' });
}

/** Active reservations a document holds, straight from INV's table. */
async function heldBy(holderId: string): Promise<{ qty: string; n: number }> {
  const r = await one("SELECT COALESCE(sum(qty), 0)::numeric(14,3)::text AS qty, count(*)::int AS n FROM inv.stock_reservation WHERE holder_document_id = $1 AND status = 'ACTIVE'", [holderId]);
  return { qty: r['qty'] as string, n: r['n'] as number };
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await one("SELECT id FROM mdm.branch WHERE code = 'DDW'"))['id'] as string;
  for (const [name, sku] of [['goat', 'LIV-0004'], ['eggs', 'EGG-0003'], ['cabbage', 'PRD-0005']] as const) ids.set(name, (await one('SELECT id FROM mdm.product WHERE sku = $1', [sku]))['id'] as string);
  for (const tag of ['G-0142', 'G-0143', 'G-0144', 'G-0145']) ids.set(tag, (await one('SELECT id FROM inv.stock_unit WHERE identifier = $1', [tag]))['id'] as string);
  const tema = await createBranch(database, 'TMA');
  const people: [string, string, string, boolean, string?][] = [
    ['owner', 'Kwabena Owusu', 'OWNER', true],
    ['manager', 'Akosua Boateng', 'MANAGER', true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
    ['sales', 'Esi Appiah', 'SALES', false],
    ['cashier', 'Adwoa Darko', 'CASHIER', false],
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', false],
    ['temaOwner', 'Yaa Asantewaa', 'OWNER', true, tema.branchId],
  ];
  for (const [who, name, role, privileged, at] of people) {
    const user = await createUser(database, { name, grants: [{ role: role as 'OWNER', branchId: at ?? branchId }] });
    users.set(who, user);
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  const shopper = await createUser(database, { name: 'Abena Kyei', realm: 'CUSTOMER' });
  sessions.set('customer', await login(api.server, shopper));
});

afterAll(async () => {
  if (process.env['QUO_DEBUG'] !== undefined) (await import('node:fs')).writeFileSync(process.env['QUO_DEBUG'], JSON.stringify(api.logLines().filter((l) => Number(l['level']) >= 50), null, 1));
  await api?.close();
  await database?.drop();
});

describe('a quote is made of versions; an issued one never changes (FR-QUO-006, the gate)', () => {
  it('keeps version 1 at 280,000 when version 2 is issued at 264,000, lists both with author and totals, and marks only 2 current', async () => {
    const made = await draft('sales', [goatLine(70_000)]);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const quote = made.body;
    ids.set('goatQuote', quote.id);
    expect([quote.status, quote.quoteNo, quote.versionCount, quote.currentVersion.versionNo, quote.currentVersion.status]).toEqual(['DRAFT', expect.stringMatching(/^QUO-\d{4}-DDW-\d{6}$/), 1, 1, 'DRAFT']);
    // The goats' cost is the average of their pools at the branch, straight from INV's table: 4 at 240,000 is 60,000 a head.
    const pools = await one(
      "SELECT sum(c.value_pesewas)::text AS v, sum(c.qty)::text AS q FROM inv.cost_pool c JOIN inv.stock_unit u ON u.id = c.stock_unit_id WHERE c.product_id = $1 AND c.branch_id = $2 AND u.status = 'ACTIVE' AND c.qty > 0",
      [id('goat'), branchId],
    );
    expect([pools['v'], pools['q']]).toEqual(['240000', '4.000']);
    const v1 = quote.currentVersion;
    expect([v1.netPesewas, v1.taxPesewas, v1.grossPesewas, v1.estimatedCostPesewas, v1.marginPercent, v1.belowMarginFloor]).toEqual([280_000, 0, 280_000, 240_000, '16.67', false]);
    expect(v1.lines.map((l: Record<string, unknown>) => [l['quantity'], l['uom'], l['unitPricePesewas'], l['lineNetPesewas'], l['estimatedUnitCostPesewas']])).toEqual([['4.000', 'HEAD', 70_000, 280_000, 60_000]]);

    const issued = await issue('sales', v1.id);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect([issued.body.status, issued.body.acceptanceLinkToken]).toEqual(['ISSUED', expect.stringMatching(/^quo_[A-Za-z0-9_-]{43}$/)]);
    ids.set('v1', v1.id);
    ids.set('v1Token', issued.body.acceptanceLinkToken);

    const revised = await post('sales', `/quotes/${quote.id}/versions`, { changeNote: 'Buyer asked for a better price per head' });
    expect(revised.status, JSON.stringify(revised.body)).toBe(201);
    expect([revised.body.versionNo, revised.body.status, revised.body.changeNote, revised.body.netPesewas]).toEqual([2, 'DRAFT', 'Buyer asked for a better price per head', 280_000]);
    const edited = await put('sales', `/quote-versions/${revised.body.id}`, { version: revised.body.version ?? 1, lines: [goatLine(66_000)] });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    // 264,000 over 240,000 is exactly 10.00 percent: at the floor, not below it, so it issues without approval (FR-QUO-005).
    expect([edited.body.netPesewas, edited.body.marginPercent, edited.body.belowMarginFloor]).toEqual([264_000, '10.00', false]);
    const second = await issue('sales', revised.body.id);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    ids.set('v2', revised.body.id);
    ids.set('v2Token', second.body.acceptanceLinkToken);

    const versions = await get('sales', `/quotes/${quote.id}/versions`);
    expect(versions.status).toBe(200);
    const salesId = users.get('sales')!.principalId;
    expect(versions.body.data.map((v: Record<string, Record<string, unknown>>) => [v['versionNo'], v['status'], v['grossPesewas'], v['createdBy']!['id'], typeof v['createdAt']])).toEqual([
      [2, 'ISSUED', 264_000, salesId, 'string'],
      [1, 'SUPERSEDED', 280_000, salesId, 'string'],
    ]);
    const now = await get('sales', `/quotes/${quote.id}`);
    expect([now.body.status, now.body.versionCount, now.body.currentVersion.versionNo, now.body.currentVersion.grossPesewas]).toEqual(['ISSUED', 2, 2, 264_000]);
    const stored = await one('SELECT net_pesewas::text AS net, status FROM quo.quote_version WHERE id = $1', [v1.id]);
    expect([stored['net'], stored['status']]).toEqual(['280000', 'SUPERSEDED']);
  });

  it('refuses, by direct SQL, any change to an issued version or its lines', async () => {
    expect(await sqlStateOf(app().query('UPDATE quo.quote_version SET net_pesewas = 1, gross_pesewas = 1, version = version + 1 WHERE id = $1', [id('v2')]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app().query('UPDATE quo.quote_line SET unit_price_pesewas = 1 WHERE quote_version_id = $1', [id('v2')]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app().query('DELETE FROM quo.quote_line WHERE quote_version_id = $1', [id('v1')]))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(app().query('UPDATE quo.quote_line SET removed = true WHERE quote_version_id = $1', [id('v1')]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app().query("UPDATE quo.quote_version SET status = 'DRAFT', version = version + 1 WHERE id = $1", [id('v1')]))).toBe(SQLSTATE.documentFrozen);
    const edit = await put('sales', `/quote-versions/${id('v2')}`, { version: 2, lines: [goatLine(1)] });
    expect([edit.status, edit.body.error?.code]).toEqual([422, 'INVALID_STATE_TRANSITION']);
  });
});

describe('below the margin floor a version waits for a different person (FR-QUO-005, the gate)', () => {
  it('answers 202 at 263,996 (9.998 percent, shown as 10.00, compared exactly), refuses its author and the wrong role, and issues once the Owner approves', async () => {
    const made = await draft('manager', [goatLine(65_999)]);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const v = made.body.currentVersion;
    expect([v.netPesewas, v.marginPercent, v.belowMarginFloor]).toEqual([263_996, '10.00', true]);
    const asked = await issue('manager', v.id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect([asked.body.kind, asked.body.subject.id, asked.body.status]).toEqual(['QUOTE_BELOW_MARGIN', made.body.id, 'PENDING_APPROVAL']);
    const pending = await get('manager', `/quotes/${made.body.id}`);
    expect([pending.body.status, pending.body.currentVersion.status, pending.body.currentVersion.approvalRequestId]).toEqual(['PENDING_APPROVAL', 'PENDING_APPROVAL', asked.body.approvalRequestId]);
    expect(await heldBy(made.body.id)).toEqual({ qty: '0.000', n: 0 });

    const bySales = await post('sales', `/iam/approvals/${asked.body.approvalRequestId}/approve`, { reason: 'I can approve this' });
    expect(bySales.status).toBe(403);
    const byAuthor = await approve('manager', asked.body.approvalRequestId);
    expect([byAuthor.status, byAuthor.body.error?.code]).toEqual([422, 'MAKER_CANNOT_CHECK']);
    const byOwner = await approve('owner', asked.body.approvalRequestId);
    expect(byOwner.status, JSON.stringify(byOwner.body)).toBe(200);
    const after = await get('manager', `/quotes/${made.body.id}`);
    expect([after.body.status, after.body.currentVersion.status, after.body.currentVersion.issuedBy.id]).toEqual(['ISSUED', 'ISSUED', users.get('manager')!.principalId]);
    const approved = await one('SELECT approved_by FROM quo.quote_version WHERE id = $1', [v.id]);
    expect(approved['approved_by']).toBe(users.get('owner')!.principalId);
    // The re-issue after approval sends no second message: it answers a fresh link, and the outbox holds one QuoteIssued.
    const again = await issue('manager', v.id);
    expect([again.status, again.body.status, again.body.acceptanceLinkToken]).toEqual([200, 'ISSUED', expect.stringMatching(/^quo_/)]);
    const sent = await one("SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'quo.QuoteIssued' AND subject_id = $1", [made.body.id]);
    expect(sent['n']).toBe(1);
  });

  it("refuses the version's author as its checker even when someone else asked to issue it (ADR-0017)", async () => {
    const made = await draft('owner', [goatLine(64_000)]);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const asked = await issue('manager', made.body.currentVersion.id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const byAuthor = await approve('owner', asked.body.approvalRequestId);
    expect([byAuthor.status, byAuthor.body.error?.code]).toEqual([422, 'QUOTE_AUTHOR_CANNOT_APPROVE']);
    const still = await get('manager', `/quotes/${made.body.id}`);
    expect([still.body.status, still.body.currentVersion.status]).toEqual(['PENDING_APPROVAL', 'PENDING_APPROVAL']);
  });

  it('issues a version at the floor at once and refuses, by direct SQL, to issue one below it without an approval by someone else', async () => {
    const made = await draft('sales', [goatLine(65_000)]);
    const v = made.body.currentVersion;
    expect(v.belowMarginFloor).toBe(true);
    const salesId = users.get('sales')!.principalId;
    const issueSql = "UPDATE quo.quote_version SET status = 'ISSUED', issued_at = now(), issued_by = $2, version = version + 1 WHERE id = $1";
    expect(await sqlStateOf(app().query(issueSql, [v.id, salesId]))).toBe(SQLSTATE.checkViolation);
    // An approval request decided by the author is refused too: the approver must be neither author nor issuer.
    const asked = await issue('sales', v.id);
    expect(asked.status).toBe(202);
    expect(
      await sqlStateOf(
        app().query("UPDATE quo.quote_version SET status = 'ISSUED', issued_at = now(), issued_by = $2, approved_by = $2, approved_at = now(), version = version + 1 WHERE id = $1", [v.id, salesId]),
      ),
    ).toBe(SQLSTATE.checkViolation);
  });
});

describe('a line in a crate or a single egg is priced by its own unit and reserved in eggs (CR-045)', () => {
  it('prices 3 crates at 6,000 and 7 eggs at 220, holds 97 eggs for the validity, and costs them from the pools', async () => {
    const made = await draft('sales', [
      { productId: id('eggs'), description: 'Big eggs by the crate', quantity: '3.000', uom: 'CRATE', priceBasis: 'PER_UNIT', unitPricePesewas: 6_000 },
      { productId: id('eggs'), description: 'Big eggs, single', quantity: '7.000', uom: 'EGG', priceBasis: 'PER_UNIT', unitPricePesewas: 220 },
    ]);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const v = made.body.currentVersion;
    expect(v.lines.map((l: Record<string, unknown>) => [l['uom'], l['quantity'], l['resolvedUnitPricePesewas'], l['unitPricePesewas'], l['lineNetPesewas']])).toEqual([
      ['CRATE', '3.000', 6_000, 6_000, 18_000],
      ['EGG', '7.000', 220, 220, 1_540],
    ]);
    // The cost straight from INV's pools of the eggs' lots at the branch, worked by hand: value over eggs, a crate is 30.
    const pools = await one(
      "SELECT sum(c.value_pesewas)::bigint::text AS v, (sum(c.qty) * 1000)::bigint::text AS q FROM inv.cost_pool c JOIN inv.stock_unit u ON u.id = c.stock_unit_id WHERE c.product_id = $1 AND c.branch_id = $2 AND u.status = 'ACTIVE' AND c.qty > 0",
      [id('eggs'), branchId],
    );
    const value = BigInt(pools['v'] as string);
    const thousandths = BigInt(pools['q'] as string);
    const halfUp = (n: bigint, d: bigint) => (2n * n + d) / (2n * d);
    const crate = halfUp(value * 30n * 1000n, thousandths);
    const egg = halfUp(value * 1000n, thousandths);
    expect(v.lines.map((l: Record<string, unknown>) => l['estimatedUnitCostPesewas'])).toEqual([Number(crate), Number(egg)]);
    expect(v.estimatedCostPesewas).toBe(Number(crate * 3n + egg * 7n));
    expect([v.netPesewas, v.taxPesewas, v.grossPesewas]).toEqual([19_540, 0, 19_540]);

    const issued = await issue('sales', v.id);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(await heldBy(made.body.id)).toEqual({ qty: '97.000', n: expect.any(Number) });
    const expiry = await one("SELECT min(expires_at) AS e, max(expires_at) AS f FROM inv.stock_reservation WHERE holder_document_id = $1 AND status = 'ACTIVE'", [made.body.id]);
    expect([(expiry['e'] as Date).toISOString(), (expiry['f'] as Date).toISOString()]).toEqual([new Date(v.validUntil).toISOString(), new Date(v.validUntil).toISOString()]);
    ids.set('eggQuote', made.body.id);
    ids.set('eggToken', issued.body.acceptanceLinkToken);
  });

  it('refuses a unit the product has no exact conversion for, and a crate line in a fraction of an egg', async () => {
    const kg = await draft('sales', [{ productId: id('eggs'), description: 'Eggs by weight', quantity: '2.000', uom: 'KG', priceBasis: 'PER_UNIT', unitPricePesewas: 1_000 }]);
    expect([kg.status, kg.body.error?.code, kg.body.error?.details?.[0]?.code]).toEqual([422, 'QUOTE_INVALID', 'NO_CONVERSION']);
    const part = await draft('sales', [{ productId: id('eggs'), description: 'Part of a crate', quantity: '0.0001', uom: 'CRATE', priceBasis: 'PER_UNIT', unitPricePesewas: 6_000 }]);
    expect(part.status).toBe(400);
  });
});

describe('the acceptance link is a random token, stored only as its hash, opening only the live version (CR-047, FR-QUO-008)', () => {
  it('stores only the SHA-256 of each token, with the version validity as its expiry, and the token nowhere else', async () => {
    for (const name of ['v1Token', 'v2Token', 'eggToken']) {
      const found = await one('SELECT t.expires_at, v.valid_until FROM quo.quote_link_token t JOIN quo.quote_version v ON v.id = t.quote_version_id WHERE t.token_hash = $1', [sha256(id(name))]);
      expect(found['expires_at']).toEqual(found['valid_until']);
    }
    const leaks = await one(
      `SELECT (SELECT count(*) FROM platform.outbox_message o WHERE o.payload::text LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM platform.idempotency_key k WHERE k.response_body::text LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM platform.audit_event a WHERE a."after"::text LIKE '%' || $1 || '%')::int AS n`,
      [id('v2Token').slice(4)],
    );
    expect(Number(leaks['n'])).toBe(0);
  });

  it('opens the live version; a replaced version, a guessed token, the quote id and its number open nothing', async () => {
    const live = await publicGet(`/shop/quotes/${id('v2Token')}`);
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    expect([live.body.versionNo, live.body.status, live.body.grossPesewas, live.body.lines[0].lineNetPesewas]).toEqual([2, 'ISSUED', 264_000, 264_000]);
    expect(Object.keys(live.body.lines[0]).sort()).toEqual(['description', 'lineNetPesewas', 'priceBasis', 'quantity', 'unitPricePesewas', 'uom']);
    const replaced = await publicGet(`/shop/quotes/${id('v1Token')}`);
    expect([replaced.status, replaced.body.error?.code, replaced.body.error?.details?.[0]?.code, replaced.body.lines]).toEqual([422, 'QUOTE_LINK_CLOSED', 'REPLACED', undefined]);
    const acceptOld = await publicPost(`/shop/quotes/${id('v1Token')}/accept`, { acceptedName: 'Kofi Mensah' });
    expect([acceptOld.status, acceptOld.body.error?.details?.[0]?.code]).toEqual([422, 'REPLACED']);
    const quote = await get('sales', `/quotes/${id('goatQuote')}`);
    const flipped = id('v2Token').slice(0, -1) + (id('v2Token').endsWith('A') ? 'B' : 'A');
    for (const guess of [flipped, `quo_${randomUUID()}`, id('goatQuote'), quote.body.quoteNo, id('v2')]) {
      const read = await publicGet(`/shop/quotes/${encodeURIComponent(guess)}`);
      expect([guess, read.status]).toEqual([guess, 404]);
      const accept = await publicPost(`/shop/quotes/${encodeURIComponent(guess)}/accept`, { acceptedName: 'Kofi Mensah' });
      expect([guess, accept.status]).toEqual([guess, 404]);
    }
  });

  it('accepts once by the live token: 200, then 409; the link then answers ACCEPTED', async () => {
    const first = await publicPost(`/shop/quotes/${id('v2Token')}/accept`, { acceptedName: 'Kofi Mensah' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect([first.body.status, first.body.versionNo]).toEqual(['ACCEPTED', 2]);
    const twice = await publicPost(`/shop/quotes/${id('v2Token')}/accept`, { acceptedName: 'Kofi Mensah' });
    expect([twice.status, twice.body.error?.code]).toEqual([409, 'QUOTE_ALREADY_DECIDED']);
    const read = await publicGet(`/shop/quotes/${id('v2Token')}`);
    expect([read.status, read.body.status]).toEqual([200, 'ACCEPTED']);
    const accepted = await one("SELECT method, accepted_name, ip IS NOT NULL AS has_ip FROM quo.quote_acceptance WHERE quote_version_id = $1", [id('v2')]);
    expect([accepted['method'], accepted['accepted_name'], accepted['has_ip']]).toEqual(['SIGNED_LINK', 'Kofi Mensah', true]);
    expect(await sqlStateOf(app().query('INSERT INTO quo.quote_acceptance (id, quote_version_id, method, accepted_name, note, accepted_at, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, now(), now(), $6)', [randomUUID(), id('v2'), 'IN_PERSON', 'Someone', 'A second acceptance', SYSTEM_PRINCIPAL]))).toBe(SQLSTATE.uniqueViolation);
  });

  it('answers DECLINED after a decline by link, and refuses the decline twice', async () => {
    const made = await draft('sales', [{ productId: id('cabbage'), description: 'Cabbage heads', quantity: '5.000', priceBasis: 'PER_UNIT', unitPricePesewas: 1_500 }]);
    const issued = await issue('sales', made.body.currentVersion.id);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const declined = await publicPost(`/shop/quotes/${issued.body.acceptanceLinkToken}/decline`, { reason: 'Bought at the market' });
    expect([declined.status, declined.body.status]).toEqual([200, 'DECLINED']);
    expect((await publicGet(`/shop/quotes/${issued.body.acceptanceLinkToken}`)).body.status).toBe('DECLINED');
    expect((await publicPost(`/shop/quotes/${issued.body.acceptanceLinkToken}/decline`, { reason: 'Again' })).status).toBe(409);
    const quote = await get('sales', `/quotes/${made.body.id}`);
    expect([quote.body.status, quote.body.declineReason]).toEqual(['DECLINED', 'Bought at the market']);
    expect(await heldBy(made.body.id)).toEqual({ qty: '0.000', n: 0 });
  });

});

describe('an accepted quote converts to exactly one order that keeps every link (FR-QUO-011, the gate)', () => {
  it('converts the accepted goats into four order lines at 66,000, each naming the one quote line; again is 409', async () => {
    const accepted = await get('sales', `/quotes/${id('goatQuote')}`);
    expect([accepted.body.status, accepted.body.acceptedVersionId]).toEqual(['ACCEPTED', id('v2')]);
    const goats = ['G-0142', 'G-0143', 'G-0144', 'G-0145'].map(id);
    const key = randomUUID();
    const converted = await post('sales', `/quotes/${id('goatQuote')}/convert`, { fulfilmentMode: 'COLLECTION', paymentTerms: 'COD', stockUnitIds: goats }, key);
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    const order = converted.body;
    const quoteLine = accepted.body.currentVersion.lines[0].id;
    expect([order.channel, order.status, order.source.id, order.estimatedTotalPesewas]).toEqual(['QUOTE', 'PLACED', id('goatQuote'), 264_000]);
    expect(order.lines.map((l: Record<string, Record<string, unknown>>) => [l['stockUnit']!['id'], l['qtyOrdered'], l['priceSource'], l['quoteLineId'], l['agreedUnitPricePesewas'], l['estimatedLineTotalPesewas']])).toEqual(
      goats.map((g) => [g, '1.000', 'QUOTE', quoteLine, 66_000, 66_000]),
    );
    const replay = await post('sales', `/quotes/${id('goatQuote')}/convert`, { fulfilmentMode: 'COLLECTION', paymentTerms: 'COD', stockUnitIds: goats }, key);
    expect([replay.status, replay.body.id]).toEqual([201, order.id]);
    const again = await post('sales', `/quotes/${id('goatQuote')}/convert`, { fulfilmentMode: 'COLLECTION', paymentTerms: 'COD', stockUnitIds: goats });
    expect([again.status, again.body.error?.code]).toEqual([409, 'QUOTE_ALREADY_CONVERTED']);
    const quote = await get('sales', `/quotes/${id('goatQuote')}`);
    expect([quote.body.status, quote.body.convertedOrder.id, quote.body.convertedOrder.number]).toEqual(['CONVERTED', order.id, order.orderNo]);
    const orders = await one("SELECT count(*)::int AS n FROM ord.sales_order WHERE source_document_id = $1", [id('goatQuote')]);
    expect(orders['n']).toBe(1);
    expect(await sqlStateOf(app().query('UPDATE quo.quote SET converted_order_id = NULL, version = version + 1 WHERE id = $1', [id('goatQuote')]))).toBe(SQLSTATE.documentFrozen);
  });

  it("hands the accepted eggs' hold to the order, which its confirmation counts as promised, and the proforma keeps the chain", async () => {
    const token = id('eggToken');
    const acceptedEggs = await publicPost(`/shop/quotes/${token}/accept`, { acceptedName: 'Ama Owusu' });
    expect(acceptedEggs.status, JSON.stringify(acceptedEggs.body)).toBe(200);
    const converted = await post('sales', `/quotes/${id('eggQuote')}/convert`, { fulfilmentMode: 'COLLECTION', paymentTerms: 'COD' });
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    const order = converted.body;
    const quote = (await get('sales', `/quotes/${id('eggQuote')}`)).body;
    expect(order.lines.map((l: Record<string, unknown>) => [l['qtyOrdered'], l['uom'], l['agreedUnitPricePesewas'], l['quoteLineId']])).toEqual([
      ['3.000', 'CRATE', 6_000, quote.currentVersion.lines[0].id],
      ['7.000', 'EGG', 220, quote.currentVersion.lines[1].id],
    ]);
    expect(await heldBy(id('eggQuote'))).toEqual({ qty: '0.000', n: 0 });
    expect(await heldBy(order.id)).toEqual({ qty: '97.000', n: expect.any(Number) });
    const confirmed = await post('sales', `/orders/${order.id}/confirm`);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect((await heldBy(order.id)).qty).toBe('97.000');
    const proforma = await post('owner', `/orders/${order.id}/proforma`);
    expect(proforma.status, JSON.stringify(proforma.body)).toBe(201);
    const chain = await admin().query(
      `SELECT bl.order_line_ref = ol.id AS bill_to_order, ol.quote_line_ref = ql.id AS order_to_quote, qv.quote_id = $2 AS line_to_quote, o.source_document_id = $2 AS order_source
         FROM bil.billing_document_line bl JOIN ord.sales_order_line ol ON ol.id = bl.order_line_ref JOIN ord.sales_order o ON o.id = ol.sales_order_id
         JOIN quo.quote_line ql ON ql.id = ol.quote_line_ref JOIN quo.quote_version qv ON qv.id = ql.quote_version_id
        WHERE bl.billing_document_id = $1 ORDER BY bl.line_no`,
      [proforma.body.id, id('eggQuote')],
    );
    expect(chain.rows).toEqual([
      { bill_to_order: true, order_to_quote: true, line_to_quote: true, order_source: true },
      { bill_to_order: true, order_to_quote: true, line_to_quote: true, order_source: true },
    ]);
  });

  it('refuses to convert a quote not accepted, and a live-animal line without its animals', async () => {
    const made = await draft('sales', [goatLine(80_000, '2.000')]);
    await issue('sales', made.body.currentVersion.id);
    const early = await post('sales', `/quotes/${made.body.id}/convert`, { fulfilmentMode: 'COLLECTION', paymentTerms: 'COD' });
    expect([early.status, early.body.error?.code]).toEqual([422, 'INVALID_STATE_TRANSITION']);
    const recorded = await post('sales', `/quotes/${made.body.id}/record-acceptance`, { method: 'IN_PERSON', acceptedName: 'Kofi Mensah', note: 'Signed the printed quote at the farm gate' });
    expect([recorded.status, recorded.body.status], JSON.stringify(recorded.body)).toEqual([200, 'ACCEPTED']);
    const noAnimals = await post('sales', `/quotes/${made.body.id}/convert`, { fulfilmentMode: 'COLLECTION', paymentTerms: 'COD' });
    expect([noAnimals.status, noAnimals.body.error?.details?.[0]?.code]).toEqual([422, 'ANIMALS_REQUIRED']);
    const noNote = await post('sales', `/quotes/${made.body.id}/record-acceptance`, { method: 'IN_PERSON', acceptedName: 'Kofi Mensah' });
    expect([noNote.status, noNote.body.error?.details?.[0]?.code]).toEqual([422, 'NOTE_REQUIRED']);
  });
});

describe('a named animal is held for the quote (FR-QUO-012)', () => {
  it('reserves G-0142 named on a quote until it is withdrawn, and a second quote naming it cannot be issued meanwhile', async () => {
    const made = await draft('sales', [{ productId: id('goat'), stockUnitId: id('G-0142'), description: 'Goat G-0142', quantity: '1.000', priceBasis: 'PER_HEAD', unitPricePesewas: 90_000 }]);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const issued = await issue('sales', made.body.currentVersion.id);
    // The animal is promised to the converted goat order (not yet confirmed, so not reserved): the quote holds it.
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(await heldBy(made.body.id)).toEqual({ qty: '1.000', n: 1 });
    const rival = await draft('sales', [{ productId: id('goat'), stockUnitId: id('G-0142'), description: 'Goat G-0142 again', quantity: '1.000', priceBasis: 'PER_HEAD', unitPricePesewas: 95_000 }]);
    const refused = await issue('sales', rival.body.currentVersion.id);
    expect([refused.status, refused.body.error?.code, refused.body.error?.details?.[0]?.code]).toEqual([422, 'QUOTE_INVALID', 'STOCK_SHORT']);
    const cancelled = await post('sales', `/quotes/${made.body.id}/cancel`, { reason: 'Buyer chose another animal' });
    expect([cancelled.status, cancelled.body.status]).toEqual([200, 'CANCELLED']);
    expect(await heldBy(made.body.id)).toEqual({ qty: '0.000', n: 0 });
    expect((await issue('sales', rival.body.currentVersion.id)).status).toBe(200);
  });
});

describe('requests for quote (FR-QUO-001, FR-QUO-002, item 4)', () => {
  it('takes a public request with a quantity in a unit the product is sold by, and refuses another unit', async () => {
    const ok = await publicPost('/shop/quote-requests', { contactName: 'Efua Asante', contactPhone: '+233201234567', requirements: 'Ten crates for a wedding <script>alert(1)</script>', productId: id('eggs'), quantity: '10.000', uom: 'CRATE', consentToContact: true }, randomUUID(), '203.0.113.20');
    expect(ok.status, JSON.stringify(ok.body)).toBe(202);
    expect(ok.body.rfqNo).toMatch(/^RFQ-\d{4}-DDW-\d{6}$/);
    const stored = await one('SELECT requirements, qty::text AS qty, uom, source, status FROM quo.rfq WHERE rfq_no = $1', [ok.body.rfqNo]);
    expect([stored['requirements'], stored['qty'], stored['uom'], stored['source'], stored['status']]).toEqual(['Ten crates for a wedding <script>alert(1)</script>', '10.000', 'CRATE', 'REQUEST_TO_BUY', 'NEW']);
    const wrong = await publicPost('/shop/quote-requests', { contactName: 'Efua Asante', contactPhone: '+233201234567', requirements: 'By weight', productId: id('eggs'), quantity: '2.000', uom: 'KG', consentToContact: true }, randomUUID(), '203.0.113.21');
    expect([wrong.status, wrong.body.error?.details?.[0]?.code]).toEqual([422, 'UOM_NOT_SOLD']);
    const orphan = await publicPost('/shop/quote-requests', { contactName: 'Efua Asante', contactPhone: '+233201234567', requirements: 'Some', quantity: '2.000', uom: 'CRATE', consentToContact: true }, randomUUID(), '203.0.113.22');
    expect(orphan.status).toBe(400);
  });

  it('refuses the sixth request from one address in an hour with 429, and the sixth from one phone too', async () => {
    const body = (phone: string) => ({ contactName: 'Yaw Darko', contactPhone: phone, requirements: 'Twenty goats for a funeral', consentToContact: true });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await publicPost('/shop/quote-requests', body(`+23324400${String(i).padStart(4, '0')}`), randomUUID(), '203.0.113.50')).status);
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
    const byPhone: number[] = [];
    for (let i = 0; i < 6; i += 1) byPhone.push((await publicPost('/shop/quote-requests', body('+233244009999'), randomUUID(), `203.0.113.${60 + i}`)).status);
    expect(byPhone).toEqual([202, 202, 202, 202, 202, 429]);
  });

  it('links a WhatsApp request to the customer who holds the number, and a quote made from it keeps the request', async () => {
    const customer = await one("SELECT id FROM mdm.customer WHERE customer_no = 'C-00002'");
    const made = await post('sales', '/rfqs', { source: 'WHATSAPP', contactName: 'Akua Sarpong', contactPhone: '+233200000202', requirements: 'Five crates every Friday' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect([made.body.source, made.body.status, made.body.rfqNo, made.body.customer?.id]).toEqual(['WHATSAPP', 'NEW', expect.stringMatching(/^RFQ-/), customer['id']]);
    const stranger = await post('sales', '/rfqs', { source: 'PHONE', contactName: 'Akua Sarpong', contactPhone: '+233244777001', requirements: 'Goats' });
    expect([stranger.status, stranger.body.customer]).toEqual([201, null]);
    const quote = await draft('sales', [{ productId: id('eggs'), description: 'Five crates', quantity: '5.000', uom: 'CRATE', priceBasis: 'PER_UNIT', unitPricePesewas: 6_000 }], { rfqId: made.body.id });
    expect([quote.status, quote.body.rfqId]).toEqual([201, made.body.id]);
    const rfq = await get('sales', `/rfqs/${made.body.id}`);
    expect([rfq.body.status, rfq.body.quoteIds]).toEqual(['QUOTED', [quote.body.id]]);
  });
});

describe('every quote operation refuses the wrong role and another branch (item 5, ADR-0035)', () => {
  it('lets Sales build, send and convert, and refuses the Cashier, the Storekeeper and the Accountant', async () => {
    for (const who of ['cashier', 'storekeeper', 'accountant']) {
      expect([who, (await draft(who, [goatLine(70_000)])).status]).toEqual([who, 403]);
      expect([who, (await get(who, '/quotes')).status]).toEqual([who, 403]);
      expect([who, (await get(who, `/quotes/${id('goatQuote')}`)).status]).toEqual([who, 403]);
      expect([who, (await issue(who, id('v2'))).status]).toEqual([who, 403]);
      expect([who, (await post(who, `/quotes/${id('eggQuote')}/convert`, { fulfilmentMode: 'COLLECTION', paymentTerms: 'COD' })).status]).toEqual([who, 403]);
      expect([who, (await post(who, '/rfqs', { source: 'PHONE', contactName: 'X', contactPhone: '+233244000001', requirements: 'Y' })).status]).toEqual([who, 403]);
      expect([who, (await get(who, '/rfqs')).status]).toEqual([who, 403]);
    }
  });

  it("shows another branch's Owner no Dodowa quote and opens none by its id", async () => {
    const list = await get('temaOwner', '/quotes');
    expect([list.status, list.body.data.length]).toEqual([200, 0]);
    expect((await get('temaOwner', `/quotes/${id('goatQuote')}`)).status).toBe(403);
    expect((await get('customer', `/quotes/${id('goatQuote')}`)).status).toBe(401);
    expect((await publicGet(`/quotes/${id('goatQuote')}`)).status).toBe(401);
  });
});

// Last, because it moves the clock past the validity (and past the sessions' idle time).
describe('a quote past its validity (FR-QUO-004, FR-QUO-009, CR-047)', () => {
  it('opens nothing once the validity has passed, and the expiry job expires the quote and gives its eggs back', async () => {
    const made = await draft('sales', [{ productId: id('eggs'), description: 'Two crates', quantity: '2.000', uom: 'CRATE', priceBasis: 'PER_UNIT', unitPricePesewas: 6_000 }], { validUntil: new Date(clock.now().getTime() + 3_600_000).toISOString() });
    const issued = await issue('sales', made.body.currentVersion.id);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(await heldBy(made.body.id)).toEqual({ qty: '60.000', n: expect.any(Number) });
    clock.advanceBy(3_600_001);
    sessions.set('sales', await login(api.server, users.get('sales')!));
    const read = await publicGet(`/shop/quotes/${issued.body.acceptanceLinkToken}`);
    expect([read.status, read.body.error?.details?.[0]?.code]).toEqual([422, 'EXPIRED']);
    const accept = await publicPost(`/shop/quotes/${issued.body.acceptanceLinkToken}/accept`, { acceptedName: 'Kofi Mensah' });
    expect([accept.status, accept.body.error?.details?.[0]?.code]).toEqual([422, 'EXPIRED']);
    const recorded = await post('sales', `/quotes/${made.body.id}/record-acceptance`, { method: 'PHONE_CONFIRMED', acceptedName: 'Kofi Mensah', note: 'Called back after the date' });
    expect([recorded.status, recorded.body.error?.details?.[0]?.code]).toEqual([422, 'EXPIRED']);
    const expired = await runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(QuoteExpiry).run({ kind: 'SYSTEM', principalId: SYSTEM_PRINCIPAL }));
    expect(expired).toContain(made.body.id);
    expect((await get('sales', `/quotes/${made.body.id}`)).body.status).toBe('EXPIRED');
    expect(await heldBy(made.body.id)).toEqual({ qty: '0.000', n: 0 });
  });
});
