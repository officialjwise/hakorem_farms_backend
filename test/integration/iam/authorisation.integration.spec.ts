import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATION_METADATA, type OperationSpec } from '../../../src/platform/http/operation';
import {
  consoleGet,
  consolePost,
  createBranch,
  createUser,
  enrolAndLogin,
  login,
  relaxRateLimits,
  testStartTime,
  type RoleCode,
  type TestBranch,
} from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

interface RouteInfo {
  readonly method: string;
  readonly path: string;
  readonly handler: string;
  readonly spec: OperationSpec | undefined;
}

let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let dodowa: TestBranch;
let routes: RouteInfo[];

/** Every route of every controller the application mounted, with the operation it declares. */
function registeredRoutes(): RouteInfo[] {
  const found: RouteInfo[] = [];
  for (const module of api.app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const type = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (type === null) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, type) ?? '');
      for (const name of Object.getOwnPropertyNames(type.prototype)) {
        const handler = (type.prototype as Record<string, unknown>)[name];
        if (name === 'constructor' || typeof handler !== 'function' || Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number]!;
        const path = `/v1/${[base, String(Reflect.getMetadata(PATH_METADATA, handler))].filter((p) => p !== '' && p !== '/').join('/')}`.replace(/\/+/g, '/');
        found.push({ method, path, handler: `${type.name}.${name}`, spec: Reflect.getMetadata(OPERATION_METADATA, handler) as OperationSpec | undefined });
      }
    }
  }
  return found;
}

/** A body that passes validation for each state-changing operation, so the refusal seen is the permission's. */
const VALID_BODY: Readonly<Record<string, object>> = {
  createProduct: { sku: 'MEAT-GOAT-5KG', name: 'Goat meat, 5 kg pack', categoryId: randomUUID(), stockPolicy: 'CATCH_WEIGHT', baseUom: 'KG', saleUom: 'PACK', onlineMode: 'LISTED' },
  revokeSession: { reason: 'Tablet left unattended overnight' },
};

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  dodowa = await createBranch(database);
  routes = registeredRoutes();
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('deny by default: the handler walk (ADR-0017, security architecture section 14)', () => {
  it('finds the B3 routes, and every one declares its operation', () => {
    expect(routes.map((route) => route.spec?.operationId).sort()).toEqual(
      [
        'changePassword', 'confirmTotpEnrolment', 'createProduct', 'getCurrentSession', 'getHealth', 'getProduct', 'listProducts', 'listSessions',
        'loginCustomer', 'loginInvestor', 'loginStaff', 'logout', 'refreshSession', 'revokeSession', 'startTotpEnrolment', 'stepUp', 'verifyTotp',
      ].sort(),
    );
    expect(routes.filter((route) => route.spec === undefined).map((route) => route.handler)).toEqual([]);
  });

  it('declares a permission on every staff operation that is not on the caller\'s own account or public', () => {
    const own = new Set(['logout', 'getCurrentSession', 'changePassword', 'startTotpEnrolment', 'confirmTotpEnrolment', 'stepUp']);
    for (const route of routes) {
      const spec = route.spec!;
      if (spec.access === 'PUBLIC' || own.has(spec.operationId)) {
        expect(spec.permission, spec.operationId).toBeNull();
      } else {
        expect(spec.permission, spec.operationId).toMatch(/^[a-z]+\.[a-z_]+\.[a-z_.]+$/);
      }
    }
  });

  it('refuses a staff user who holds no grant on every permissioned operation, with 403 FORBIDDEN', async () => {
    const nobody = await createUser(database, { name: 'Kwame Nkansah' });
    const session = await login(api.server, nobody);
    const guarded = routes.filter((route) => route.spec?.permission !== null && route.spec?.permission !== undefined);
    expect(guarded.length).toBeGreaterThanOrEqual(5);
    for (const route of guarded) {
      const path = route.path.replace(/:[a-zA-Z]+/g, randomUUID());
      const response =
        route.method === 'GET'
          ? await consoleGet(api.server, session, path)
          : await consolePost(api.server, session, path).send(VALID_BODY[route.spec!.operationId] ?? {});
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      expect(response.body.error.code, route.path).toBe('FORBIDDEN');
    }
  });

  it('audits each refusal on its own connection, so it survives the refused command\'s rollback', async () => {
    const { rows } = await database
      .pool('admin')
      .query<{ permission: string; reason: string }>(
        "SELECT metadata->>'permission' AS permission, metadata->>'reason' AS reason FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'",
      );
    expect(rows.map((row) => row.permission)).toEqual(expect.arrayContaining(['mdm.product.read', 'mdm.product.create', 'iam.session.read', 'iam.session.revoke']));
    expect(new Set(rows.map((row) => row.reason))).toEqual(new Set(['NO_GRANT']));
  });
});

