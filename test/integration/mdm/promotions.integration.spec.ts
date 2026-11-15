import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { Approvals } from '../../../src/modules/iam';
import { couponLockKey, Promotions } from '../../../src/modules/mdm';
import { createCatalogue, TAX_CATEGORY } from '../../support/catalogue';
import {
  consoleGet,
  consolePost,
  createBranch,
  createUser,
  enrolAndLogin,
  login,
  relaxRateLimits,
  SYSTEM_PRINCIPAL,
  testStartTime,
  type TestSession,
} from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * FR-MDM-018 through the API and MDM's door: promotions drafted, approved by a second user and applied after the
 * base price by their stacking rules; coupons validated and redeemed within their limit under concurrency.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
let manager: TestSession;
let managerActor: Actor;
let otherManagerActor: Actor;
let ownerActor: Actor;
let sales: TestSession;
let cashier: TestSession;
let broilerId: string;
let poultryId: string;
let catererId: string;
let liveCategoryId: string;

const actor = (principalId: string, displayName: string, steppedUpAt: Date | null): Actor => ({
  principalId,
  kind: 'USER',
  displayName,
  realm: 'STAFF',
  sessionId: null,
  steppedUpAt,
});

function decide(who: Actor, approvalId: string, decision: 'APPROVED' | 'REJECTED' = 'APPROVED') {
  return runWithRequestContext({ correlationId: randomUUID(), ip: '127.0.0.1', userAgent: 'test', actor: who }, () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable' }, (tx) => api.app.get(Approvals).decide(tx, who, approvalId, decision, decision === 'REJECTED' ? 'Not this season' : null)),
  );
}

const post = (session: TestSession, path: string, body: object, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const put = (session: TestSession, path: string, body: object) =>
  request(api.server)
    .put(`/v1${path}`)
    .set('Cookie', session.jar.header())
    .set('X-CSRF-Token', session.csrfToken)
    .set('Origin', TEST_ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .send(body);
const patch = (session: TestSession, path: string, body: object) =>
  request(api.server)
    .patch(`/v1${path}`)
    .set('Cookie', session.jar.header())
    .set('X-CSRF-Token', session.csrfToken)
    .set('Origin', TEST_ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .send(body);
/** Ten broilers at GHS 180.00 a head: a line of 180,000 pesewas at list. */
const resolveBroilers = (body: object = {}) =>
  post(manager, '/pricing/resolve', { channel: 'POS', branchId, lines: [{ lineRef: 'b1', productId: broilerId, quantity: '10.000' }], ...body });

let codeSeq = 0;
function promotionBody(fields: object = {}) {
  codeSeq += 1;
  return {
    code: `PROMO-${codeSeq}`,
    name: `Promotion ${codeSeq}`,
    kind: 'PERCENT_OFF',
    percentOff: '5',
    appliesTo: 'LINE',
    validFrom: new Date(clock.now().getTime() - 3_600_000).toISOString(),
    validTo: new Date(clock.now().getTime() + 30 * 86_400_000).toISOString(),
    targets: [{ productId: broilerId }],
    ...fields,
  };
}

/** Drafted by the manager, approved by the owner: an ACTIVE promotion. */
async function activePromotion(fields: object = {}): Promise<{ id: string; code: string }> {
  const created = await post(manager, '/promotions', promotionBody(fields));
  expect(created.status).toBe(201);
  const submitted = await post(manager, `/promotions/${created.body.id}/submit`, {});
  expect(submitted.status).toBe(202);
  await decide(ownerActor, submitted.body.approvalRequestId);
  return { id: created.body.id, code: created.body.code };
}

async function endPromotion(id: string): Promise<void> {
  expect((await post(manager, `/promotions/${id}/end`, { reason: 'Test finished' })).status).toBe(200);
}

/** A price list with one broiler entry, drafted by the manager and approved by the owner. */
async function activeList(body: object, listPricePesewas: number): Promise<string> {
  const list = await post(manager, '/price-lists', body);
  const version = await post(manager, `/price-lists/${list.body.id}/versions`, { validFrom: clock.now().toISOString() });
  await put(manager, `/price-list-versions/${version.body.id}/entries`, {
    version: 1,
    entries: [
      { productId: broilerId, basis: 'PER_HEAD', listPricePesewas, floorPricePesewas: listPricePesewas - 2_000, ceilingPricePesewas: listPricePesewas + 2_000 },
    ],
  });
  const submitted = await post(manager, `/price-list-versions/${version.body.id}/submit`, {});
  await decide(ownerActor, submitted.body.approvalRequestId);
  return list.body.id;
}

/** A business document the redemption belongs to, as an order is in B9a. */
async function order(): Promise<string> {
  const id = randomUUID();
  await database
    .pool('app')
    .query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'FIXTURE_ORDER', 'ord', $2, $3)", [
      id,
      branchId,
      SYSTEM_PRINCIPAL,
    ]);
  return id;
}

