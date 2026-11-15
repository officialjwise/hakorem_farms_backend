import { createHash } from 'node:crypto';
import { createUuidV7Generator, Money, Rate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import { databaseErrorOf, sqlStateOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { InvalidStateTransitionError, NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { translate } from '../../../platform/i18n/messages';
import type { Approvals, ApprovalHandler, ApprovalRecord, Authoriser } from '../../iam';
import type { Channel } from '../domain/pricing/pricing-engine';
import {
  defineCoupon,
  definePromotion,
  judgeCoupon,
  type CouponRefusal,
  type PromotionDraft,
  type PromotionKind,
  type PromotionRule,
  type PromotionScope,
  type PromotionStatus,
} from '../domain/pricing/promotions';
import type { PromotionActivated, PromotionEnded } from '../events';
import { CouponInvalidError, CouponUnavailableError, DuplicateRecordError, PromotionInvalidError, referencesNotFound } from './errors';
import type { CouponRow, PromotionFilter, PromotionRow, PromotionStore, TargetInput } from './promotion-store';
import { percentText, type Page } from './tax-admin';

export const CREATE_PROMOTION = 'createPromotion';
export const UPDATE_PROMOTION = 'updatePromotion';
export const SUBMIT_PROMOTION = 'submitPromotion';
export const END_PROMOTION = 'endPromotion';
export const CREATE_COUPON = 'createCoupon';
export const LIST_PROMOTIONS = 'listPromotions';
export const LIST_COUPONS = 'listCoupons';
export const PROMOTION_ACTIVATION = 'PROMOTION_ACTIVATION';

/** The contract's `PromotionTarget`. */
export interface PromotionTargetView {
  readonly product: { readonly id: string; readonly sku: string; readonly name: string } | null;
  readonly category: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly bundleQty: string | null;
}

/** The contract's `Promotion`. */
export interface PromotionView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: PromotionKind;
  readonly percentOff: string | null;
  readonly amountOffPesewas: number | null;
  readonly bundlePricePesewas: number | null;
  readonly appliesTo: PromotionScope;
  readonly channel: Channel | null;
  readonly minOrderPesewas: number | null;
  readonly stackGroup: string;
  readonly isExclusive: boolean;
  readonly requiresCoupon: boolean;
  readonly maxRedemptions: number | null;
  readonly redemptions: number;
  readonly validFrom: string;
  readonly validTo: string;
  readonly status: PromotionStatus;
  readonly approvalRequestId: string | null;
  readonly targets: readonly PromotionTargetView[];
  readonly currency: 'GHS';
  readonly version: number;
  readonly createdAt: string;
}

/** The contract's `Coupon`. */
export interface CouponView {
  readonly id: string;
  readonly promotionId: string;
  readonly code: string;
  readonly maxUses: number | null;
  readonly perCustomerLimit: number | null;
  readonly usedCount: number;
  readonly version: number;
}

/** The contract's `CouponValidation`. */
export interface CouponValidationView {
  readonly valid: boolean;
  readonly reason: 'NOT_FOUND' | CouponRefusal | null;
  readonly promotion: { readonly id: string; readonly code: string; readonly name: string } | null;
}

/** The contract's `ApprovalPending`, the 202 body of submitPromotion. */
export interface PromotionApprovalPendingView {
  readonly status: 'PENDING_APPROVAL';
  readonly approvalRequestId: string;
  readonly kind: typeof PROMOTION_ACTIVATION;
  readonly subject: { readonly id: string; readonly docType: 'PROMOTION'; readonly number: null };
  readonly summary: string;
  readonly requestedAt: string;
}

export interface PromotionCreateRequest {
  readonly code: string;
  readonly name: string;
  readonly kind: PromotionKind;
  readonly percentOff?: string | undefined;
  readonly amountOffPesewas?: bigint | undefined;
  readonly bundlePricePesewas?: bigint | undefined;
  readonly appliesTo: PromotionScope;
  readonly channel?: Channel | undefined;
  readonly minOrderPesewas?: bigint | undefined;
  readonly stackGroup?: string | undefined;
  readonly isExclusive?: boolean | undefined;
  readonly requiresCoupon?: boolean | undefined;
  readonly maxRedemptions?: number | undefined;
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly targets?: readonly TargetRequest[] | undefined;
}

export interface TargetRequest {
  readonly productId?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly bundleQty?: string | undefined;
}

export interface PromotionUpdateRequest {
  readonly version: number;
  readonly name?: string | undefined;
  readonly percentOff?: string | undefined;
  readonly amountOffPesewas?: bigint | undefined;
  readonly validTo?: Date | undefined;
  readonly targets?: readonly TargetRequest[] | undefined;
}

/** A use of a coupon by a selling module, inside its own transaction (B7, B9a). */
export interface CouponRedemptionRequest {
  readonly code: string;
  readonly customerId: string | null;
  /** The order or sale the discount belongs to, registered as a business document. */
  readonly sourceDocumentId: string;
  /** The discount the coupon's promotion gave on that document. */
  readonly amountPesewas: bigint;
  readonly actorId: string;
}

const DETAIL_REFUSAL: ReadonlySet<string> = new Set(['EXPIRED', 'LIMIT_REACHED', 'NOT_APPLICABLE', 'ALREADY_USED']);

/**
 * The lock a selling module names in `seriesLocks` when its transaction redeems a coupon. The database holds the
 * limit by row lock whatever the caller does; taking this lock before the transaction starts makes concurrent
 * redemptions of one code queue instead of failing serialization and retrying (ADR-0040).
 */
export function couponLockKey(code: string): string {
  return `mdm.coupon:${code.trim().toUpperCase()}`;
}

function money(pesewas: bigint | null): number | null {
  return pesewas === null ? null : Money.ofPesewas(pesewas).toJsonInteger();
}

export function promotionView(row: PromotionRow): PromotionView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    percentOff: row.percentOff === null ? null : percentText(row.percentOff),
    amountOffPesewas: money(row.amountOffPesewas),
    bundlePricePesewas: money(row.bundlePricePesewas),
    appliesTo: row.appliesTo,
    channel: row.channel,
    minOrderPesewas: money(row.minOrderPesewas),
    stackGroup: row.stackGroup,
    isExclusive: row.isExclusive,
    requiresCoupon: row.requiresCoupon,
    maxRedemptions: row.maxRedemptions,
    redemptions: row.redemptions,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo.toISOString(),
    status: row.status,
    approvalRequestId: row.approvalRequestId,
    targets: row.targets.map((target) => ({ product: target.product, category: target.category, bundleQty: target.bundleQty })),
    currency: 'GHS',
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}

function couponView(row: CouponRow): CouponView {
  return { ...row };
}

/** A promotion as the pure engine takes it. */
export function promotionRule(row: PromotionRow): PromotionRule {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    percentOff: row.percentOff === null ? null : Rate.parsePercent(row.percentOff),
    amountOffPesewas: row.amountOffPesewas,
    appliesTo: row.appliesTo,
    channel: row.channel,
    minOrderPesewas: row.minOrderPesewas,
    stackGroup: row.stackGroup,
    isExclusive: row.isExclusive,
    requiresCoupon: row.requiresCoupon,
    validFrom: row.validFrom,
    validTo: row.validTo,
    productIds: row.targets.flatMap((target) => (target.product === null ? [] : [target.product.id])),
    categoryIds: row.targets.flatMap((target) => (target.category === null ? [] : [target.category.id])),
  };
}

