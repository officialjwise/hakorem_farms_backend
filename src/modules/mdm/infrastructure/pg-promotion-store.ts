import type { Transaction } from '../../../platform/database/unit-of-work';
import type { Channel } from '../domain/pricing/pricing-engine';
import type { PromotionKind, PromotionScope, PromotionStatus } from '../domain/pricing/promotions';
import type {
  CouponRow,
  DraftChange,
  NewPromotion,
  NewRedemption,
  PromotionFilter,
  PromotionRow,
  PromotionStore,
  TargetInput,
  TargetRow,
} from '../application/promotion-store';

interface PromotionRecord {
  id: string;
  code: string;
  name: string;
  kind: PromotionKind;
  percent_off: string | null;
  amount_off: string | null;
  bundle_price: string | null;
  applies_to: PromotionScope;
  channel: Channel | null;
  min_order: string | null;
  stack_group: string;
  is_exclusive: boolean;
  requires_coupon: boolean;
  max_redemptions: number | null;
  redemptions: number;
  valid_from: Date;
  valid_to: Date;
  status: PromotionStatus;
  approval_request_id: string | null;
  branch_id: string;
  version: number;
  created_at: Date;
}

interface TargetRecord {
  promotion_id: string;
  product_id: string | null;
  sku: string | null;
  product_name: string | null;
  category_id: string | null;
  category_code: string | null;
  category_name: string | null;
  bundle_qty: string | null;
}

interface CouponRecord {
  id: string;
  promotion_id: string;
  code: string;
  max_uses: number | null;
  per_customer_limit: number | null;
  used_count: number;
  version: number;
}

const PROMOTION_SELECT = `
  SELECT p.id, p.code, p.name, p.kind, p.percent_off::text AS percent_off, p.amount_off_pesewas::text AS amount_off,
         p.bundle_price_pesewas::text AS bundle_price, p.applies_to, p.channel, p.min_order_pesewas::text AS min_order, p.stack_group,
         p.is_exclusive, p.requires_coupon, p.max_redemptions, p.valid_from, p.valid_to, p.status, p.approval_request_id, p.branch_id,
         p.version, p.created_at,
         (SELECT COALESCE(sum(k.used_count), 0)::int FROM mdm.coupon k WHERE k.promotion_id = p.id) AS redemptions
    FROM mdm.promotion p`;

const COUPON_SELECT = 'SELECT id, promotion_id, code, max_uses, per_customer_limit, used_count, version FROM mdm.coupon';

function optionalBigInt(text: string | null): bigint | null {
  return text === null ? null : BigInt(text);
}

function toPromotion(row: PromotionRecord, targets: readonly TargetRow[]): PromotionRow {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    percentOff: row.percent_off,
    amountOffPesewas: optionalBigInt(row.amount_off),
    bundlePricePesewas: optionalBigInt(row.bundle_price),
    appliesTo: row.applies_to,
    channel: row.channel,
    minOrderPesewas: optionalBigInt(row.min_order),
    stackGroup: row.stack_group,
    isExclusive: row.is_exclusive,
    requiresCoupon: row.requires_coupon,
    maxRedemptions: row.max_redemptions,
    redemptions: row.redemptions,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    status: row.status,
    approvalRequestId: row.approval_request_id,
    branchId: row.branch_id,
    targets,
    version: row.version,
    createdAt: row.created_at,
  };
}

function toCoupon(row: CouponRecord): CouponRow {
  return {
    id: row.id,
    promotionId: row.promotion_id,
    code: row.code,
    maxUses: row.max_uses,
    perCustomerLimit: row.per_customer_limit,
    usedCount: row.used_count,
    version: row.version,
  };
}

