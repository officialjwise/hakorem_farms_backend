import { Body, Controller, Get, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { ReceiptLinks, type PublicReceiptView, type ReceiptLinkRevocationView } from '../application/receipt-links';
import { IdParam, ReasonBody, ReceiptTokenParam } from './schemas';

/** The counter's digital receipt (CR-033 points 1 and 2, ADR-0083): no session; the till's own random token is the only key. */
@Controller()
export class ReceiptsController {
  constructor(@Inject(ReceiptLinks) private readonly receipts: ReceiptLinks) {}

  @Get('shop/receipts/:token')
  @Operation({ operationId: 'getPublicReceipt', access: 'PUBLIC', realms: [], permission: null, idempotent: false, csrf: false, rateLimit: 'public' })
  getPublicReceipt(@Param('token', zodPipe(ReceiptTokenParam)) token: string): Promise<PublicReceiptView> {
    return this.receipts.publicReceipt(token);
  }

  /** A sale's receipt link revoked by a supervisor of its branch, with a reason (A-284 (f), A-285). */
  @Post('pos/sales/:id/revoke-receipt-link')
  @Operation({ operationId: 'revokeReceiptLink', access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console', permission: 'pos.shift.close.approve' })
  async revokeReceiptLink(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReceiptLinkRevocationView> {
    const stored = await this.receipts.revoke(actor, id, body, key);
    res.status(stored.status);
    return stored.body;
  }
}
