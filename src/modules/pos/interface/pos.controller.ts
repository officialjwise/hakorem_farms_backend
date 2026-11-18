import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { CounterSales, type CounterSaleResultView } from '../application/counter-sales';
import { Devices, type DeviceEnrolledView, type DeviceView } from '../application/devices';
import { HeldSales, type HeldSaleView } from '../application/held-sales';
import { OfflinePacks, type OfflinePackView } from '../application/offline-packs';
import { OfflineSync, type OfflineSyncResultView } from '../application/offline-sync';
import { Registers, type RegisterView } from '../application/registers';
import { Shifts, type CashMovementView, type Page, type ShiftReportView, type ShiftView } from '../application/shifts';
import { CashMovementCreate, CounterSale, DeviceEnrolmentCreate, ForceClosedShiftCount, HeldSaleCreate, IdParam, OfflineSyncBatch, PageQuery, ReasonBody, RegisterCreate, RegisterPageQuery, RegisterUpdate, ShiftClose, ShiftOpen, ShiftPageQuery } from './schemas';

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
    @Inject(Devices) private readonly devices: Devices,
    @Inject(CounterSales) private readonly sales: CounterSales,
    @Inject(HeldSales) private readonly held: HeldSales,
    @Inject(OfflinePacks) private readonly packs: OfflinePacks,
    @Inject(OfflineSync) private readonly offline: OfflineSync,
  ) {}

  /** Per-sale exactly-once by the sale's client id, so the batch takes no `Idempotency-Key` (OFFLINE_SYNC 4.1). */
  @Post('pos/sync')
  @HttpCode(200)
  @Operation({ operationId: 'syncOfflineSales', access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: true, rateLimit: 'console', permission: 'pos.sale.create' })
  syncOfflineSales(@CurrentActor() actor: Actor | undefined, @Body(zodPipe(OfflineSyncBatch)) body: z.infer<typeof OfflineSyncBatch>, @Headers('x-device-credential') deviceCredential: string | undefined): Promise<OfflineSyncResultView> {
    return this.offline.sync(actor, body, deviceCredential);
  }

  @Get('registers/:id/offline-pack')
  @Operation({ operationId: 'getOfflinePack', ...READ, permission: 'pos.sale.create' })
  getOfflinePack(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @Headers('x-device-credential') deviceCredential: string | undefined): Promise<OfflinePackView> {
    return this.packs.get(actor, id, deviceCredential);
  }

  @Get('registers/:id/held-sales')
  @Operation({ operationId: 'listHeldSales', ...READ, permission: 'pos.sale.create' })
  listHeldSales(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<HeldSaleView>> {
    return this.held.list(actor, id, query.cursor, query.limit);
  }

  @Post('registers/:id/held-sales')
  @Operation({ operationId: 'holdSale', ...WRITE, permission: 'pos.sale.create' })
  holdSale(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(HeldSaleCreate)) body: z.infer<typeof HeldSaleCreate>,
    @IdempotencyKeyHeader() key: string,
    @Headers('x-device-credential') deviceCredential: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HeldSaleView> {
    return reply(res, this.held.hold(actor, id, body, key, deviceCredential));
  }

  @Delete('held-sales/:id')
  @Operation({ operationId: 'recallHeldSale', ...WRITE, permission: 'pos.sale.create' })
  recallHeldSale(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Headers('x-device-credential') deviceCredential: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HeldSaleView> {
    return reply(res, this.held.recall(actor, id, key, deviceCredential));
  }

  @Post('pos/sales')
  @Operation({ operationId: 'completeCounterSale', ...WRITE, permission: 'pos.sale.create' })
  completeCounterSale(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(CounterSale)) body: z.infer<typeof CounterSale>,
    @IdempotencyKeyHeader() key: string,
    @Headers('x-device-credential') deviceCredential: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CounterSaleResultView> {
    return reply(res, this.sales.complete(actor, body, key, deviceCredential));
  }

  @Get('registers/:id/devices')
  @Operation({ operationId: 'listRegisterDevices', ...READ, permission: 'pos.device.read' })
  listRegisterDevices(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<DeviceView>> {
    return this.devices.list(actor, id, query.cursor, query.limit);
  }

  @Post('registers/:id/devices')
  @Operation({ operationId: 'enrolDevice', ...WRITE, permission: 'pos.device.enrol' })
  enrolDevice(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(DeviceEnrolmentCreate)) body: z.infer<typeof DeviceEnrolmentCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeviceEnrolledView> {
    return reply(res, this.devices.enrol(actor, id, body, key));
  }

  @Post('devices/:id/revoke')
  @Operation({ operationId: 'revokeDevice', ...WRITE, permission: 'pos.device.enrol' })
  revokeDevice(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeviceView> {
    return reply(res, this.devices.revoke(actor, id, body, key));
  }

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

  @Post('shifts/:id/force-close')
  @Operation({ operationId: 'forceCloseShift', ...WRITE, permission: 'pos.shift.force_close' })
  forceCloseShift(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ShiftView> {
    return reply(res, this.shifts.forceClose(actor, id, body, key));
  }

  @Post('shifts/:id/late-count')
  @Operation({ operationId: 'countForceClosedShift', ...WRITE, permission: 'pos.shift.close.approve' })
  countForceClosedShift(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ForceClosedShiftCount)) body: z.infer<typeof ForceClosedShiftCount>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ShiftView> {
    return reply(res, this.shifts.countLate(actor, id, body, key));
  }
}
