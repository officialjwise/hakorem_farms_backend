import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { OnlineOrders, type CustomerOrderSummaryView, type CustomerOrderView, type OrderTrackingView } from '../application/online-orders';
import type { Page } from '../application/orders';
import { IdParam, PageQuery, TrackingTokenParam } from './schemas';

/** A signed-in customer's own orders (FR-SHP-010): ownership, no permission code. Parses and delegates. */
@Controller('me/orders')
export class MyOrdersController {
  constructor(@Inject(OnlineOrders) private readonly online: OnlineOrders) {}

  @Get()
  @Operation({ operationId: 'listMyOrders', access: 'SESSION', realms: ['CUSTOMER'], permission: null, idempotent: false, csrf: false, rateLimit: 'console' })
  listMyOrders(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<CustomerOrderSummaryView>> {
    return this.online.mine(actor, query.cursor, query.limit);
  }

  @Get(':id')
  @Operation({ operationId: 'getMyOrder', access: 'SESSION', realms: ['CUSTOMER'], permission: null, idempotent: false, csrf: false, rateLimit: 'console' })
  getMyOrder(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<CustomerOrderView> {
    return this.online.mineOne(actor, id);
  }
}

/** An order's progress by its signed tracking link (FR-SHP-009): no session; the token is the only key. */
@Controller('shop/orders/track')
export class OrderTrackingController {
  constructor(@Inject(OnlineOrders) private readonly online: OnlineOrders) {}

  @Get(':token')
  @Operation({ operationId: 'trackOrder', access: 'PUBLIC', realms: [], permission: null, idempotent: false, csrf: false, rateLimit: 'public' })
  trackOrder(@Param('token', zodPipe(TrackingTokenParam)) token: string): Promise<OrderTrackingView> {
    return this.online.track(token);
  }
}
