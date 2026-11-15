import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Page } from '../application/product-catalogue';
import { ReferenceDataAdmin, type DeliveryQuoteView, type DeliveryZoneView, type SupplierView } from '../application/reference-data-admin';
import type { PaymentMethodView, ReasonCodeView } from '../application/reference-data-store';
import {
  ArchiveBody,
  DeliveryQuoteRequest,
  DeliveryZoneCreate,
  DeliveryZoneUpdate,
  IdParam,
  ListDeliveryZonesQuery,
  ListPaymentMethodsQuery,
  ListReasonCodesQuery,
  ListSuppliersQuery,
  PaymentMethodUpdate,
  SupplierCreate,
  SupplierUpdate,
} from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/**
 * Suppliers (FR-MDM-007), payment methods (FR-MDM-009), delivery zones and the delivery quote (FR-MDM-010) and the
 * fixed reason codes (FR-MDM-011). The controller parses and delegates; the handlers authorise and decide.
 */
@Controller()
export class ReferenceDataController {
  constructor(@Inject(ReferenceDataAdmin) private readonly admin: ReferenceDataAdmin) {}

  @Get('suppliers')
  @Operation({ operationId: 'listSuppliers', ...READ, permission: 'mdm.supplier.read' })
  listSuppliers(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListSuppliersQuery)) query: z.infer<typeof ListSuppliersQuery>): Promise<Page<SupplierView>> {
    return this.admin.listSuppliers(actor, { q: query.q, categoryId: query.categoryId, status: query.status }, query.cursor, query.limit);
  }

  @Post('suppliers')
  @Operation({ operationId: 'createSupplier', ...WRITE, permission: 'mdm.supplier.create' })
  createSupplier(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(SupplierCreate)) body: z.infer<typeof SupplierCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierView> {
    return reply(res, this.admin.createSupplier(actor, body, key));
  }

  @Get('suppliers/:id')
  @Operation({ operationId: 'getSupplier', ...READ, permission: 'mdm.supplier.read' })
  getSupplier(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<SupplierView> {
    return this.admin.getSupplier(actor, id);
  }

  @Patch('suppliers/:id')
  @Operation({ operationId: 'updateSupplier', ...WRITE, permission: 'mdm.supplier.update' })
  updateSupplier(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(SupplierUpdate)) body: z.infer<typeof SupplierUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierView> {
    return reply(res, this.admin.updateSupplier(actor, id, body, key));
  }

  @Post('suppliers/:id/archive')
  @Operation({ operationId: 'archiveSupplier', ...WRITE, permission: 'mdm.supplier.archive' })
  archiveSupplier(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ArchiveBody)) body: z.infer<typeof ArchiveBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierView> {
    return reply(res, this.admin.archiveSupplier(actor, id, body, key));
  }

  @Get('payment-methods')
  @Operation({ operationId: 'listPaymentMethods', ...READ, permission: 'mdm.payment_method.read' })
  listPaymentMethods(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListPaymentMethodsQuery)) query: z.infer<typeof ListPaymentMethodsQuery>): Promise<Page<PaymentMethodView>> {
    return this.admin.listPaymentMethods(actor, query.includeDisabled, query.cursor, query.limit);
  }

  @Patch('payment-methods/:id')
  @Operation({ operationId: 'updatePaymentMethod', ...WRITE, permission: 'mdm.payment_method.manage' })
  updatePaymentMethod(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(PaymentMethodUpdate)) body: z.infer<typeof PaymentMethodUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentMethodView> {
    return reply(res, this.admin.updatePaymentMethod(actor, id, body, key));
  }

  @Get('delivery-zones')
  @Operation({ operationId: 'listDeliveryZones', ...READ, permission: 'mdm.delivery_zone.read' })
  listDeliveryZones(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListDeliveryZonesQuery)) query: z.infer<typeof ListDeliveryZonesQuery>): Promise<Page<DeliveryZoneView>> {
    return this.admin.listZones(actor, query.branchId, query.cursor, query.limit);
  }

  @Post('delivery-zones')
  @Operation({ operationId: 'createDeliveryZone', ...WRITE, permission: 'mdm.delivery_zone.create' })
  createDeliveryZone(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(DeliveryZoneCreate)) body: z.infer<typeof DeliveryZoneCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryZoneView> {
    return reply(res, this.admin.createZone(actor, body, key));
  }

  @Get('delivery-zones/:id')
  @Operation({ operationId: 'getDeliveryZone', ...READ, permission: 'mdm.delivery_zone.read' })
  getDeliveryZone(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<DeliveryZoneView> {
    return this.admin.getZone(actor, id);
  }

  @Patch('delivery-zones/:id')
  @Operation({ operationId: 'updateDeliveryZone', ...WRITE, permission: 'mdm.delivery_zone.update' })
  updateDeliveryZone(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(DeliveryZoneUpdate)) body: z.infer<typeof DeliveryZoneUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliveryZoneView> {
    return reply(res, this.admin.updateZone(actor, id, body, key));
  }

  /** Public and read-only: no session, no idempotency key, no CSRF; rate-limited by address like validateCoupon. */
  @Post('shop/delivery/quote')
  @HttpCode(200)
  @Operation({ operationId: 'quoteDelivery', access: 'PUBLIC', realms: [], permission: null, idempotent: false, csrf: false, rateLimit: 'public' })
  quoteDelivery(@Body(zodPipe(DeliveryQuoteRequest)) body: z.infer<typeof DeliveryQuoteRequest>): Promise<DeliveryQuoteView> {
    return this.admin.quoteDelivery(body);
  }

  @Get('reason-codes')
  @Operation({ operationId: 'listReasonCodes', ...READ, permission: 'mdm.reason_code.read' })
  listReasonCodes(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListReasonCodesQuery)) query: z.infer<typeof ListReasonCodesQuery>): Promise<Page<ReasonCodeView>> {
    return this.admin.listReasonCodes(actor, query.domain, query.cursor, query.limit);
  }
}
