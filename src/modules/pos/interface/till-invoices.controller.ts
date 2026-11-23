import { Body, Controller, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { DriverCashReconciliationView } from '../../del';
import { TillDriverCash } from '../application/till-driver-cash';
import { TillInvoicePayments, type TillInvoicePaymentView } from '../application/till-invoices';
import { DriverCashHandInCreate, IdParam, TillInvoicePaymentCreate } from './schemas';

/** Money taken at the till on the cashier's own open shift: an invoice paid in cash (A-212 (a), A-285 (g)) and a driver's cash handed in (CR-057). */
@Controller()
export class TillInvoicesController {
  constructor(
    @Inject(TillInvoicePayments) private readonly payments: TillInvoicePayments,
    @Inject(TillDriverCash) private readonly driverCash: TillDriverCash,
  ) {}

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

  /** A driver's cash on delivery counted into the cashier's own open shift (CR-057, ADR-0092). */
  @Post('shifts/:id/driver-cash-hand-ins')
  @Operation({ operationId: 'handInDriverCash', access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console', permission: 'pos.sale.create' })
  async handInDriverCash(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(DriverCashHandInCreate)) body: z.infer<typeof DriverCashHandInCreate>,
    @IdempotencyKeyHeader() key: string,
    @Headers('x-device-credential') deviceCredential: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DriverCashReconciliationView> {
    const stored = await this.driverCash.handIn(actor, id, body, key, deviceCredential);
    res.status(stored.status);
    return stored.body;
  }
}
