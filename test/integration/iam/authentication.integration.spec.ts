import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consoleGet,
  consolePost,
  CookieJar,
  createBranch,
  createUser,
  login,
  relaxRateLimits,
  testStartTime,
  type TestBranch,
  type TestUser,
} from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let dodowa: TestBranch;
let cashier: TestUser;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  dodowa = await createBranch(database);
  cashier = await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId: dodowa.branchId, locationId: dodowa.shopId }] });
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

function staffLogin(identifier: string, password: string) {
  return request(api.server).post('/v1/auth/staff/login').set('Origin', TEST_ORIGIN).send({ identifier, password, deviceLabel: 'Shop till tablet' });
}

describe('staff login (ADR-0016, docs/API.md section 3.1)', () => {
  it('authenticates a cashier, sets host-bound HttpOnly Secure SameSite=Strict cookies, and returns the session with grants', async () => {
    const response = await staffLogin(cashier.identifier, cashier.password);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('AUTHENTICATED');
    expect(response.body.challengeToken).toBeNull();
    const cookies = response.headers['set-cookie'] as unknown as string[];
    for (const name of ['__Host-hk_s_at', '__Host-hk_s_rt']) {
      const cookie = cookies.find((c) => c.startsWith(`${name}=`));
      expect(cookie, name).toBeDefined();
      expect(cookie).toMatch(/; Path=\//);
      expect(cookie).toMatch(/; HttpOnly/);
      expect(cookie).toMatch(/; Secure/);
      expect(cookie).toMatch(/; SameSite=Strict/);
      expect(cookie).not.toMatch(/Domain=/i);
    }
    const session = response.body.session;
    expect(session.realm).toBe('STAFF');
    expect(session.principal).toEqual({ id: cashier.principalId, displayName: 'Adwoa Darko' });
    expect(session.grants).toEqual([
      { roleCode: 'CASHIER', roleName: 'Cashier', branchId: dodowa.branchId, branchCode: 'DDW', locationId: dodowa.shopId, locationCode: 'SHOP' },
    ]);
    expect(session.permissions).toEqual(['iam.session.read', 'iam.session.revoke', 'mdm.product.read']);
    expect(Date.parse(session.accessExpiresAt) - clock.now().getTime()).toBeLessThanOrEqual(600_000);
    expect(session.mustChangePassword).toBe(false);
    expect(session.totpEnrolled).toBe(false);
  });

  it('answers a wrong password and an unknown account with the same status, code and message', async () => {
    const wrong = await staffLogin(cashier.identifier, 'not-the-password-at-all');
    const unknown = await staffLogin('nobody.here@hakoremfarms.test', 'not-the-password-at-all');
    for (const response of [wrong, unknown]) {
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    expect(wrong.body.error.details).toEqual(unknown.body.error.details);
  });

  it('takes about the same time for an unknown account as for a wrong password, because a dummy hash is verified', async () => {
    const time = async (identifier: string) => {
      const started = process.hrtime.bigint();
      await staffLogin(identifier, 'not-the-password-at-all');
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    const other = await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'CASHIER', branchId: dodowa.branchId }] });
    for (let i = 0; i < 3; i += 1) {
      known.push(await time(other.identifier));
      unknown.push(await time(`ghost.${i}@hakoremfarms.test`));
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[1]!;
    // Without the dummy hash an unknown account answers in a few milliseconds; with it, in the same order as a real one.
    expect(median(unknown)).toBeGreaterThan(median(known) / 3);
  });

  it('locks an identifier after five consecutive failures, whether or not an account exists, with Retry-After', async () => {
    const victim = await createUser(database, { name: 'Yaw Boateng', grants: [{ role: 'STOREKEEPER', branchId: dodowa.branchId }] });
    for (const identifier of [victim.identifier, 'no.such.person@hakoremfarms.test']) {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        expect((await staffLogin(identifier, 'wrong-password-123')).status).toBe(401);
      }
      const locked = await staffLogin(identifier, 'wrong-password-123');
      expect(locked.status).toBe(429);
      expect(locked.body.error.code).toBe('RATE_LIMITED');
      expect(Number(locked.headers['retry-after'])).toBeGreaterThanOrEqual(59);
    }
    // Even the right password is refused while the lock lasts.
    expect((await staffLogin(victim.identifier, victim.password)).status).toBe(429);
    const { rows } = await database.pool('admin').query<{ failed_attempts: number; locked: boolean }>(
      'SELECT failed_attempts, locked_until > now() AS locked FROM iam.user_account WHERE principal_id = $1',
      [victim.principalId],
    );
    expect(rows[0]).toEqual({ failed_attempts: 5, locked: true });
  });

  it('records every login and failure in the audit trail, with no actor only for an unknown account', async () => {
    const { rows } = await database.pool('admin').query<{ action: string; actor_id: string | null; reason: string | null }>(
      `SELECT action, actor_id, metadata->>'reason' AS reason FROM platform.audit_event WHERE module = 'iam' ORDER BY recorded_at`,
    );
    expect(rows.some((row) => row.action === 'LOGIN' && row.actor_id === cashier.principalId)).toBe(true);
    expect(rows.some((row) => row.action === 'LOGIN_FAILED' && row.actor_id === cashier.principalId)).toBe(true);
    expect(rows.some((row) => row.action === 'LOGIN_FAILED' && row.actor_id === null)).toBe(true);
    const { rows: leaks } = await database
      .pool('admin')
      .query("SELECT 1 FROM platform.audit_event WHERE convert_from(coalesce(\"after\", ''), 'UTF8') LIKE '%Pw-%' OR metadata::text LIKE '%Pw-%'");
    expect(leaks).toHaveLength(0);
  });

  it('refuses a disabled account with the same answer as a wrong password', async () => {
    const gone = await createUser(database, { name: 'Esi Bonsu', status: 'DISABLED', grants: [{ role: 'SALES', branchId: dodowa.branchId }] });
    const response = await staffLogin(gone.identifier, gone.password);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('sessions, refresh and logout (ADR-0016)', () => {
  it('returns the same session and CSRF token on GET /auth/session as at login', async () => {
    const session = await login(api.server, cashier);
    const response = await consoleGet(api.server, session, '/v1/auth/session');
    expect(response.status).toBe(200);
    expect(response.body.sessionId).toBe(session.sessionId);
    expect(response.body.csrfToken).toBe(session.csrfToken);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rotates the refresh token on every refresh, and revokes the whole session when a rotated token is presented again', async () => {
    const session = await login(api.server, cashier);
    const firstRefresh = session.jar.get('__Host-hk_s_rt')!;
    const refreshed = await request(api.server).post('/v1/auth/refresh').set('Origin', TEST_ORIGIN).set('Cookie', session.jar.header());
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.sessionId).toBe(session.sessionId);
    session.jar.store(refreshed.headers['set-cookie']);
    expect(session.jar.get('__Host-hk_s_rt')).not.toBe(firstRefresh);

    const stolen = new CookieJar();
    stolen.set('__Host-hk_s_rt', firstRefresh);
    const reused = await request(api.server).post('/v1/auth/refresh').set('Origin', TEST_ORIGIN).set('Cookie', stolen.header());
    expect(reused.status).toBe(401);

    // The legitimate holder is logged out too: the session is revoked.
    expect((await consoleGet(api.server, session, '/v1/auth/session')).status).toBe(401);
    const { rows } = await database.pool('admin').query<{ revoke_reason: string }>('SELECT revoke_reason FROM iam.session WHERE id = $1', [session.sessionId]);
    expect(rows[0]!.revoke_reason).toBe('REFRESH_TOKEN_REUSE');
    const { rows: audit } = await database.pool('admin').query("SELECT 1 FROM platform.audit_event WHERE action = 'TOKEN_REUSE' AND entity_id = $1", [session.sessionId]);
    expect(audit).toHaveLength(1);
  });

  it('refuses a refresh from an origin that is not on the allow-list', async () => {
    const session = await login(api.server, cashier);
    const response = await request(api.server).post('/v1/auth/refresh').set('Origin', 'https://evil.example.com').set('Cookie', session.jar.header());
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('ends the session at logout: the access cookie stops working at once and the refresh cookie too', async () => {
    const session = await login(api.server, cashier);
    const out = await consolePost(api.server, session, '/v1/auth/logout');
    expect(out.status).toBe(204);
    expect((await consoleGet(api.server, session, '/v1/auth/session')).status).toBe(401);
    const refresh = await request(api.server).post('/v1/auth/refresh').set('Origin', TEST_ORIGIN).set('Cookie', session.jar.header());
    expect(refresh.status).toBe(401);
  });

  it('expires the access token after its lifetime, and a refresh brings the session back', async () => {
    const session = await login(api.server, cashier);
    clock.advanceBy(601_000);
    try {
      expect((await consoleGet(api.server, session, '/v1/auth/session')).status).toBe(401);
      const refreshed = await request(api.server).post('/v1/auth/refresh').set('Origin', TEST_ORIGIN).set('Cookie', session.jar.header());
      expect(refreshed.status).toBe(200);
      session.jar.store(refreshed.headers['set-cookie']);
      expect((await consoleGet(api.server, session, '/v1/auth/session')).status).toBe(200);
    } finally {
      clock.advanceBy(-601_000);
    }
  });
});

describe('CSRF and origin on cookie-authenticated state changes (ADR-0016)', () => {
  it('refuses a state change without the X-CSRF-Token header, or with another session\'s token', async () => {
    const session = await login(api.server, cashier);
    const other = await login(api.server, cashier);
    const missing = await request(api.server).post('/v1/auth/logout').set('Cookie', session.jar.header()).set('Origin', TEST_ORIGIN);
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('CSRF_TOKEN_INVALID');
    const wrong = await request(api.server)
      .post('/v1/auth/logout')
      .set('Cookie', session.jar.header())
      .set('Origin', TEST_ORIGIN)
      .set('X-CSRF-Token', other.csrfToken);
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('refuses a state change from an origin that is not allowed, even with the right token', async () => {
    const session = await login(api.server, cashier);
    const response = await request(api.server)
      .post('/v1/auth/logout')
      .set('Cookie', session.jar.header())
      .set('Origin', 'https://hakoremfarms.example.net')
      .set('X-CSRF-Token', session.csrfToken);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('answers a CORS preflight from the console with the allowed headers, and refuses one from anywhere else', async () => {
    const allowed = await request(api.server)
      .options('/v1/products')
      .set('Origin', TEST_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,idempotency-key,x-csrf-token');
    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(allowed.headers['access-control-allow-headers']).toContain('X-CSRF-Token');
    const refused = await request(api.server).options('/v1/products').set('Origin', 'https://evil.example.com').set('Access-Control-Request-Method', 'POST');
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('realms are separate (ADR-0016)', () => {
  it('never accepts a customer session where a staff session is required', async () => {
    const customer = await createUser(database, { name: 'Ama Serwaa Ofori', realm: 'CUSTOMER' });
    const session = await login(api.server, customer);
    expect(session.jar.get('__Host-hk_c_at')).toBeDefined();
    expect(session.jar.get('__Host-hk_s_at')).toBeUndefined();
    const staffOnly = await consoleGet(api.server, session, '/v1/iam/sessions');
    expect(staffOnly.status).toBe(401);
    // A customer's access token renamed to the staff cookie is refused too: the token carries its realm.
    const forged = await request(api.server).get('/v1/iam/sessions').set('Cookie', `__Host-hk_s_at=${session.jar.get('__Host-hk_c_at')}`);
    expect(forged.status).toBe(401);
  });

  it('does not log a staff account in through the customer endpoint', async () => {
    const response = await request(api.server).post('/v1/auth/customer/login').send({ identifier: cashier.identifier, password: cashier.password });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});
