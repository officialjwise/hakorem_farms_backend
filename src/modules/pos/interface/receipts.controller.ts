import { Controller, Get, Inject, Param } from '@nestjs/common';
import { Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { ReceiptLinks, type PublicReceiptView } from '../application/receipt-links';
import { ReceiptTokenParam } from './schemas';

/** The counter's digital receipt (CR-033 points 1 and 2, ADR-0083): no session; the till's own random token is the only key. */
@Controller('shop')
export class ReceiptsController {
  constructor(@Inject(ReceiptLinks) private readonly receipts: ReceiptLinks) {}

  @Get('receipts/:token')
  @Operation({ operationId: 'getPublicReceipt', access: 'PUBLIC', realms: [], permission: null, idempotent: false, csrf: false, rateLimit: 'public' })
  getPublicReceipt(@Param('token', zodPipe(ReceiptTokenParam)) token: string): Promise<PublicReceiptView> {
    return this.receipts.publicReceipt(token);
  }
}
