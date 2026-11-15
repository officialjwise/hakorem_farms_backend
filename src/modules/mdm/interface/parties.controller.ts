import { Body, Controller, Get, Inject, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { PartiesAdmin, type AssignmentView, type CustomerView } from '../application/parties-admin';
import type { AddressView, TierView } from '../application/parties-store';
import type { Page } from '../application/product-catalogue';
import {
  ArchiveBody,
  CustomerAddressCreate,
  CustomerAddressUpdate,
  CustomerCreate,
  CustomerTierCreate,
  CustomerUpdate,
  IdParam,
  ListCustomersQuery,
  PageQuery,
  PriceListAssignmentInput,
} from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Customers, tiers, addresses and the assigned price list (FR-MDM-008, FR-MDM-021). The handlers authorise and decide. */
@Controller()
export class PartiesController {
  constructor(@Inject(PartiesAdmin) private readonly admin: PartiesAdmin) {}

  @Get('customers')
  @Operation({ operationId: 'listCustomers', ...READ, permission: 'mdm.customer.read' })
  listCustomers(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListCustomersQuery)) query: z.infer<typeof ListCustomersQuery>): Promise<Page<CustomerView>> {
    return this.admin.listCustomers(actor, { q: query.q, kind: query.kind, tierId: query.tierId, status: query.status }, query.cursor, query.limit);
  }

  @Post('customers')
  @Operation({ operationId: 'createCustomer', ...WRITE, permission: 'mdm.customer.create' })
  createCustomer(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(CustomerCreate)) body: z.infer<typeof CustomerCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerView> {
    return reply(res, this.admin.createCustomer(actor, body, key));
  }

  @Get('customers/:id')
  @Operation({ operationId: 'getCustomer', ...READ, permission: 'mdm.customer.read' })
  getCustomer(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<CustomerView> {
    return this.admin.getCustomer(actor, id);
  }

  @Patch('customers/:id')
  @Operation({ operationId: 'updateCustomer', ...WRITE, permission: 'mdm.customer.update' })
  updateCustomer(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(CustomerUpdate)) body: z.infer<typeof CustomerUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerView> {
    return reply(res, this.admin.updateCustomer(actor, id, body, key));
  }

  @Post('customers/:id/archive')
  @Operation({ operationId: 'archiveCustomer', ...WRITE, permission: 'mdm.customer.archive' })
  archiveCustomer(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ArchiveBody)) body: z.infer<typeof ArchiveBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerView> {
    return reply(res, this.admin.archiveCustomer(actor, id, body, key));
  }

  @Get('customer-tiers')
  @Operation({ operationId: 'listCustomerTiers', ...READ, permission: 'mdm.customer.read' })
  listCustomerTiers(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<TierView>> {
    return this.admin.listTiers(actor, query.cursor, query.limit);
  }

  @Post('customer-tiers')
  @Operation({ operationId: 'createCustomerTier', ...WRITE, permission: 'mdm.customer.create' })
  createCustomerTier(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(CustomerTierCreate)) body: z.infer<typeof CustomerTierCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TierView> {
    return reply(res, this.admin.createTier(actor, body, key));
  }

  @Get('customers/:id/addresses')
  @Operation({ operationId: 'listCustomerAddresses', ...READ, permission: 'mdm.customer.read' })
  listCustomerAddresses(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>,
  ): Promise<Page<AddressView>> {
    return this.admin.listAddresses(actor, id, query.cursor, query.limit);
  }

  @Post('customers/:id/addresses')
  @Operation({ operationId: 'createCustomerAddress', ...WRITE, permission: 'mdm.customer.update' })
  createCustomerAddress(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(CustomerAddressCreate)) body: z.infer<typeof CustomerAddressCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AddressView> {
    return reply(res, this.admin.createAddress(actor, id, body, key));
  }

  @Patch('customer-addresses/:id')
  @Operation({ operationId: 'updateCustomerAddress', ...WRITE, permission: 'mdm.customer.update' })
  updateCustomerAddress(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(CustomerAddressUpdate)) body: z.infer<typeof CustomerAddressUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AddressView> {
    return reply(res, this.admin.updateAddress(actor, id, body, key));
  }

  @Post('customer-addresses/:id/archive')
  @Operation({ operationId: 'archiveCustomerAddress', ...WRITE, permission: 'mdm.customer.update' })
  archiveCustomerAddress(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ArchiveBody)) body: z.infer<typeof ArchiveBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AddressView> {
    return reply(res, this.admin.archiveAddress(actor, id, body, key));
  }

  @Put('customers/:id/price-list')
  @Operation({ operationId: 'assignCustomerPriceList', ...WRITE, permission: 'mdm.price_list.assign' })
  assignCustomerPriceList(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(PriceListAssignmentInput)) body: z.infer<typeof PriceListAssignmentInput>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AssignmentView> {
    return reply(res, this.admin.assignPriceList(actor, id, body, key));
  }
}
