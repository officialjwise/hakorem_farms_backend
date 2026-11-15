import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCatalogue } from '../../support/catalogue';
import { createBranch, createUser, SYSTEM_PRINCIPAL } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { createTestDatabase, expectTeardownTermination, type TestDatabase } from '../../support/test-database';

/** Every rule migration 0017 puts in the database, each violated once (FR-MDM-018, ADR-0004, ADR-0040). */
let database: TestDatabase;
let app: pg.Pool;
let branchId: string;
let checker: string;
let productId: string;
let categoryId: string;
let codeSeq = 0;

function nextCode(prefix: string): string {
  codeSeq += 1;
  return `${prefix}-${codeSeq}`;
}

async function promotion(
  fields: {
    kind?: string;
    percent?: string | null;
    amount?: string | null;
    bundle?: string | null;
    appliesTo?: string;
    validTo?: string;
    maxRedemptions?: number | null;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await app.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'PROMOTION', 'mdm', $2, $3)", [
    id,
    branchId,
    SYSTEM_PRINCIPAL,
  ]);
  await app.query(
    `INSERT INTO mdm.promotion (id, code, name, kind, percent_off, amount_off_pesewas, bundle_price_pesewas, applies_to, valid_from, valid_to, max_redemptions, status, branch_id, created_by, updated_by)
     VALUES ($1, $2, 'Fixture promotion', $3, $4, $5, $6, $7, '2026-12-01T00:00:00Z', $8, $9, 'DRAFT', $10, $11, $11)`,
    [
      id,
      nextCode('PROMO'),
      fields.kind ?? 'PERCENT_OFF',
      fields.percent === undefined ? '5' : fields.percent,
      fields.amount ?? null,
      fields.bundle ?? null,
      fields.appliesTo ?? 'LINE',
      fields.validTo ?? '2027-01-01T00:00:00Z',
      fields.maxRedemptions ?? null,
      branchId,
      SYSTEM_PRINCIPAL,
    ],
  );
  return id;
}

function target(promotionId: string, product: string | null, category: string | null) {
  return app.query('INSERT INTO mdm.promotion_target (id, promotion_id, product_id, category_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5)', [
    randomUUID(),
    promotionId,
    product,
    category,
    SYSTEM_PRINCIPAL,
  ]);
}

async function submit(promotionId: string): Promise<void> {
  const approvalId = randomUUID();
  await app.query(
    `INSERT INTO iam.approval_request (id, kind, branch_id, subject_document_id, payload_hash, summary, requested_by, status)
     VALUES ($1, 'PROMOTION_ACTIVATION', $2, $3, $4, 'Activate a promotion', $5, 'PENDING')`,
    [approvalId, branchId, promotionId, Buffer.alloc(32), SYSTEM_PRINCIPAL],
  );
  await app.query("UPDATE mdm.promotion SET version = version + 1, status = 'PENDING_APPROVAL', approval_request_id = $2 WHERE id = $1", [
    promotionId,
    approvalId,
  ]);
}

function activate(promotionId: string, validFrom?: string) {
  return app.query(
    "UPDATE mdm.promotion SET version = version + 1, status = 'ACTIVE', activated_at = now(), activated_by = $2, valid_from = COALESCE($3::timestamptz, valid_from) WHERE id = $1",
    [promotionId, checker, validFrom ?? null],
  );
}

async function activePromotion(maxRedemptions: number | null = null): Promise<string> {
  const id = await promotion({ maxRedemptions });
  await target(id, productId, null);
  await submit(id);
  await activate(id);
  return id;
}

async function coupon(promotionId: string, maxUses: number | null, perCustomerLimit: number | null = null): Promise<string> {
  const id = randomUUID();
  await app.query('INSERT INTO mdm.coupon (id, promotion_id, code, max_uses, per_customer_limit, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)', [
    id,
    promotionId,
    nextCode('COUPON'),
    maxUses,
    perCustomerLimit,
    SYSTEM_PRINCIPAL,
  ]);
  return id;
}

async function order(): Promise<string> {
  const id = randomUUID();
  await app.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'FIXTURE_ORDER', 'ord', $2, $3)", [
    id,
    branchId,
    SYSTEM_PRINCIPAL,
  ]);
  return id;
}

