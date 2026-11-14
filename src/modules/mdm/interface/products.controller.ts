import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { ProductCatalogue, type Page } from '../application/product-catalogue';
import type { ProductView } from '../application/product-store';
import { ListProductsQuery, ProductCreate, ProductIdParam } from './schemas';

/**
 * `listProducts`, `createProduct`, `getProduct`. The controller parses and delegates; the handler authorises,
 * does the work and decides the status (201, or the stored status of a replay).
 */
@Controller('products')
export class ProductsController {
  constructor(@Inject(ProductCatalogue) private readonly catalogue: ProductCatalogue) {}

  @Get()
  @Operation({ operationId: 'listProducts', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.product.read', idempotent: false, csrf: false, rateLimit: 'console' })
  listProducts(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListProductsQuery)) query: z.infer<typeof ListProductsQuery>): Promise<Page<ProductView>> {
    const { cursor, limit, ...filter } = query;
    return this.catalogue.list(actor, filter, cursor, limit);
  }

  @Post()
  @Operation({ operationId: 'createProduct', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.product.create', idempotent: true, csrf: true, rateLimit: 'console' })
  async createProduct(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(ProductCreate)) body: z.infer<typeof ProductCreate>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductView> {
    const response = await this.catalogue.create(actor, body, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  @Get(':id')
  @Operation({ operationId: 'getProduct', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.product.read', idempotent: false, csrf: false, rateLimit: 'console' })
  getProduct(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(ProductIdParam)) id: string): Promise<ProductView> {
    return this.catalogue.get(actor, id);
  }
}
