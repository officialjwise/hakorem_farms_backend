import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, relaxRateLimits, ROLE_IDS, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B04e user, role and grant operations answer in the shapes of contract/openapi.yaml 1.10.0. */
let database: TestDatabase;
let api: TestApp;
let owner: TestSession;
let branchId: string;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

const post = (path: string, body: object) => consolePost(api.server, owner, `/v1${path}`, randomUUID()).send(body);
const get = (path: string) => consoleGet(api.server, owner, `/v1${path}`);

beforeAll(async () => {
  database = await createTestDatabase();
  const clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  ({ branchId } = await createBranch(database));
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Abena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('user, role and grant administration in the contract shapes', () => {
  it('createUser, getUser, listUsers, updateUser, disableUser, enableUser, unlockUser and resetUserPassword', async () => {
    const created = await post('/iam/users', { displayName: 'Kojo Asante', email: 'kojo.asante@hakoremfarms.test', phone: '+233200009901', realm: 'STAFF', grants: [{ roleId: ROLE_IDS.SALES, branchId }] });
    expect(created.status).toBe(201);
    expectShape('UserCreated', created.body);
    const id = created.body.user.id as string;
    expectShape('UserAccount', (await get(`/iam/users/${id}`)).body);
    expectShape('UserAccountPage', (await get('/iam/users?realm=STAFF&status=ACTIVE&q=kojo')).body);
    const updated = await request(api.server)
      .patch(`/v1/iam/users/${id}`)
      .set('Cookie', owner.jar.header())
      .set('X-CSRF-Token', owner.csrfToken)
      .set('Origin', TEST_ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({ version: created.body.user.version, displayName: 'Kojo Asante Mensah' });
    expect(updated.status).toBe(200);
    expectShape('UserAccount', updated.body);
    for (const action of ['disable', 'enable', 'unlock']) {
      const response = await post(`/iam/users/${id}/${action}`, { reason: 'Contract check' });
      expect(response.status, action).toBe(200);
      expectShape('UserAccount', response.body);
    }
    const reset = await post(`/iam/users/${id}/reset-password`, { reason: 'Contract check' });
    expectShape('TemporaryPassword', reset.body);
  });

  it('listRoles, getRole and listPermissions', async () => {
    expectShape('RolePage', (await get('/iam/roles')).body);
    expectShape('Role', (await get(`/iam/roles/${ROLE_IDS.MANAGER}`)).body);
    expectShape('PermissionPage', (await get('/iam/permissions?module=iam')).body);
  });

  it('createGrant, listGrants and revokeGrant', async () => {
    const user = await createUser(database, { name: 'Efua Grant' });
    const granted = await post('/iam/grants', { principalId: user.principalId, roleId: ROLE_IDS.DRIVER, branchId });
    expect(granted.status).toBe(201);
    expectShape('RoleGrant', granted.body);
    expectShape('RoleGrantPage', (await get(`/iam/grants?principalId=${user.principalId}`)).body);
    const revoked = await post(`/iam/grants/${granted.body.id}/revoke`, { reason: 'Contract check' });
    expectShape('RoleGrant', revoked.body);
  });
});