function redeem(client: pg.Pool | pg.PoolClient, couponId: string, documentId: string, direction = 'REDEEM', customerId: string | null = null) {
  return client.query(
    'INSERT INTO mdm.coupon_redemption (id, coupon_id, customer_id, source_document_id, direction, amount_pesewas, actor_id) VALUES ($1, $2, $3, $4, $5, 1500, $6)',
    [randomUUID(), couponId, customerId, documentId, direction, SYSTEM_PRINCIPAL],
  );
}

async function usedCount(couponId: string): Promise<number> {
  return (await app.query<{ used_count: number }>('SELECT used_count FROM mdm.coupon WHERE id = $1', [couponId])).rows[0]!.used_count;
}

async function hk006Detail(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (error: { code?: string; detail?: string }) => `${error.code}:${error.detail}`,
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = database.pool('app');
  ({ branchId } = await createBranch(database));
  checker = (await createUser(database, { name: 'Akosua Owusu' })).principalId;
  const catalogue = await createCatalogue(database);
  categoryId = catalogue.meatCategoryId;
  productId = randomUUID();
  await app.query(
    `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by)
     SELECT $1, 'BROILER-FULL', 'Full chicken', c.id, 'CATCH_WEIGHT', 'LOT', 'KG', 'KG', c.tax_category_id, c.gl_group, 'LISTED', 'ACTIVE', $2, $2 FROM mdm.category c WHERE c.id = $3`,
    [productId, SYSTEM_PRINCIPAL, categoryId],
  );
  await database
    .pool('admin')
    .query(
      "INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES ('FIXTURE_ORDER', 'ord', 'Fixture order', false, NULL)",
    );
});

afterAll(async () => {
  await database?.drop();
});

describe('mdm.promotion', () => {
  it.each([
    ['a percentage promotion with an amount as well', { amount: '100' }],
    ['an amount promotion without its amount', { kind: 'AMOUNT_OFF', percent: null }],
    ['a bundle without its price', { kind: 'BUNDLE_PRICE', percent: null }],
    ['free delivery on a line', { kind: 'FREE_DELIVERY', percent: null }],
    ['a percentage above one hundred', { percent: '100.5' }],
    ['a percentage of zero', { percent: '0' }],
    ['a window that ends where it starts', { validTo: '2026-12-01T00:00:00Z' }],
    ['a redemption limit of zero', { maxRedemptions: 0 }],
  ])('refuses %s', async (_name, fields) => {
    expect(await sqlStateOf(promotion(fields))).toBe(SQLSTATE.checkViolation);
  });

  it('accepts free delivery on the whole order', async () => {
    expect(await sqlStateOf(promotion({ kind: 'FREE_DELIVERY', percent: null, appliesTo: 'ORDER' }))).toBeUndefined();
  });

  it('refuses an active promotion without an approval', async () => {
    const id = await promotion();
    expect(await sqlStateOf(app.query("UPDATE mdm.promotion SET version = version + 1, status = 'PENDING_APPROVAL' WHERE id = $1", [id]))).toBe(
      SQLSTATE.checkViolation,
    );
  });

  it('freezes the terms once submitted and lets an active promotion only end earlier', async () => {
    const id = await promotion();
    await submit(id);
    expect(await sqlStateOf(app.query('UPDATE mdm.promotion SET version = version + 1, percent_off = 50 WHERE id = $1', [id]))).toBe(SQLSTATE.documentFrozen);
    await activate(id);
    expect(await sqlStateOf(app.query("UPDATE mdm.promotion SET version = version + 1, name = 'Renamed' WHERE id = $1", [id]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query("UPDATE mdm.promotion SET version = version + 1, valid_to = '2027-06-01T00:00:00Z' WHERE id = $1", [id]))).toBe(
      SQLSTATE.documentFrozen,
    );
    expect(await sqlStateOf(app.query("UPDATE mdm.promotion SET version = version + 1, status = 'DRAFT' WHERE id = $1", [id]))).toBe(SQLSTATE.documentFrozen);
    expect(
      await sqlStateOf(app.query("UPDATE mdm.promotion SET version = version + 1, status = 'ENDED', valid_to = '2026-12-20T00:00:00Z' WHERE id = $1", [id])),
    ).toBeUndefined();
    expect(await sqlStateOf(app.query("UPDATE mdm.promotion SET version = version + 1, status = 'ACTIVE' WHERE id = $1", [id]))).toBe(SQLSTATE.documentFrozen);
  });

  it('lets activation move the start later, never earlier', async () => {
    const earlier = await promotion();
    await submit(earlier);
    expect(await sqlStateOf(activate(earlier, '2026-11-20T00:00:00Z'))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(activate(earlier, '2026-12-05T00:00:00Z'))).toBeUndefined();
  });

  it('refuses a rejected promotion coming back', async () => {
    const id = await promotion();
    await submit(id);
    await app.query("UPDATE mdm.promotion SET version = version + 1, status = 'REJECTED' WHERE id = $1", [id]);
    expect(await sqlStateOf(activate(id))).toBe(SQLSTATE.documentFrozen);
  });

  it('holds promotion codes unique', async () => {
    const id = await promotion();
    const { rows } = await app.query<{ code: string }>('SELECT code FROM mdm.promotion WHERE id = $1', [id]);
    const other = randomUUID();
    await app.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'PROMOTION', 'mdm', $2, $3)", [
      other,
      branchId,
      SYSTEM_PRINCIPAL,
    ]);
    expect(
      await sqlStateOf(
        app.query(
          `INSERT INTO mdm.promotion (id, code, name, kind, percent_off, applies_to, valid_from, valid_to, status, branch_id, created_by, updated_by)
           VALUES ($1, $2, 'Copy', 'PERCENT_OFF', 5, 'LINE', '2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z', 'DRAFT', $3, $4, $4)`,
          [other, rows[0]!.code, branchId, SYSTEM_PRINCIPAL],
        ),
      ),
    ).toBe(SQLSTATE.uniqueViolation);
  });
});

