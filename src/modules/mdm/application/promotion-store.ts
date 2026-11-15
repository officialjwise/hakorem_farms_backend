import type { Transaction } from '../../../platform/database/unit-of-work';
import type { Channel } from '../domain/pricing/pricing-engine';
import type { PromotionKind, PromotionScope, PromotionStatus } from '../domain/pricing/promotions';

export interface TargetRow {
  readonly product: { readonly id: string; readonly sku: string; readonly name: string } | null;
  readonly category: { readonly id: string; readonly code: string; readonly name: string } | null;
  /** Three-place decimal string, or null outside a bundle. */
  readonly bundleQty: string | null;
}

export interface PromotionRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: PromotionKind;
  /** NUMERIC(7,4) as PostgreSQL prints it ("5.0000"), or null. */
  readonly percentOff: string | null;
  readonly amountOffPesewas: bigint | null;
  readonly bundlePricePesewas: bigint | null;
  readonly appliesTo: PromotionScope;
  readonly channel: Channel | null;
  readonly minOrderPesewas: bigint | null;
  readonly stackGroup: string;
  readonly isExclusive: boolean;
  readonly requiresCoupon: boolean;
  readonly maxRedemptions: number | null;
  /** Uses counted on all its coupons, net of releases. */
  readonly redemptions: number;
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly status: PromotionStatus;
  readonly approvalRequestId: string | null;
  readonly branchId: string;
  readonly targets: readonly TargetRow[];
  readonly version: number;
  readonly createdAt: Date;
}

export interface NewPromotion {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: PromotionKind;
  readonly percentOff: string | null;
  readonly amountOffPesewas: bigint | null;
  readonly bundlePricePesewas: bigint | null;
  readonly appliesTo: PromotionScope;
  readonly channel: Channel | null;
  readonly minOrderPesewas: bigint | null;
  readonly stackGroup: string;
  readonly isExclusive: boolean;
  readonly requiresCoupon: boolean;
  readonly maxRedemptions: number | null;
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly branchId: string;
}

export interface TargetInput {
  readonly productId: string | null;
  readonly categoryId: string | null;
  readonly bundleQty: string | null;
}

export interface DraftChange {
  readonly name: string;
  readonly percentOff: string | null;
  readonly amountOffPesewas: bigint | null;
  readonly validTo: Date;
}

export interface CouponRow {
  readonly id: string;
  readonly promotionId: string;
  readonly code: string;
  readonly maxUses: number | null;
  readonly perCustomerLimit: number | null;
  readonly usedCount: number;
  readonly version: number;
}

export interface PromotionFilter {
  readonly status?: PromotionStatus | undefined;
  readonly channel?: Channel | undefined;
}

export interface NewRedemption {
  readonly id: string;
  readonly couponId: string;
  readonly customerId: string | null;
  readonly sourceDocumentId: string;
  readonly direction: 'REDEEM' | 'RELEASE';
  readonly amountPesewas: bigint;
  readonly actorId: string;
}

/** MDM's promotion reads and writes, each in the caller's transaction. */
export interface PromotionStore {
  firstBranchId(tx: Transaction): Promise<string>;
  insert(tx: Transaction, promotion: NewPromotion, actorId: string): Promise<void>;
  replaceTargets(tx: Transaction, promotionId: string, targets: readonly TargetInput[], actorId: string, nextId: () => string): Promise<void>;
  promotion(tx: Transaction, id: string, forUpdate: boolean): Promise<PromotionRow | null>;
  /** Up to `limit + 1` rows, newest first, so the caller can tell whether another page follows. */
  page(tx: Transaction, filter: PromotionFilter, afterId: string | null, limit: number): Promise<readonly PromotionRow[]>;
  /** Changes a draft at the expected version; false if it moved meanwhile. */
  updateDraft(tx: Transaction, id: string, expectedVersion: number, change: DraftChange, actorId: string): Promise<boolean>;
  touch(tx: Transaction, id: string, expectedVersion: number, actorId: string): Promise<boolean>;
  markPending(tx: Transaction, id: string, approvalRequestId: string, actorId: string): Promise<void>;
  activate(tx: Transaction, id: string, validFrom: Date, actorId: string, at: Date): Promise<void>;
  reject(tx: Transaction, id: string, actorId: string): Promise<void>;
  /** Ends an active promotion at `at`, or at its own end if that came first; never before it starts. */
  end(tx: Transaction, id: string, at: Date, actorId: string): Promise<void>;
  /** ACTIVE promotions whose window holds `at`, for the channel or every channel. */
  inForce(tx: Transaction, channel: Channel, at: Date): Promise<readonly PromotionRow[]>;
  /** The ids among these that name no live product or category. */
  missingTargets(
    tx: Transaction,
    productIds: readonly string[],
    categoryIds: readonly string[],
  ): Promise<{ readonly products: ReadonlySet<string>; readonly categories: ReadonlySet<string> }>;
  /** Up to `limit + 1` coupons, oldest first. */
  coupons(tx: Transaction, promotionId: string, afterId: string | null, limit: number): Promise<readonly CouponRow[]>;
  coupon(tx: Transaction, id: string): Promise<CouponRow | null>;
  couponByCode(tx: Transaction, code: string): Promise<CouponRow | null>;
  insertCoupon(
    tx: Transaction,
    coupon: {
      readonly id: string;
      readonly promotionId: string;
      readonly code: string;
      readonly maxUses: number | null;
      readonly perCustomerLimit: number | null;
    },
    actorId: string,
  ): Promise<void>;
  /** Uses of a coupon by one customer, net of releases. */
  customerUses(tx: Transaction, couponId: string, customerId: string): Promise<number>;
  /** The use a document holds of a coupon: its redeemed amount and customer, or null if it holds none. */
  heldUse(tx: Transaction, couponId: string, sourceDocumentId: string): Promise<{ readonly amountPesewas: bigint; readonly customerId: string | null } | null>;
  insertRedemption(tx: Transaction, redemption: NewRedemption): Promise<void>;
}

export const PROMOTION_STORE = Symbol('PROMOTION_STORE');
