import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { ProductCatalogue, type Page, type ProductLabelView } from '../application/product-catalogue';
import { ProductGallery } from '../application/product-gallery';
import type { ProductView } from '../application/product-store';
import { ArchiveBody, ListProductsQuery, ProductCreate, ProductIdParam, ProductImageCreateBody, ProductImageIdParam, ProductUpdate } from './schemas';

/**
 * `listProducts`, `createProduct`, `getProduct`, `updateProduct`, `archiveProduct`, and the gallery's `addProductImage`
 * and `removeProductImage` (FR-DOC-005). The controller parses and delegates; the handler authorises,
 * does the work and decides the status (201, or the stored status of a replay).
 */
@Controller('products')
export class ProductsController {
  constructor(
    @Inject(ProductCatalogue) private readonly catalogue: ProductCatalogue,
    @Inject(ProductGallery) private readonly gallery: ProductGallery,
  ) {}

  @Get()
  @Operation({ operationId: 'listProducts', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.product.read', idempotent: false, csrf: false, rateLimit: 'console' })
  listProducts(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListProductsQuery)) query: z.infer<typeof ListProductsQuery>): Promise<Page<ProductView>> {
    const { cursor, limit, sort, direction, ...filter } = query;
    return this.catalogue.list(actor, filter, cursor, limit, { sort, direction });
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

  @Get(':id/label')
  @Operation({ operationId: 'getProductLabel', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.product.read', idempotent: false, csrf: false, rateLimit: 'console' })
  getProductLabel(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(ProductIdParam)) id: string): Promise<ProductLabelView> {
    return this.catalogue.getLabel(actor, id);
  }

  @Patch(':id')
  @Operation({ operationId: 'updateProduct', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.product.update', idempotent: true, csrf: true, rateLimit: 'console' })
  async updateProduct(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(ProductIdParam)) id: string,
    @Body(zodPipe(ProductUpdate)) body: z.infer<typeof ProductUpdate>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductView> {
    const response = await this.catalogue.update(actor, id, body, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  @Post(':id/archive')
  @Operation({ operationId: 'archiveProduct', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.product.archive', idempotent: true, csrf: true, rateLimit: 'console' })
  async archive(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(ProductIdParam)) id: string,
    @Body(zodPipe(ArchiveBody)) body: z.infer<typeof ArchiveBody>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductView> {
    const response = await this.catalogue.archive(actor, id, body, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  @Post(':id/images')
  @Operation({ operationId: 'addProductImage', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.product.update', idempotent: true, csrf: true, rateLimit: 'console' })
  async addProductImage(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(ProductIdParam)) id: string,
    @Body(zodPipe(ProductImageCreateBody)) body: z.infer<typeof ProductImageCreateBody>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductView> {
    const response = await this.gallery.add(actor, id, body, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  @Delete(':id/images/:imageId')
  @Operation({ operationId: 'removeProductImage', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.product.update', idempotent: true, csrf: true, rateLimit: 'console' })
  async removeProductImage(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(ProductIdParam)) id: string,
    @Param('imageId', zodPipe(ProductImageIdParam)) imageId: string,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const response = await this.gallery.remove(actor, id, imageId, idempotencyKey);
    res.status(response.status);
  }
}
