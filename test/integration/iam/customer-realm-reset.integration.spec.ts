import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CookieJar, createBranch, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The customer realm (FR-IAM-019) and password reset (FR-IAM-020, CR-004 point 3), A-123: registration and reset
 * requests answer alike for known and unknown accounts, codes go by SMS (to a stub provider here) and are kept only
 * hashed, a sixth code is refused even when right, and a reset is single use, expires and revokes every session.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let provider: HttpServer;
const sent: Array<{ to: string; text: string; reference: string }> = [];
let phoneCounter = 0;

const newPhone = () => `+23324${String(10_000_000 + (phoneCounter += 1)).slice(1)}`;
const strongPassword = () => `Waakye-on-Sunday-${randomUUID().slice(0, 8)}`;
const call = (path: string, body: object) => request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).send(body);
const register = (phone: string, overrides: object = {}) =>
  call('/auth/customer/register', { name: 'Grace Nyarko', phone, password: strongPassword(), marketingConsent: false, ...overrides });
const admin = () => database.pool('admin');

/** The newest SMS to `to` whose text matches, waiting for the delivery that runs after the response. */
async function messageTo(to: string, pattern: RegExp, after = 0): Promise<RegExpExecArray> {
  for (let tries = 0; tries < 100; tries += 1) {
    const found = sent.slice(after).filter((message) => message.to === to).map((message) => pattern.exec(message.text)).filter((match) => match !== null);
    if (found.length > 0) return found.at(-1)!;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no SMS to ${to} matching ${pattern}`);
}
const codeIn = async (to: string, after = 0) => (await messageTo(to, /code is (\d{6})/, after))[1]!;
const resetTokenIn = async (to: string, after = 0) => (await messageTo(to, /reset code is (hk1\.rs\.[A-Za-z0-9_-]+)/, after))[1]!;

beforeAll(async () => {
  provider = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      sent.push(JSON.parse(body) as { to: string; text: string; reference: string });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: `msg-${sent.length}` }));
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, {
    clock,
    environment: { MESSAGING_MODE: 'sandbox', SMS_BASE_URL: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`, SMS_API_KEY: 'stub-provider-key-not-secret' },
  });
});

afterAll(async () => {
  await api.close();
  await database.drop();
  await new Promise((resolve) => provider.close(resolve));
});