function targetInputs(targets: readonly TargetRequest[]): TargetInput[] {
  return targets.map((target) => ({ productId: target.productId ?? null, categoryId: target.categoryId ?? null, bundleQty: target.bundleQty ?? null }));
}

function wrongStatus(row: PromotionRow, action: string, needed: PromotionStatus): InvalidStateTransitionError {
  return new InvalidStateTransitionError(`promotion ${row.id} is ${row.status}; ${action} needs ${needed}`, [
    { field: null, code: row.status, message: translate('error.invalid_state_transition') },
  ]);
}

/**
 * Promotions and coupons (FR-MDM-018, ADR-0004, ADR-0040): a promotion is drafted, changed while a draft, submitted
 * and activated by a different user (PROMOTION_ACTIVATION, step-up), and can be ended early with a reason. This class
 * is the approval handler IAM calls in the approval's transaction, and MDM's door for the selling modules to redeem
 * and release a coupon inside their own transaction. Every write is serializable, claims its idempotency key first
 * and writes its audit event in the same transaction.
 */
export class Promotions implements ApprovalHandler {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: PromotionStore,
    private readonly authoriser: Authoriser,
    private readonly approvals: Approvals,
    private readonly documents: DocumentRegistry,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  async list(actor: Actor | undefined, filter: PromotionFilter, cursor: string | undefined, limit: number): Promise<Page<PromotionView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.promotion.read');
      const binding = {
        operationId: LIST_PROMOTIONS,
        principalId: actor!.principalId,
        filters: { status: filter.status ?? null, channel: filter.channel ?? null },
      };
      const position = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const rows = await this.store.page(tx, filter, position?.['id'] ?? null, limit);
      const data = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      return { data: data.map(promotionView), page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: data.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  async get(actor: Actor | undefined, id: string): Promise<PromotionView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.promotion.read');
      return promotionView(await this.found(tx, id, false));
    });
  }

  async create(actor: Actor | undefined, body: PromotionCreateRequest, idempotencyKey: string): Promise<StoredResponse<PromotionView>> {
    try {
      return await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        await this.authoriser.authorise(tx, actor, 'mdm.promotion.create');
        const claim = await this.idempotency.claim(tx, { operationId: CREATE_PROMOTION, principalId: actor!.principalId, key: idempotencyKey, request: body });
        if (claim.kind === 'REPLAY') {
          return claim.response as StoredResponse<PromotionView>;
        }
        const targets = targetInputs(body.targets ?? []);
        this.check({
          kind: body.kind,
          percentOff: body.percentOff ?? null,
          amountOffPesewas: body.amountOffPesewas ?? null,
          bundlePricePesewas: body.bundlePricePesewas ?? null,
          appliesTo: body.appliesTo,
          maxRedemptions: body.maxRedemptions ?? null,
          validFrom: body.validFrom,
          validTo: body.validTo,
          targets,
        });
        await this.checkTargetsExist(tx, targets);
        const id = this.nextId();
        const branchId = await this.store.firstBranchId(tx);
        await this.documents.register(tx, { id, docType: 'PROMOTION', ownerModule: 'mdm', branchId, actorId: actor!.principalId });
        await this.store.insert(
          tx,
          {
            id,
            code: body.code,
            name: body.name,
            kind: body.kind,
            percentOff: body.percentOff ?? null,
            amountOffPesewas: body.amountOffPesewas ?? null,
            bundlePricePesewas: body.bundlePricePesewas ?? null,
            appliesTo: body.appliesTo,
            channel: body.channel ?? null,
            minOrderPesewas: body.minOrderPesewas ?? null,
            stackGroup: body.stackGroup ?? 'DEFAULT',
            isExclusive: body.isExclusive ?? false,
            requiresCoupon: body.requiresCoupon ?? false,
            maxRedemptions: body.maxRedemptions ?? null,
            validFrom: body.validFrom,
            validTo: body.validTo,
            branchId,
          },
          actor!.principalId,
        );
        await this.store.replaceTargets(tx, id, targets, actor!.principalId, this.nextId);
        const view = promotionView((await this.store.promotion(tx, id, false))!);
        await this.audit.record(tx, { module: 'mdm', action: 'CREATE', entityType: 'Promotion', entityId: id, branchId, before: null, after: { ...view } });
        const response = { status: 201, body: view };
        await this.idempotency.complete(tx, claim.id, response);
        return response;
      });
    } catch (error) {
      if (sqlStateOf(error) === '23505' && databaseErrorOf(error)?.constraint === 'uq_promotion_code') {
        throw new DuplicateRecordError(['/code']);
      }
      throw error;
    }
  }

  /** Changes a draft: its name, its value, its end and its targets. The merged promotion is checked as a whole. */
  async update(actor: Actor | undefined, id: string, body: PromotionUpdateRequest, idempotencyKey: string): Promise<StoredResponse<PromotionView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.promotion.update');
      const claim = await this.idempotency.claim(tx, {
        operationId: UPDATE_PROMOTION,
        principalId: actor!.principalId,
        key: idempotencyKey,
        request: { id, ...body },
      });
      if (claim.kind === 'REPLAY') {
        return claim.response as StoredResponse<PromotionView>;
      }
      const row = await this.found(tx, id, true);
      if (row.status !== 'DRAFT') {
        throw wrongStatus(row, 'changing it', 'DRAFT');
      }
      if (row.version !== body.version) {
        throw new VersionConflictError(`promotion ${id} is at version ${row.version}, not ${body.version}`);
      }
      const before = promotionView(row);
      const targets = body.targets === undefined ? null : targetInputs(body.targets);
      const change = {
        name: body.name ?? row.name,
        percentOff: body.percentOff ?? row.percentOff,
        amountOffPesewas: body.amountOffPesewas ?? row.amountOffPesewas,
        validTo: body.validTo ?? row.validTo,
      };
      this.check({
        kind: row.kind,
        percentOff: change.percentOff,
        amountOffPesewas: change.amountOffPesewas,
        bundlePricePesewas: row.bundlePricePesewas,
        appliesTo: row.appliesTo,
        maxRedemptions: row.maxRedemptions,
        validFrom: row.validFrom,
        validTo: change.validTo,
        targets:
          targets ??
          row.targets.map((target) => ({ productId: target.product?.id ?? null, categoryId: target.category?.id ?? null, bundleQty: target.bundleQty })),
      });
      if (targets !== null) {
        await this.checkTargetsExist(tx, targets);
        await this.store.replaceTargets(tx, id, targets, actor!.principalId, this.nextId);
      }
      if (!(await this.store.updateDraft(tx, id, row.version, change, actor!.principalId))) {
        throw new VersionConflictError(`promotion ${id} changed while it was updated`);
      }
      const view = promotionView((await this.store.promotion(tx, id, false))!);
      await this.audit.record(tx, {
        module: 'mdm',
        action: 'UPDATE',
        entityType: 'Promotion',
        entityId: id,
        branchId: row.branchId,
        before: { ...before },
        after: { ...view },
      });
      const response = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  async submit(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<PromotionApprovalPendingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.promotion.update');
      const claim = await this.idempotency.claim(tx, { operationId: SUBMIT_PROMOTION, principalId: actor!.principalId, key: idempotencyKey, request: { id } });
      if (claim.kind === 'REPLAY') {
        return claim.response as StoredResponse<PromotionApprovalPendingView>;
      }
      const row = await this.found(tx, id, true);
      if (row.status !== 'DRAFT') {
        throw wrongStatus(row, 'submitting it', 'DRAFT');
      }
      if (row.validTo.getTime() <= this.clock.now().getTime()) {
        throw new InvalidStateTransitionError(`promotion ${id} ended before it was submitted`, [
          { field: '/validTo', code: 'WINDOW_PASSED', message: translate('error.invalid_state_transition') },
        ]);
      }
      const discount =
        row.percentOff !== null
          ? `${percentText(row.percentOff)}% off`
          : row.amountOffPesewas !== null
            ? `GHS ${Money.ofPesewas(row.amountOffPesewas).toDecimalString()} off`
            : row.kind;
      const summary = `Activate promotion ${row.code} (${discount}) from ${row.validFrom.toISOString()} to ${row.validTo.toISOString()}`;
      const request = await this.approvals.request(tx, actor, {
        kind: PROMOTION_ACTIVATION,
        branchId: row.branchId,
        subjectDocumentId: id,
        payloadHash: await this.currentPayloadHash(tx, id),
        summary,
      });
      await this.store.markPending(tx, id, request.id, actor!.principalId);
      await this.audit.record(tx, {
        module: 'mdm',
        action: 'SUBMIT',
        entityType: 'Promotion',
        entityId: id,
        branchId: row.branchId,
        before: { status: 'DRAFT' },
        after: { status: 'PENDING_APPROVAL', approvalRequestId: request.id },
      });
      const body: PromotionApprovalPendingView = {
        status: 'PENDING_APPROVAL',
        approvalRequestId: request.id,
        kind: PROMOTION_ACTIVATION,
        subject: { id, docType: 'PROMOTION', number: null },
        summary,
        requestedAt: request.requestedAt.toISOString(),
      };
      const response = { status: 202, body };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** Ends an active promotion now, with a reason; from this moment it discounts nothing. */
  async end(actor: Actor | undefined, id: string, reason: string, idempotencyKey: string): Promise<StoredResponse<PromotionView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.promotion.update');
      const claim = await this.idempotency.claim(tx, {
        operationId: END_PROMOTION,
        principalId: actor!.principalId,
        key: idempotencyKey,
        request: { id, reason },
      });
      if (claim.kind === 'REPLAY') {
        return claim.response as StoredResponse<PromotionView>;
      }
      const row = await this.found(tx, id, true);
      if (row.status !== 'ACTIVE') {
        throw wrongStatus(row, 'ending it', 'ACTIVE');
      }
      await this.store.end(tx, id, this.clock.now(), actor!.principalId);
      const view = promotionView((await this.store.promotion(tx, id, false))!);
      await this.audit.record(tx, {
        module: 'mdm',
        action: 'END',
        entityType: 'Promotion',
        entityId: id,
        branchId: row.branchId,
        before: { status: row.status, validTo: row.validTo.toISOString() },
        after: { status: view.status, validTo: view.validTo },
        metadata: { reason },
      });
      const payload: PromotionEnded = { promotionId: id, code: row.code, validTo: view.validTo, reason };
      await this.events.publish(tx, { type: 'mdm.PromotionEnded', subjectType: 'Promotion', subjectId: id, branchId: row.branchId, payload });
      const response = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  async listCoupons(actor: Actor | undefined, promotionId: string, cursor: string | undefined, limit: number): Promise<Page<CouponView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.promotion.read');
      await this.found(tx, promotionId, false);
      const binding = { operationId: LIST_COUPONS, principalId: actor!.principalId, filters: { promotionId } };
      const position = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const rows = await this.store.coupons(tx, promotionId, position?.['id'] ?? null, limit);
      const data = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      return { data: data.map(couponView), page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: data.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  async createCoupon(
    actor: Actor | undefined,
    promotionId: string,
    body: { readonly code: string; readonly maxUses?: number | undefined; readonly perCustomerLimit?: number | undefined },
    idempotencyKey: string,
  ): Promise<StoredResponse<CouponView>> {
    try {
      return await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        await this.authoriser.authorise(tx, actor, 'mdm.promotion.update');
        const claim = await this.idempotency.claim(tx, {
          operationId: CREATE_COUPON,
          principalId: actor!.principalId,
          key: idempotencyKey,
          request: { promotionId, ...body },
        });
        if (claim.kind === 'REPLAY') {
          return claim.response as StoredResponse<CouponView>;
        }
        const promotion = await this.found(tx, promotionId, false);
        if (!promotion.requiresCoupon || promotion.status === 'ENDED' || promotion.status === 'REJECTED') {
          throw new InvalidStateTransitionError(`promotion ${promotionId} takes no new coupon`, [
            { field: null, code: promotion.requiresCoupon ? promotion.status : 'COUPON_NOT_REQUIRED', message: translate('error.invalid_state_transition') },
          ]);
        }
        const defined = defineCoupon({ code: body.code, maxUses: body.maxUses ?? null, perCustomerLimit: body.perCustomerLimit ?? null });
        if (!defined.ok) {
          throw new CouponInvalidError([{ field: defined.error.field, rule: defined.error.code }]);
        }
        const id = this.nextId();
        await this.store.insertCoupon(tx, { id, promotionId, ...defined.value }, actor!.principalId);
        const view = couponView((await this.store.coupon(tx, id))!);
        await this.audit.record(tx, {
          module: 'mdm',
          action: 'CREATE',
          entityType: 'Coupon',
          entityId: id,
          branchId: promotion.branchId,
          before: null,
          after: { ...view },
        });
        const response = { status: 201, body: view };
        await this.idempotency.complete(tx, claim.id, response);
        return response;
      });
    } catch (error) {
      if (sqlStateOf(error) === '23505' && databaseErrorOf(error)?.constraint === 'uq_coupon_code') {
        throw new DuplicateRecordError(['/code']);
      }
      throw error;
    }
  }

  /**
   * validateCoupon: public and read-only. Says whether a code could be used now, never who has used it: the
   * per-customer limit is checked when the coupon is redeemed, not here (ADR-0040). No cart exists before B7, so a
   * cart id names nothing.
   */
  async validate(request: { readonly code: string; readonly cartId?: string | undefined }): Promise<CouponValidationView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      if (request.cartId !== undefined) {
        throw referencesNotFound(['/cartId']);
      }
      const coupon = await this.store.couponByCode(tx, request.code.trim().toUpperCase());
      if (coupon === null) {
        return { valid: false, reason: 'NOT_FOUND', promotion: null };
      }
      const promotion = (await this.store.promotion(tx, coupon.promotionId, false))!;
      const refusal = judgeCoupon(
        { ...coupon, promotionStatus: promotion.status, validFrom: promotion.validFrom, validTo: promotion.validTo },
        0,
        this.clock.now(),
      );
      return refusal === null
        ? { valid: true, reason: null, promotion: { id: promotion.id, code: promotion.code, name: promotion.name } }
        : { valid: false, reason: refusal, promotion: null };
    });
  }

  /**
   * Redeems a coupon for a document, inside the selling module's transaction. Checked first so the refusal names its
   * reason, then counted by the database under a row lock, which holds every limit even if two callers race. The
   * caller passes `couponLockKey(code)` in `seriesLocks`, so concurrent redemptions queue instead of retrying.
   */
  async redeemIn(tx: Transaction, request: CouponRedemptionRequest): Promise<{ readonly couponId: string; readonly promotionId: string }> {
    const coupon = await this.store.couponByCode(tx, request.code.trim().toUpperCase());
    if (coupon === null) {
      throw referencesNotFound(['/couponCode']);
    }
    const promotion = (await this.store.promotion(tx, coupon.promotionId, false))!;
    const customerUses = request.customerId === null ? 0 : await this.store.customerUses(tx, coupon.id, request.customerId);
    const refusal = judgeCoupon(
      { ...coupon, promotionStatus: promotion.status, validFrom: promotion.validFrom, validTo: promotion.validTo },
      customerUses,
      this.clock.now(),
    );
    if (refusal !== null) {
      throw new CouponUnavailableError('/couponCode', refusal);
    }
    try {
      await this.store.insertRedemption(tx, {
        id: this.nextId(),
        couponId: coupon.id,
        customerId: request.customerId,
        sourceDocumentId: request.sourceDocumentId,
        direction: 'REDEEM',
        amountPesewas: request.amountPesewas,
        actorId: request.actorId,
      });
    } catch (error) {
      const detail = databaseErrorOf(error)?.detail ?? '';
      if (sqlStateOf(error) === 'HK006' && DETAIL_REFUSAL.has(detail)) {
        throw new CouponUnavailableError('/couponCode', detail);
      }
      throw error;
    }
    return { couponId: coupon.id, promotionId: promotion.id };
  }

  /** Releases the use a cancelled document holds of a coupon, inside the caller's transaction. */
  async releaseIn(tx: Transaction, request: { readonly code: string; readonly sourceDocumentId: string; readonly actorId: string }): Promise<void> {
    const coupon = await this.store.couponByCode(tx, request.code.trim().toUpperCase());
    if (coupon === null) {
      throw referencesNotFound(['/couponCode']);
    }
    const held = await this.store.heldUse(tx, coupon.id, request.sourceDocumentId);
    if (held === null) {
      throw new InvalidStateTransitionError(`document ${request.sourceDocumentId} holds no use of coupon ${coupon.code}`, [
        { field: '/couponCode', code: 'NOTHING_TO_RELEASE', message: translate('error.invalid_state_transition') },
      ]);
    }
    await this.store.insertRedemption(tx, {
      id: this.nextId(),
      couponId: coupon.id,
      customerId: held.customerId,
      sourceDocumentId: request.sourceDocumentId,
      direction: 'RELEASE',
      amountPesewas: held.amountPesewas,
      actorId: request.actorId,
    });
  }

  /** ApprovalHandler: the hash of the promotion's terms and targets; nothing in it can change while it is submitted. */
  async currentPayloadHash(tx: Transaction, subjectDocumentId: string): Promise<string> {
    const view = promotionView(await this.found(tx, subjectDocumentId, false));
    const terms = { ...view, status: null, approvalRequestId: null, version: null, redemptions: null };
    return createHash('sha256').update(canonicalJson(terms)).digest('hex');
  }

  /**
   * ApprovalHandler: activates the promotion in the approval's transaction, from its start or from the moment of
   * approval if later (ADR-0040), so a late approval never discounts a sale already priced.
   */
  async onApproved(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const row = (await this.store.promotion(tx, request.subjectDocumentId, true))!;
    const now = this.clock.now();
    if (row.validTo.getTime() <= now.getTime()) {
      throw new InvalidStateTransitionError(`promotion ${row.id} ended before it was approved`, [
        { field: '/validTo', code: 'WINDOW_PASSED', message: translate('error.invalid_state_transition') },
      ]);
    }
    const validFrom = row.validFrom.getTime() < now.getTime() ? now : row.validFrom;
    await this.store.activate(tx, row.id, validFrom, request.decidedBy!, now);
    await this.audit.record(tx, {
      module: 'mdm',
      action: 'ACTIVATE',
      entityType: 'Promotion',
      entityId: row.id,
      branchId: row.branchId,
      before: { status: row.status, validFrom: row.validFrom.toISOString() },
      after: { status: 'ACTIVE', validFrom: validFrom.toISOString(), validTo: row.validTo.toISOString() },
      metadata: { approvalRequestId: request.id },
    });
    const payload: PromotionActivated = { promotionId: row.id, code: row.code, validFrom: validFrom.toISOString(), validTo: row.validTo.toISOString() };
    await this.events.publish(tx, { type: 'mdm.PromotionActivated', subjectType: 'Promotion', subjectId: row.id, branchId: row.branchId, payload });
  }

  /** ApprovalHandler: a rejected promotion is REJECTED and frozen. */
  async onRejected(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const row = (await this.store.promotion(tx, request.subjectDocumentId, true))!;
    await this.store.reject(tx, row.id, request.decidedBy!);
    await this.audit.record(tx, {
      module: 'mdm',
      action: 'REJECT',
      entityType: 'Promotion',
      entityId: row.id,
      branchId: row.branchId,
      before: { status: row.status },
      after: { status: 'REJECTED' },
      metadata: { approvalRequestId: request.id },
    });
  }

  private check(draft: PromotionDraft): void {
    const defined = definePromotion(draft);
    if (!defined.ok) {
      throw new PromotionInvalidError([{ field: defined.error.field, rule: defined.error.code }]);
    }
  }

  private async checkTargetsExist(tx: Transaction, targets: readonly TargetInput[]): Promise<void> {
    const productIds = targets.flatMap((target) => (target.productId === null ? [] : [target.productId]));
    const categoryIds = targets.flatMap((target) => (target.categoryId === null ? [] : [target.categoryId]));
    const missing = await this.store.missingTargets(tx, productIds, categoryIds);
    const pointers = targets.flatMap((target, index) => [
      ...(target.productId !== null && missing.products.has(target.productId) ? [`/targets/${index}/productId`] : []),
      ...(target.categoryId !== null && missing.categories.has(target.categoryId) ? [`/targets/${index}/categoryId`] : []),
    ]);
    if (pointers.length > 0) {
      throw referencesNotFound(pointers);
    }
  }

  private async found(tx: Transaction, id: string, forUpdate: boolean): Promise<PromotionRow> {
    const row = await this.store.promotion(tx, id, forUpdate);
    if (row === null) {
      throw new NotFoundError('no such promotion');
    }
    return row;
  }
}
