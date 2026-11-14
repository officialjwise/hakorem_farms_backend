import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { PricingService, type PriceResolveResultView } from '../application/pricing';
import { PriceResolveRequest } from './schemas';

/** `resolvePrices`: read-only, so no idempotency key; a cookie-authenticated POST, so CSRF. */
@Controller('pricing')
export class PricingController {
  constructor(@Inject(PricingService) private readonly pricing: PricingService) {}

  @Post('resolve')
  @HttpCode(200)
  @Operation({ operationId: 'resolvePrices', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.price.resolve', idempotent: false, csrf: true, rateLimit: 'console' })
  resolvePrices(@CurrentActor() actor: Actor | undefined, @Body(zodPipe(PriceResolveRequest)) body: z.infer<typeof PriceResolveRequest>): Promise<PriceResolveResultView> {
    return this.pricing.resolve(actor, body);
  }
}
