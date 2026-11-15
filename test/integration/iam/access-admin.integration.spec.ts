import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, ROLE_IDS, testStartTime, type TestSession } from '../../support/iam';
import { sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * User, role and grant administration over the seeded farm (FR-IAM-001, FR-IAM-008, FR-IAM-015, FR-IAM-017,
 * FR-IAM-022, A-120): every operation refuses the wrong role in the application layer (ADR-0035), nobody administers
 * their own access, nobody grants beyond what they hold, the last Owner stays, and a temporary password is shown
 * once and kept nowhere in the clear.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let owner: TestSession & { secret: Buffer };
let manager: TestSession & { secret: Buffer };
let managerAtTest: TestSession & { secret: Buffer };
let accountant: TestSession & { secret: Buffer };
let sales: TestSession;
let cashier: TestSession;
let storekeeper: TestSession;
let driver: TestSession;
let ownerId: string;
let managerId: string;
let ddw: string;
let tst: string;
let shop: string;
let tstLocation: string;

const post = (session: TestSession, path: string, body: object, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const patch = (session: TestSession, path: string, body: object, key: string = randomUUID()) =>
  request(api.server).patch(`/v1${path}`).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const loginAs = (identifier: string, password: string) => request(api.server).post('/v1/auth/staff/login').set('Origin', TEST_ORIGIN).send({ identifier, password });
const admin = () => database.pool('admin');
let phoneCounter = 0;
const newPhone = () => `+23320000${String(9000 + (phoneCounter += 1)).padStart(4, '0')}`;
const newStaff = (grants: object[] = []) => ({ displayName: `Kojo Asante ${randomUUID().slice(0, 4)}`, email: `kojo.${randomUUID().slice(0, 8)}@hakoremfarms.test`, phone: newPhone(), realm: 'STAFF', grants });

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const ids = new Map(
    (
      await admin().query<{ code: string; id: string }>(
        `SELECT 'branch:' || code AS code, id FROM mdm.branch UNION ALL SELECT 'location:' || b.code || ':' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id`,
      )
    ).rows.map((row) => [row.code, row.id] as const),
  );
  ddw = ids.get('branch:DDW')!;
  tst = ids.get('branch:TST')!;
  shop = ids.get('location:DDW:SHOP')!;
  tstLocation = [...ids.entries()].find(([code]) => code.startsWith('location:TST:'))![1];
  const now = () => clock.now();
  const ownerUser = await createUser(database, { name: 'Abena Owusu', grants: [{ role: 'OWNER', branchId: ddw }, { role: 'OWNER', branchId: tst }] });
  ownerId = ownerUser.principalId;
  owner = await enrolAndLogin(api.server, ownerUser, now);
  const managerUser = await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId: ddw }] });
  managerId = managerUser.principalId;
  manager = await enrolAndLogin(api.server, managerUser, now);
  managerAtTest = await enrolAndLogin(api.server, await createUser(database, { name: 'Test Manager', grants: [{ role: 'MANAGER', branchId: tst }] }), now);
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId: ddw }] }), now);
  sales = await login(api.server, await createUser(database, { name: 'Esi Appiah', grants: [{ role: 'SALES', branchId: ddw }] }));
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId: ddw, locationId: shop }] }));
  storekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId: ddw }] }));
  driver = await login(api.server, await createUser(database, { name: 'Selorm Agbeko', grants: [{ role: 'DRIVER', branchId: ddw }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('wrong roles are refused on every user, role and grant operation (ADR-0035)', () => {
  const someId = randomUUID();
  const writes: ReadonlyArray<readonly [string, 'POST' | 'PATCH', string, () => object]> = [
    ['createUser', 'POST', '/iam/users', () => newStaff()],
    ['updateUser', 'PATCH', `/iam/users/${someId}`, () => ({ version: 1, displayName: 'Refused' })],
    ['disableUser', 'POST', `/iam/users/${someId}/disable`, () => ({ reason: 'Refused' })],
    ['enableUser', 'POST', `/iam/users/${someId}/enable`, () => ({ reason: 'Refused' })],
    ['unlockUser', 'POST', `/iam/users/${someId}/unlock`, () => ({ reason: 'Refused' })],
    ['resetUserPassword', 'POST', `/iam/users/${someId}/reset-password`, () => ({ reason: 'Refused' })],
    ['createGrant', 'POST', '/iam/grants', () => ({ principalId: someId, roleId: ROLE_IDS.CASHIER, branchId: ddw })],
    ['revokeGrant', 'POST', `/iam/grants/${someId}/revoke`, () => ({ reason: 'Refused' })],
  ];
  const refused = () => ({ accountant, sales, cashier, storekeeper, driver }) as Record<string, TestSession>;

  it.each(writes)('%s: the Accountant, Sales, the Cashier, the Storekeeper and the Driver are refused with 403 FORBIDDEN, each refusal audited', async (_id, method, path, body) => {
    const count = async () => (await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'")).rows[0]!.n;
    const before = await count();
    for (const [role, session] of Object.entries(refused())) {
      const response = method === 'POST' ? await post(session, path, body()) : await patch(session, path, body());
      expect(response.status, role).toBe(403);
      expect(response.body.error.code, role).toBe('FORBIDDEN');
    }
    expect((await count()) - before).toBe(5);
  });

  it('only the Owner, the Manager and the Accountant read users, roles, permissions and grants', async () => {
    for (const path of ['/iam/users', `/iam/users/${ownerId}`, '/iam/roles', `/iam/roles/${ROLE_IDS.OWNER}`, '/iam/permissions', '/iam/grants']) {
      for (const [role, session] of Object.entries({ sales, cashier, storekeeper, driver })) {
        expect((await get(session, path)).status, `${role} ${path}`).toBe(403);
      }
      for (const session of [owner, manager, accountant]) {
        expect((await get(session, path)).status, path).toBe(200);
      }
    }
  });

  it('a Manager granted at the test branch cannot disable, change or unlock a Dodowa user, nor grant at Dodowa', async () => {
    const target = await createUser(database, { name: 'Ama Dodowa', grants: [{ role: 'SALES', branchId: ddw }] });
    expect((await post(managerAtTest, `/iam/users/${target.principalId}/disable`, { reason: 'Out of scope' })).status).toBe(403);
    expect((await patch(managerAtTest, `/iam/users/${target.principalId}`, { version: 1, displayName: 'Out of scope' })).status).toBe(403);
    expect((await post(managerAtTest, `/iam/users/${target.principalId}/unlock`, { reason: 'Out of scope' })).status).toBe(403);
    expect((await post(managerAtTest, '/iam/grants', { principalId: target.principalId, roleId: ROLE_IDS.CASHIER, branchId: ddw })).status).toBe(403);
    expect((await post(managerAtTest, '/iam/users', newStaff([{ roleId: ROLE_IDS.SALES, branchId: ddw }]))).status).toBe(403);
  });
});

describe('creating a staff account (FR-IAM-001)', () => {
  it('answers 201 with the account and a temporary password shown once, never in the audit trail or the idempotency store', async () => {
    const key = randomUUID();
    const body = newStaff([{ roleId: ROLE_IDS.CASHIER, branchId: ddw, locationId: shop }]);
    const created = await post(manager, '/iam/users', body, key);
    expect(created.status).toBe(201);
    const password = created.body.temporaryPassword as string;
    expect(password).toMatch(/^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/);
    expect(created.body.user).toMatchObject({ displayName: body.displayName, email: body.email, phone: body.phone, realm: 'STAFF', status: 'ACTIVE', mustChangePassword: true, totpRequired: false });
    expect(created.body.user.grants).toEqual([{ roleCode: 'CASHIER', roleName: 'Cashier', branchId: ddw, branchCode: 'DDW', locationId: shop, locationCode: 'SHOP' }]);

    const replay = await post(manager, '/iam/users', body, key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(created.body);
    const leaks = await admin().query<{ n: number }>(
      `SELECT (SELECT count(*) FROM platform.audit_event WHERE coalesce(before::text, '') || coalesce(after::text, '') || coalesce(metadata::text, '') LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM platform.idempotency_key WHERE response_body::text LIKE '%' || $1 || '%') AS n`,
      [password],
    );
    expect(Number(leaks.rows[0]!.n)).toBe(0);

    const first = await loginAs(body.email, password);
    expect(first.body.status).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('refuses a live phone or email twice in the realm (422 DUPLICATE_VALUE), an account with neither, and an investor account until capital exists', async () => {
    const body = newStaff();
    expect((await post(owner, '/iam/users', body)).status).toBe(201);
    const twice = await post(owner, '/iam/users', { ...newStaff(), phone: body.phone });
    expect(twice.status).toBe(422);
    expect(twice.body.error).toMatchObject({ code: 'DUPLICATE_VALUE', details: [{ field: '/phone' }] });
    const email = await post(owner, '/iam/users', { ...newStaff(), email: body.email.toUpperCase() });
    expect(email.body.error).toMatchObject({ code: 'DUPLICATE_VALUE', details: [{ field: '/email' }] });
    const none = await post(owner, '/iam/users', { displayName: 'No Contact', realm: 'STAFF', grants: [] });
    expect(none.body.error).toMatchObject({ code: 'USER_INVALID', details: [{ code: 'NO_IDENTIFIER' }] });
    const investor = await post(owner, '/iam/users', { ...newStaff(), realm: 'INVESTOR' });
    expect(investor.body.error).toMatchObject({ code: 'USER_INVALID', details: [{ field: '/realm', code: 'INVESTOR_ACCOUNTS_NOT_AVAILABLE' }] });
  });

  it('a Manager cannot create an Owner: the role holds permissions the Manager does not hold, and nothing is written', async () => {
    const body = newStaff([{ roleId: ROLE_IDS.OWNER, branchId: ddw }]);
    const refused = await post(manager, '/iam/users', body);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('FORBIDDEN');
    expect((await admin().query('SELECT 1 FROM iam.user_account WHERE email = $1', [body.email])).rowCount).toBe(0);
  });
});

describe('grants (FR-IAM-011, FR-IAM-022)', () => {
  it('refuses a Manager granting themselves the Owner role or any role (403), and the database refuses a self-grant row', async () => {
    const owner403 = await post(manager, '/iam/grants', { principalId: managerId, roleId: ROLE_IDS.OWNER, branchId: ddw });
    expect(owner403.status).toBe(403);
    const self = await post(manager, '/iam/grants', { principalId: managerId, roleId: ROLE_IDS.SALES, branchId: ddw });
    expect(self.status).toBe(403);
    const failures = await admin().query<{ reason: string; actor: string }>(
      "SELECT metadata->>'reason' AS reason, actor_id AS actor FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE' AND metadata->>'permission' = 'iam.grant.manage'",
    );
    expect(failures.rows).toContainEqual({ reason: 'SELF_GRANT', actor: managerId });
    const direct = database
      .pool('app')
      .query('INSERT INTO iam.role_grant (id, principal_id, role_id, branch_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $2, $2)', [randomUUID(), managerId, ROLE_IDS.SALES, ddw]);
    expect(await sqlStateOf(direct)).toBe('23514');
  });

  it('the Owner grants a Manager, which is audited as PERMISSION_CHANGE naming granter, grantee and role, and published', async () => {
    const target = await createUser(database, { name: 'Nana Yeboah' });
    const granted = await post(owner, '/iam/grants', { principalId: target.principalId, roleId: ROLE_IDS.MANAGER, branchId: ddw });
    expect(granted.status).toBe(201);
    expect(granted.body).toMatchObject({ principal: { id: target.principalId }, role: { code: 'MANAGER' }, branch: { id: ddw, code: 'DDW' }, location: null, createdBy: { id: ownerId } });
    const audit = await admin().query<{ actor_id: string; grantee: string; role: string; change: string }>(
      `SELECT actor_id, metadata->>'granteePrincipalId' AS grantee, metadata->>'roleCode' AS role, metadata->>'change' AS change
         FROM platform.audit_event WHERE action = 'PERMISSION_CHANGE' AND entity_id = $1`,
      [granted.body.id],
    );
    expect(audit.rows).toEqual([{ actor_id: ownerId, grantee: target.principalId, role: 'MANAGER', change: 'GRANTED' }]);
    const event = await admin().query("SELECT 1 FROM platform.outbox_message WHERE event_type = 'iam.RoleGranted' AND subject_id = $1", [granted.body.id]);
    expect(event.rowCount).toBe(1);
    const twice = await post(owner, '/iam/grants', { principalId: target.principalId, roleId: ROLE_IDS.MANAGER, branchId: ddw });
    expect(twice.body.error.code).toBe('DUPLICATE_VALUE');
  });

  it('refuses a location of another branch, a window ending before it starts, the Customer role to staff, and an unknown role', async () => {
    const target = await createUser(database, { name: 'Efua Grant' });
    const other = await post(owner, '/iam/grants', { principalId: target.principalId, roleId: ROLE_IDS.CASHIER, branchId: ddw, locationId: tstLocation });
    expect(other.body.error).toMatchObject({ code: 'GRANT_INVALID', details: [{ field: '/locationId', code: 'LOCATION_NOT_IN_BRANCH' }] });
    const window = await post(owner, '/iam/grants', { principalId: target.principalId, roleId: ROLE_IDS.CASHIER, branchId: ddw, validFrom: '2026-12-01T00:00:00Z', validTo: '2026-11-30T00:00:00Z' });
    expect(window.body.error).toMatchObject({ code: 'GRANT_INVALID', details: [{ field: '/validTo', code: 'NOT_AFTER_VALID_FROM' }] });
    const customer = await post(owner, '/iam/grants', { principalId: target.principalId, roleId: ROLE_IDS.CUSTOMER, branchId: ddw });
    expect(customer.body.error).toMatchObject({ code: 'GRANT_INVALID', details: [{ code: 'ROLE_NOT_FOR_REALM' }] });
    const unknown = await post(owner, '/iam/grants', { principalId: target.principalId, roleId: randomUUID(), branchId: ddw });
    expect(unknown.body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/roleId' }] });
  });

  it('a revoked grant takes effect on the next request, nobody revokes their own grant, and the database refuses a self-revocation', async () => {
    const user = await createUser(database, { name: 'Kwesi Revoke' });
    const granted = await post(owner, '/iam/grants', { principalId: user.principalId, roleId: ROLE_IDS.SALES, branchId: ddw });
    const session = await login(api.server, user);
    expect((await get(session, '/products')).status).toBe(200);
    const revoked = await post(owner, `/iam/grants/${granted.body.id}/revoke`, { reason: 'Moved to the farm' });
    expect(revoked.status).toBe(200);
    expect((await get(session, '/products')).status).toBe(403);
    expect((await get(owner, `/iam/grants?principalId=${user.principalId}`)).body.data).toEqual([]);

    const own = (await admin().query<{ id: string }>('SELECT id FROM iam.role_grant WHERE principal_id = $1 AND deleted_at IS NULL LIMIT 1', [managerId])).rows[0]!.id;
    expect((await post(manager, `/iam/grants/${own}/revoke`, { reason: 'Self' })).status).toBe(403);
    const direct = database
      .pool('app')
      .query("UPDATE iam.role_grant SET deleted_at = now(), deleted_by = principal_id, delete_reason = 'self', version = version + 1 WHERE id = $1", [own]);
    expect(await sqlStateOf(direct)).toBe('23514');
  });

  it('a Manager cannot revoke an Owner grant: the role holds permissions the Manager does not hold', async () => {
    const ownerGrant = (await admin().query<{ id: string }>('SELECT id FROM iam.role_grant WHERE principal_id = $1 AND branch_id = $2', [ownerId, ddw])).rows[0]!.id;
    const refused = await post(manager, `/iam/grants/${ownerGrant}/revoke`, { reason: 'Coup' });
    expect(refused.status).toBe(403);
    expect((await admin().query('SELECT 1 FROM iam.role_grant WHERE id = $1 AND deleted_at IS NULL', [ownerGrant])).rowCount).toBe(1);
  });
});

describe('disabling, enabling, unlocking and resetting (FR-IAM-015, FR-IAM-017)', () => {
  it('disabling revokes every session at once and login fails generically; enabling restores login', async () => {
    const user = await createUser(database, { name: 'Akua Disable', grants: [{ role: 'SALES', branchId: ddw }] });
    const sessions = [await login(api.server, user), await login(api.server, user)];
    const disabled = await post(manager, `/iam/users/${user.principalId}/disable`, { reason: 'Left the business' });
    expect(disabled.status).toBe(200);
    expect(disabled.body.status).toBe('DISABLED');
    for (const session of sessions) expect((await get(session, '/products')).status).toBe(401);
    expect((await loginAs(user.identifier, user.password)).status).toBe(401);
    expect((await post(manager, `/iam/users/${user.principalId}/disable`, { reason: 'Again' })).body.error.code).toBe('INVALID_STATE_TRANSITION');
    const enabled = await post(manager, `/iam/users/${user.principalId}/enable`, { reason: 'Came back' });
    expect(enabled.body.status).toBe('ACTIVE');
    expect((await loginAs(user.identifier, user.password)).body.status).toBe('AUTHENTICATED');
  });

  it('nobody disables, unlocks or resets themselves', async () => {
    for (const action of ['disable', 'unlock', 'reset-password']) {
      const response = await post(manager, `/iam/users/${managerId}/${action}`, { reason: 'Self' });
      expect(response.status, action).toBe(403);
    }
  });

  it('unlocking clears a lockout at once', async () => {
    const user = await createUser(database, { name: 'Yaa Locked', grants: [{ role: 'SALES', branchId: ddw }] });
    for (let attempt = 0; attempt < 5; attempt += 1) await loginAs(user.identifier, 'wrong-password-here');
    expect((await loginAs(user.identifier, user.password)).status).not.toBe(200);
    expect((await get(manager, `/iam/users/${user.principalId}`)).body.status).toBe('LOCKED');
    const unlocked = await post(manager, `/iam/users/${user.principalId}/unlock`, { reason: 'Forgot the password' });
    expect(unlocked.body.status).toBe('ACTIVE');
    expect((await loginAs(user.identifier, user.password)).body.status).toBe('AUTHENTICATED');
  });

  it('a password reset gives a temporary password once, revokes every session, and forces a change at next sign-in', async () => {
    const user = await createUser(database, { name: 'Kwame Reset', grants: [{ role: 'SALES', branchId: ddw }] });
    const session = await login(api.server, user);
    const key = randomUUID();
    const reset = await post(owner, `/iam/users/${user.principalId}/reset-password`, { reason: 'Lost it' }, key);
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ temporaryPassword: expect.stringMatching(/^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/) });
    expect((await post(owner, `/iam/users/${user.principalId}/reset-password`, { reason: 'Lost it' }, key)).body).toEqual(reset.body);
    expect((await get(session, '/products')).status).toBe(401);
    expect((await loginAs(user.identifier, user.password)).status).toBe(401);
    expect((await loginAs(user.identifier, reset.body.temporaryPassword)).body.status).toBe('PASSWORD_CHANGE_REQUIRED');
  });
});

describe('roles and permissions read (FR-IAM-008)', () => {
  it('lists the ten system roles with their permissions, and every permission with its step-up flag', async () => {
    const roles = await get(owner, '/iam/roles?limit=100');
    expect(roles.body.data.map((role: { code: string }) => role.code).sort()).toEqual(['ACCOUNTANT', 'CASHIER', 'CUSTOMER', 'DRIVER', 'FARM_HAND', 'INVESTOR', 'MANAGER', 'OWNER', 'SALES', 'STOREKEEPER']);
    const ownerRole = (await get(owner, `/iam/roles/${ROLE_IDS.OWNER}`)).body;
    expect(ownerRole).toMatchObject({ code: 'OWNER', isSystem: true, requiresTotp: true });
    expect(ownerRole.permissions).toContain('iam.grant.manage');
    const permissions = await get(owner, '/iam/permissions?module=iam&limit=100');
    const grantManage = permissions.body.data.find((row: { code: string }) => row.code === 'iam.grant.manage');
    expect(grantManage).toEqual({ code: 'iam.grant.manage', module: 'iam', description: expect.any(String), requiresStepUp: true });
    const firstPage = await get(owner, '/iam/permissions?limit=2');
    expect(firstPage.body.page.hasMore).toBe(true);
    const second = await get(owner, `/iam/permissions?limit=2&cursor=${encodeURIComponent(firstPage.body.page.nextCursor)}`);
    expect(second.body.data[0].code > firstPage.body.data[1].code).toBe(true);
  });

  it('every Cashier and Storekeeper permission is also a Manager permission, so a Manager can grant those roles', async () => {
    const { rows } = await admin().query<{ code: string }>(
      `SELECT DISTINCT rp.permission_code AS code FROM iam.role_permission rp JOIN iam.role r ON r.id = rp.role_id
        WHERE r.code IN ('CASHIER', 'STOREKEEPER', 'SALES', 'FARM_HAND', 'DRIVER')
       EXCEPT SELECT rp.permission_code FROM iam.role_permission rp JOIN iam.role r ON r.id = rp.role_id WHERE r.code = 'MANAGER'`,
    );
    expect(rows).toEqual([]);
  });
});

describe('step-up (FR-IAM-007)', () => {
  it('refuses createUser, resetUserPassword and createGrant without a step-up in the last five minutes, and accepts them after one', async () => {
    clock.advanceBy(301_000);
    const target = await createUser(database, { name: 'Step Up Target', grants: [{ role: 'SALES', branchId: ddw }] });
    for (const [path, body] of [
      ['/iam/users', newStaff()],
      [`/iam/users/${target.principalId}/reset-password`, { reason: 'Step-up' }],
      ['/iam/grants', { principalId: target.principalId, roleId: ROLE_IDS.DRIVER, branchId: ddw }],
    ] as const) {
      const stale = await post(owner, path, body);
      expect(stale.status, path).toBe(403);
      expect(stale.body.error.code, path).toBe('STEP_UP_REQUIRED');
    }
    clock.advanceBy(30_000);
    const stepped = await post(owner, '/auth/step-up', { code: totpAt(owner.secret, Math.floor(clock.now().getTime() / 1000)) });
    expect(stepped.status).toBe(200);
    expect((await post(owner, '/iam/grants', { principalId: target.principalId, roleId: ROLE_IDS.DRIVER, branchId: ddw })).status).toBe(201);
  });
});