describe('mdm.promotion_target', () => {
  it('refuses a target naming both a product and a category, or neither', async () => {
    const id = await promotion();
    expect(await sqlStateOf(target(id, productId, categoryId))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(target(id, null, null))).toBe(SQLSTATE.checkViolation);
  });

  it('refuses the same target twice', async () => {
    const id = await promotion();
    await target(id, productId, null);
    expect(await sqlStateOf(target(id, productId, null))).toBe(SQLSTATE.uniqueViolation);
  });

  it('freezes targets with their promotion, and only the definer function empties a draft', async () => {
    const id = await promotion();
    await target(id, productId, null);
    expect(await sqlStateOf(app.query('DELETE FROM mdm.promotion_target WHERE promotion_id = $1', [id]))).toBe(SQLSTATE.insufficientPrivilege);
    expect((await app.query<{ removed: number }>('SELECT mdm.clear_draft_promotion_targets($1) AS removed', [id])).rows[0]!.removed).toBe(1);
    await target(id, null, categoryId);
    await submit(id);
    expect(await sqlStateOf(target(id, productId, null))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query('SELECT mdm.clear_draft_promotion_targets($1)', [id]))).toBe(SQLSTATE.documentFrozen);
  });
});

describe('mdm.coupon and mdm.coupon_redemption', () => {
  it('counts a redemption and a release, and refuses a release with nothing to release', async () => {
    const couponId = await coupon(await activePromotion(), 10);
    const doc = await order();
    await redeem(app, couponId, doc);
    expect(await usedCount(couponId)).toBe(1);
    expect(await hk006Detail(redeem(app, couponId, doc))).toBe('HK006:ALREADY_USED');
    await redeem(app, couponId, doc, 'RELEASE');
    expect(await usedCount(couponId)).toBe(0);
    expect(await hk006Detail(redeem(app, couponId, doc, 'RELEASE'))).toBe('HK006:NOTHING_TO_RELEASE');
  });

  it('refuses a use beyond the coupon limit', async () => {
    const couponId = await coupon(await activePromotion(), 1);
    await redeem(app, couponId, await order());
    expect(await hk006Detail(redeem(app, couponId, await order()))).toBe('HK006:LIMIT_REACHED');
    expect(await usedCount(couponId)).toBe(1);
  });

  it('refuses a use beyond the promotion limit across its coupons', async () => {
    const promotionId = await activePromotion(1);
    await redeem(app, await coupon(promotionId, null), await order());
    expect(await hk006Detail(redeem(app, await coupon(promotionId, null), await order()))).toBe('HK006:LIMIT_REACHED');
  });

  it('refuses a customer beyond their own limit', async () => {
    const couponId = await coupon(await activePromotion(), 10, 1);
    const customerId = randomUUID();
    await app.query(
      "INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by) VALUES ($1, 'C-90001', 'INDIVIDUAL', 'Kofi Boateng', '01900000-0000-7000-8000-000000000301', 'ACTIVE', $2, $2)",
      [customerId, SYSTEM_PRINCIPAL],
    );
    await redeem(app, couponId, await order(), 'REDEEM', customerId);
    expect(await hk006Detail(redeem(app, couponId, await order(), 'REDEEM', customerId))).toBe('HK006:ALREADY_USED');
    expect(await sqlStateOf(redeem(app, couponId, await order(), 'REDEEM', null))).toBeUndefined();
  });

  it('refuses a coupon of a promotion that is not active', async () => {
    const couponId = await coupon(await promotion(), null);
    expect(await hk006Detail(redeem(app, couponId, await order()))).toBe('HK006:NOT_APPLICABLE');
  });

  it('refuses a use count changed by anything but a redemption, and a coupon moved or renamed', async () => {
    const couponId = await coupon(await activePromotion(), 10);
    expect(await sqlStateOf(app.query('UPDATE mdm.coupon SET version = version + 1, used_count = 0 + 5 WHERE id = $1', [couponId]))).toBe(
      SQLSTATE.documentFrozen,
    );
    expect(await sqlStateOf(app.query("UPDATE mdm.coupon SET version = version + 1, code = 'RENAMED-1' WHERE id = $1", [couponId]))).toBe(
      SQLSTATE.documentFrozen,
    );
    expect(await sqlStateOf(app.query('UPDATE mdm.coupon SET version = version + 1, max_uses = 20 WHERE id = $1', [couponId]))).toBeUndefined();
  });

  it('refuses a limit below the uses already counted', async () => {
    const couponId = await coupon(await activePromotion(), 10);
    await redeem(app, couponId, await order());
    await redeem(app, couponId, await order());
    expect(await sqlStateOf(app.query('UPDATE mdm.coupon SET version = version + 1, max_uses = 1 WHERE id = $1', [couponId]))).toBe(SQLSTATE.checkViolation);
  });

  it('keeps the redemption ledger append-only', async () => {
    const couponId = await coupon(await activePromotion(), 10);
    await redeem(app, couponId, await order());
    expect(await sqlStateOf(app.query('UPDATE mdm.coupon_redemption SET amount_pesewas = 1 WHERE coupon_id = $1', [couponId]))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(app.query('DELETE FROM mdm.coupon_redemption WHERE coupon_id = $1', [couponId]))).toBe(SQLSTATE.insufficientPrivilege);
    // Not even a superuser: the trigger refuses every role.
    const admin = database.pool('admin');
    expect(await sqlStateOf(admin.query('UPDATE mdm.coupon_redemption SET amount_pesewas = 1 WHERE coupon_id = $1', [couponId]))).toBe(SQLSTATE.ledgerImmutable);
    expect(await sqlStateOf(admin.query('DELETE FROM mdm.coupon_redemption WHERE coupon_id = $1', [couponId]))).toBe(SQLSTATE.ledgerImmutable);
    expect(await sqlStateOf(admin.query('TRUNCATE mdm.coupon_redemption'))).toBe(SQLSTATE.ledgerImmutable);
  });

  it('holds a limit of 100 under 20 concurrent connections redeeming 101 times, with no lock taken by the caller', async () => {
    const couponId = await coupon(await activePromotion(), 100);
    const documents = await Promise.all(Array.from({ length: 101 }, () => order()));
    const outcomes: string[] = [];
    let next = 0;
    // A pool of 20 at the database's default isolation: only the row locks of the trigger stand between them.
    const racers = expectTeardownTermination(new pg.Pool({ connectionString: database.url('app'), max: 20 }));
    try {
      await Promise.all(
        Array.from({ length: 20 }, async () => {
          for (let index = next++; index < documents.length; index = next++) {
            const client = await racers.connect();
            try {
              outcomes.push((await hk006Detail(redeem(client, couponId, documents[index]!))) ?? 'REDEEMED');
            } finally {
              client.release();
            }
          }
        }),
      );
    } finally {
      await racers.end();
    }
    expect(outcomes.filter((outcome) => outcome === 'REDEEMED')).toHaveLength(100);
    expect(outcomes.filter((outcome) => outcome === 'HK006:LIMIT_REACHED')).toHaveLength(1);
    expect(await usedCount(couponId)).toBe(100);
    const { rows } = await app.query<{ n: string }>('SELECT count(*) AS n FROM mdm.coupon_redemption WHERE coupon_id = $1', [couponId]);
    expect(rows[0]!.n).toBe('100');
  });
});
