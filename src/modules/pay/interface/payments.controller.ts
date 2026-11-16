import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { currentRequestContext, type Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { Payments, type Page, type PaymentDocumentView } from '../application/payments';
import { ProviderPayments } from '../application/provider-payments';
import { Receipts } from '../application/receipts';
import { Receivables, type OpenItemPageView } from '../application/receivables';
import { Refunds, type ApprovalPendingView, type RefundView } from '../application/refunds';
import { StoreCredit, type StoreCreditView } from '../application/store-credit';
import { PaymentWebhooks, WEBHOOK_ACTOR } from '../application/webhooks';
import { AllocationBody, ChequeClearanceBody, IdParam, MobileMoneyChargeBody, OpenItemQuery, PageQuery, PaymentPageQuery, ProviderParam, RecordPaymentBody, RefundBody, RefundMarkPaidBody, RefundPageQuery, ReversalBody, UnallocateBody } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

const dateOrNull = (value: string | undefined) => (value === undefined ? null : new Date(value));

/** Payments, allocations and provider charges (FR-PAY-003 to FR-PAY-010). Parses and delegates. */
@Controller('payments')
export class PaymentsController {
  constructor(
    @Inject(Payments) private readonly payments: Payments,
    @Inject(ProviderPayments) private readonly providerPayments: ProviderPayments,
    @Inject(Receipts) private readonly receipts: Receipts,
  ) {}

  @Post()
  @Operation({ operationId: 'recordPayment', ...WRITE, permission: 'pay.payment.create' })
  recordPayment(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(RecordPaymentBody)) body: z.infer<typeof RecordPaymentBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentDocumentView> {
    return reply(
      res,
      this.receipts.record(
        actor,
        {
          id: body.id,
          paymentMethodId: body.paymentMethodId,
          amountPesewas: BigInt(body.amountPesewas),
          customerId: body.customerId ?? null,
          orderId: body.orderId ?? null,
          shiftId: body.shiftId ?? null,
          bankAccountId: body.bankAccountId ?? null,
          externalReference: body.externalReference ?? null,
          chequeDueOn: body.chequeDueOn ?? null,
          receivedAt: new Date(body.receivedAt),
          allocations: (body.allocations ?? []).map((a) => ({ billingDocumentId: a.billingDocumentId, amountPesewas: BigInt(a.amountPesewas) })),
        },
        key,
      ),
    );
  }

  @Get()
  @Operation({ operationId: 'listPayments', ...READ, permission: 'pay.payment.read' })
  listPayments(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PaymentPageQuery)) query: z.infer<typeof PaymentPageQuery>): Promise<Page<PaymentDocumentView>> {
    return this.payments.list(
      actor,
      {
        status: query.status ?? null,
        methodKind: query.methodKind ?? null,
        customerId: query.customerId ?? null,
        orderId: query.orderId ?? null,
        shiftId: query.shiftId ?? null,
        from: dateOrNull(query.from),
        to: dateOrNull(query.to),
        unallocatedOnly: query.unallocatedOnly ?? false,
      },
      query.cursor,
      query.limit,
    );
  }

  @Get('unmatched')
  @Operation({ operationId: 'listUnmatchedPayments', ...READ, permission: 'pay.payment.read' })
  listUnmatchedPayments(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<PaymentDocumentView>> {
    return this.payments.listUnmatched(actor, query.cursor, query.limit);
  }

  @Post('mobile-money')
  @Operation({ operationId: 'initiateMobileMoneyCharge', ...WRITE, rateLimit: 'checkout', permission: 'pay.payment.initiate' })
  initiateMobileMoneyCharge(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(MobileMoneyChargeBody)) body: z.infer<typeof MobileMoneyChargeBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentDocumentView> {
    return reply(
      res,
      this.providerPayments.initiate(
        actor,
        { id: body.id, amountPesewas: BigInt(body.amountPesewas), payerPhone: body.payerPhone, network: body.network, orderId: body.orderId ?? null, shiftId: body.shiftId ?? null, customerId: body.customerId ?? null },
        key,
      ),
    );
  }

  @Get(':id')
  @Operation({ operationId: 'getPayment', ...READ, permission: 'pay.payment.read' })
  getPayment(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<PaymentDocumentView> {
    return this.payments.get(actor, id);
  }

  @Post(':id/check-status')
  @HttpCode(200)
  @Operation({ operationId: 'checkPaymentStatus', ...READ, csrf: true, permission: 'pay.payment.read' })
  checkPaymentStatus(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<PaymentDocumentView> {
    return this.providerPayments.checkStatus(actor, id);
  }

  @Post(':id/allocate')
  @Operation({ operationId: 'allocatePayment', ...WRITE, permission: 'pay.payment.allocate' })
  allocatePayment(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(AllocationBody)) body: z.infer<typeof AllocationBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentDocumentView> {
    return reply(res, this.payments.allocate(actor, id, { allocations: body.allocations.map((a) => ({ billingDocumentId: a.billingDocumentId, amountPesewas: BigInt(a.amountPesewas) })) }, key));
  }

  @Post(':id/reverse')
  @Operation({ operationId: 'reversePayment', ...WRITE, permission: 'pay.payment.reverse' })
  reversePayment(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReversalBody)) body: z.infer<typeof ReversalBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalPendingView> {
    return reply(res, this.receipts.requestReversal(actor, id, { reasonCode: body.reasonCode, note: body.note ?? null }, key));
  }

  @Post(':id/clear-cheque')
  @Operation({ operationId: 'clearCheque', ...WRITE, permission: 'pay.payment.clear_cheque' })
  clearCheque(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ChequeClearanceBody)) body: z.infer<typeof ChequeClearanceBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentDocumentView> {
    return reply(res, this.receipts.clearCheque(actor, id, body, key));
  }

  @Post(':id/unallocate')
  @Operation({ operationId: 'unallocatePayment', ...WRITE, permission: 'pay.payment.allocate' })
  unallocatePayment(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(UnallocateBody)) body: z.infer<typeof UnallocateBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentDocumentView> {
    return reply(res, this.payments.unallocate(actor, id, body, key));
  }
}

