import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { LocationsAdmin } from '../application/locations-admin';
import type { BranchView, LocationView } from '../application/locations-store';
import type { Page } from '../application/product-catalogue';
import { ArchiveBody, BranchCreate, BranchUpdate, IdParam, ListLocationsQuery, LocationCreate, LocationUpdate, PageQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Branches and locations (FR-MDM-006). The controller parses and delegates; the handlers authorise and decide. */
@Controller()
export class LocationsController {
  constructor(@Inject(LocationsAdmin) private readonly admin: LocationsAdmin) {}

  @Get('branches')
  @Operation({ operationId: 'listBranches', ...READ, permission: 'mdm.branch.read' })
  listBranches(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<BranchView>> {
    return this.admin.listBranches(actor, query.cursor, query.limit);
  }

  @Post('branches')
  @Operation({ operationId: 'createBranch', ...WRITE, permission: 'mdm.branch.create' })
  createBranch(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(BranchCreate)) body: z.infer<typeof BranchCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BranchView> {
    return reply(res, this.admin.createBranch(actor, body, key));
  }

  @Get('branches/:id')
  @Operation({ operationId: 'getBranch', ...READ, permission: 'mdm.branch.read' })
  getBranch(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<BranchView> {
    return this.admin.getBranch(actor, id);
  }

  @Patch('branches/:id')
  @Operation({ operationId: 'updateBranch', ...WRITE, permission: 'mdm.branch.update' })
  updateBranch(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(BranchUpdate)) body: z.infer<typeof BranchUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BranchView> {
    return reply(res, this.admin.updateBranch(actor, id, body, key));
  }

  @Get('locations')
  @Operation({ operationId: 'listLocations', ...READ, permission: 'mdm.location.read' })
  listLocations(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListLocationsQuery)) query: z.infer<typeof ListLocationsQuery>): Promise<Page<LocationView>> {
    return this.admin.listLocations(actor, { branchId: query.branchId, kind: query.kind, parentId: query.parentId, includeVirtual: query.includeVirtual }, query.cursor, query.limit);
  }

  @Post('locations')
  @Operation({ operationId: 'createLocation', ...WRITE, permission: 'mdm.location.create' })
  createLocation(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(LocationCreate)) body: z.infer<typeof LocationCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LocationView> {
    return reply(res, this.admin.createLocation(actor, body, key));
  }

  @Get('locations/:id')
  @Operation({ operationId: 'getLocation', ...READ, permission: 'mdm.location.read' })
  getLocation(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<LocationView> {
    return this.admin.getLocation(actor, id);
  }

  @Patch('locations/:id')
  @Operation({ operationId: 'updateLocation', ...WRITE, permission: 'mdm.location.update' })
  updateLocation(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(LocationUpdate)) body: z.infer<typeof LocationUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LocationView> {
    return reply(res, this.admin.updateLocation(actor, id, body, key));
  }

  @Post('locations/:id/archive')
  @Operation({ operationId: 'archiveLocation', ...WRITE, permission: 'mdm.location.archive' })
  archiveLocation(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ArchiveBody)) body: z.infer<typeof ArchiveBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LocationView> {
    return reply(res, this.admin.archiveLocation(actor, id, body, key));
  }
}
