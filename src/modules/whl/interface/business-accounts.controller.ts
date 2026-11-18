import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import type { CreditOverridePending } from '../../ord';
import { BusinessAccounts, type ApprovalPendingView, type BusinessAccountView, type Page } from '../application/business-accounts';
import { CreditControl, type CreditOverrideView, type OrderCreditCheckView } from '../application/credit-control';
import { AccountCreate, AccountPageQuery, AccountUpdate, CreditOverridePageQuery, CustomerIdParam, IdParam, ReasonBody } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Business accounts and credit control (FR-WHL-001, FR-WHL-006 to FR-WHL-008, CR-046, CR-048). The handlers authorise. */
@Controller()
export class BusinessAccountsController {
  constructor(
    @Inject(BusinessAccounts) private readonly accounts: BusinessAccounts,
    @Inject(CreditControl) private readonly credit: CreditControl,
  ) {}

  @Get('business-accounts')
  @Operation({ operationId: 'listBusinessAccounts', ...READ, permission: 'whl.account.read' })
  listBusinessAccounts(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(AccountPageQuery)) q: z.infer<typeof AccountPageQuery>): Promise<Page<BusinessAccountView>> {
    return this.accounts.list(actor, { status: q.status ?? null, accountManagerId: q.accountManagerId ?? null, overLimit: q.overLimit ?? null }, q.cursor, q.limit);
  }

  @Post('business-accounts')
  @Operation({ operationId: 'createBusinessAccount', ...WRITE, permission: 'whl.account.manage' })
  createBusinessAccount(@CurrentActor() actor: Actor | undefined, @Body(zodPipe(AccountCreate)) body: z.infer<typeof AccountCreate>, @IdempotencyKeyHeader() key: string, @Res({ passthrough: true }) res: Response): Promise<BusinessAccountView | ApprovalPendingView> {
    return reply(res, this.accounts.create(actor, body, key));
  }

  @Get('business-accounts/:customerId')
  @Operation({ operationId: 'getBusinessAccount', ...READ, permission: 'whl.account.read' })
  getBusinessAccount(@CurrentActor() actor: Actor | undefined, @Param('customerId', zodPipe(CustomerIdParam)) customerId: string): Promise<BusinessAccountView> {
    return this.accounts.get(actor, customerId);
  }

  @Patch('business-accounts/:customerId')
  @Operation({ operationId: 'updateBusinessAccount', ...WRITE, permission: 'whl.account.manage' })
  updateBusinessAccount(
    @CurrentActor() actor: Actor | undefined,
    @Param('customerId', zodPipe(CustomerIdParam)) customerId: string,
    @Body(zodPipe(AccountUpdate)) body: z.infer<typeof AccountUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BusinessAccountView | ApprovalPendingView> {
    return reply(res, this.accounts.update(actor, customerId, body, key));
  }

  @Post('business-accounts/:customerId/hold')
  @HttpCode(200)
  @Operation({ operationId: 'holdBusinessAccount', ...WRITE, permission: 'whl.account.hold' })
  holdBusinessAccount(
    @CurrentActor() actor: Actor | undefined,
    @Param('customerId', zodPipe(CustomerIdParam)) customerId: string,
    @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BusinessAccountView> {
    return reply(res, this.accounts.hold(actor, customerId, body, key));
  }

  @Post('business-accounts/:customerId/release')
  @HttpCode(202)
  @Operation({ operationId: 'releaseBusinessAccount', ...WRITE, permission: 'whl.account.release' })
  releaseBusinessAccount(
    @CurrentActor() actor: Actor | undefined,
    @Param('customerId', zodPipe(CustomerIdParam)) customerId: string,
    @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalPendingView> {
    return reply(res, this.accounts.release(actor, customerId, body, key));
  }

  @Get('credit-overrides')
  @Operation({ operationId: 'listCreditOverrides', ...READ, permission: 'whl.account.read' })
  listCreditOverrides(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(CreditOverridePageQuery)) q: z.infer<typeof CreditOverridePageQuery>): Promise<Page<CreditOverrideView>> {
    return this.credit.list(actor, { customerId: q.customerId ?? null, from: q.from ?? null, to: q.to ?? null }, q.cursor, q.limit);
  }

  @Get('orders/:id/credit-check')
  @Operation({ operationId: 'getOrderCreditCheck', ...READ, permission: 'ord.order.read' })
  getOrderCreditCheck(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<OrderCreditCheckView> {
    return this.credit.creditCheck(actor, id);
  }

  @Post('orders/:id/credit-override')
  @HttpCode(202)
  @Operation({ operationId: 'requestCreditOverride', ...WRITE, permission: 'ord.order.confirm' })
  requestCreditOverride(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CreditOverridePending> {
    return reply(res, this.credit.requestOverride(actor, id, body, key));
  }
}