describe('customer registration and phone verification (FR-IAM-019)', () => {
  it('registers, sends a six-digit code, verifies and signs the customer in with the customer cookies', async () => {
    const phone = newPhone();
    const registered = await register(phone, { email: 'grace.nyarko@example.com', marketingConsent: true });
    expect(registered.status).toBe(201);
    expect(registered.body).toMatchObject({ status: 'VERIFICATION_REQUIRED', session: null });
    const code = await codeIn(phone);
    const stored = await admin().query("SELECT code_hash, token_hash FROM iam.verification_token WHERE purpose = 'PHONE_VERIFY' ORDER BY id DESC LIMIT 1");
    expect(stored.rows[0].code_hash).toHaveLength(32);
    expect(JSON.stringify(stored.rows)).not.toContain(code);
    const verified = await call('/auth/customer/verify-phone', { challengeToken: registered.body.challengeToken, code });
    expect(verified.status).toBe(200);
    expect(verified.body.status).toBe('AUTHENTICATED');
    expect(verified.body.session.realm).toBe('CUSTOMER');
    expect(String(verified.headers['set-cookie'])).toContain('__Host-hk_c_at');
    const account = await admin().query('SELECT realm, email, phone_verified_at IS NOT NULL AS verified FROM iam.user_account WHERE phone_e164 = $1', [phone]);
    expect(account.rows[0]).toEqual({ realm: 'CUSTOMER', email: 'grace.nyarko@example.com', verified: true });
    const events = await admin().query("SELECT event_type, payload FROM platform.outbox_message WHERE event_type IN ('iam.UserCreated', 'iam.PhoneVerified') ORDER BY id");
    expect(events.rows.map((row) => row.event_type)).toEqual(['iam.UserCreated', 'iam.PhoneVerified']);
    expect(events.rows[0].payload).toMatchObject({ realm: 'CUSTOMER', marketingConsent: true, phoneVerified: false });
    expect(JSON.stringify(events.rows)).not.toContain(phone);
    const audit = await admin().query("SELECT after FROM platform.audit_event WHERE action = 'CREATE' AND entity_type = 'UserAccount' AND module = 'iam' ORDER BY recorded_at DESC LIMIT 1");
    expect(JSON.stringify(audit.rows[0])).not.toContain(phone);
  });

  it('answers a known phone exactly as a new one, makes no second account, sends a notice and accepts no code', async () => {
    const phone = newPhone();
    await register(phone);
    const before = sent.length;
    const again = await register(phone, { name: 'Somebody Else' });
    const fresh = await register(newPhone());
    expect(again.status).toBe(fresh.status);
    expect(Object.keys(again.body).sort()).toEqual(Object.keys(fresh.body).sort());
    expect(again.body.status).toBe('VERIFICATION_REQUIRED');
    expect(again.body.challengeToken).toMatch(/^hk1\.ch\.[A-Za-z0-9_-]{43}$/);
    expect((await admin().query('SELECT count(*)::int AS n FROM iam.user_account WHERE phone_e164 = $1', [phone])).rows[0].n).toBe(1);
    await messageTo(phone, /already has an account/, before);
    for (const code of ['000000', '123456', '999999']) {
      expect((await call('/auth/customer/verify-phone', { challengeToken: again.body.challengeToken, code })).body.error.code).toBe('VERIFICATION_CODE_INVALID');
    }
  });

  it('refuses a sixth code even when it is right, and spends the challenge', async () => {
    const phone = newPhone();
    const registered = await register(phone);
    const code = await codeIn(phone);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await call('/auth/customer/verify-phone', { challengeToken: registered.body.challengeToken, code: wrong });
      expect(response.status, `attempt ${attempt}`).toBe(422);
      expect(response.body.error.code).toBe('VERIFICATION_CODE_INVALID');
    }
    const sixth = await call('/auth/customer/verify-phone', { challengeToken: registered.body.challengeToken, code });
    expect(sixth.status).toBe(401);
    expect(sixth.body.error.code).toBe('CHALLENGE_EXPIRED');
  });

  it('expires a code after ten minutes; an unverified customer signing in gets a new code instead of a session', async () => {
    const phone = newPhone();
    const password = strongPassword();
    const registered = await register(phone, { password });
    const code = await codeIn(phone);
    clock.advanceBy(600_000);
    expect((await call('/auth/customer/verify-phone', { challengeToken: registered.body.challengeToken, code })).body.error.code).toBe('CHALLENGE_EXPIRED');
    const before = sent.length;
    const login = await call('/auth/customer/login', { identifier: phone, password });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ status: 'VERIFICATION_REQUIRED', session: null });
    expect(login.headers['set-cookie']).toBeUndefined();
    const second = await codeIn(phone, before);
    expect((await call('/auth/customer/verify-phone', { challengeToken: login.body.challengeToken, code: second })).body.status).toBe('AUTHENTICATED');
  });

  it('takes only a Ghana phone and a password meeting the policy', async () => {
    const foreign = await register('+447700900123');
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.details[0]).toMatchObject({ field: '/phone', code: 'NOT_GHANA_PHONE' });
    expect((await register(newPhone(), { password: 'short' })).status).toBe(400);
    expect((await register(newPhone(), { password: 'password1234' })).body.error.code).toBe('PASSWORD_BREACHED');
  });

  it('limits registrations to five per phone in fifteen minutes', async () => {
    const phone = newPhone();
    for (let attempt = 1; attempt <= 5; attempt += 1) expect((await register(phone)).status).toBe(201);
    const sixth = await register(phone);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('RATE_LIMITED');
  });

  it('keeps the customer realm off staff operations', async () => {
    const phone = newPhone();
    const registered = await register(phone);
    const verified = await call('/auth/customer/verify-phone', { challengeToken: registered.body.challengeToken, code: await codeIn(phone) });
    const jar = new CookieJar();
    jar.store(verified.headers['set-cookie']);
    const users = await request(api.server).get('/v1/iam/users').set('Cookie', jar.header()).set('Origin', TEST_ORIGIN);
    expect(users.status).toBe(401);
  });
});

