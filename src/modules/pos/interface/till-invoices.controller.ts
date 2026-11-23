import { Body, Controller, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { TillInvoicePayments, type TillInvoicePaymentView } from '../application/till-invoices';
import { IdParam, TillInvoicePaymentCreate } from './schemas';

/** An invoice paid in cash at the till, on the cashier's own open shift (A-212 (a), A-285 (g)). */
@Controller()
export class TillInvoicesController {
  constructor(@Inject(TillInvoicePayments) private readonly payments: TillInvoicePayments) {}

  @Post('shifts/:id/invoice-payments')
  @Operation({ operationId: 'payInvoiceAtTill', access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console', permission: 'pos.sale.create' })
  async payInvoiceAtTill(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(TillInvoicePaymentCreate)) body: z.infer<typeof TillInvoicePaymentCreate>,
    @IdempotencyKeyHeader() key: string,
    @Headers('x-device-credential') deviceCredential: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TillInvoicePaymentView> {
    const stored = await this.payments.pay(actor, id, body, key, deviceCredential);
    res.status(stored.status);
    return stored.body;
  }
}
