import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { Registers, type RegisterView } from '../application/registers';
import { Shifts, type CashMovementView, type Page, type ShiftReportView, type ShiftView } from '../application/shifts';
import { CashMovementCreate, IdParam, PageQuery, ReasonBody, RegisterCreate, RegisterPageQuery, RegisterUpdate, ShiftClose, ShiftOpen, ShiftPageQuery } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/**
 * The till (FR-POS-015 to FR-POS-019, B9b): registers, shifts with their float, cash movements, the X and Z reports,
 * and the blind close with its supervisor's sign-off. The controller parses and delegates; the handlers authorise.
 */
@Controller()
export class PosController {
  constructor(
    @Inject(Registers) private readonly registers: Registers,
    @Inject(Shifts) private readonly shifts: Shifts,
  ) {}

  @Get('registers')
  @Operation({ operationId: 'listRegisters', ...READ, permission: 'pos.register.read' })
  listRegisters(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(RegisterPageQuery)) query: z.infer<typeof RegisterPageQuery>): Promise<Page<RegisterView>> {
    return this.registers.list(actor, query.branchId ?? null, query.cursor, query.limit);
  }

  @Post('registers')
  @Operation({ operationId: 'createRegister', ...WRITE, permission: 'pos.register.manage' })
  createRegister(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(RegisterCreate)) body: z.infer<typeof RegisterCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RegisterView> {
    return reply(res, this.registers.create(actor, body, key));
  }

  @Patch('registers/:id')
  @Operation({ operationId: 'updateRegister', ...WRITE, permission: 'pos.register.manage' })
  updateRegister(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(RegisterUpdate)) body: z.infer<typeof RegisterUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RegisterView> {
    return reply(res, this.registers.update(actor, id, body, key));
  }

  @Get('shifts')
  @Operation({ operationId: 'listShifts', ...READ, permission: 'pos.shift.read' })
  listShifts(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ShiftPageQuery)) query: z.infer<typeof ShiftPageQuery>): Promise<Page<ShiftView>> {
    return this.shifts.list(
      actor,
      { registerId: query.registerId ?? null, cashierId: query.cashierId ?? null, status: query.status ?? null, from: query.from ?? null, to: query.to ?? null },
      query.cursor,
      query.limit,
    );
  }

  @Post('shifts')
  @Operation({ operationId: 'openShift', ...WRITE, permission: 'pos.shift.open' })
  openShift(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(ShiftOpen)) body: z.infer<typeof ShiftOpen>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ShiftView> {
    return reply(res, this.shifts.open(actor, body, key));
  }

  @Get('shifts/:id')
  @Operation({ operationId: 'getShift', ...READ, permission: 'pos.shift.read' })
  getShift(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<ShiftView> {
    return this.shifts.get(actor, id);
  }

  @Get('shifts/:id/cash-movements')
  @Operation({ operationId: 'listShiftCashMovements', ...READ, permission: 'pos.shift.read' })
  listShiftCashMovements(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>,
  ): Promise<Page<CashMovementView>> {
    return this.shifts.listCashMovements(actor, id, query.cursor, query.limit);
  }

  @Post('shifts/:id/cash-movements')
  @Operation({ operationId: 'recordCashMovement', ...WRITE, permission: 'pos.cash.move' })
  recordCashMovement(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(CashMovementCreate)) body: z.infer<typeof CashMovementCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CashMovementView> {
    return reply(res, this.shifts.recordCashMovement(actor, id, body, key));
  }

  @Get('shifts/:id/x-report')
  @Operation({ operationId: 'getShiftXReport', ...READ, permission: 'pos.shift.report' })
  getShiftXReport(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<ShiftReportView> {
    return this.shifts.xReport(actor, id);
  }

  @Get('shifts/:id/z-report')
  @Operation({ operationId: 'getShiftZReport', ...READ, permission: 'pos.shift.report' })
  getShiftZReport(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<ShiftReportView> {
    return this.shifts.zReport(actor, id);
  }

  @Post('shifts/:id/close')
  @Operation({ operationId: 'closeShift', ...WRITE, permission: 'pos.shift.close' })
  closeShift(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ShiftClose)) body: z.infer<typeof ShiftClose>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ShiftView> {
    return reply(res, this.shifts.close(actor, id, body, key));
  }

  @Post('shifts/:id/approve-close')
  @Operation({ operationId: 'approveShiftClose', ...WRITE, permission: 'pos.shift.close.approve' })
  approveShiftClose(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ShiftView> {
    return reply(res, this.shifts.approveClose(actor, id, body, key));
  }
}
