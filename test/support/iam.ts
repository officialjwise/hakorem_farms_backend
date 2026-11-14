import { randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import type { Server } from 'node:http';
import request from 'supertest';
import { base32Decode, totpAt } from '../../src/modules/iam/domain/totp';
import type { TestDatabase } from './test-database';
import { TEST_ORIGIN } from './test-app';

export const SYSTEM_PRINCIPAL = '01900000-0000-7000-8000-000000000001';

export const ROLE_IDS = {
  OWNER: '01900000-0000-7000-8000-000000000101',
  MANAGER: '01900000-0000-7000-8000-000000000102',
  ACCOUNTANT: '01900000-0000-7000-8000-000000000103',
  STOREKEEPER: '01900000-0000-7000-8000-000000000104',
  CASHIER: '01900000-0000-7000-8000-000000000105',
  SALES: '01900000-0000-7000-8000-000000000106',
  FARM_HAND: '01900000-0000-7000-8000-000000000107',
  DRIVER: '01900000-0000-7000-8000-000000000108',
  INVESTOR: '01900000-0000-7000-8000-000000000109',
  CUSTOMER: '01900000-0000-7000-8000-000000000110',
} as const;

export type RoleCode = keyof typeof ROLE_IDS;

/**
 * Raises the per-address limits for a test file that logs in many times from 127.0.0.1, through the same settings
 * rows the owner would use. The limit itself is proved by its own test, which does not call this.
 */
export async function relaxRateLimits(database: TestDatabase): Promise<void> {
  for (const key of ['rate_limit.auth.per_address_15m', 'rate_limit.console.per_account_1m']) {
    await database.pool('app').query(
      `INSERT INTO platform.setting (id, key, value, value_type, valid_from, description, created_by, updated_by)
       VALUES ($1, $2, '100000', 'INTEGER', now() - interval '1 day', 'Raised for a test file', $3, $3)`,
      [randomUUID(), key, SYSTEM_PRINCIPAL],
    );
  }
}

/** A clock a minute ahead of the database, so rows stamped with the database's now() are already current. */
export function testStartTime(): Date {
  return new Date(Date.now() + 60_000);
}

/** A branch with a shop floor and a pen, as the seeded farm at Dodowa has. */
export interface TestBranch {
  readonly branchId: string;
  readonly shopId: string;
  readonly pensId: string;
  readonly code: string;
}

export async function createBranch(database: TestDatabase, code = 'DDW'): Promise<TestBranch> {
  const app = database.pool('app');
  const branchId = randomUUID();
  const shopId = randomUUID();
  const pensId = randomUUID();
  await app.query("INSERT INTO mdm.branch (id, code, name, status, created_by, updated_by) VALUES ($1, $2, $3, 'ACTIVE', $4, $4)", [
    branchId,
    code,
    `${code} farm and shop`,
    SYSTEM_PRINCIPAL,
  ]);
  await app.query(
    `INSERT INTO mdm.location (id, branch_id, code, name, kind, is_virtual, is_sellable, created_by, updated_by) VALUES
       ($1, $3, 'SHOP', 'Shop floor', 'SHOP_FLOOR', false, true, $4, $4),
       ($2, $3, 'PENS', 'Goat pens', 'PEN', false, false, $4, $4)`,
    [shopId, pensId, branchId, SYSTEM_PRINCIPAL],
  );
  return { branchId, shopId, pensId, code };
}

export interface TestUser {
  readonly principalId: string;
  readonly identifier: string;
  readonly password: string;
  readonly realm: 'STAFF' | 'CUSTOMER' | 'INVESTOR';
}

let counter = 0;

/** A user account with the given role grants. Passwords are random per test run, never fixed (SEC-034). */
export async function createUser(
  database: TestDatabase,
  options: {
    readonly name: string;
    readonly realm?: 'STAFF' | 'CUSTOMER' | 'INVESTOR';
    readonly grants?: ReadonlyArray<{ readonly role: RoleCode; readonly branchId: string; readonly locationId?: string }>;
    readonly mustChangePassword?: boolean;
    readonly status?: 'ACTIVE' | 'DISABLED';
  },
): Promise<TestUser> {
  counter += 1;
  const app = database.pool('app');
  const principalId = randomUUID();
  const realm = options.realm ?? 'STAFF';
  const identifier = `${options.name.toLowerCase().replace(/[^a-z]+/g, '.')}.${counter}.${principalId.slice(0, 6)}@hakoremfarms.test`;
  const password = `Pw-${randomUUID()}`;
  const passwordHash = await hash(password, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  await app.query("INSERT INTO iam.principal (id, kind, display_name, status, created_by, updated_by) VALUES ($1, 'USER', $2, $3, $4, $4)", [
    principalId,
    options.name,
    options.status ?? 'ACTIVE',
    SYSTEM_PRINCIPAL,
  ]);
  await app.query(
    `INSERT INTO iam.user_account (principal_id, realm, email, password_hash, must_change_password, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [principalId, realm, identifier, passwordHash, options.mustChangePassword ?? false, SYSTEM_PRINCIPAL],
  );
  for (const grant of options.grants ?? []) {
    await app.query(
      `INSERT INTO iam.role_grant (id, principal_id, role_id, branch_id, location_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [randomUUID(), principalId, ROLE_IDS[grant.role], grant.branchId, grant.locationId ?? null, SYSTEM_PRINCIPAL],
    );
  }
  return { principalId, identifier, password, realm };
}

/** Cookies as a browser would hold them for the API host: name to value, from Set-Cookie headers. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  store(setCookie: string[] | string | undefined): void {
    for (const header of Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie]) {
      const [pair] = header.split(';');
      const separator = pair!.indexOf('=');
      const name = pair!.slice(0, separator).trim();
      const value = pair!.slice(separator + 1).trim();
      if (value === '' || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(header)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

/** A logged-in browser: its cookies and the CSRF token from the session it got. */
export interface TestSession {
  readonly jar: CookieJar;
  readonly csrfToken: string;
  readonly sessionId: string;
}

const LOGIN_PATH = { STAFF: '/v1/auth/staff/login', CUSTOMER: '/v1/auth/customer/login', INVESTOR: '/v1/auth/investor/login' } as const;

/** Logs in with a password only; fails the test unless the result is AUTHENTICATED. */
export async function login(server: Server, user: TestUser, deviceLabel = 'Shop till tablet'): Promise<TestSession> {
  const jar = new CookieJar();
  const response = await request(server)
    .post(LOGIN_PATH[user.realm])
    .set('Origin', TEST_ORIGIN)
    .send({ identifier: user.identifier, password: user.password, deviceLabel });
  if (response.status !== 200 || response.body.status !== 'AUTHENTICATED') {
    throw new Error(`login of ${user.identifier} gave ${response.status} ${JSON.stringify(response.body)}`);
  }
  jar.store(response.headers['set-cookie']);
  return { jar, csrfToken: response.body.session.csrfToken as string, sessionId: response.body.session.sessionId as string };
}

/** A state-changing request as the console sends it: cookies, CSRF token, allowed origin and an idempotency key. */
export function consolePost(server: Server, session: TestSession, path: string, idempotencyKey: string = randomUUID()) {
  return request(server)
    .post(path)
    .set('Cookie', session.jar.header())
    .set('X-CSRF-Token', session.csrfToken)
    .set('Origin', TEST_ORIGIN)
    .set('Idempotency-Key', idempotencyKey);
}

export function consoleGet(server: Server, session: TestSession, path: string) {
  return request(server).get(path).set('Cookie', session.jar.header()).set('Origin', TEST_ORIGIN);
}

/**
 * Logs in a privileged user (Owner, Manager, Accountant) through first-time TOTP enrolment, as the console would:
 * password, enrol with the challenge, confirm with a code. Returns the session and the secret for later codes.
 */
export async function enrolAndLogin(server: Server, user: TestUser, now: () => Date): Promise<TestSession & { readonly secret: Buffer }> {
  const post = (path: string, body: object) => request(server).post(path).set('Origin', TEST_ORIGIN).send(body);
  const first = await post(LOGIN_PATH[user.realm], { identifier: user.identifier, password: user.password });
  if (first.body.status !== 'TOTP_ENROLMENT_REQUIRED') {
    throw new Error(`expected TOTP enrolment for ${user.identifier}, got ${JSON.stringify(first.body)}`);
  }
  const challengeToken = first.body.challengeToken as string;
  const started = await post('/v1/auth/totp/enrol', { challengeToken });
  const secret = base32Decode(started.body.secretBase32 as string);
  const confirmed = await post('/v1/auth/totp/confirm', { challengeToken, code: totpAt(secret, Math.floor(now().getTime() / 1000)) });
  if (confirmed.status !== 200) {
    throw new Error(`TOTP confirmation failed: ${JSON.stringify(confirmed.body)}`);
  }
  const jar = new CookieJar();
  jar.store(confirmed.headers['set-cookie']);
  const session = await request(server).get('/v1/auth/session').set('Cookie', jar.header());
  return { jar, csrfToken: session.body.csrfToken as string, sessionId: session.body.sessionId as string, secret };
}
