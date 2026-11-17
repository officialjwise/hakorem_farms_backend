import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { Slots, type SlotOptionView } from '../../del';
import { Catalogue, STOREFRONT_ACTOR, type CatalogueItemView, type Page, type ProductDetailView } from '../application/catalogue';
import { Carts, type CartView, type GuestToken } from '../application/carts';
import { Checkouts, type CheckoutView, type PlaceOrderView } from '../application/checkouts';
import { CartLineAdd, CartLineUpdate, CatalogueQuery, CheckoutStart, CheckoutUpdate, CouponApply, IdParam, PageQuery, PlaceOrder, SlotOptionQuery, SlugParam } from './schemas';

/** The host-only cookie that proves a guest cart is the caller's (A-177): never readable by script, never cross-site. */
export const GUEST_COOKIE = '__Host-hk_guest';
const GUEST_COOKIE_MAX_AGE_MS = 30 * 24 * 3_600_000;

const READ = { access: 'PUBLIC', realms: [], permission: null, idempotent: false, csrf: false, rateLimit: 'public' } as const;
/** A guest's write: an allowed Origin, an Idempotency-Key, and the Storefront principal as the actor of record. */
const WRITE = { access: 'PUBLIC', realms: [], permission: null, idempotent: true, csrf: false, rateLimit: 'public', originRequired: true, publicActor: STOREFRONT_ACTOR } as const;
const CHECKOUT = { ...WRITE, rateLimit: 'checkout' } as const;

function guest(req: Request): GuestToken {
  for (const part of (req.header('Cookie') ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === GUEST_COOKIE) return { value: decodeURIComponent(rest.join('=')) };
  }
  return { value: undefined };
}

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/**
 * The public storefront (FR-SHP-001 to FR-SHP-008): the catalogue, guest carts and checkout. The controller parses,
 * reads the guest cookie and delegates; the handlers decide who may reach which cart.
 */
@Controller('shop')
export class ShopController {
  constructor(
    @Inject(Catalogue) private readonly catalogue: Catalogue,
    @Inject(Carts) private readonly carts: Carts,
    @Inject(Checkouts) private readonly checkouts: Checkouts,
    @Inject(Slots) private readonly slots: Slots,
  ) {}

  @Get('catalogue')
  @Operation({ operationId: 'listCatalogue', ...READ })
  listCatalogue(@Query(zodPipe(CatalogueQuery)) query: z.infer<typeof CatalogueQuery>): Promise<Page<CatalogueItemView>> {
    return this.catalogue.list({ q: query.q ?? null, category: query.category ?? null, productLine: query.productLine ?? null, availability: query.availability ?? null, sort: query.sort }, query.cursor, query.limit);
  }

  @Get('products/:slug')
  @Operation({ operationId: 'getCatalogueProduct', ...READ })
  getCatalogueProduct(@Param('slug', zodPipe(SlugParam)) slug: string): Promise<ProductDetailView> {
    return this.catalogue.product(slug);
  }

  @Get('categories')
  @Operation({ operationId: 'listShopCategories', ...READ })
  listShopCategories(@Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>) {
    return this.catalogue.categories(query.cursor, query.limit);
  }

