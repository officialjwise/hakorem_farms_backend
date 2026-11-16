import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import type { ApprovalPendingView, Page } from '../application/purchase-command';
import { PurchaseOrders, type PurchaseOrderView } from '../application/purchase-orders';
import { SupplierInvoices, type SupplierInvoiceView } from '../application/supplier-invoices';
import { SupplierPayments, type SupplierPaymentView, type SupplierRemittanceView } from '../application/supplier-payments';
import { SupplierScores, type SupplierScoreView } from '../application/supplier-scores';
import {
  IdParam,
  PurchaseOrderCreate,
  PurchaseOrderPageQuery,
  PurchaseOrderSend,
  PurchaseOrderUpdate,
  ReasonBody,
  SupplierInvoiceCreate,
  SupplierInvoicePageQuery,
  SupplierInvoiceUpdate,
  SupplierInvoiceVarianceRequest,
  SupplierPaymentCreate,
  SupplierPaymentMarkPaid,
  SupplierPaymentPageQuery,
  SupplierScorePageQuery,
} from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/**
 * Purchase to pay (FR-PUR-005 to FR-PUR-010, FR-PUR-012, B7): purchase orders, supplier invoices with the three-way
 * match, and supplier payments. The controller parses and delegates; the handlers authorise, judge and decide the status.
 */
@Controller()
export class PurchasingController {
  constructor(
    @Inject(PurchaseOrders) private readonly orders: PurchaseOrders,
    @Inject(SupplierInvoices) private readonly invoices: SupplierInvoices,
    @Inject(SupplierPayments) private readonly payments: SupplierPayments,
    @Inject(SupplierScores) private readonly scores: SupplierScores,
  ) {}