/** The promotion tables of migration 0017, in plain SQL. */
export class PgPromotionStore implements PromotionStore {
  async firstBranchId(tx: Transaction): Promise<string> {
    const { rows } = await tx.query<{ id: string }>(
      "SELECT id FROM mdm.branch WHERE deleted_at IS NULL AND status = 'ACTIVE' AND NOT is_test ORDER BY created_at, code LIMIT 1",
    );
    if (rows[0] === undefined) {
      throw new Error('no active branch exists to register a promotion under');
    }
    return rows[0].id;
  }

  async insert(tx: Transaction, p: NewPromotion, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO mdm.promotion (id, code, name, kind, percent_off, amount_off_pesewas, bundle_price_pesewas, applies_to, channel, min_order_pesewas,
                                  stack_group, is_exclusive, requires_coupon, max_redemptions, valid_from, valid_to, status, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'DRAFT', $17, $18, $18)`,
      [
        p.id,
        p.code,
        p.name,
        p.kind,
        p.percentOff,
        p.amountOffPesewas?.toString() ?? null,
        p.bundlePricePesewas?.toString() ?? null,
        p.appliesTo,
        p.channel,
        p.minOrderPesewas?.toString() ?? null,
        p.stackGroup,
        p.isExclusive,
        p.requiresCoupon,
        p.maxRedemptions,
        p.validFrom,
        p.validTo,
        p.branchId,
        actorId,
      ],
    );
  }

  async replaceTargets(tx: Transaction, promotionId: string, targets: readonly TargetInput[], actorId: string, nextId: () => string): Promise<void> {
    await tx.query('SELECT mdm.clear_draft_promotion_targets($1)', [promotionId]);
    if (targets.length === 0) {
      return;
    }
    await tx.query(
      `INSERT INTO mdm.promotion_target (id, promotion_id, product_id, category_id, bundle_qty, created_by, updated_by)
       SELECT t.id, $1, t.product_id, t.category_id, t.bundle_qty, $2, $2
         FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::numeric[]) AS t (id, product_id, category_id, bundle_qty)`,
      [promotionId, actorId, targets.map(() => nextId()), targets.map((t) => t.productId), targets.map((t) => t.categoryId), targets.map((t) => t.bundleQty)],
    );
  }

  async promotion(tx: Transaction, id: string, forUpdate: boolean): Promise<PromotionRow | null> {
    // The lock is taken on the promotion row alone; the use count is read after it, so it is the committed one.
    if (forUpdate) {
      await tx.query('SELECT id FROM mdm.promotion WHERE id = $1 FOR UPDATE', [id]);
    }
    const { rows } = await tx.query<PromotionRecord>(`${PROMOTION_SELECT} WHERE p.id = $1`, [id]);
    return rows[0] === undefined ? null : (await this.withTargets(tx, rows))[0]!;
  }

  async page(tx: Transaction, filter: PromotionFilter, afterId: string | null, limit: number): Promise<readonly PromotionRow[]> {
    const { rows } = await tx.query<PromotionRecord>(
      `${PROMOTION_SELECT}
        WHERE ($1::text IS NULL OR p.status = $1) AND ($2::text IS NULL OR p.channel = $2) AND ($3::uuid IS NULL OR p.id < $3)
        ORDER BY p.id DESC
        LIMIT $4 + 1`,
      [filter.status ?? null, filter.channel ?? null, afterId, limit],
    );
    return this.withTargets(tx, rows);
  }

  async updateDraft(tx: Transaction, id: string, expectedVersion: number, change: DraftChange, actorId: string): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE mdm.promotion SET version = version + 1, name = $3, percent_off = $4, amount_off_pesewas = $5, valid_to = $6, updated_by = $7
        WHERE id = $1 AND version = $2 AND status = 'DRAFT'`,
      [id, expectedVersion, change.name, change.percentOff, change.amountOffPesewas?.toString() ?? null, change.validTo, actorId],
    );
    return rowCount === 1;
  }

  async touch(tx: Transaction, id: string, expectedVersion: number, actorId: string): Promise<boolean> {
    const { rowCount } = await tx.query("UPDATE mdm.promotion SET version = version + 1, updated_by = $3 WHERE id = $1 AND version = $2 AND status = 'DRAFT'", [
      id,
      expectedVersion,
      actorId,
    ]);
    return rowCount === 1;
  }

  async markPending(tx: Transaction, id: string, approvalRequestId: string, actorId: string): Promise<void> {
    await tx.query("UPDATE mdm.promotion SET version = version + 1, status = 'PENDING_APPROVAL', approval_request_id = $2, updated_by = $3 WHERE id = $1", [
      id,
      approvalRequestId,
      actorId,
    ]);
  }

  async activate(tx: Transaction, id: string, validFrom: Date, actorId: string, at: Date): Promise<void> {
    await tx.query(
      "UPDATE mdm.promotion SET version = version + 1, status = 'ACTIVE', valid_from = $2, activated_at = $4, activated_by = $3, updated_by = $3 WHERE id = $1",
      [id, validFrom, actorId, at],
    );
  }

  async reject(tx: Transaction, id: string, actorId: string): Promise<void> {
    await tx.query("UPDATE mdm.promotion SET version = version + 1, status = 'REJECTED', updated_by = $2 WHERE id = $1", [id, actorId]);
  }

  async end(tx: Transaction, id: string, at: Date, actorId: string): Promise<void> {
    // A promotion ended before it starts keeps a window of one millisecond, so its row stays valid.
    await tx.query(
      `UPDATE mdm.promotion SET version = version + 1, status = 'ENDED', updated_by = $3,
              valid_to = GREATEST(LEAST($2::timestamptz, valid_to), valid_from + interval '1 millisecond')
        WHERE id = $1`,
      [id, at, actorId],
    );
  }

  async inForce(tx: Transaction, channel: Channel, at: Date): Promise<readonly PromotionRow[]> {
    const { rows } = await tx.query<PromotionRecord>(
      `${PROMOTION_SELECT}
        WHERE p.status = 'ACTIVE' AND p.valid_from <= $2 AND p.valid_to > $2 AND (p.channel IS NULL OR p.channel = $1)
        ORDER BY p.code`,
      [channel, at],
    );
    return this.withTargets(tx, rows);
  }

  async missingTargets(tx: Transaction, productIds: readonly string[], categoryIds: readonly string[]) {
    const [products, categories] = await Promise.all([
      tx.query<{ id: string }>('SELECT id FROM mdm.product WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [[...productIds]]),
      tx.query<{ id: string }>('SELECT id FROM mdm.category WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [[...categoryIds]]),
    ]);
    const foundProducts = new Set(products.rows.map((row) => row.id));
    const foundCategories = new Set(categories.rows.map((row) => row.id));
    return { products: new Set(productIds.filter((id) => !foundProducts.has(id))), categories: new Set(categoryIds.filter((id) => !foundCategories.has(id))) };
  }

  async coupons(tx: Transaction, promotionId: string, afterId: string | null, limit: number): Promise<readonly CouponRow[]> {
    const { rows } = await tx.query<CouponRecord>(
      `${COUPON_SELECT} WHERE promotion_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id > $2) ORDER BY id LIMIT $3 + 1`,
      [promotionId, afterId, limit],
    );
    return rows.map(toCoupon);
  }

  async coupon(tx: Transaction, id: string): Promise<CouponRow | null> {
    const { rows } = await tx.query<CouponRecord>(`${COUPON_SELECT} WHERE id = $1 AND deleted_at IS NULL`, [id]);
    return rows[0] === undefined ? null : toCoupon(rows[0]);
  }

  async couponByCode(tx: Transaction, code: string): Promise<CouponRow | null> {
    const { rows } = await tx.query<CouponRecord>(`${COUPON_SELECT} WHERE code = $1 AND deleted_at IS NULL`, [code]);
    return rows[0] === undefined ? null : toCoupon(rows[0]);
  }

  async insertCoupon(
    tx: Transaction,
    coupon: {
      readonly id: string;
      readonly promotionId: string;
      readonly code: string;
      readonly maxUses: number | null;
      readonly perCustomerLimit: number | null;
    },
    actorId: string,
  ): Promise<void> {
    await tx.query(
      'INSERT INTO mdm.coupon (id, promotion_id, code, max_uses, per_customer_limit, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)',
      [coupon.id, coupon.promotionId, coupon.code, coupon.maxUses, coupon.perCustomerLimit, actorId],
    );
  }

  async customerUses(tx: Transaction, couponId: string, customerId: string): Promise<number> {
    const { rows } = await tx.query<{ uses: number }>(
      "SELECT COALESCE(sum(CASE direction WHEN 'REDEEM' THEN 1 ELSE -1 END), 0)::int AS uses FROM mdm.coupon_redemption WHERE coupon_id = $1 AND customer_id = $2",
      [couponId, customerId],
    );
    return rows[0]!.uses;
  }

  async heldUse(tx: Transaction, couponId: string, sourceDocumentId: string): Promise<{ readonly amountPesewas: bigint; readonly customerId: string | null } | null> {
    const { rows } = await tx.query<{ net: number; amount: string | null; customer_id: string | null }>(
      `SELECT COALESCE(sum(CASE r.direction WHEN 'REDEEM' THEN 1 ELSE -1 END), 0)::int AS net, last.amount, last.customer_id
         FROM mdm.coupon_redemption r
         LEFT JOIN LATERAL (
           SELECT r2.amount_pesewas::text AS amount, r2.customer_id FROM mdm.coupon_redemption r2
            WHERE r2.coupon_id = $1 AND r2.source_document_id = $2 AND r2.direction = 'REDEEM'
            ORDER BY r2.recorded_at DESC, r2.id DESC LIMIT 1
         ) last ON true
        WHERE r.coupon_id = $1 AND r.source_document_id = $2
        GROUP BY last.amount, last.customer_id`,
      [couponId, sourceDocumentId],
    );
    const row = rows[0];
    return row === undefined || row.net < 1 ? null : { amountPesewas: BigInt(row.amount!), customerId: row.customer_id };
  }

  async insertRedemption(tx: Transaction, r: NewRedemption): Promise<void> {
    await tx.query(
      'INSERT INTO mdm.coupon_redemption (id, coupon_id, customer_id, source_document_id, direction, amount_pesewas, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [r.id, r.couponId, r.customerId, r.sourceDocumentId, r.direction, r.amountPesewas.toString(), r.actorId],
    );
  }

  private async withTargets(tx: Transaction, rows: readonly PromotionRecord[]): Promise<PromotionRow[]> {
    if (rows.length === 0) {
      return [];
    }
    const { rows: targets } = await tx.query<TargetRecord>(
      `SELECT t.promotion_id, t.product_id, p.sku, p.name AS product_name, t.category_id, c.code AS category_code, c.name AS category_name,
              t.bundle_qty::text AS bundle_qty
         FROM mdm.promotion_target t
         LEFT JOIN mdm.product p ON p.id = t.product_id
         LEFT JOIN mdm.category c ON c.id = t.category_id
        WHERE t.promotion_id = ANY($1::uuid[])
        ORDER BY t.promotion_id, t.id`,
      [rows.map((row) => row.id)],
    );
    const byPromotion = new Map<string, TargetRow[]>();
    for (const target of targets) {
      const list = byPromotion.get(target.promotion_id) ?? [];
      list.push({
        product: target.product_id === null ? null : { id: target.product_id, sku: target.sku!, name: target.product_name! },
        category: target.category_id === null ? null : { id: target.category_id, code: target.category_code!, name: target.category_name! },
        bundleQty: target.bundle_qty,
      });
      byPromotion.set(target.promotion_id, list);
    }
    return rows.map((row) => toPromotion(row, byPromotion.get(row.id) ?? []));
  }
}
