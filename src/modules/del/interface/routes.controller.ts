import { Body, Controller, Get, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { Page } from '../application/deliveries';
import { Routes, type RouteView } from '../application/routes';
import { DriverPageQuery, IdParam, MyRouteQuery, RouteCreate, RoutePageQuery, RouteStopsReplace } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

/** A driver's run for a day, for the back office (FR-DEL-005, CR-056 items 3 and 4). Parses and delegates. */
@Controller('routes')
export class RoutesController {
  constructor(@Inject(Routes) private readonly routes: Routes) {}

  @Get()
  @Operation({ operationId: 'listRoutes', ...READ, permission: 'del.route.read' })
  listRoutes(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(RoutePageQuery)) query: z.infer<typeof RoutePageQuery>): Promise<Page<RouteView>> {
    return this.routes.list(actor, { date: query.date ?? null, driverId: query.driverId ?? null }, query.cursor, query.limit);
  }

  @Post()
  @Operation({ operationId: 'createRoute', ...WRITE, permission: 'del.route.manage' })
  async createRoute(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(RouteCreate)) body: z.infer<typeof RouteCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RouteView> {
    const response = await this.routes.create(actor, body, key);
    res.status(response.status);
    return response.body;
  }

  @Get(':id')
  @Operation({ operationId: 'getRoute', ...READ, permission: 'del.route.read' })
  getRoute(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<RouteView> {
    return this.routes.get(actor, id);
  }

  @Put(':id/stops')
  @Operation({ operationId: 'reorderRouteStops', ...WRITE, permission: 'del.route.manage' })
  async reorderRouteStops(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(RouteStopsReplace)) body: z.infer<typeof RouteStopsReplace>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RouteView> {
    const response = await this.routes.reorder(actor, id, body, key);
    res.status(response.status);
    return response.body;
  }

  @Post(':id/start')
  @Operation({ operationId: 'startRoute', ...WRITE, permission: 'del.route.manage' })
  async startRoute(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<RouteView> {
    const response = await this.routes.start(actor, id, key);
    res.status(response.status);
    return response.body;
  }

  @Post(':id/complete')
  @Operation({ operationId: 'completeRoute', ...WRITE, permission: 'del.route.manage' })
  async completeRoute(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<RouteView> {
    const response = await this.routes.complete(actor, id, key);
    res.status(response.status);
    return response.body;
  }
}

/** Who a delivery or a run may be given (CR-056 item 4). Parses and delegates. */
@Controller('drivers')
export class DriversController {
  constructor(@Inject(Routes) private readonly routes: Routes) {}

  @Get()
  @Operation({ operationId: 'listDrivers', ...READ, permission: 'del.route.manage' })
  listDrivers(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(DriverPageQuery)) query: z.infer<typeof DriverPageQuery>): Promise<Page<{ readonly id: string; readonly displayName: string }>> {
    return this.routes.drivers(actor, query.branchId, query.cursor, query.limit);
  }
}

/** The driver's own run (FR-DEL-005, FR-DEL-006, CR-057 point 2). Parses and delegates. */
@Controller('driver/route')
export class DriverRouteController {
  constructor(@Inject(Routes) private readonly routes: Routes) {}

  @Get()
  @Operation({ operationId: 'getMyRoute', ...READ, permission: 'del.delivery.read.assigned' })
  getMyRoute(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(MyRouteQuery)) query: z.infer<typeof MyRouteQuery>): Promise<RouteView> {
    return this.routes.getMine(actor, query.date);
  }
}