  @Get('purchase-orders')
  @Operation({ operationId: 'listPurchaseOrders', ...READ, permission: 'pur.purchase_order.read' })
  listPurchaseOrders(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PurchaseOrderPageQuery)) query: z.infer<typeof PurchaseOrderPageQuery>): Promise<Page<PurchaseOrderView>> {
    return this.orders.list(actor, { status: query.status, supplierId: query.supplierId, from: query.from, to: query.to }, query.cursor, query.limit);
  }

  @Post('purchase-orders')
  @Operation({ operationId: 'createPurchaseOrder', ...WRITE, permission: 'pur.purchase_order.create' })
  createPurchaseOrder(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(PurchaseOrderCreate)) body: z.infer<typeof PurchaseOrderCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PurchaseOrderView> {
    return reply(res, this.orders.create(actor, body, key));
  }

  @Get('purchase-orders/:id')
  @Operation({ operationId: 'getPurchaseOrder', ...READ, permission: 'pur.purchase_order.read' })
  getPurchaseOrder(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<PurchaseOrderView> {
    return this.orders.get(actor, id);
  }

  @Patch('purchase-orders/:id')
  @Operation({ operationId: 'updatePurchaseOrder', ...WRITE, permission: 'pur.purchase_order.create' })
  updatePurchaseOrder(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(PurchaseOrderUpdate)) body: z.infer<typeof PurchaseOrderUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PurchaseOrderView> {
    return reply(res, this.orders.update(actor, id, body, key));
  }

  @Post('purchase-orders/:id/submit')
  @Operation({ operationId: 'submitPurchaseOrder', ...WRITE, permission: 'pur.purchase_order.create' })
  submitPurchaseOrder(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PurchaseOrderView | ApprovalPendingView> {
    return reply(res, this.orders.submit(actor, id, key));
  }

  @Post('purchase-orders/:id/send')
  @Operation({ operationId: 'sendPurchaseOrder', ...WRITE, permission: 'pur.purchase_order.send' })
  sendPurchaseOrder(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(PurchaseOrderSend)) body: z.infer<typeof PurchaseOrderSend>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PurchaseOrderView> {
    return reply(res, this.orders.send(actor, id, body, key));
  }

  @Post('purchase-orders/:id/close')
  @Operation({ operationId: 'closePurchaseOrder', ...WRITE, permission: 'pur.purchase_order.close' })
  closePurchaseOrder(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PurchaseOrderView> {
    return reply(res, this.orders.close(actor, id, body.reason, key));
  }

  @Post('purchase-orders/:id/cancel')
  @Operation({ operationId: 'cancelPurchaseOrder', ...WRITE, permission: 'pur.purchase_order.close' })
  cancelPurchaseOrder(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PurchaseOrderView> {
    return reply(res, this.orders.cancel(actor, id, body.reason, key));
  }

  @Get('supplier-invoices')
  @Operation({ operationId: 'listSupplierInvoices', ...READ, permission: 'pur.supplier_invoice.read' })
  listSupplierInvoices(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(SupplierInvoicePageQuery)) query: z.infer<typeof SupplierInvoicePageQuery>): Promise<Page<SupplierInvoiceView>> {
    return this.invoices.list(
      actor,
      { status: query.status, kind: query.kind, supplierId: query.supplierId, matchStatus: query.matchStatus, dueBefore: query.dueBefore, outstandingOnly: query.outstandingOnly ?? false },
      query.cursor,
      query.limit,
    );
  }

  @Post('supplier-invoices')
  @Operation({ operationId: 'createSupplierInvoice', ...WRITE, permission: 'pur.supplier_invoice.create' })
  createSupplierInvoice(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(SupplierInvoiceCreate)) body: z.infer<typeof SupplierInvoiceCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierInvoiceView> {
    return reply(res, this.invoices.create(actor, body, key));
  }

  @Get('supplier-invoices/:id')
  @Operation({ operationId: 'getSupplierInvoice', ...READ, permission: 'pur.supplier_invoice.read' })
  getSupplierInvoice(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<SupplierInvoiceView> {
    return this.invoices.get(actor, id);
  }

  @Patch('supplier-invoices/:id')
  @Operation({ operationId: 'updateSupplierInvoice', ...WRITE, permission: 'pur.supplier_invoice.create' })
  updateSupplierInvoice(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(SupplierInvoiceUpdate)) body: z.infer<typeof SupplierInvoiceUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierInvoiceView> {
    return reply(res, this.invoices.update(actor, id, body, key));
  }

  @Post('supplier-invoices/:id/match')
  @Operation({ operationId: 'matchSupplierInvoice', ...WRITE, permission: 'pur.supplier_invoice.match' })
  matchSupplierInvoice(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierInvoiceView> {
    return reply(res, this.invoices.match(actor, id, key));
  }

  @Post('supplier-invoices/:id/approve')
  @Operation({ operationId: 'approveSupplierInvoice', ...WRITE, permission: 'pur.supplier_invoice.approve' })
  approveSupplierInvoice(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierInvoiceView> {
    return reply(res, this.invoices.approve(actor, id, key));
  }

  @Post('supplier-invoices/:id/submit')
  @Operation({ operationId: 'submitSupplierCreditNote', ...WRITE, permission: 'pur.supplier_invoice.create' })
  submitSupplierCreditNote(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalPendingView> {
    return reply(res, this.invoices.submitCreditNote(actor, id, key));
  }

  @Post('supplier-invoices/:id/variance')
  @Operation({ operationId: 'requestSupplierInvoiceVariance', ...WRITE, permission: 'pur.supplier_invoice.approve' })
  requestSupplierInvoiceVariance(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(SupplierInvoiceVarianceRequest)) body: z.infer<typeof SupplierInvoiceVarianceRequest>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalPendingView> {
    return reply(res, this.invoices.requestVariance(actor, id, body.reason, key));
  }

  @Post('supplier-invoices/:id/cancel')
  @Operation({ operationId: 'cancelSupplierInvoice', ...WRITE, permission: 'pur.supplier_invoice.create' })
  cancelSupplierInvoice(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierInvoiceView> {
    return reply(res, this.invoices.cancel(actor, id, body.reason, key));
  }

  @Get('supplier-payments')
  @Operation({ operationId: 'listSupplierPayments', ...READ, permission: 'pur.supplier_payment.read' })
  listSupplierPayments(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(SupplierPaymentPageQuery)) query: z.infer<typeof SupplierPaymentPageQuery>): Promise<Page<SupplierPaymentView>> {
    return this.payments.list(actor, { status: query.status, supplierId: query.supplierId, scheduledBefore: query.scheduledBefore }, query.cursor, query.limit);
  }

  @Post('supplier-payments')
  @Operation({ operationId: 'createSupplierPayment', ...WRITE, permission: 'pur.supplier_payment.create' })
  createSupplierPayment(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(SupplierPaymentCreate)) body: z.infer<typeof SupplierPaymentCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierPaymentView> {
    return reply(res, this.payments.create(actor, body, key));
  }

  @Get('supplier-payments/:id')
  @Operation({ operationId: 'getSupplierPayment', ...READ, permission: 'pur.supplier_payment.read' })
  getSupplierPayment(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<SupplierPaymentView> {
    return this.payments.get(actor, id);
  }

  @Get('supplier-payments/:id/remittance')
  @Operation({ operationId: 'getSupplierPaymentRemittance', ...READ, permission: 'pur.supplier_payment.read' })
  getSupplierPaymentRemittance(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<SupplierRemittanceView> {
    return this.payments.remittance(actor, id);
  }

  @Get('supplier-scores')
  @Operation({ operationId: 'listSupplierScores', ...READ, permission: 'pur.supplier.read' })
  listSupplierScores(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(SupplierScorePageQuery)) query: z.infer<typeof SupplierScorePageQuery>): Promise<Page<SupplierScoreView>> {
    return this.scores.list(actor, query.periodStart, query.supplierId, query.cursor, query.limit);
  }

  @Post('supplier-payments/:id/submit')
  @Operation({ operationId: 'submitSupplierPayment', ...WRITE, permission: 'pur.supplier_payment.create' })
  submitSupplierPayment(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalPendingView> {
    return reply(res, this.payments.submit(actor, id, key));
  }

  @Post('supplier-payments/:id/mark-paid')
  @Operation({ operationId: 'markSupplierPaymentPaid', ...WRITE, permission: 'pur.supplier_payment.pay' })
  markSupplierPaymentPaid(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(SupplierPaymentMarkPaid)) body: z.infer<typeof SupplierPaymentMarkPaid>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierPaymentView> {
    return reply(res, this.payments.markPaid(actor, id, body, key));
  }

  @Post('supplier-payments/:id/cancel')
  @Operation({ operationId: 'cancelSupplierPayment', ...WRITE, permission: 'pur.supplier_payment.create' })
  cancelSupplierPayment(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupplierPaymentView> {
    return reply(res, this.payments.cancel(actor, id, body.reason, key));
  }
}