  @Post('carts')
  @Operation({ operationId: 'createCart', ...WRITE })
  async createCart(@IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<CartView> {
    const created = await this.carts.create(key);
    if (created.token !== null) {
      res.cookie(GUEST_COOKIE, created.token, { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: GUEST_COOKIE_MAX_AGE_MS });
    }
    res.status(created.status);
    return created.body;
  }

  @Get('carts/:id')
  @Operation({ operationId: 'getCart', ...READ })
  getCart(@Req() req: Request, @Param('id', zodPipe(IdParam)) id: string): Promise<CartView> {
    return this.carts.get(guest(req), id);
  }

  @Post('carts/:id/lines')
  @Operation({ operationId: 'addCartLine', ...WRITE })
  addCartLine(@Req() req: Request, @Param('id', zodPipe(IdParam)) id: string, @Body(zodPipe(CartLineAdd)) body: z.infer<typeof CartLineAdd>, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<CartView> {
    return reply(res, this.carts.addLine(guest(req), id, body, key));
  }

  @Patch('carts/:id/lines/:lineId')
  @Operation({ operationId: 'updateCartLine', ...WRITE })
  updateCartLine(
    @Req() req: Request,
    @Param('id', zodPipe(IdParam)) id: string,
    @Param('lineId', zodPipe(IdParam)) lineId: string,
    @Body(zodPipe(CartLineUpdate)) body: z.infer<typeof CartLineUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CartView> {
    return reply(res, this.carts.updateLine(guest(req), id, lineId, body, key));
  }

  @Delete('carts/:id/lines/:lineId')
  @Operation({ operationId: 'removeCartLine', ...WRITE })
  removeCartLine(@Req() req: Request, @Param('id', zodPipe(IdParam)) id: string, @Param('lineId', zodPipe(IdParam)) lineId: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<CartView> {
    return reply(res, this.carts.removeLine(guest(req), id, lineId, key));
  }

  @Put('carts/:id/coupon')
  @Operation({ operationId: 'applyCartCoupon', ...WRITE })
  applyCartCoupon(@Req() req: Request, @Param('id', zodPipe(IdParam)) id: string, @Body(zodPipe(CouponApply)) body: z.infer<typeof CouponApply>, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<CartView> {
    return reply(res, this.carts.applyCoupon(guest(req), id, body, key));
  }

  @Delete('carts/:id/coupon')
  @Operation({ operationId: 'removeCartCoupon', ...WRITE })
  removeCartCoupon(@Req() req: Request, @Param('id', zodPipe(IdParam)) id: string, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<CartView> {
    return reply(res, this.carts.removeCoupon(guest(req), id, key));
  }

  @Get('delivery/slots')
  @Operation({ operationId: 'listDeliverySlotOptions', ...READ })
  listDeliverySlotOptions(@Query(zodPipe(SlotOptionQuery)) query: z.infer<typeof SlotOptionQuery>): Promise<Page<SlotOptionView>> {
    return this.slots.listOptions(query.zoneId, query.from, query.cursor, query.limit);
  }

  @Post('carts/:id/checkout')
  @Operation({ operationId: 'startCheckout', ...CHECKOUT })
  startCheckout(@Req() req: Request, @Param('id', zodPipe(IdParam)) id: string, @Body(zodPipe(CheckoutStart)) body: z.infer<typeof CheckoutStart>, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<CheckoutView> {
    return reply(res, this.checkouts.start(guest(req), id, body, key));
  }

  @Post('checkouts/:id/place')
  @Operation({ operationId: 'placeOrder', ...CHECKOUT })
  placeOrder(@Req() req: Request, @Param('id', zodPipe(IdParam)) id: string, @Body(zodPipe(PlaceOrder)) body: z.infer<typeof PlaceOrder>, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<PlaceOrderView> {
    return reply(res, this.checkouts.place(guest(req), id, body, key));
  }

  @Get('checkouts/:id')
  @Operation({ operationId: 'getCheckout', ...READ })
  getCheckout(@Req() req: Request, @Param('id', zodPipe(IdParam)) id: string): Promise<CheckoutView> {
    return this.checkouts.get(guest(req), id);
  }

  @Patch('checkouts/:id')
  @Operation({ operationId: 'updateCheckout', ...CHECKOUT })
  updateCheckout(@Req() req: Request, @Param('id', zodPipe(IdParam)) id: string, @Body(zodPipe(CheckoutUpdate)) body: z.infer<typeof CheckoutUpdate>, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<CheckoutView> {
    return reply(res, this.checkouts.update(guest(req), id, body, key));
  }
}