describe('password reset (FR-IAM-020, CR-004 point 3)', () => {
  it('answers a known and an unknown address with identical bodies', async () => {
    const phone = newPhone();
    const registered = await register(phone);
    await call('/auth/customer/verify-phone', { challengeToken: registered.body.challengeToken, code: await codeIn(phone) });
    const known = await call('/auth/password/reset-request', { identifier: phone, realm: 'CUSTOMER' });
    const unknown = await call('/auth/password/reset-request', { identifier: newPhone(), realm: 'CUSTOMER' });
    const malformed = await call('/auth/password/reset-request', { identifier: 'not an address', realm: 'STAFF' });
    for (const response of [known, unknown, malformed]) {
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: 'ACCEPTED', message: 'If the account exists, a reset code has been sent.' });
    }
    await resetTokenIn(phone);
    const outcomes = await admin().query("SELECT metadata->>'outcome' AS outcome FROM platform.audit_event WHERE action = 'PASSWORD_RESET_REQUESTED' ORDER BY recorded_at");
    expect(outcomes.rows.map((row) => row.outcome)).toEqual(expect.arrayContaining(['SENT', 'NO_ACCOUNT']));
  });

  it('resets once, revokes every session, clears the lockout, and names a used, a wrong and an expired code', async () => {
    const branch = await createBranch(database, 'RST');
    const user = await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId: branch.branchId }] });
    const phone = newPhone();
    await admin().query('UPDATE iam.user_account SET phone_e164 = $2, version = version + 1 WHERE principal_id = $1', [user.principalId, phone]);
    const loginFor = (password: string) => call('/auth/staff/login', { identifier: user.identifier, password });
    const signedIn = await loginFor(user.password);
    const jar = new CookieJar();
    jar.store(signedIn.headers['set-cookie']);
    const session: TestSession = { jar, csrfToken: signedIn.body.session.csrfToken, sessionId: signedIn.body.session.sessionId };
    for (let attempt = 0; attempt < 5; attempt += 1) await loginFor('Not-the-password-at-all');
    expect((await call('/auth/password/reset-request', { identifier: user.identifier, realm: 'STAFF' })).status).toBe(202);
    const token = await resetTokenIn(phone);
    expect((await admin().query("SELECT count(*)::int AS n FROM iam.verification_token WHERE purpose = 'PASSWORD_RESET' AND principal_id = $1", [user.principalId])).rows[0].n).toBe(1);
    const newPassword = strongPassword();
    const reset = await call('/auth/password/reset', { token, newPassword });
    expect(reset.status).toBe(204);
    expect((await request(api.server).get('/v1/auth/session').set('Cookie', session.jar.header())).status).toBe(401);
    expect((await loginFor(newPassword)).body.status).toBe('AUTHENTICATED');
    const used = await call('/auth/password/reset', { token, newPassword: strongPassword() });
    expect(used.status).toBe(422);
    expect(used.body.error.code).toBe('RESET_TOKEN_USED');
    expect((await call('/auth/password/reset', { token: `hk1.rs.${'A'.repeat(43)}`, newPassword: strongPassword() })).body.error.code).toBe('RESET_TOKEN_INVALID');
    const before = sent.length;
    await call('/auth/password/reset-request', { identifier: phone, realm: 'STAFF' });
    const later = await resetTokenIn(phone, before);
    clock.advanceBy(1_800_000);
    const expired = await call('/auth/password/reset', { token: later, newPassword: strongPassword() });
    expect(expired.status).toBe(422);
    expect(expired.body.error.code).toBe('RESET_TOKEN_EXPIRED');
    const audit = await admin().query("SELECT metadata FROM platform.audit_event WHERE action = 'PASSWORD_RESET' AND entity_id = $1", [user.principalId]);
    expect(audit.rows[0].metadata).toMatchObject({ realm: 'STAFF', sessionsRevoked: 1 });
    expect(JSON.stringify(audit.rows)).not.toContain(newPassword);
  });

  it('keeps only the newest reset code, and refuses a breached new password without spending the code', async () => {
    const phone = newPhone();
    const registered = await register(phone);
    await call('/auth/customer/verify-phone', { challengeToken: registered.body.challengeToken, code: await codeIn(phone) });
    let before = sent.length;
    await call('/auth/password/reset-request', { identifier: phone, realm: 'CUSTOMER' });
    const first = await resetTokenIn(phone, before);
    before = sent.length;
    await call('/auth/password/reset-request', { identifier: phone, realm: 'CUSTOMER' });
    const second = await resetTokenIn(phone, before);
    expect((await call('/auth/password/reset', { token: first, newPassword: strongPassword() })).body.error.code).toBe('RESET_TOKEN_USED');
    expect((await call('/auth/password/reset', { token: second, newPassword: 'password1234' })).body.error.code).toBe('PASSWORD_BREACHED');
    expect((await call('/auth/password/reset', { token: second, newPassword: strongPassword() })).status).toBe(204);
  });

  it('limits reset requests to five per identifier in fifteen minutes, known or not', async () => {
    const phone = newPhone();
    for (let attempt = 1; attempt <= 5; attempt += 1) expect((await call('/auth/password/reset-request', { identifier: phone, realm: 'CUSTOMER' })).status).toBe(202);
    expect((await call('/auth/password/reset-request', { identifier: phone, realm: 'CUSTOMER' })).status).toBe(429);
  });

  it('a Manager signing in is untouched by the customer rules', async () => {
    const branch = await createBranch(database, 'MGR');
    const manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId: branch.branchId }] }), () => clock.now());
    expect(manager.sessionId).toBeTruthy();
  });
});