function redeem(code: string, sourceDocumentId: string, customerId: string | null = null) {
  // As a selling module does: the coupon's lock first, then one serializable transaction.
  return api.app
    .get(UnitOfWork)
    .run({ isolation: 'serializable', seriesLocks: [couponLockKey(code)] }, (tx) =>
      api.app.get(Promotions).redeemIn(tx, { code, customerId, sourceDocumentId, amountPesewas: 9_000n, actorId: SYSTEM_PRINCIPAL }),
    );
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  ({ branchId } = await createBranch(database));
  const catalogue = await createCatalogue(database);
  liveCategoryId = catalogue.liveCategoryId;
  const app = database.pool('app');
  // Poultry sits under the live animals category, so a promotion on "Live animals" covers it.
  poultryId = randomUUID();
  await app.query(
    "INSERT INTO mdm.category (id, parent_id, code, name, product_line, gl_group, tax_category_id, created_by, updated_by) VALUES ($1, $2, 'POULTRY', 'Poultry', 'LIVE', 'LIVE_ANIMALS', $3, $4, $4)",
    [poultryId, catalogue.liveCategoryId, TAX_CATEGORY.LIVE_ANIMALS, SYSTEM_PRINCIPAL],
  );
  broilerId = randomUUID();
  await app.query(
    `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by)
     VALUES ($1, 'LIV-BROILER', 'Broiler chicken', $2, 'COUNTABLE', 'NONE', 'HEAD', 'HEAD', $3, 'LIVE_ANIMALS', 'LISTED', 'ACTIVE', $4, $4)`,
    [broilerId, poultryId, TAX_CATEGORY.LIVE_ANIMALS, SYSTEM_PRINCIPAL],
  );
  catererId = randomUUID();
  await app.query(
    "INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by) VALUES ($1, 'C-10001', 'BUSINESS', 'Asantewaa Catering', '01900000-0000-7000-8000-000000000302', 'ACTIVE', $2, $2)",
    [catererId, SYSTEM_PRINCIPAL],
  );
  await database
    .pool('admin')
    .query(
      "INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES ('FIXTURE_ORDER', 'ord', 'Fixture order', false, NULL)",
    );

  const managerUser = await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] });
  manager = await enrolAndLogin(api.server, managerUser, () => clock.now());
  managerActor = actor(managerUser.principalId, 'Akosua Boateng', clock.now());
  const otherManager = await createUser(database, { name: 'Yaw Mensah', grants: [{ role: 'MANAGER', branchId }] });
  await enrolAndLogin(api.server, otherManager, () => clock.now());
  otherManagerActor = actor(otherManager.principalId, 'Yaw Mensah', clock.now());
  const ownerUser = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] });
  await enrolAndLogin(api.server, ownerUser, () => clock.now());
  ownerActor = actor(ownerUser.principalId, 'Kwabena Owusu', clock.now());
  sales = await login(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'SALES', branchId }] }));
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId }] }));

  await activeList({ code: 'BASE', name: 'Base prices', kind: 'BASE', taxInclusive: true }, 18_000);
  const contract = await activeList({ code: 'CATERERS-2026', name: 'Caterers 2026', kind: 'CUSTOMER', taxInclusive: true }, 17_000);
  await app.query('INSERT INTO mdm.customer_price_list (id, customer_id, price_list_id, valid_from, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5)', [
    randomUUID(),
    catererId,
    contract,
    new Date(clock.now().getTime() - 86_400_000),
    SYSTEM_PRINCIPAL,
  ]);
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the promotion lifecycle', () => {
  it('creates a draft, changes it, and refuses a value that does not fit its kind', async () => {
    const created = await post(manager, '/promotions', promotionBody({ code: 'xmas-chicken', name: 'Christmas chicken' }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      code: 'XMAS-CHICKEN',
      status: 'DRAFT',
      kind: 'PERCENT_OFF',
      percentOff: '5.00',
      amountOffPesewas: null,
      stackGroup: 'DEFAULT',
      isExclusive: false,
      redemptions: 0,
      currency: 'GHS',
      version: 1,
      targets: [{ product: { id: broilerId, sku: 'LIV-BROILER', name: 'Broiler chicken' }, category: null, bundleQty: null }],
    });
    const changed = await patch(manager, `/promotions/${created.body.id}`, { version: 1, percentOff: '7.5', targets: [{ categoryId: poultryId }] });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ percentOff: '7.50', version: 2, targets: [{ product: null, category: { id: poultryId, code: 'POULTRY' } }] });
    expect((await patch(manager, `/promotions/${created.body.id}`, { version: 1, name: 'Stale' })).status).toBe(409);
    const both = await post(manager, '/promotions', promotionBody({ amountOffPesewas: 500 }));
    expect(both.status).toBe(422);
    expect(both.body.error).toMatchObject({ code: 'PROMOTION_INVALID', details: [{ field: '/amountOffPesewas', code: 'PROMOTION_INVALID' }] });
    const unknown = await post(manager, '/promotions', promotionBody({ targets: [{ productId: randomUUID() }] }));
    expect(unknown.body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/targets/0/productId' }] });
    const duplicate = await post(manager, '/promotions', promotionBody({ code: 'XMAS-CHICKEN' }));
    expect(duplicate.body.error).toMatchObject({ code: 'DUPLICATE_VALUE', details: [{ field: '/code' }] });
  });

  it('activates only on a second person’s approval, from the moment of approval, and freezes the promotion', async () => {
    const created = await post(manager, '/promotions', promotionBody());
    const submitted = await post(manager, `/promotions/${created.body.id}/submit`, {});
    expect(submitted.status).toBe(202);
    expect(submitted.body).toMatchObject({
      status: 'PENDING_APPROVAL',
      kind: 'PROMOTION_ACTIVATION',
      subject: { id: created.body.id, docType: 'PROMOTION', number: null },
    });
    // Not yet active: the line is not discounted.
    expect((await resolveBroilers()).body.lines[0].promotions).toEqual([]);
    await expect(decide(managerActor, submitted.body.approvalRequestId)).rejects.toMatchObject({ code: 'MAKER_CANNOT_CHECK' });
    await decide(otherManagerActor, submitted.body.approvalRequestId);
    const active = await consoleGet(api.server, manager, `/v1/promotions/${created.body.id}`);
    expect(active.body).toMatchObject({ status: 'ACTIVE', validFrom: clock.now().toISOString() });
    expect((await patch(manager, `/promotions/${created.body.id}`, { version: active.body.version, name: 'Too late' })).body.error).toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
    clock.advanceBy(60_000);
    await endPromotion(created.body.id);
    const ended = await consoleGet(api.server, manager, `/v1/promotions/${created.body.id}`);
    expect(ended.body).toMatchObject({ status: 'ENDED', validTo: clock.now().toISOString() });
    expect((await resolveBroilers()).body.lines[0].promotions).toEqual([]);
  });

  it('lists promotions newest first, filtered by status', async () => {
    const page = await consoleGet(api.server, sales, '/v1/promotions?status=ENDED&limit=1');
    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.data[0].status).toBe('ENDED');
    expect(page.body.page.limit).toBe(1);
  });

  it('refuses the wrong roles: sales and the cashier cannot create, the cashier cannot read, sales cannot approve (ADR-0035)', async () => {
    for (const session of [sales, cashier]) {
      const refused = await post(session, '/promotions', promotionBody());
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN');
    }
    expect((await consoleGet(api.server, cashier, '/v1/promotions')).status).toBe(403);
    const created = await post(manager, '/promotions', promotionBody());
    expect((await post(sales, `/promotions/${created.body.id}/submit`, {})).status).toBe(403);
    expect((await post(sales, `/promotions/${created.body.id}/coupons`, { code: 'NOPE-1' })).status).toBe(403);
    const submitted = await post(manager, `/promotions/${created.body.id}/submit`, {});
    const withoutApprove = actor(randomUUID(), 'Nobody', clock.now());
    await expect(decide(withoutApprove, submitted.body.approvalRequestId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await decide(ownerActor, submitted.body.approvalRequestId, 'REJECTED');
    expect((await consoleGet(api.server, manager, `/v1/promotions/${created.body.id}`)).body.status).toBe('REJECTED');
  });
});

