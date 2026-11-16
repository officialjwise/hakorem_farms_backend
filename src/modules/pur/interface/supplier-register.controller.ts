import { Body, Controller, Get, Inject, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import type { ApprovalPendingView, Page } from '../application/purchase-command';
import type { PurchaseOrderView } from '../application/purchase-orders';
import { Requisitions, type PurchaseRequisitionView } from '../application/requisitions';
import { Suppliers, type SupplierDocumentView, type SupplierPayoutDetailsView, type SupplierProfileView } from '../application/suppliers';
import {
  IdParam,
  PageQuery,
  PurchaseRequisitionCreate,
  PurchaseRequisitionPageQuery,
  PurchaseRequisitionUpdate,
  ReasonBody,
  RequisitionConvert,
  SupplierDocumentCreate,
  SupplierProfileUpdate,
} from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/**
 * The supplier register's procurement half and requisitions (FR-PUR-001 to FR-PUR-004, B07 continued): terms, payout
 * details (masked; in full only with their own permission), supplier documents, and requisitions converted into
 * purchase orders. The controller parses and delegates; the handlers authorise and decide.
 */
@Controller()
export class SupplierRegisterController {
  constructor(
    @Inject(Suppliers) private readonly suppliers: Suppliers,
    @Inject(Requisitions) private readonly requisitions: Requisitions,
  ) {}

  @Get('suppliers/:id/profile')
  @Operation({ operationId: 'getSupplierProfile', ...READ, permission: 'pur.supplier.read' })
  getSupplierProfile(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<SupplierProfileView> {
    return this.suppliers.getProfile(actor, id);
  }

  @Put('suppliers/:id/profile')
  @Operation({ operationId: 'updateSupplierProfile', ...WRITE, permission: 'pur.supplier.update' })
  updateSupplierProfile(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(SupplierProfileUpdate)) body: z.infer<typeof SupplierProfileUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierProfileView | ApprovalPendingView> {
    return reply(res, this.suppliers.updateProfile(actor, id, body, key));
  }

  @Get('suppliers/:id/payout-details')
  @Operation({ operationId: 'getSupplierPayoutDetails', ...READ, permission: 'pur.supplier.payout_read' })
  getSupplierPayoutDetails(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<SupplierPayoutDetailsView> {
    return this.suppliers.payoutDetails(actor, id);
  }

  @Get('suppliers/:id/documents')
  @Operation({ operationId: 'listSupplierDocuments', ...READ, permission: 'pur.supplier.read' })
  listSupplierDocuments(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>,
  ): Promise<Page<SupplierDocumentView>> {
    return this.suppliers.listDocuments(actor, id, query.cursor, query.limit);
  }

  @Post('suppliers/:id/documents')
  @Operation({ operationId: 'addSupplierDocument', ...WRITE, permission: 'pur.supplier.update' })
  addSupplierDocument(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(SupplierDocumentCreate)) body: z.infer<typeof SupplierDocumentCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierDocumentView> {
    return reply(res, this.suppliers.addDocument(actor, id, body, key));
  }

  @Get('purchase-requisitions')
  @Operation({ operationId: 'listPurchaseRequisitions', ...READ, permission: 'pur.requisition.read' })
  listPurchaseRequisitions(
    @CurrentActor() actor: Actor | undefined,
    @Query(zodPipe(PurchaseRequisitionPageQuery)) query: z.infer<typeof PurchaseRequisitionPageQuery>,
  ): Promise<Page<PurchaseRequisitionView>> {
    return this.requisitions.list(actor, { status: query.status, requestedBy: query.requestedBy }, query.cursor, query.limit);
  }

  @Post('purchase-requisitions')
  @Operation({ operationId: 'createPurchaseRequisition', ...WRITE, permission: 'pur.requisition.create' })
  createPurchaseRequisition(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(PurchaseRequisitionCreate)) body: z.infer<typeof PurchaseRequisitionCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PurchaseRequisitionView> {
    return reply(res, this.requisitions.create(actor, body, key));
  }

  @Get('purchase-requisitions/:id')
  @Operation({ operationId: 'getPurchaseRequisition', ...READ, permission: 'pur.requisition.read' })
  getPurchaseRequisition(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<PurchaseRequisitionView> {
    return this.requisitions.get(actor, id);
  }

  @Patch('purchase-requisitions/:id')
  @Operation({ operationId: 'updatePurchaseRequisition', ...WRITE, permission: 'pur.requisition.create' })
  updatePurchaseRequisition(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(PurchaseRequisitionUpdate)) body: z.infer<typeof PurchaseRequisitionUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PurchaseRequisitionView> {
    return reply(res, this.requisitions.update(actor, id, body, key));
  }

  @Post('purchase-requisitions/:id/submit')
  @Operation({ operationId: 'submitPurchaseRequisition', ...WRITE, permission: 'pur.requisition.create' })
  submitPurchaseRequisition(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PurchaseRequisitionView> {
    return reply(res, this.requisitions.submit(actor, id, key));
  }

  @Post('purchase-requisitions/:id/reject')
  @Operation({ operationId: 'rejectPurchaseRequisition', ...WRITE, permission: 'pur.requisition.approve' })
  rejectPurchaseRequisition(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PurchaseRequisitionView> {
    return reply(res, this.requisitions.reject(actor, id, body.reason, key));
  }

  @Post('purchase-requisitions/:id/convert')
  @Operation({ operationId: 'convertPurchaseRequisition', ...WRITE, permission: 'pur.purchase_order.create' })
  convertPurchaseRequisition(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(RequisitionConvert)) body: z.infer<typeof RequisitionConvert>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PurchaseOrderView> {
    return reply(res, this.requisitions.convert(actor, id, body, key));
  }
}
