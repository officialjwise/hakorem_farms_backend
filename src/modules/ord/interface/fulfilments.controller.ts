import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { Dispatches } from '../application/dispatches';
import type { CreditOverridePending } from '../application/order-confirmation-policy';
import { Fulfilments, type FulfilmentView } from '../application/fulfilments';
import { OnlineOrders, type CustomerOrderView } from '../application/online-orders';
import type { Page, SalesOrderView } from '../application/orders';
import {
  CollectRecordBody,
  ConsentRecordBody,
  DispatchRecordBody,
  FulfilmentCreateBody,
  FulfilmentPageQuery,
  FulfilmentReasonBody,
  IdParam,
  MyConsentBody,
  PackRecordBody,
  PickRecordBody,
  ShortPickCreateBody,
  SubstitutionCreateBody,
} from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Pick lists, picks and packing (FR-ORD-008 to FR-ORD-011, CR-053, CR-054). Parses and delegates; `Fulfilments` authorises. */
@Controller('fulfilments')
export class FulfilmentsController {
  constructor(
    @Inject(Fulfilments) private readonly fulfilments: Fulfilments,
    @Inject(Dispatches) private readonly dispatches: Dispatches,
  ) {}

  @Get()
  @Operation({ operationId: 'listFulfilments', ...READ, permission: 'ord.fulfilment.read' })
  listFulfilments(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(FulfilmentPageQuery)) query: z.infer<typeof FulfilmentPageQuery>): Promise<Page<FulfilmentView>> {
    return this.fulfilments.list(
      actor,
      { orderId: query.orderId ?? null, status: query.status ?? null, pickLocationId: query.pickLocationId ?? null, date: query.date ?? null },
      query.cursor,
      query.limit,
    );
  }

  @Get(':id')
  @Operation({ operationId: 'getFulfilment', ...READ, permission: 'ord.fulfilment.read' })
  getFulfilment(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<FulfilmentView> {
    return this.fulfilments.get(actor, id);
  }

  @Post(':id/picks')
  @HttpCode(200)
  @Operation({ operationId: 'recordPicks', ...WRITE, permission: 'ord.fulfilment.pick' })
  recordPicks(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(PickRecordBody)) body: z.infer<typeof PickRecordBody>,
    @IdempotencyKeyHeader() key: string,
  ): Promise<FulfilmentView> {
    return this.fulfilments.recordPicks(actor, id, body, key).then((r) => r.body);
  }

  @Post(':id/pack')
  @HttpCode(200)
  @Operation({ operationId: 'packFulfilment', ...WRITE, permission: 'ord.fulfilment.pick' })
  packFulfilment(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(PackRecordBody)) body: z.infer<typeof PackRecordBody>,
    @IdempotencyKeyHeader() key: string,
  ): Promise<FulfilmentView> {
    return this.fulfilments.pack(actor, id, body, key).then((r) => r.body);
  }

  @Post(':id/collect')
  @HttpCode(200)
  @Operation({ operationId: 'collectFulfilment', ...WRITE, permission: 'ord.fulfilment.dispatch' })
  collectFulfilment(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(CollectRecordBody)) body: z.infer<typeof CollectRecordBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FulfilmentView | CreditOverridePending> {
    return reply(res, this.dispatches.collect(actor, id, key, body ?? {}));
  }

  @Post(':id/dispatch')
  @HttpCode(200)
  @Operation({ operationId: 'dispatchFulfilment', ...WRITE, permission: 'ord.fulfilment.dispatch' })
  dispatchFulfilment(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(DispatchRecordBody)) body: z.infer<typeof DispatchRecordBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FulfilmentView | CreditOverridePending> {
    return reply(res, this.dispatches.dispatch(actor, id, body, key));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Operation({ operationId: 'cancelFulfilment', ...WRITE, permission: 'ord.fulfilment.pick' })
  cancelFulfilment(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(FulfilmentReasonBody)) body: z.infer<typeof FulfilmentReasonBody>,
    @IdempotencyKeyHeader() key: string,
  ): Promise<FulfilmentView> {
    return this.fulfilments.cancel(actor, id, body, key).then((r) => r.body);
  }
}

/** An order's pick lists made, and what it asks its customer (FR-ORD-008, FR-ORD-010, FR-ORD-013, CR-054). */
@Controller('orders')
export class OrderFulfilmentController {
  constructor(@Inject(Fulfilments) private readonly fulfilments: Fulfilments) {}

  @Post(':id/fulfilments')
  @Operation({ operationId: 'createFulfilment', ...WRITE, permission: 'ord.fulfilment.pick' })
  async createFulfilment(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(FulfilmentCreateBody)) body: z.infer<typeof FulfilmentCreateBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FulfilmentView> {
    return reply(res, this.fulfilments.create(actor, id, body, key));
  }

  @Post(':id/substitutions')
  @HttpCode(200)
  @Operation({ operationId: 'proposeSubstitution', ...WRITE, permission: 'ord.fulfilment.pick' })
  proposeSubstitution(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(SubstitutionCreateBody)) body: z.infer<typeof SubstitutionCreateBody>,
    @IdempotencyKeyHeader() key: string,
  ): Promise<SalesOrderView> {
    return this.fulfilments.proposeSubstitution(actor, id, body, key).then((r) => r.body);
  }

  @Post(':id/short-picks')
  @HttpCode(200)
  @Operation({ operationId: 'proposeShortPick', ...WRITE, permission: 'ord.fulfilment.pick' })
  proposeShortPick(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ShortPickCreateBody)) body: z.infer<typeof ShortPickCreateBody>,
    @IdempotencyKeyHeader() key: string,
  ): Promise<SalesOrderView> {
    return this.fulfilments.proposeShortPick(actor, id, body, key).then((r) => r.body);
  }

  @Post(':id/consent')
  @HttpCode(200)
  @Operation({ operationId: 'recordCustomerConsent', ...WRITE, permission: 'ord.order.update' })
  recordCustomerConsent(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ConsentRecordBody)) body: z.infer<typeof ConsentRecordBody>,
    @IdempotencyKeyHeader() key: string,
  ): Promise<SalesOrderView> {
    return this.fulfilments.recordConsent(actor, id, body, key).then((r) => r.body);
  }
}

/** The signed-in customer's own answer to what their order asks (FR-ORD-013). */
@Controller('me/orders')
export class MyOrderConsentController {
  constructor(@Inject(OnlineOrders) private readonly online: OnlineOrders) {}

  @Post(':id/consent')
  @HttpCode(200)
  @Operation({ operationId: 'answerMyOrderConsent', access: 'SESSION', realms: ['CUSTOMER'], permission: null, idempotent: true, csrf: true, rateLimit: 'console' })
  answerMyOrderConsent(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(MyConsentBody)) body: z.infer<typeof MyConsentBody>,
    @IdempotencyKeyHeader() key: string,
  ): Promise<CustomerOrderView> {
    return this.online.answerMine(actor, id, body, key).then((r) => r.body);
  }
}
