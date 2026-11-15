import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Approvals } from '../../../src/modules/iam';
import { runWithRequestContext } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { createCatalogue, TAX_CATEGORY } from '../../support/catalogue';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The promotion operations (B04d) answer in the shapes of contract/openapi.yaml 1.6.0. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let ownerId: string;
let branchId: string;
let productId: string;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

function approve(approvalId: string) {
  const owner = { principalId: ownerId, kind: 'USER' as const, displayName: 'Kwabena Owusu', realm: 'STAFF' as const, sessionId: null, steppedUpAt: clock.now() };
  return runWithRequestContext({ correlationId: randomUUID(), ip: '127.0.0.1', userAgent: 'test', actor: owner }, () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable' }, (tx) => api.app.get(Approvals).decide(tx, owner, approvalId, 'APPROVED', null)),
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  ({ branchId } = await createBranch(database));
  const catalogue = await createCatalogue(database);
  productId = randomUUID();
  await database
    .pool('app')
    .query(
      `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by)
       VALUES ($1, 'EGG-CRATE-BIG', 'Eggs, big, crate of 30', $2, 'COUNTABLE', 'NONE', 'CRATE', 'CRATE', $3, 'PRODUCE_EGGS', 'LISTED', 'ACTIVE', $4, $4)`,
      [productId, catalogue.eggsCategoryId, TAX_CATEGORY.EGGS, SYSTEM_PRINCIPAL],
    );
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  const owner = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] });
  await enrolAndLogin(api.server, owner, () => clock.now());
  ownerId = owner.principalId;
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('promotion operations answer in the contract shapes', () => {
  it('the promotion lifecycle, its coupons, coupon validation and a resolved line with its discount', async () => {
    const created = await consolePost(api.server, manager, '/v1/promotions').send({
      code: 'EGGS-WEEK',
      name: 'Egg week, 10% off a crate',
      kind: 'PERCENT_OFF',
      percentOff: '10',
      appliesTo: 'LINE',
      requiresCoupon: true,
      validFrom: clock.now().toISOString(),
      validTo: new Date(clock.now().getTime() + 7 * 86_400_000).toISOString(),
      targets: [{ productId }],
    });
    expect(created.status).toBe(201);
    expectShape('Promotion', created.body);
    const changed = await request(api.server)
      .patch(`/v1/promotions/${created.body.id}`)
      .set('Cookie', manager.jar.header())
      .set('X-CSRF-Token', manager.csrfToken)
      .set('Origin', TEST_ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({ version: 1, name: 'Egg week' });
    expectShape('Promotion', changed.body);
    const invalid = await consolePost(api.server, manager, '/v1/promotions').send({ code: 'BAD-1', name: 'Bad', kind: 'AMOUNT_OFF', appliesTo: 'LINE', validFrom: clock.now().toISOString(), validTo: clock.now().toISOString() });
    expect(invalid.status).toBe(422);
    expectShape('Error', invalid.body);
    const submitted = await consolePost(api.server, manager, `/v1/promotions/${created.body.id}/submit`).send({});
    expect(submitted.status).toBe(202);
    expectShape('ApprovalPending', submitted.body);
    await approve(submitted.body.approvalRequestId);
    expectShape('Promotion', (await consoleGet(api.server, manager, `/v1/promotions/${created.body.id}`)).body);
    expectShape('PromotionPage', (await consoleGet(api.server, manager, '/v1/promotions?status=ACTIVE')).body);

    const coupon = await consolePost(api.server, manager, `/v1/promotions/${created.body.id}/coupons`).send({ code: 'EGGS10', maxUses: 50 });
    expect(coupon.status).toBe(201);
    expectShape('Coupon', coupon.body);
    expectShape('CouponPage', (await consoleGet(api.server, manager, `/v1/promotions/${created.body.id}/coupons`)).body);
    expectShape('CouponValidation', (await request(api.server).post('/v1/coupons/validate').send({ code: 'EGGS10' })).body);
    expectShape('CouponValidation', (await request(api.server).post('/v1/coupons/validate').send({ code: 'NOPE-NOPE' })).body);

    const resolved = await consolePost(api.server, manager, '/v1/pricing/resolve').send({ channel: 'POS', branchId, couponCode: 'EGGS10', lines: [{ lineRef: 'e1', productId, quantity: '2.000' }] });
    expect(resolved.status).toBe(200);
    expectShape('PriceResolveResult', resolved.body);

    const ended = await consolePost(api.server, manager, `/v1/promotions/${created.body.id}/end`).send({ reason: 'Egg week over early' });
    expect(ended.status).toBe(200);
    expectShape('Promotion', ended.body);
    const unavailable = await consolePost(api.server, manager, '/v1/pricing/resolve').send({ channel: 'POS', branchId, couponCode: 'EGGS10', lines: [{ lineRef: 'e1', productId, quantity: '2.000' }] });
    expect(unavailable.status).toBe(422);
    expectShape('Error', unavailable.body);
  });
});
