import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { loadFragments } from '../../../scripts/contract/code-document';
import {
  LoginRequest,
  PasswordChangeRequest,
  ReasonRequest,
  StepUpRequest,
  TotpCodeRequest,
  TotpEnrolmentStart,
  TotpVerifyRequest,
} from '../../../src/modules/iam/interface/schemas';
import { ProductCreate } from '../../../src/modules/mdm/interface/schemas';
import { createCatalogue, type TestCatalogue } from '../../support/catalogue';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let catalogue: TestCatalogue;
let manager: TestSession;
let cashier: TestSession;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  const dodowa = await createBranch(database);
  catalogue = await createCatalogue(database);
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId: dodowa.branchId }] }), () => clock.now());
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId: dodowa.branchId, locationId: dodowa.shopId }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

describe('the implemented operations answer in the shapes of contract/openapi.yaml', () => {
  it('loginStaff, getCurrentSession and refreshSession return LoginResult and SessionInfo', async () => {
    const user = await createUser(database, { name: 'Akua Mensah', grants: [] });
    const response = await request(api.server).post('/v1/auth/staff/login').set('Origin', TEST_ORIGIN).send({ identifier: user.identifier, password: user.password });
    expectShape('LoginResult', response.body);
    expectShape('SessionInfo', (await consoleGet(api.server, cashier, '/v1/auth/session')).body);
    const refreshed = await request(api.server).post('/v1/auth/refresh').set('Origin', TEST_ORIGIN).set('Cookie', manager.jar.header());
    expectShape('SessionInfo', refreshed.body);
    manager.jar.store(refreshed.headers['set-cookie']);
  });

  it('a challenge step returns LoginResult with a challenge and no session', async () => {
    const owner = await createUser(database, { name: 'Esi Bonsu', grants: [{ role: 'OWNER', branchId: (await createBranch(database, 'KSA')).branchId }] });
    const response = await request(api.server).post('/v1/auth/staff/login').set('Origin', TEST_ORIGIN).send({ identifier: owner.identifier, password: owner.password });
    expect(response.body.status).toBe('TOTP_ENROLMENT_REQUIRED');
    expectShape('LoginResult', response.body);
    const started = await request(api.server).post('/v1/auth/totp/enrol').set('Origin', TEST_ORIGIN).send({ challengeToken: response.body.challengeToken });
    expectShape('TotpEnrolment', started.body);
  });

  it('listSessions returns SessionRecordPage', async () => {
    expectShape('SessionRecordPage', (await consoleGet(api.server, cashier, '/v1/iam/sessions')).body);
  });

  it('createProduct, getProduct and listProducts return Product and ProductPage', async () => {
    const created = await consolePost(api.server, manager, '/v1/products').send({
      sku: 'MEAT-BEEF-15KG',
      name: 'Beef, 15 kg pack',
      categoryId: catalogue.meatCategoryId,
      stockPolicy: 'CATCH_WEIGHT',
      baseUom: 'KG',
      saleUom: 'PACK',
      nominalPackKg: '15.000',
      storageTempClass: 'FROZEN',
      onlineMode: 'LISTED',
    });
    expect(created.status).toBe(201);
    expectShape('Product', created.body);
    expectShape('Product', (await consoleGet(api.server, cashier, `/v1/products/${created.body.id}`)).body);
    expectShape('ProductPage', (await consoleGet(api.server, cashier, '/v1/products')).body);
  });

  it('every refusal on these operations uses the Error envelope', async () => {
    const responses = [
      await request(api.server).post('/v1/auth/staff/login').send({ identifier: 'nobody@hakoremfarms.test', password: 'x' }),
      await request(api.server).get('/v1/products'),
      await consolePost(api.server, cashier, '/v1/products').send({ sku: 'X' }),
      await consolePost(api.server, cashier, `/v1/iam/sessions/${randomUUID()}/revoke`).send({ reason: 'x' }),
      await consoleGet(api.server, cashier, `/v1/products/${randomUUID()}`),
    ];
    // A cashier may revoke sessions, so an unknown session is 404, not 403.
    expect(responses.map((r) => r.status)).toEqual([401, 401, 400, 404, 404]);
    for (const response of responses) {
      expectShape('Error', response.body);
      expect(response.body.error.correlationId).toBe(response.headers['x-correlation-id']);
    }
  });
});

describe('request schemas in code and contract agree (ADR-0031)', () => {
  const fragments = loadFragments(`${__dirname}/../../../src`);
  const SCHEMAS: Readonly<Record<string, z.ZodType>> = {
    loginStaff: LoginRequest,
    loginCustomer: LoginRequest,
    loginInvestor: LoginRequest,
    verifyTotp: TotpVerifyRequest,
    changePassword: PasswordChangeRequest,
    startTotpEnrolment: TotpEnrolmentStart,
    confirmTotpEnrolment: TotpCodeRequest,
    stepUp: StepUpRequest,
    revokeSession: ReasonRequest,
    createProduct: ProductCreate,
  };

  it('parses every request example of an implemented operation with the schema its route validates with', () => {
    let checked = 0;
    for (const [operationId, { operation }] of fragments) {
      const body = (operation['requestBody'] as { content?: Record<string, { example?: unknown }> } | undefined)?.content?.['application/json'];
      if (body?.example === undefined) {
        continue;
      }
      const schema = SCHEMAS[operationId];
      expect(schema, `${operationId} has a request example but no schema in this test`).toBeDefined();
      const parsed = schema!.safeParse(body.example);
      expect(parsed.success, `${operationId}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it('refuses in code a request the contract refuses: an unknown field', () => {
    expect(ProductCreate.safeParse({ ...{ sku: 'LIV-GOAT', name: 'Goat', categoryId: randomUUID(), stockPolicy: 'SERIALISED', baseUom: 'HEAD', saleUom: 'HEAD', onlineMode: 'HIDDEN' }, price: 1 }).success).toBe(false);
    const validate = contractSchema('ProductCreate');
    expect(validate({ sku: 'LIV-GOAT', name: 'Goat', categoryId: randomUUID(), stockPolicy: 'SERIALISED', baseUom: 'HEAD', saleUom: 'HEAD', onlineMode: 'HIDDEN', price: 1 })).toBe(false);
  });
});
