import { Body, Controller, Get, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { Quotes, type PublicQuoteView, type QuoteDecisionView } from '../application/quotes';
import { STOREFRONT_ACTOR } from '../application/public-actor';
import { Rfqs } from '../application/rfqs';
import { LinkTokenParam, PublicQuoteRequest, QuoteAcceptByLink, QuoteDeclineByLink } from './schemas';

const READ = { access: 'PUBLIC', realms: [], permission: null, idempotent: false, csrf: false, rateLimit: 'public' } as const;
/** A buyer's write with no account: an allowed Origin, an Idempotency-Key, and the Storefront principal as the actor of record. */
const WRITE = { access: 'PUBLIC', realms: [], permission: null, idempotent: true, csrf: false, rateLimit: 'public', originRequired: true, publicActor: STOREFRONT_ACTOR } as const;

/** The storefront's request for quote and the quote link (FR-QUO-001, FR-QUO-008, CR-047): no session; the link's own random token is the only key. */
@Controller('shop')
export class QuoteLinksController {
  constructor(
    @Inject(Quotes) private readonly quotes: Quotes,
    @Inject(Rfqs) private readonly rfqs: Rfqs,
  ) {}

  @Post('quote-requests')
  @Operation({ operationId: 'submitQuoteRequest', ...WRITE })
  async submitQuoteRequest(@Body(zodPipe(PublicQuoteRequest)) body: z.infer<typeof PublicQuoteRequest>, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<{ rfqNo: string; message: string }> {
    const response = await this.rfqs.submitPublic(body, key);
    res.status(response.status);
    return response.body;
  }

  @Get('quotes/:token')
  @Operation({ operationId: 'viewQuoteByLink', ...READ })
  viewQuoteByLink(@Param('token', zodPipe(LinkTokenParam)) token: string): Promise<PublicQuoteView> {
    return this.quotes.viewByLink(token);
  }

  @Post('quotes/:token/accept')
  @Operation({ operationId: 'acceptQuoteByLink', ...WRITE })
  async acceptQuoteByLink(
    @Param('token', zodPipe(LinkTokenParam)) token: string,
    @Body(zodPipe(QuoteAcceptByLink)) body: z.infer<typeof QuoteAcceptByLink>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QuoteDecisionView> {
    const response = await this.quotes.acceptByLink(token, body, key);
    res.status(response.status);
    return response.body;
  }

  @Post('quotes/:token/decline')
  @Operation({ operationId: 'declineQuoteByLink', ...WRITE })
  async declineQuoteByLink(
    @Param('token', zodPipe(LinkTokenParam)) token: string,
    @Body(zodPipe(QuoteDeclineByLink)) body: z.infer<typeof QuoteDeclineByLink>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QuoteDecisionView> {
    const response = await this.quotes.declineByLink(token, body, key);
    res.status(response.status);
    return response.body;
  }
}