/** Refunds against an original payment (FR-PAY-012, FR-PAY-013). Parses and delegates. */
@Controller('refunds')
export class RefundsController {
  constructor(@Inject(Refunds) private readonly refunds: Refunds) {}

  @Get()
  @Operation({ operationId: 'listRefunds', ...READ, permission: 'pay.refund.read' })
  listRefunds(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(RefundPageQuery)) query: z.infer<typeof RefundPageQuery>): Promise<Page<RefundView>> {
    return this.refunds.list(actor, { status: query.status ?? null, createdBy: query.createdBy ?? null, from: dateOrNull(query.from), to: dateOrNull(query.to) }, query.cursor, query.limit);
  }

  @Post()
  @Operation({ operationId: 'requestRefund', ...WRITE, permission: 'pay.refund.create' })
  requestRefund(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(RefundBody)) body: z.infer<typeof RefundBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalPendingView> {
    return reply(
      res,
      this.refunds.request(
        actor,
        { originalPaymentId: body.originalPaymentId, amountPesewas: BigInt(body.amountPesewas), destination: body.destination, reasonCode: body.reasonCode, creditNoteId: body.creditNoteId ?? null, note: body.note ?? null },
        key,
      ),
    );
  }

  @Get(':id')
  @Operation({ operationId: 'getRefund', ...READ, permission: 'pay.refund.read' })
  getRefund(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<RefundView> {
    return this.refunds.get(actor, id);
  }

  @Post(':id/retry')
  @Operation({ operationId: 'retryRefund', ...WRITE, permission: 'pay.refund.create' })
  retryRefund(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<RefundView> {
    return reply(res, this.refunds.retry(actor, id, key));
  }

  @Post(':id/mark-paid')
  @Operation({ operationId: 'markRefundPaid', ...WRITE, permission: 'pay.refund.pay' })
  markRefundPaid(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(RefundMarkPaidBody)) body: z.infer<typeof RefundMarkPaidBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RefundView> {
    return reply(res, this.refunds.markPaid(actor, id, { paidAt: new Date(body.paidAt), externalReference: body.externalReference ?? null }, key));
  }
}

/**
 * The payment provider's webhook (FR-PAY-004, docs/API.md section 13). Public: the signature over the raw body is the
 * only credential, checked first by the handler; the route acts as the webhook's own principal, which holds no grant.
 */
@Controller('webhooks/payments')
export class WebhooksController {
  constructor(@Inject(PaymentWebhooks) private readonly webhooks: PaymentWebhooks) {}

  @Post(':provider')
  @HttpCode(200)
  @Operation({ operationId: 'receivePaymentWebhook', access: 'PUBLIC', realms: [], permission: null, idempotent: false, csrf: false, rateLimit: 'public', publicActor: WEBHOOK_ACTOR })
  receivePaymentWebhook(@Param('provider', zodPipe(ProviderParam)) provider: string, @Headers('x-paystack-signature') signature: string | undefined, @Req() req: Request): Promise<{ readonly received: true }> {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    return this.webhooks.receive({ provider, rawBody: raw, signature, sourceIp: req.ip ?? null, correlationId: currentRequestContext()?.correlationId ?? null });
  }
}

/** A customer's store credit, for staff (FR-PAY-015). Parses and delegates. */
@Controller('customers')
export class StoreCreditController {
  constructor(@Inject(StoreCredit) private readonly storeCredit: StoreCredit) {}

  @Get(':id/store-credit')
  @Operation({ operationId: 'getCustomerStoreCredit', ...READ, permission: 'pay.store_credit.read' })
  getCustomerStoreCredit(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<StoreCreditView> {
    return this.storeCredit.forCustomer(actor, id);
  }
}

/** A signed-in customer's own store credit (FR-PAY-015): ownership, no permission code. */
@Controller('me')
export class MyStoreCreditController {
  constructor(@Inject(StoreCredit) private readonly storeCredit: StoreCredit) {}

  @Get('store-credit')
  @Operation({ operationId: 'getMyStoreCredit', access: 'SESSION', realms: ['CUSTOMER'], permission: null, idempotent: false, csrf: false, rateLimit: 'console' })
  getMyStoreCredit(@CurrentActor() actor: Actor | undefined): Promise<StoreCreditView> {
    return this.storeCredit.mine(actor);
  }
}

/** Open items: what customers still owe (FR-PAY-009). Parses and delegates. */
@Controller('receivables')
export class ReceivablesController {
  constructor(@Inject(Receivables) private readonly receivables: Receivables) {}

  @Get('open-items')
  @Operation({ operationId: 'listOpenItems', ...READ, permission: 'pay.receivable.read' })
  listOpenItems(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(OpenItemQuery)) query: z.infer<typeof OpenItemQuery>): Promise<OpenItemPageView> {
    return this.receivables.list(actor, { customerId: query.customerId ?? null, overdueOnly: query.overdueOnly ?? false, asOf: query.asOf ?? null }, query.cursor, query.limit);
  }
}
