import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consolePost, createUser, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * A possible staff acceptance (the owner, 2026-11-23, decision 5; A-325 as amended, A-343; abuse case 40): a quote
 * decided through the buyer's link from the address of a staff session active in the 24 hours before, by the
 * application clock, is flagged naming the staff, with whether the browser was the same; it is never blocked, and no
 * staff cookie is read anywhere in QUO. Each case decides from its own address so the cases never see each other's staff.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let sales: TestSession;
const users = new Map<string, TestUser>();
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const one = async (sql: string, values: unknown[] = []) => (await admin().query(sql, values)).rows[0]!;
const HOUR = 3_600_000;
const PHONE = 'Mozilla/5.0 (Linux; Android 13) Chrome/131.0 Mobile (TEST)';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/133.0 (TEST)';
let eggs: string;

const validFor = (days: number) => new Date(Math.floor(clock.now().getTime() / 86_400_000) * 86_400_000 + days * 86_400_000 + 86_399_000).toISOString();

/** A staff login from an address and a browser, as the console's own login sends it. */
async function loginFrom(user: TestUser, ip: string, userAgent: string): Promise<string> {
  const response = await request(api.server).post('/v1/auth/staff/login').set('Origin', TEST_ORIGIN).set('X-Forwarded-For', ip).set('User-Agent', userAgent).send({ identifier: user.identifier, password: user.password, deviceLabel: 'Back office laptop' });
  expect([response.status, response.body.status], JSON.stringify(response.body)).toEqual([200, 'AUTHENTICATED']);
  return response.body.session.sessionId as string;
}