describe('promotions in the engine (the B04d gate)', () => {
  it('applies only the larger of two promotions in one stack group', async () => {
    const five = await activePromotion({ percentOff: '5', stackGroup: 'SEASONAL' });
    const eight = await activePromotion({ percentOff: '8', stackGroup: 'SEASONAL' });
    const resolved = await resolveBroilers();
    expect(resolved.body.lines[0].resolved.listPricePesewas).toBe(18_000);
    // 8 percent of the line at list, 180,000 pesewas: exactly 14,400.
    expect(resolved.body.lines[0].promotions).toEqual([{ promotionId: eight.id, code: eight.code, name: expect.any(String), discountPesewas: 14_400 }]);
    await endPromotion(five.id);
    await endPromotion(eight.id);
  });

  it('applies only an exclusive 10 percent when a 5 percent sits in another group', async () => {
    const exclusive = await activePromotion({ percentOff: '10', stackGroup: 'FESTIVE', isExclusive: true });
    const other = await activePromotion({ percentOff: '5', stackGroup: 'LOYALTY', targets: [{ categoryId: poultryId }] });
    const resolved = await resolveBroilers();
    expect(resolved.body.lines[0].promotions).toEqual([{ promotionId: exclusive.id, code: exclusive.code, name: expect.any(String), discountPesewas: 18_000 }]);
    await endPromotion(exclusive.id);
    // With the exclusive one gone, the other group's promotion applies on its own.
    expect((await resolveBroilers()).body.lines[0].promotions).toEqual([expect.objectContaining({ promotionId: other.id, discountPesewas: 9_000 })]);
    await endPromotion(other.id);
  });

  it('stacks one promotion from each group, and matches a promotion on a parent category', async () => {
    const live = await activePromotion({ percentOff: '5', stackGroup: 'LIVE_WEEK', targets: [{ categoryId: liveCategoryId }] });
    const fixed = await activePromotion({ kind: 'AMOUNT_OFF', percentOff: undefined, amountOffPesewas: 2_500, stackGroup: 'MARKET_DAY' });
    const resolved = await resolveBroilers();
    expect(resolved.body.lines[0].promotions.map((applied: { discountPesewas: number }) => applied.discountPesewas)).toEqual([9_000, 2_500]);
    await endPromotion(live.id);
    await endPromotion(fixed.id);
  });

  it('never discounts a customer contract price', async () => {
    const promotion = await activePromotion({ percentOff: '5' });
    const resolved = await resolveBroilers({ customerId: catererId });
    expect(resolved.body.lines[0].resolved).toMatchObject({ listPricePesewas: 17_000, priceList: { kind: 'CUSTOMER' } });
    expect(resolved.body.lines[0].promotions).toEqual([]);
    await endPromotion(promotion.id);
  });
});