describe('the seeded roles (ADR-0017: a test per role that a forbidden action is refused)', () => {
  const withoutCreate: RoleCode[] = ['ACCOUNTANT', 'STOREKEEPER', 'CASHIER', 'SALES', 'FARM_HAND', 'DRIVER'];

  for (const role of withoutCreate) {
    it(`refuses a ${role} who tries to create a product`, async () => {
      const user = await createUser(database, { name: `Test ${role}`, grants: [{ role, branchId: dodowa.branchId }] });
      const session = role === 'ACCOUNTANT' ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user);
      expect((await consoleGet(api.server, session, '/v1/products')).status).toBe(200);
      const created = await consolePost(api.server, session, '/v1/products').send(VALID_BODY['createProduct']);
      expect(created.status).toBe(403);
      expect(created.body.error.code).toBe('FORBIDDEN');
    });
  }

  it('refuses investors and customers at every staff operation, because their sessions are of another realm', async () => {
    for (const realm of ['INVESTOR', 'CUSTOMER'] as const) {
      const user = await createUser(database, { name: `Test ${realm}`, realm });
      const session = await login(api.server, user);
      expect((await consoleGet(api.server, session, '/v1/products')).status).toBe(401);
      expect((await consoleGet(api.server, session, '/v1/iam/sessions')).status).toBe(401);
    }
  });
});

describe('the device list and forced logout (ADR-0016, FR-IAM-016)', () => {
  it('lets a cashier list their own sessions and refuses them anyone else\'s', async () => {
    const cashier = await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId: dodowa.branchId, locationId: dodowa.shopId }] });
    const other = await createUser(database, { name: 'Kofi Boadu', grants: [{ role: 'CASHIER', branchId: dodowa.branchId }] });
    const session = await login(api.server, cashier, 'Shop till tablet');
    await login(api.server, cashier, 'Adwoa phone');
    const own = await consoleGet(api.server, session, '/v1/iam/sessions');
    expect(own.status).toBe(200);
    expect(own.body.data.map((row: { deviceLabel: string }) => row.deviceLabel).sort()).toEqual(['Adwoa phone', 'Shop till tablet']);
    expect(own.body.data.filter((row: { current: boolean }) => row.current)).toHaveLength(1);
    expect(own.body.page).toEqual({ nextCursor: null, limit: 25, hasMore: false });
    const theirs = await consoleGet(api.server, session, `/v1/iam/sessions?principalId=${other.principalId}`);
    expect(theirs.status).toBe(403);
  });

  it('pages the device list with a signed cursor that refuses tampering', async () => {
    const cashier = await createUser(database, { name: 'Ama Owusu', grants: [{ role: 'CASHIER', branchId: dodowa.branchId }] });
    const session = await login(api.server, cashier);
    await login(api.server, cashier);
    await login(api.server, cashier);
    const first = await consoleGet(api.server, session, '/v1/iam/sessions?limit=2');
    expect(first.body.data).toHaveLength(2);
    expect(first.body.page.hasMore).toBe(true);
    const second = await consoleGet(api.server, session, `/v1/iam/sessions?limit=2&cursor=${encodeURIComponent(first.body.page.nextCursor)}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.page).toEqual({ nextCursor: null, limit: 2, hasMore: false });
    const tampered = `${first.body.page.nextCursor.slice(0, -2)}xx`;
    const refused = await consoleGet(api.server, session, `/v1/iam/sessions?limit=2&cursor=${encodeURIComponent(tampered)}`);
    expect(refused.status).toBe(400);
    expect(refused.body.error.details[0].field).toBe('/cursor');
  });

  it('lets a manager revoke a cashier\'s session, which then fails on its next request, and replays the revoke once', async () => {
    const manager = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId: dodowa.branchId }] });
    const cashier = await createUser(database, { name: 'Efua Mensah', grants: [{ role: 'CASHIER', branchId: dodowa.branchId }] });
    const managerSession = await enrolAndLogin(api.server, manager, () => clock.now());
    const cashierSession = await login(api.server, cashier);
    expect((await consoleGet(api.server, cashierSession, '/v1/products')).status).toBe(200);

    const key = randomUUID();
    const revoke = () => consolePost(api.server, managerSession, `/v1/iam/sessions/${cashierSession.sessionId}/revoke`, key).send({ reason: 'Tablet left unattended overnight' });
    expect((await revoke()).status).toBe(204);
    expect((await consoleGet(api.server, cashierSession, '/v1/products')).status).toBe(401);
    expect((await revoke()).status).toBe(204);
    const changed = await consolePost(api.server, managerSession, `/v1/iam/sessions/${cashierSession.sessionId}/revoke`, key).send({ reason: 'A different reason' });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const { rows } = await database.pool('admin').query<{ revoke_reason: string; revoked_by: string }>('SELECT revoke_reason, revoked_by FROM iam.session WHERE id = $1', [
      cashierSession.sessionId,
    ]);
    expect(rows[0]).toEqual({ revoke_reason: 'Tablet left unattended overnight', revoked_by: manager.principalId });
  });

  it('refuses a state change with no Idempotency-Key, before doing anything', async () => {
    const cashier = await createUser(database, { name: 'Kojo Asare', grants: [{ role: 'CASHIER', branchId: dodowa.branchId }] });
    const session = await login(api.server, cashier);
    const response = await request(api.server)
      .post(`/v1/iam/sessions/${session.sessionId}/revoke`)
      .set('Cookie', session.jar.header())
      .set('Origin', TEST_ORIGIN)
      .set('X-CSRF-Token', session.csrfToken)
      .send({ reason: 'Lost phone' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await consoleGet(api.server, session, '/v1/auth/session')).status).toBe(200);
  });
});
