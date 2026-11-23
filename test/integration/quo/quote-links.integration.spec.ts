import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The quote link (B10 continued 4; the owner's decisions of 2026-11-18, items 2 and 4; ADR-0074, ADR-0087; abuse case
 * 40) and the customer's own quotes (FR-QUO-013 `listMyQuotes`, CR-047 point 2):
 * - several links of one version live at once, each revoked on its own while the others keep working; the quote is
 *   accepted once across all of them; every link closes when the version is replaced, accepted or expires;
 * - every acceptance and decline through a link records the address, the user agent and whose staff session the
 *   browser also held, and a decision from a browser with a staff session is raised for the exception report naming
 *   that staff member, never blocked;
 * - a link's token is answered once and no read returns it;
 * - a customer lists only the quotes issued to them.
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
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const one = async (sql: string, values: unknown[] = []) => (await admin().query(sql, values)).rows[0]!;
const UA = 'Mozilla/5.0 (Linux; Android 13) Chrome/131.0 Mobile (TEST)';
/** A call through the link from the buyer's phone; `cookie` is what else the browser holds, a staff session or none. */
const linkPost = (token: string, action: 'accept' | 'decline', body: object, cookie?: string, key: string = randomUUID()) => {
  const call = request(api.server).post(`/v1/shop/quotes/${token}/${action}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).set('X-Forwarded-For', '198.51.100.23').set('User-Agent', UA);
  return (cookie === undefined ? call : call.set('Cookie', cookie)).send(body);
};
const view = (token: string) => request(api.server).get(`/v1/shop/quotes/${token}`);

const validFor = (days: number) => new Date(Math.floor(clock.now().getTime() / 86_400_000) * 86_400_000 + days * 86_400_000 + 86_399_000).toISOString();
const eggs = (crates = '1.000') => ({ productId: id('eggs'), description: 'Big eggs by the crate', quantity: crates, uom: 'CRATE', priceBasis: 'PER_UNIT', unitPricePesewas: 6_000 });

/** A quote to the named customer, issued; answers the quote, its version and its first link. */
async function issued(extra: object = {}, validDays = 7): Promise<{ quoteId: string; versionId: string; token: string; linkId: string }> {
  const made = await post('sales', '/quotes', { contactName: 'Ama Owusu', contactPhone: '+233244519034', validUntil: validFor(validDays), taxInclusive: true, lines: [eggs()], ...extra });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const answer = await post('sales', `/quote-versions/${made.body.currentVersion.id}/issue`, { channels: ['WHATSAPP'] });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return { quoteId: made.body.id, versionId: made.body.currentVersion.id, token: answer.body.acceptanceLinkToken, linkId: answer.body.acceptanceLinkId };
}

/** One more link of an issued version, as the console's "send the link again": a fresh token, shown once. */
async function anotherLink(versionId: string): Promise<{ token: string; linkId: string }> {
  const answer = await post('sales', `/quote-versions/${versionId}/issue`, { channels: [] });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return { token: answer.body.acceptanceLinkToken, linkId: answer.body.acceptanceLinkId };
}

const linkStates = async (quoteId: string) => ((await get('sales', `/quotes/${quoteId}`)).body.currentVersion.links as { id: string; state: string }[]).map((l) => [l.id, l.state]);
const decisions = (versionId: string) => admin().query('SELECT link_token_id, decision, host(ip) AS ip, user_agent, staff_principal_id, staff_session_id FROM quo.quote_link_decision WHERE quote_version_id = $1', [versionId]);
const flags = (quoteId: string) => admin().query("SELECT payload FROM platform.outbox_message WHERE event_type = 'quo.QuoteLinkDecidedInStaffBrowser' AND subject_id = $1", [quoteId]);

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await one("SELECT id FROM mdm.branch WHERE code = 'DDW'"))['id'] as string;
  ids.set('eggs', (await one("SELECT id FROM mdm.product WHERE sku = 'EGG-0003'"))['id'] as string);
  const tema = await createBranch(database, 'TMA');
  const people: [string, string, string, boolean, string?][] = [
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
  // Two buyers with their own sign-in, each linked to a seeded customer.
  for (const [who, name, customerNo] of [['buyer', 'Abena Kyei', 'C-00002'], ['otherBuyer', 'Kojo Badu', 'C-00003']] as const) {
    const user = await createUser(database, { name, realm: 'CUSTOMER' });
    users.set(who, user);
    const customer = (await one('SELECT id FROM mdm.customer WHERE customer_no = $1', [customerNo]))['id'] as string;
    await admin().query('UPDATE mdm.customer SET principal_id = $1, version = version + 1 WHERE id = $2', [user.principalId, customer]);
    ids.set(`${who}Customer`, customer);
    sessions.set(who, await login(api.server, user));
  }
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('several live links per version (the owner, 2026-11-18, item 2)', () => {
  it('(a) revokes one link on its own: it opens nothing, the others keep working, and it is revoked once', async () => {
    const q = await issued({ customerId: id('buyerCustomer') });
    const second = await anotherLink(q.versionId);
    const third = await anotherLink(q.versionId);
    Object.entries({ q: q.quoteId, v: q.versionId, t1: q.token, l1: q.linkId, t2: second.token, l2: second.linkId, t3: third.token, l3: third.linkId }).forEach(([k, v]) => ids.set(`a.${k}`, v));
    expect(new Set([q.token, second.token, third.token]).size).toBe(3);
    expect(await linkStates(q.quoteId)).toEqual([[q.linkId, 'OPEN'], [second.linkId, 'OPEN'], [third.linkId, 'OPEN']]);
    for (const t of [q.token, second.token, third.token]) expect((await view(t)).status).toBe(200);

    const revoked = await post('sales', `/quote-links/${q.linkId}/revoke`, { reason: 'Sent to the wrong WhatsApp number' });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    const mine = revoked.body.links.find((l: { id: string }) => l.id === q.linkId);
    expect([mine.state, mine.revokeReason, mine.revokedBy.id, typeof mine.revokedAt]).toEqual(['REVOKED', 'Sent to the wrong WhatsApp number', users.get('sales')!.principalId, 'string']);
    expect(await linkStates(q.quoteId)).toEqual([[q.linkId, 'REVOKED'], [second.linkId, 'OPEN'], [third.linkId, 'OPEN']]);
    // The revoked link opens nothing, as a link that never existed; the other two still open the quote.
    const gone = await view(q.token);
    expect([gone.status, gone.body.error.code]).toEqual([404, 'NOT_FOUND']);
    expect(JSON.stringify(gone.body)).not.toContain('QUO-');
    expect((await linkPost(q.token, 'accept', { acceptedName: 'Abena Kyei' })).status).toBe(404);
    expect((await linkPost(q.token, 'decline', {})).status).toBe(404);
    expect([(await view(second.token)).status, (await view(third.token)).status]).toEqual([200, 200]);
    const again = await post('sales', `/quote-links/${q.linkId}/revoke`, { reason: 'Again' });
    expect([again.status, again.body.error.code, again.body.error.details[0].code]).toEqual([422, 'INVALID_STATE_TRANSITION', 'REVOKED']);
    // Audited once, insert-only.
    expect((await one("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'REVOKE_LINK' AND entity_id = $1", [q.linkId]))['n']).toBe(1);
    expect((await one('SELECT count(*)::int AS n FROM quo.quote_link_revocation WHERE link_token_id = $1', [q.linkId]))['n']).toBe(1);
  });

  it('(a) refuses the wrong role, another branch, an unknown id and an id that is not a link', async () => {
    for (const who of ['cashier', 'storekeeper', 'accountant']) {
      const refused = await post(who, `/quote-links/${id('a.l2')}/revoke`, { reason: 'Not mine to revoke' });
      expect([who, refused.status, refused.body.error.code]).toEqual([who, 403, 'FORBIDDEN']);
    }
    expect((await post('temaOwner', `/quote-links/${id('a.l2')}/revoke`, { reason: 'Another branch' })).status).toBe(403);
    for (const other of [randomUUID(), id('a.v'), id('a.q')]) expect((await post('sales', `/quote-links/${other}/revoke`, { reason: 'Not a link' })).status).toBe(404);
    expect((await consolePost(api.server, as('buyer'), `/v1/quote-links/${id('a.l2')}/revoke`).send({ reason: 'A buyer' })).status).toBe(401);
    expect((await request(api.server).post(`/v1/quote-links/${id('a.l2')}/revoke`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send({ reason: 'Nobody' })).status).toBe(401);
    expect(await linkStates(id('a.q'))).toEqual([[id('a.l1'), 'REVOKED'], [id('a.l2'), 'OPEN'], [id('a.l3'), 'OPEN']]);
  });

  it('(b) accepts once across all links: two links at once give one 200 and one 409, and a second use of either is refused', async () => {
    const [x, y] = await Promise.all([linkPost(id('a.t2'), 'accept', { acceptedName: 'Abena Kyei' }), linkPost(id('a.t3'), 'accept', { acceptedName: 'Abena Kyei' })]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect([x, y].find((r) => r.status === 409)!.body.error.code).toBe('QUOTE_ALREADY_DECIDED');
    for (const t of [id('a.t2'), id('a.t3')]) {
      expect((await linkPost(t, 'accept', { acceptedName: 'Abena Kyei' })).status).toBe(409);
      expect((await linkPost(t, 'decline', {})).status).toBe(409);
    }
    expect((await one('SELECT count(*)::int AS n FROM quo.quote_acceptance WHERE quote_version_id = $1', [id('a.v')]))['n']).toBe(1);
    expect((await decisions(id('a.v'))).rows.map((r) => r['decision'])).toEqual(['ACCEPTED']);
    // (c) Accepted, every link shows the decision and opens nothing else (CR-047 point 2: who accepted, and when).
    expect(await linkStates(id('a.q'))).toEqual([[id('a.l1'), 'REVOKED'], [id('a.l2'), 'ACCEPTED'], [id('a.l3'), 'ACCEPTED']]);
    const shown = await view(id('a.t3'));
    expect([shown.status, shown.body.status, shown.body.acceptedName, shown.body.decidedAt]).toEqual([200, 'ACCEPTED', 'Abena Kyei', clock.now().toISOString()]);
  });

  it('(c) closes every link of a version when a newer version is issued', async () => {
    const q = await issued();
    const second = await anotherLink(q.versionId);
    const revised = await post('sales', `/quotes/${q.quoteId}/versions`, { changeNote: 'Two crates, not one' });
    expect(revised.status, JSON.stringify(revised.body)).toBe(201);
    expect((await post('sales', `/quote-versions/${revised.body.id}/issue`, { channels: ['SMS'] })).status).toBe(200);
    for (const t of [q.token, second.token]) {
      for (const call of [() => view(t), () => linkPost(t, 'accept', { acceptedName: 'Ama Owusu' }), () => linkPost(t, 'decline', {})]) {
        const r = await call();
        expect([r.status, r.body.error.code, r.body.error.details[0].code]).toEqual([422, 'QUOTE_LINK_CLOSED', 'REPLACED']);
      }
    }
    const old = (await get('sales', `/quotes/${q.quoteId}/versions`)).body.data.find((v: { id: string }) => v.id === q.versionId);
    expect(old.links.map((l: { state: string }) => l.state)).toEqual(['REPLACED', 'REPLACED']);
  });
});

describe('the device and session behind a decision through the link (the owner, 2026-11-18, item 4; abuse case 40)', () => {
  it('records an acceptance with no staff session, and does not flag it', async () => {
    const q = await issued();
    const accepted = await linkPost(q.token, 'accept', { acceptedName: 'Ama Owusu' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await decisions(q.versionId)).rows).toEqual([{ link_token_id: q.linkId, decision: 'ACCEPTED', ip: '198.51.100.23', user_agent: UA, staff_principal_id: null, staff_session_id: null }]);
    expect((await flags(q.quoteId)).rows).toEqual([]);
  });

  it('flags an acceptance from a browser holding a signed-in staff session, naming that staff member, and never blocks it', async () => {
    const q = await issued();
    const accepted = await linkPost(q.token, 'accept', { acceptedName: 'Ama Owusu' }, as('sales').jar.header());
    expect([accepted.status, accepted.body.status]).toEqual([200, 'ACCEPTED']);
    expect((await get('sales', `/quotes/${q.quoteId}`)).body.status).toBe('ACCEPTED');
    expect((await decisions(q.versionId)).rows).toEqual([
      { link_token_id: q.linkId, decision: 'ACCEPTED', ip: '198.51.100.23', user_agent: UA, staff_principal_id: users.get('sales')!.principalId, staff_session_id: as('sales').sessionId },
    ]);
    const raised = (await flags(q.quoteId)).rows.map((r) => r['payload']);
    expect(raised).toEqual([
      expect.objectContaining({ quoteId: q.quoteId, versionId: q.versionId, linkId: q.linkId, decision: 'ACCEPTED', staffPrincipalId: users.get('sales')!.principalId, branchId, abuseCase: 40, grossPesewas: 6_000 }),
    ]);
    // The flag carries no address, user agent or token: those stay in QUO's own table.
    expect(JSON.stringify(raised)).not.toMatch(/198\.51|Mozilla|quo_/);
  });

  it('flags a decline from a browser holding a staff session too, and ignores a staff cookie that is no live session', async () => {
    const q = await issued();
    const declined = await linkPost(q.token, 'decline', { reason: 'Found eggs nearer home' }, as('manager').jar.header());
    expect([declined.status, declined.body.status]).toEqual([200, 'DECLINED']);
    expect((await decisions(q.versionId)).rows.map((r) => [r['decision'], r['staff_principal_id'], r['staff_session_id']])).toEqual([['DECLINED', users.get('manager')!.principalId, as('manager').sessionId]]);
    expect((await flags(q.quoteId)).rows.map((r) => [r['payload']['decision'], r['payload']['staffPrincipalId']])).toEqual([['DECLINED', users.get('manager')!.principalId]]);
    const shown = await view(q.token);
    expect([shown.body.status, shown.body.acceptedName, shown.body.decidedAt]).toEqual(['DECLINED', null, clock.now().toISOString()]);

    const forged = await issued();
    expect((await linkPost(forged.token, 'accept', { acceptedName: 'Ama Owusu' }, '__Host-hk_s_at=not-a-session-token')).status).toBe(200);
    expect((await decisions(forged.versionId)).rows.map((r) => r['staff_principal_id'])).toEqual([null]);
    expect((await flags(forged.quoteId)).rows).toEqual([]);
  });

  it('holds the decision rules in the database', async () => {
    const q = await issued();
    const second = await anotherLink(q.versionId);
    const other = await issued();
    const row = (link: string, version: string, extra = '') =>
      admin().query(`INSERT INTO quo.quote_link_decision (id, link_token_id, quote_version_id, decision, decided_at, recorded_at, actor_id${extra === '' ? '' : ', staff_principal_id'}) VALUES ($1, $2, $3, 'ACCEPTED', now(), now(), $4${extra})`, [
        randomUUID(),
        link,
        version,
        users.get('sales')!.principalId,
      ]);
    expect(await sqlStateOf(row(other.linkId, q.versionId))).toBe('HK004');
    await admin().query("INSERT INTO quo.quote_link_revocation (id, link_token_id, reason, recorded_at, actor_id) VALUES ($1, $2, 'TEST', now(), $3)", [randomUUID(), second.linkId, users.get('sales')!.principalId]);
    expect(await sqlStateOf(row(second.linkId, q.versionId))).toBe('HK004');
    expect(await sqlStateOf(admin().query("INSERT INTO quo.quote_link_revocation (id, link_token_id, reason, recorded_at, actor_id) VALUES ($1, $2, 'TEST', now(), $3)", [randomUUID(), second.linkId, users.get('sales')!.principalId]))).toBe(SQLSTATE.uniqueViolation);
    expect(await sqlStateOf(row(q.linkId, q.versionId, `, '${users.get('sales')!.principalId}'`))).toBe(SQLSTATE.checkViolation);
    await row(q.linkId, q.versionId);
    expect(await sqlStateOf(row(q.linkId, q.versionId))).toBe(SQLSTATE.uniqueViolation);
    for (const table of ['quo.quote_link_decision', 'quo.quote_link_revocation']) {
      expect(await sqlStateOf(app().query(`UPDATE ${table} SET recorded_at = now()`))).toBe('42501');
      expect(await sqlStateOf(admin().query(`UPDATE ${table} SET recorded_at = now()`))).toBe('HK001');
      expect(await sqlStateOf(admin().query(`DELETE FROM ${table}`))).toBe('HK001');
    }
  });
});

describe('the link token is shown once (ADR-0074, ADR-0087; the owner, 2026-11-18, item 4 (c))', () => {
  it('answers each token only in the issue that made it; no read, outbox message or stored answer carries one', async () => {
    const q = await issued({ customerId: id('buyerCustomer') });
    const second = await anotherLink(q.versionId);
    const tokens = [q.token, second.token, id('a.t1'), id('a.t2'), id('a.t3')];
    const reads = [
      await get('sales', `/quotes/${q.quoteId}`),
      await get('sales', `/quotes/${q.quoteId}/versions`),
      await get('sales', '/quotes'),
      await get('sales', `/quotes/${id('a.q')}`),
      await view(q.token),
      await consoleGet(api.server, as('buyer'), '/v1/me/quotes'),
    ];
    for (const r of reads) expect(r.status, JSON.stringify(r.body)).toBe(200);
    const text = JSON.stringify(reads.map((r) => r.body));
    for (const t of tokens) expect(text).not.toContain(t.slice(4));
    expect(JSON.parse(text)[0].currentVersion.acceptanceLinkToken).toBeNull();
    expect(JSON.parse(text)[0].currentVersion.acceptanceLinkId).toBeNull();
    for (const t of tokens) {
      const found = await one(
        "SELECT (SELECT count(*) FROM platform.outbox_message WHERE payload::text LIKE '%' || $1 || '%')::int AS outbox, (SELECT count(*) FROM platform.idempotency_key WHERE response_body::text LIKE '%' || $1 || '%')::int AS stored",
        [t.slice(4)],
      );
      expect(found).toEqual({ outbox: 0, stored: 0 });
    }
  });
});

describe('listMyQuotes: a customer sees only the quotes issued to them (FR-QUO-013, CR-047 point 2)', () => {
  it('lists the buyer\'s own issued quotes, newest first, in the buyer\'s shape, and nobody else\'s', async () => {
    const draftOnly = await post('sales', '/quotes', { customerId: id('buyerCustomer'), contactName: 'Abena Kyei', contactPhone: '+233244519034', validUntil: validFor(7), taxInclusive: true, lines: [eggs()] });
    expect(draftOnly.status).toBe(201);
    const theirs = await issued({ customerId: id('otherBuyerCustomer') });
    const mine = await consoleGet(api.server, as('buyer'), '/v1/me/quotes');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    const quoteNos = (await admin().query("SELECT quote_no FROM quo.quote WHERE customer_id = $1 AND status <> 'DRAFT' ORDER BY id DESC", [id('buyerCustomer')])).rows.map((r) => r['quote_no']);
    expect(quoteNos.length).toBe(2);
    expect(mine.body.data.map((q: { quoteNo: string }) => q.quoteNo)).toEqual(quoteNos);
    expect(mine.body.data.map((q: Record<string, unknown>) => [q['status'], q['acceptedName'], q['grossPesewas'], q['currency']])).toEqual([
      ['ISSUED', null, 6_000, 'GHS'],
      ['ACCEPTED', 'Abena Kyei', 6_000, 'GHS'],
    ]);
    const text = JSON.stringify(mine.body);
    expect(text).not.toMatch(/estimatedCost|marginPercent|belowMarginFloor|salesperson|"id"/);
    const theirNo = (await one('SELECT quote_no FROM quo.quote WHERE id = $1', [theirs.quoteId]))['quote_no'] as string;
    expect(text).not.toContain(theirNo);
    expect(text).not.toContain((await one('SELECT quote_no FROM quo.quote WHERE id = $1', [draftOnly.body.id]))['quote_no'] as string);
    const other = await consoleGet(api.server, as('otherBuyer'), '/v1/me/quotes');
    expect(other.body.data.map((q: { quoteNo: string }) => q.quoteNo)).toEqual([theirNo]);
    // Paged by a cursor bound to the caller.
    const first = await consoleGet(api.server, as('buyer'), '/v1/me/quotes?limit=1');
    expect([first.body.data.length, first.body.page.hasMore]).toEqual([1, true]);
    const next = await consoleGet(api.server, as('buyer'), `/v1/me/quotes?limit=1&cursor=${encodeURIComponent(first.body.page.nextCursor as string)}`);
    expect(next.body.data.map((q: { quoteNo: string }) => q.quoteNo)).toEqual([quoteNos[1]]);
    expect((await consoleGet(api.server, as('otherBuyer'), `/v1/me/quotes?limit=1&cursor=${encodeURIComponent(first.body.page.nextCursor as string)}`)).status).toBe(400);
  });

  it('opens nothing of another customer\'s quote by its id or number, and answers no staff or anonymous caller', async () => {
    const theirs = await issued({ customerId: id('otherBuyerCustomer') });
    const theirNo = (await one('SELECT quote_no FROM quo.quote WHERE id = $1', [theirs.quoteId]))['quote_no'] as string;
    for (const key of [theirs.quoteId, theirs.versionId, theirNo, theirs.linkId]) expect((await view(key)).status).toBe(404);
    expect((await consoleGet(api.server, as('buyer'), `/v1/quotes/${theirs.quoteId}`)).status).toBe(401);
    expect((await consoleGet(api.server, as('buyer'), `/v1/me/quotes/${theirs.quoteId}`)).status).toBe(404);
    expect((await get('sales', '/me/quotes')).status).toBe(401);
    expect((await request(api.server).get('/v1/me/quotes')).status).toBe(401);
  });
});

describe('every link closes when its version expires (item 2 (c))', () => {
  it('answers EXPIRED through every link of a version past its validity, and lists it as expired to the buyer', async () => {
    const q = await issued({ customerId: id('otherBuyerCustomer') }, 1);
    const second = await anotherLink(q.versionId);
    clock.advanceBy(3 * 86_400_000);
    // Three days on, the console and the shop sign in again.
    sessions.set('sales', await login(api.server, users.get('sales')!));
    sessions.set('otherBuyer', await login(api.server, users.get('otherBuyer')!));
    for (const t of [q.token, second.token]) {
      for (const call of [() => view(t), () => linkPost(t, 'accept', { acceptedName: 'Kojo Badu' })]) {
        const r = await call();
        expect([r.status, r.body.error.code, r.body.error.details[0].code]).toEqual([422, 'QUOTE_LINK_CLOSED', 'EXPIRED']);
      }
    }
    expect(await linkStates(q.quoteId)).toEqual([[q.linkId, 'EXPIRED'], [second.linkId, 'EXPIRED']]);
    const listed = await consoleGet(api.server, as('otherBuyer'), '/v1/me/quotes');
    expect(listed.body.data[0]).toMatchObject({ status: 'EXPIRED', acceptedName: null, decidedAt: null });
  });
});