describe('coupons', () => {
  let couponPromotion: { id: string; code: string };

  beforeAll(async () => {
    couponPromotion = await activePromotion({ percentOff: '20', requiresCoupon: true, stackGroup: 'COUPONS' });
  });

  it('creates a coupon only for a promotion that requires one, and refuses a bad code', async () => {
    const created = await post(manager, `/promotions/${couponPromotion.id}/coupons`, { code: ' welcome20 ', maxUses: 100, perCustomerLimit: 1 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ promotionId: couponPromotion.id, code: 'WELCOME20', maxUses: 100, perCustomerLimit: 1, usedCount: 0 });
    const plain = await post(manager, '/promotions', promotionBody());
    const refused = await post(manager, `/promotions/${plain.body.id}/coupons`, { code: 'PLAIN-1' });
    expect(refused.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [{ code: 'COUPON_NOT_REQUIRED' }] });
    const bad = await post(manager, `/promotions/${couponPromotion.id}/coupons`, { code: 'NO SPACES' });
    expect(bad.body.error).toMatchObject({ code: 'COUPON_INVALID', details: [{ field: '/code' }] });
    const page = await consoleGet(api.server, sales, `/v1/promotions/${couponPromotion.id}/coupons`);
    expect(page.body.data.map((coupon: { code: string }) => coupon.code)).toEqual(['WELCOME20']);
  });

  it('applies a coupon promotion only with its code', async () => {
    expect((await resolveBroilers()).body.lines[0].promotions).toEqual([]);
    const withCode = await resolveBroilers({ couponCode: 'welcome20' });
    expect(withCode.body.lines[0].promotions).toEqual([expect.objectContaining({ promotionId: couponPromotion.id, discountPesewas: 36_000 })]);
    const unknown = await resolveBroilers({ couponCode: 'NO-SUCH-CODE' });
    expect(unknown.body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/couponCode' }] });
  });

  it('validates a code publicly without saying who used it', async () => {
    const valid = await request(api.server).post('/v1/coupons/validate').send({ code: 'welcome20', customerId: catererId });
    expect(valid.status).toBe(200);
    expect(valid.body).toEqual({ valid: true, reason: null, promotion: { id: couponPromotion.id, code: couponPromotion.code, name: expect.any(String) } });
    expect((await request(api.server).post('/v1/coupons/validate').send({ code: 'NOT-A-CODE' })).body).toEqual({
      valid: false,
      reason: 'NOT_FOUND',
      promotion: null,
    });
    const cart = await request(api.server).post('/v1/coupons/validate').send({ code: 'WELCOME20', cartId: randomUUID() });
    expect(cart.body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/cartId' }] });
  });

  it('holds the per-customer limit at redemption and releases a cancelled use', async () => {
    const created = await post(manager, `/promotions/${couponPromotion.id}/coupons`, { code: 'ONCE-EACH', maxUses: 10, perCustomerLimit: 1 });
    const first = await order();
    await redeem('ONCE-EACH', first, catererId);
    await expect(redeem('ONCE-EACH', await order(), catererId)).rejects.toMatchObject({
      code: 'COUPON_UNAVAILABLE',
      details: [{ field: '/couponCode', code: 'ALREADY_USED' }],
    });
    const refused = await resolveBroilers({ couponCode: 'ONCE-EACH', customerId: catererId });
    expect(refused.body.error).toMatchObject({ code: 'COUPON_UNAVAILABLE', details: [{ code: 'ALREADY_USED' }] });
    await api.app
      .get(UnitOfWork)
      .run({ isolation: 'serializable' }, (tx) =>
        api.app.get(Promotions).releaseIn(tx, { code: 'ONCE-EACH', sourceDocumentId: first, actorId: SYSTEM_PRINCIPAL }),
      );
    await redeem('ONCE-EACH', await order(), catererId);
    const page = await consoleGet(api.server, manager, `/v1/promotions/${couponPromotion.id}/coupons`);
    expect(page.body.data.find((coupon: { id: string }) => coupon.id === created.body.id).usedCount).toBe(1);
  });

  it('refuses the 101st use of a coupon limited to 100 under 20 concurrent redemptions, and never exceeds 100', async () => {
    await post(manager, `/promotions/${couponPromotion.id}/coupons`, { code: 'FIRST-100', maxUses: 100 });
    const documents = await Promise.all(Array.from({ length: 101 }, () => order()));
    const outcomes: string[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        for (let index = next++; index < documents.length; index = next++) {
          outcomes.push(
            await redeem('FIRST-100', documents[index]!).then(
              () => 'REDEEMED',
              (error: { code?: string; details?: { code: string }[] }) => `${error.code}:${error.details?.[0]?.code}`,
            ),
          );
        }
      }),
    );
    expect(outcomes.filter((outcome) => outcome === 'REDEEMED')).toHaveLength(100);
    expect(outcomes.filter((outcome) => outcome !== 'REDEEMED')).toEqual(['COUPON_UNAVAILABLE:LIMIT_REACHED']);
    const { rows } = await database
      .pool('app')
      .query<{
        used: number;
        n: string;
      }>("SELECT k.used_count AS used, (SELECT count(*) FROM mdm.coupon_redemption r WHERE r.coupon_id = k.id) AS n FROM mdm.coupon k WHERE k.code = 'FIRST-100'");
    expect(rows[0]).toEqual({ used: 100, n: '100' });
    const validation = await request(api.server).post('/v1/coupons/validate').send({ code: 'FIRST-100' });
    expect(validation.body).toEqual({ valid: false, reason: 'LIMIT_REACHED', promotion: null });
  });
});
