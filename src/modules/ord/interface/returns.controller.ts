import { Body, Controller, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import type { ApprovalPendingView } from '../application/order-reversals';
import { Returns, type OrderReturnView } from '../application/returns';
import { IdParam, ReturnCreateBody } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Returns against the original sale (FR-ORD-015). Parses and delegates; `Returns` authorises. */
@Controller('returns')
export class ReturnsController {
  constructor(@Inject(Returns) private readonly returns: Returns) {}

  @Post()
  @HttpCode(201)
  @Operation({ operationId: 'createReturn', ...WRITE, permission: 'ord.return.create' })
  createReturn(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(ReturnCreateBody)) body: z.infer<typeof ReturnCreateBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderReturnView> {
    return reply(
      res,
      this.returns.create(
        actor,
        { ...body, note: body.note ?? null, lines: body.lines.map((l) => ({ orderLineId: l.orderLineId, qty: l.qty, weightKg: l.weightKg ?? null, disposition: l.disposition })) },
        key,
      ),
    );
  }

  @Get(':id')
  @Operation({ operationId: 'getReturn', ...READ, permission: 'ord.return.read' })
  getReturn(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<OrderReturnView> {
    return this.returns.get(actor, id);
  }

  @Post(':id/submit')
  @HttpCode(202)
  @Operation({ operationId: 'submitReturn', ...WRITE, permission: 'ord.return.create' })
  submitReturn(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalPendingView> {
    return reply(res, this.returns.submit(actor, id, key));
  }
}