/** A quote issued by the salesperson from the office: answers its version and its link's token. */
async function issued(): Promise<{ quoteId: string; versionId: string; token: string }> {
  const made = await consolePost(api.server, sales, '/v1/quotes').send({
    contactName: 'Ama Owusu',
    contactPhone: '+233244519034',
    validUntil: validFor(7),
    taxInclusive: true,
    lines: [{ productId: eggs, description: 'Big eggs by the crate', quantity: '1.000', uom: 'CRATE', priceBasis: 'PER_UNIT', unitPricePesewas: 6_000 }],
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const answer = await consolePost(api.server, sales, `/v1/quote-versions/${made.body.currentVersion.id}/issue`).send({ channels: ['WHATSAPP'] });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return { quoteId: made.body.id, versionId: made.body.currentVersion.id, token: answer.body.acceptanceLinkToken };
}

/** A decision through the link from the buyer's side: an address, a browser, and whatever cookie that browser holds. */
const decide = (token: string, action: 'accept' | 'decline', ip: string, userAgent: string, cookie?: string) => {
  const call = request(api.server).post(`/v1/shop/quotes/${token}/${action}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).set('X-Forwarded-For', ip).set('User-Agent', userAgent);
  return (cookie === undefined ? call : call.set('Cookie', cookie)).send(action === 'accept' ? { acceptedName: 'Ama Owusu' } : { reason: 'Found eggs nearer home' });
};
const matches = (versionId: string) =>
  admin().query(
    'SELECT m.staff_principal_id AS staff, m.staff_session_id AS session, m.same_browser AS "sameBrowser", m.window_hours AS hours, d.staff_principal_id AS "cookieStaff" FROM quo.quote_link_staff_match m JOIN quo.quote_link_decision d ON d.id = m.link_decision_id WHERE d.quote_version_id = $1 ORDER BY m.staff_principal_id',
    [versionId],
  );
const flags = (quoteId: string) => admin().query("SELECT payload FROM platform.outbox_message WHERE event_type = 'quo.QuoteLinkDecidedFromStaffAddress' AND subject_id = $1", [quoteId]);
const oldFlags = () => admin().query("SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'quo.QuoteLinkDecidedInStaffBrowser'");
const sessionOf = new Map<string, string>();

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const branchId = (await one("SELECT id FROM mdm.branch WHERE code = 'DDW'"))['id'] as string;
  eggs = (await one("SELECT id FROM mdm.product WHERE sku = 'EGG-0003'"))['id'] as string;
  for (const [who, name] of [['sales', 'Esi Appiah'], ['insider', 'Kofi Nyarko'], ['other', 'Abena Mensah'], ['earlier', 'Yaw Darko']] as const) {
    users.set(who, await createUser(database, { name, grants: [{ role: 'SALES', branchId }] }));
  }
  // At the start: one staff member signs in from the address the first buyer's decision comes from, in the same
  // browser; another from the second address in another browser; a third from the third address, for the window.
  sessionOf.set('insider', await loginFrom(users.get('insider')!, '198.51.100.31', PHONE));
  sessionOf.set('other', await loginFrom(users.get('other')!, '198.51.100.32', DESKTOP));
  sessionOf.set('earlier', await loginFrom(users.get('earlier')!, '198.51.100.33', PHONE));
  clock.advanceBy(HOUR);
  sales = await login(api.server, users.get('sales')!);
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('a possible staff acceptance is found by address and browser, never by a cookie, and never blocks (abuse case 40)', () => {
  it('flags an acceptance from the address and browser of a staff session seen an hour before, naming the staff member', async () => {
    const q = await issued();
    const accepted = await decide(q.token, 'accept', '198.51.100.31', PHONE);
    expect([accepted.status, accepted.body.status], JSON.stringify(accepted.body)).toEqual([200, 'ACCEPTED']);
    expect((await matches(q.versionId)).rows).toEqual([{ staff: users.get('insider')!.principalId, session: sessionOf.get('insider'), sameBrowser: true, hours: 24, cookieStaff: null }]);
    const raised = (await flags(q.quoteId)).rows.map((r) => r['payload']);
    expect(raised).toEqual([
      expect.objectContaining({ quoteId: q.quoteId, versionId: q.versionId, decision: 'ACCEPTED', staff: [{ principalId: users.get('insider')!.principalId, sameBrowser: true }], sameBrowser: true, windowHours: 24, abuseCase: 40, grossPesewas: 6_000 }),
    ]);
    // The flag carries no address, user agent, session or token: those stay in QUO's own tables.
    expect(JSON.stringify(raised)).not.toMatch(/198\.51|Mozilla|quo_|Android/);
    expect(JSON.stringify(raised)).not.toContain(sessionOf.get('insider'));
  });

  it('flags a decline from the same address in another browser too, marked not the same browser (A-343 (c))', async () => {
    const q = await issued();
    const declined = await decide(q.token, 'decline', '198.51.100.32', PHONE);
    expect([declined.status, declined.body.status]).toEqual([200, 'DECLINED']);
    expect((await matches(q.versionId)).rows.map((r) => [r['staff'], r['sameBrowser']])).toEqual([[users.get('other')!.principalId, false]]);
    expect((await flags(q.quoteId)).rows.map((r) => [r['payload']['decision'], r['payload']['staff'], r['payload']['sameBrowser']])).toEqual([['DECLINED', [{ principalId: users.get('other')!.principalId, sameBrowser: false }], false]]);
  });

  it('flags nothing from an address no staff session was seen from, even with a staff cookie in the browser', async () => {
    const q = await issued();
    const cookie = sales.jar.header();
    expect(cookie).toMatch(/__Host-hk_s_at=/);
    const accepted = await decide(q.token, 'accept', '198.51.100.40', PHONE, cookie);
    expect([accepted.status, accepted.body.status]).toEqual([200, 'ACCEPTED']);
    expect((await matches(q.versionId)).rows).toEqual([]);
    expect((await flags(q.quoteId)).rows).toEqual([]);
    const decision = await one('SELECT staff_principal_id, staff_session_id, host(ip) AS ip, user_agent FROM quo.quote_link_decision WHERE quote_version_id = $1', [q.versionId]);
    expect(decision).toEqual({ staff_principal_id: null, staff_session_id: null, ip: '198.51.100.40', user_agent: PHONE });
    expect((await oldFlags()).rows[0]!['n']).toBe(0);
  });

  it('holds the new evidence in the database: insert-only matches, and no decision takes a staff session from a cookie any more', async () => {
    const q = await issued();
    expect((await decide(q.token, 'accept', '198.51.100.31', PHONE)).status).toBe(200);
    const decided = (await one('SELECT id FROM quo.quote_link_decision WHERE quote_version_id = $1', [q.versionId]))['id'] as string;
    const link = (await one('SELECT id FROM quo.quote_link_token WHERE quote_version_id = $1', [q.versionId]))['id'] as string;
    const staff = users.get('insider')!.principalId;
    expect(await sqlStateOf(app().query('UPDATE quo.quote_link_staff_match SET same_browser = false'))).toBe('42501');
    expect(await sqlStateOf(admin().query('UPDATE quo.quote_link_staff_match SET same_browser = false'))).toBe('HK001');
    expect(await sqlStateOf(admin().query('DELETE FROM quo.quote_link_staff_match'))).toBe('HK001');
    const match = (window: number) =>
      admin().query('INSERT INTO quo.quote_link_staff_match (id, link_decision_id, staff_principal_id, staff_session_id, same_browser, session_last_seen_at, window_hours, recorded_at, actor_id) VALUES ($1, $2, $3, $4, true, now(), $5, now(), $3)', [
        randomUUID(),
        decided,
        staff,
        sessionOf.get('insider'),
        window,
      ]);
    expect(await sqlStateOf(match(24))).toBe(SQLSTATE.uniqueViolation);
    expect(await sqlStateOf(match(48))).toBe(SQLSTATE.checkViolation);
    const other = await issued();
    expect(
      await sqlStateOf(
        admin().query("INSERT INTO quo.quote_link_decision (id, link_token_id, quote_version_id, decision, staff_principal_id, staff_session_id, decided_at, recorded_at, actor_id) VALUES ($1, (SELECT id FROM quo.quote_link_token WHERE quote_version_id = $2), $2, 'ACCEPTED', $3, $4, now(), now(), $3)", [
          randomUUID(),
          other.versionId,
          staff,
          sessionOf.get('insider'),
        ]),
      ),
    ).toBe(SQLSTATE.checkViolation);
    expect(link).toEqual(expect.any(String));
  });

  it('reads no staff cookie anywhere in QUO: no cookie name, no Cookie header, no AuthenticationService', () => {
    const root = resolve(process.cwd(), 'src/modules/quo');
    const files: string[] = [];
    const walk = (dir: string) => readdirSync(dir).forEach((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith('.ts') && files.push(join(dir, f))));
    walk(root);
    expect(files.length).toBeGreaterThan(10);
    const readers = files.filter((f) => /hk_s_|__Host-|header\('Cookie'\)|req\.cookies|AuthenticationService|ModuleRef/.test(readFileSync(f, 'utf8')));
    expect(readers).toEqual([]);
  });

  it('flags nothing once the staff session was last seen more than 24 hours before the decision', async () => {
    const q = await issued();
    // `earlier` signed in from .33 at the start and was never seen again; the decision comes 24 hours and a second later.
    clock.advanceBy(23 * HOUR + 1_000);
    const accepted = await decide(q.token, 'accept', '198.51.100.33', PHONE);
    expect([accepted.status, accepted.body.status], JSON.stringify(accepted.body)).toEqual([200, 'ACCEPTED']);
    expect((await matches(q.versionId)).rows).toEqual([]);
    expect((await flags(q.quoteId)).rows).toEqual([]);
  });
});
