import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import type { BillingDocumentView } from '../../bil';
import type { CreditOverridePending } from '../application/order-confirmation-policy';
import { Dispatches, type ExtraDeliveryFeeView } from '../application/dispatches';
import { OrderReversals, type ApprovalPendingView } from '../application/order-reversals';
import { Orders, type OrderFulfilmentView, type OrderStatusChangeView, type Page, type SalesOrderView } from '../application/orders';
import { ExtraDeliveryFeeBody, IdParam, OrderConfirmBody, OrderCreateBody, OrderPageQuery, PageQuery, ReasonCodeBody } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

const dateOrNull = (value: string | undefined) => (value === undefined ? null : new Date(value));

/**
 * The order record of every channel (FR-ORD-001, FR-ORD-002, FR-ORD-005, FR-ORD-014). Parses and delegates; `Orders`
 * and `OrderReversals` authorise.
 */
@Controller('orders')
export class OrdersController {
  constructor(
    @Inject(Orders) private readonly orders: Orders,
    @Inject(OrderReversals) private readonly reversals: OrderReversals,
    @Inject(Dispatches) private readonly dispatches: Dispatches,
  ) {}

  @Post(':id/extra-delivery-fee')
  @Operation({ operationId: 'addExtraDeliveryFee', ...WRITE, permission: 'ord.delivery_fee.add' })
  addExtraDeliveryFee(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ExtraDeliveryFeeBody)) body: z.infer<typeof ExtraDeliveryFeeBody>,
    @IdempotencyKeyHeader() key: string,
  ): Promise<ExtraDeliveryFeeView> {
    return this.dispatches.addExtraFee(actor, id, body, key).then((r) => r.body);
  }

  @Get()
  @Operation({ operationId: 'listOrders', ...READ, permission: 'ord.order.read' })
  listOrders(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(OrderPageQuery)) query: z.infer<typeof OrderPageQuery>): Promise<Page<SalesOrderView>> {
    return this.orders.list(
      actor,
      {
        channel: query.channel ?? null,
        status: query.status ?? null,
        customerId: query.customerId ?? null,
        shiftId: query.shiftId ?? null,
        salespersonId: query.salespersonId ?? null,
        from: dateOrNull(query.from),
        to: dateOrNull(query.to),
        q: query.q ?? null,
      },
      query.cursor,
      query.limit,
    );
  }

  @Post()
  @Operation({ operationId: 'createOrder', ...WRITE, permission: 'ord.order.create' })
  createOrder(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(OrderCreateBody)) body: z.infer<typeof OrderCreateBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SalesOrderView | ApprovalPendingView> {
    return reply(
      res,
      this.orders.create(
        actor,
        {
          channel: body.channel,
          customerId: body.customerId,
          fulfilmentMode: body.fulfilmentMode,
          paymentTerms: body.paymentTerms,
          deliveryAddressId: body.deliveryAddressId ?? null,
          deliverySlotId: body.deliverySlotId ?? null,
          couponCode: body.couponCode ?? null,
          notes: body.notes ?? null,
          lines: body.lines.map((l) => ({
            productId: l.productId,
            stockUnitId: l.stockUnitId ?? null,
            quantity: l.quantity,
            uom: l.uom ?? null,
            gradeId: l.gradeId ?? null,
            weightKg: l.weightKg ?? null,
            agreedUnitPricePesewas: l.agreedUnitPricePesewas === undefined ? null : BigInt(l.agreedUnitPricePesewas),
            varianceReasonCode: l.varianceReasonCode ?? null,
          })),
        },
        key,
      ),
    );
  }

  @Get(':id')
  @Operation({ operationId: 'getOrder', ...READ, permission: 'ord.order.read' })
  getOrder(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<SalesOrderView> {
    return this.orders.get(actor, id);
  }

  @Get(':id/fulfilment-view')
  @Operation({ operationId: 'getOrderFulfilmentView', ...READ, permission: 'ord.order.read.fulfilment' })
  getOrderFulfilmentView(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<OrderFulfilmentView> {
    return this.orders.getForFulfilment(actor, id);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @Operation({ operationId: 'confirmOrder', ...WRITE, permission: 'ord.order.confirm' })
  confirmOrder(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(OrderConfirmBody)) body: z.infer<typeof OrderConfirmBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SalesOrderView | CreditOverridePending> {
    return reply(res, this.orders.confirm(actor, id, key, { creditOverrideReason: body?.creditOverrideReason }));
  }

  @Post(':id/proforma')
  @HttpCode(201)
  @Operation({ operationId: 'issueProforma', ...WRITE, permission: 'bil.proforma.create' })
  issueProforma(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BillingDocumentView> {
    return reply(res, this.orders.issueProforma(actor, id, key));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Operation({ operationId: 'cancelOrder', ...WRITE, permission: 'ord.order.cancel' })
  cancelOrder(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonCodeBody)) body: z.infer<typeof ReasonCodeBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SalesOrderView> {
    return reply(res, this.reversals.cancel(actor, id, { reasonCode: body.reasonCode, note: body.note ?? null }, key));
  }

  @Post(':id/void')
  @HttpCode(202)
  @Operation({ operationId: 'voidOrder', ...WRITE, permission: 'ord.order.void' })
  voidOrder(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonCodeBody)) body: z.infer<typeof ReasonCodeBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalPendingView> {
    return reply(res, this.reversals.requestVoid(actor, id, { reasonCode: body.reasonCode, note: body.note ?? null }, key));
  }

  @Get(':id/history')
  @Operation({ operationId: 'listOrderHistory', ...READ, permission: 'ord.order.read' })
  listOrderHistory(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>,
  ): Promise<Page<OrderStatusChangeView>> {
    return this.orders.history(actor, id, query.cursor, query.limit);
  }
}
