import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { Promotions, type CouponValidationView, type CouponView, type PromotionApprovalPendingView, type PromotionView } from '../application/promotions';
import type { Page } from '../application/tax-admin';
import { CouponCreate, CouponValidationRequest, IdParam, ListPromotionsQuery, PageQuery, PromotionCreate, PromotionUpdate, ReasonRequest } from './schemas';

const CONSOLE_READ = { access: 'SESSION', realms: ['STAFF'], permission: 'mdm.promotion.read', idempotent: false, csrf: false, rateLimit: 'console' } as const;
const CONSOLE_WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

/**
 * Promotions and coupons (FR-MDM-018). The controller parses and delegates; the handlers authorise, do the work and
 * decide the status: 201 on create, 200 on change, 202 `ApprovalPending` on submit.
 */
@Controller()
export class PromotionsController {
  constructor(@Inject(Promotions) private readonly promotions: Promotions) {}

  @Get('promotions')
  @Operation({ operationId: 'listPromotions', ...CONSOLE_READ })
  listPromotions(
    @CurrentActor() actor: Actor | undefined,
    @Query(zodPipe(ListPromotionsQuery)) query: z.infer<typeof ListPromotionsQuery>,
  ): Promise<Page<PromotionView>> {
    return this.promotions.list(actor, { status: query.status, channel: query.channel }, query.cursor, query.limit);
  }

  @Post('promotions')
  @Operation({ operationId: 'createPromotion', ...CONSOLE_WRITE, permission: 'mdm.promotion.create' })
  async createPromotion(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(PromotionCreate)) body: z.infer<typeof PromotionCreate>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PromotionView> {
    const response = await this.promotions.create(actor, body, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  @Get('promotions/:id')
  @Operation({ operationId: 'getPromotion', ...CONSOLE_READ })
  getPromotion(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<PromotionView> {
    return this.promotions.get(actor, id);
  }

  @Patch('promotions/:id')
  @Operation({ operationId: 'updatePromotion', ...CONSOLE_WRITE, permission: 'mdm.promotion.update' })
  async updatePromotion(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(PromotionUpdate)) body: z.infer<typeof PromotionUpdate>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PromotionView> {
    const response = await this.promotions.update(actor, id, body, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  @Post('promotions/:id/submit')
  @Operation({ operationId: 'submitPromotion', ...CONSOLE_WRITE, permission: 'mdm.promotion.update' })
  async submitPromotion(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PromotionApprovalPendingView> {
    const response = await this.promotions.submit(actor, id, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  @Post('promotions/:id/end')
  @Operation({ operationId: 'endPromotion', ...CONSOLE_WRITE, permission: 'mdm.promotion.update' })
  async endPromotion(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonRequest)) body: z.infer<typeof ReasonRequest>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PromotionView> {
    const response = await this.promotions.end(actor, id, body.reason, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  @Get('promotions/:id/coupons')
  @Operation({ operationId: 'listCoupons', ...CONSOLE_READ })
  listCoupons(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>,
  ): Promise<Page<CouponView>> {
    return this.promotions.listCoupons(actor, id, query.cursor, query.limit);
  }

  @Post('promotions/:id/coupons')
  @Operation({ operationId: 'createCoupon', ...CONSOLE_WRITE, permission: 'mdm.promotion.update' })
  async createCoupon(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(CouponCreate)) body: z.infer<typeof CouponCreate>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CouponView> {
    const response = await this.promotions.createCoupon(actor, id, body, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  /** Public and read-only: no session, no idempotency key, no CSRF; rate-limited by address (ADR-0040). */
  @Post('coupons/validate')
  @HttpCode(200)
  @Operation({ operationId: 'validateCoupon', access: 'PUBLIC', realms: [], permission: null, idempotent: false, csrf: false, rateLimit: 'public' })
  validateCoupon(@Body(zodPipe(CouponValidationRequest)) body: z.infer<typeof CouponValidationRequest>): Promise<CouponValidationView> {
    return this.promotions.validate(body);
  }
}
