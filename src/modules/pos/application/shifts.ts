import { createUuidV7Generator, Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { sqlStateOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { NumberSeries } from '../../../platform/documents/number-series';
import { ForbiddenError, NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import { IdempotencyKeyReusedError, type Idempotency, type StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import type { Orders } from '../../ord';
import type { Payments, ShiftTenderTotal } from '../../pay';
import { closeAmounts, expectedCash, judgeCashMovement, judgeCountSignOff, overShort, type CashMovementKind } from '../domain/till';
import { isUuidV7, withinTolerance } from '../domain/client-time';
import { oneMore } from './paging';
import type { CashMoved, ShiftClosed, ShiftOpened } from '../events';
import { CashMovementInvalidError, ShiftAlreadyOpenError, ShiftCloseSamePersonError, ShiftInvalidError, ShiftNotOpenError, type TillRule } from './errors';
import type { CashMovementRecord, ShiftRecord, ShiftStatus, TenderCountRecord, TillStore } from './till-store';

export const SHIFT_OPENED = 'pos.ShiftOpened';
export const CASH_DROPPED = 'pos.CashDropped';
export const CASH_PAID_IN = 'pos.CashPaidIn';
export const CASH_PAID_OUT = 'pos.CashPaidOut';
export const SHIFT_CLOSED = 'pos.ShiftClosed';
export const POS_LEDGER_EVENTS = [SHIFT_OPENED, CASH_DROPPED, CASH_PAID_IN, CASH_PAID_OUT, SHIFT_CLOSED] as const;

const READ = 'pos.shift.read';
const REPORT = 'pos.shift.report';
const OPEN = 'pos.shift.open';
const MOVE = 'pos.cash.move';
const CLOSE = 'pos.shift.close';
const APPROVE = 'pos.shift.close.approve';
/** A supervisor reads any cashier's shift; a cashier only their own (ADR-0017 ownership). */
const READ_ANY = APPROVE;
/** Who may record cash on another cashier's shift: the manager recovering a till (OFFLINE_SYNC 6.5), seeded with the force close. */
const MOVE_ANY = 'pos.shift.force_close';
const UNIQUE_VIOLATION = '23505';
/** Abuse case 17, a shift closed short (THREAT_MODEL section 4): every sign-off reaches the daily exception report's source. */
const SHIFT_OVER_SHORT_ABUSE = 17;
const MOVEMENT_EVENTS: Readonly<Record<'CASH_DROP' | 'PAY_IN' | 'PAY_OUT', { readonly type: string; readonly key: 'drop' | 'payIn' | 'payOut' }>> = {
  CASH_DROP: { type: CASH_DROPPED, key: 'drop' },
  PAY_IN: { type: CASH_PAID_IN, key: 'payIn' },
  PAY_OUT: { type: CASH_PAID_OUT, key: 'payOut' },
};

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

interface MethodRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
}

/** The contract's `Shift`. Expected cash and over or short are null until the count is declared: the close is blind. */
export interface ShiftView {
  readonly id: string;
  readonly shiftNo: string;
  readonly status: ShiftStatus;
  readonly register: { readonly id: string; readonly code: string; readonly name: string };
  readonly cashier: PrincipalRef;
  readonly shiftSeq: number;
  readonly openedAt: string;
  readonly openingFloatPesewas: number;
  readonly closedAt: string | null;
  readonly declaredCashPesewas: number | null;
  readonly expectedCashPesewas: number | null;
  readonly overShortPesewas: number | null;
  readonly overShortDirection: 'OVER' | 'SHORT' | 'EXACT' | null;
  readonly closeApprovedBy: PrincipalRef | null;
  readonly forceClosed: boolean;
  readonly lastDeviceCounter: number;
  readonly salesCount: number;
  readonly tenders: readonly {
    readonly paymentMethod: MethodRef;
    readonly declaredPesewas: number;
    readonly expectedPesewas: number | null;
    readonly variancePesewas: number | null;
    readonly varianceDirection: 'OVER' | 'SHORT' | 'EXACT' | null;
  }[];
  readonly currency: 'GHS';
  readonly branchId: string;
  readonly version: number;
}

/** The contract's `CashMovement`. */
export interface CashMovementView {
  readonly id: string;
  readonly kind: CashMovementKind;
  readonly amountPesewas: number;
  readonly reasonCode: string | null;
  readonly note: string | null;
  readonly witness: PrincipalRef | null;
  readonly actor: PrincipalRef;
  readonly occurredAt: string;
}

/** The contract's `ShiftReport`: an X reading while the shift runs, or the Z report frozen at the sign-off. */
export interface ShiftReportView {
  readonly kind: 'X' | 'Z';
  readonly shift: { readonly id: string; readonly code: string; readonly name: string };
  readonly generatedAt: string;
  readonly salesCount: number;
  readonly grossSalesPesewas: number;
  readonly voidsCount: number;
  readonly voidsPesewas: number;
  readonly overridesCount: number;
  readonly overridesPesewas: number;
  readonly refundsPesewas: number;
  readonly byMethod: readonly { readonly paymentMethod: MethodRef; readonly count: number; readonly amountPesewas: number }[];
  readonly cashMovements: readonly { readonly kind: string; readonly amountPesewas: number }[];
  readonly currency: 'GHS';
  readonly documentId: string | null;
}

export interface ShiftOpenRequest {
  readonly id: string;
  readonly registerId: string;
  readonly openingFloatPesewas: bigint;
  readonly openedAt: Date;
}

export interface CashMovementRequest {
  readonly id: string;
  readonly kind: 'CASH_DROP' | 'PAY_OUT' | 'PAY_IN';
  readonly amountPesewas: bigint;
  readonly reasonCode?: string | undefined;
  readonly note?: string | undefined;
  readonly witnessId?: string | undefined;
  readonly occurredAt: Date;
}

export interface ShiftCloseRequest {
  readonly declared: readonly { readonly paymentMethodId: string; readonly declaredPesewas: bigint }[];
  readonly lastDeviceCounter?: number | undefined;
}

export interface ShiftQuery {
  readonly registerId: string | null;
  readonly cashierId: string | null;
  readonly status: ShiftStatus | null;
  readonly from: Date | null;
  readonly to: Date | null;
}

/** What the till holds by the records: its payments by method from PAY, its movements, and the cash it should hold. */
interface TillPosition {
  readonly totals: readonly ShiftTenderTotal[];
  readonly movements: ReadonlyMap<CashMovementKind, bigint>;
  readonly expected: Money;
}

const pesewas = (amount: bigint): number => Number(amount);
const nullable = (amount: bigint | null): number | null => (amount === null ? null : Number(amount));

/**
 * Till shifts (FR-POS-015 to FR-POS-019): opened with a float from the safe, cash dropped, paid out and paid in while
 * open, declared blind by the cashier and signed off by a supervisor who is not the cashier, which posts the over or
 * short and freezes the Z report. Every handler authorises in the application layer, deny by default; a cashier
 * reaches only their own shift. Every write runs in one serializable transaction with its idempotency key.
 */
export class Shifts {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: TillStore,
    private readonly refs: MasterDataRefs,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly documents: DocumentRegistry,
    private readonly numbers: NumberSeries,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly payments: Payments,
    private readonly orders: Orders,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** `openShift`: one open shift per register and per cashier; the float moves from the safe to the till (FR-POS-015). */
  open(actor: Actor | undefined, body: ShiftOpenRequest, idempotencyKey: string): Promise<StoredResponse<ShiftView>> {
    const year = toBusinessDate(this.clock.now()).slice(0, 4);
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const register = await this.store.lockRegister(tx, body.registerId);
      await this.authoriser.authorise(tx, actor, OPEN, register === null ? {} : { branchId: register.branchId, locationId: register.locationId });
      if (register === null) throw new NotFoundError(`no register ${body.registerId}`);
      const claim = await this.idempotency.claim(tx, { operationId: 'openShift', principalId: actor!.principalId, key: idempotencyKey, request: { ...body, openingFloatPesewas: body.openingFloatPesewas.toString() } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ShiftView>;
      const now = this.clock.now();
      const broken: TillRule[] = [];
      if (!isUuidV7(body.id)) broken.push({ field: '/id', rule: 'ID_NOT_UUID_V7' });
      if (register.status !== 'ACTIVE') broken.push({ field: '/registerId', rule: 'REGISTER_RETIRED' });
      if (!withinTolerance(body.openedAt, now)) broken.push({ field: '/openedAt', rule: 'OPENED_AT_OUT_OF_WINDOW' });
      if (broken.length > 0) throw new ShiftInvalidError(broken);
      if ((await this.store.unclosedShifts(tx, [register.id])).has(register.id)) throw new ShiftAlreadyOpenError('/registerId');
      if ((await this.store.unclosedShiftOfCashier(tx, actor!.principalId)) !== null) throw new ShiftAlreadyOpenError('/cashier');
      const branch = (await this.refs.branchesIn(tx, [register.branchId])).get(register.branchId)!;

      try {
        await this.documents.register(tx, { id: body.id, docType: 'SHIFT', ownerModule: 'pos', branchId: register.branchId, actorId: actor!.principalId });
      } catch (error) {
        if (sqlStateOf(error) === UNIQUE_VIOLATION) throw new IdempotencyKeyReusedError('the shift id is already a registered document');
        throw error;
      }
      const shiftNo = await this.numbers.allocateIn(tx, { docType: 'SHIFT', fiscalYear: Number(year), branchId: register.branchId, branchCode: branch.code, documentId: body.id });
      const shiftSeq = await this.store.nextShiftSeq(tx, register.id);
      await this.store.insertShift(tx, {
        id: body.id,
        shiftNo,
        registerId: register.id,
        cashierId: actor!.principalId,
        shiftSeq,
        openedAt: now,
        openingFloatPesewas: body.openingFloatPesewas,
        branchId: register.branchId,
        actorId: actor!.principalId,
        at: now,
      });
      if (body.openingFloatPesewas > 0n) {
        await this.store.insertCashMovement(tx, {
          id: this.nextId(),
          shiftId: body.id,
          kind: 'FLOAT_IN',
          amountPesewas: body.openingFloatPesewas,
          reasonCode: null,
          note: null,
          witnessId: null,
          occurredAt: now,
          recordedAt: now,
          actorId: actor!.principalId,
        });
        const payload: ShiftOpened = {
          shiftId: body.id,
          subjectId: body.id,
          branchId: register.branchId,
          register: { id: register.id, code: register.code },
          cashierId: actor!.principalId,
          reasonCode: null,
          shiftNo,
          shiftSeq,
          openedAt: now.toISOString(),
          amountsPesewas: { float: pesewas(body.openingFloatPesewas) },
        };
        await this.events.publish(tx, { type: SHIFT_OPENED, subjectType: 'Shift', subjectId: body.id, branchId: register.branchId, payload, occurredAt: now });
      }
      const [view] = await this.views(tx, await this.store.shifts(tx, [body.id]));
      await this.audit.record(tx, { module: 'pos', action: 'OPEN', entityType: 'Shift', entityId: body.id, branchId: register.branchId, before: null, after: { ...view! } });
      const response: StoredResponse<ShiftView> = { status: 201, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  get(actor: Actor | undefined, id: string): Promise<ShiftView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const shift = await this.readable(tx, actor, READ, id);
      return (await this.views(tx, [shift]))[0]!;
    });
  }

  list(actor: Actor | undefined, query: ShiftQuery, cursor: string | undefined, limit: number): Promise<Page<ShiftView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = [...new Set((await this.authoriser.scopes(tx, actor!, READ)).map((s) => s.branchId))];
      // A cashier who may not read every shift reads their own only, whatever the filter asks.
      const own = !(await this.authoriser.holds(tx, actor!, READ_ANY));
      const cashierId = own ? actor!.principalId : query.cashierId;
      const binding = {
        operationId: 'listShifts',
        principalId: actor!.principalId,
        filters: { registerId: query.registerId, cashierId: query.cashierId, status: query.status, from: query.from?.toISOString() ?? null, to: query.to?.toISOString() ?? null },
      };
      const before = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const rows = own && query.cashierId !== null && query.cashierId !== actor!.principalId ? [] : await this.store.listShifts(tx, { ...query, cashierId, branchIds }, before, oneMore(limit));
      const kept = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      return { data: await this.views(tx, kept), page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: kept.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  listCashMovements(actor: Actor | undefined, shiftId: string, cursor: string | undefined, limit: number): Promise<Page<CashMovementView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.readable(tx, actor, READ, shiftId);
      const binding = { operationId: 'listShiftCashMovements', principalId: actor!.principalId, filters: { shiftId } };
      const before = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const rows = await this.store.cashMovementsOf(tx, shiftId, before, oneMore(limit));
      const kept = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      return { data: await this.movementViews(tx, kept), page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: kept.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  /**
   * `recordCashMovement` (FR-POS-016): a drop to the safe witnessed by a supervisor who is not the cashier, a pay-out for
   * an expense, or the float topped up from the safe, on the cashier's own open shift; never more out than it holds.
   */
  recordCashMovement(actor: Actor | undefined, shiftId: string, body: CashMovementRequest, idempotencyKey: string): Promise<StoredResponse<CashMovementView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const shift = await this.store.lockShift(tx, shiftId);
      await this.authoriser.authorise(tx, actor, MOVE, shift === null ? {} : { ...(await this.scopeOf(tx, shift)), owner: { principalId: shift.cashierId, anyPermission: MOVE_ANY } });
      if (shift === null) throw new NotFoundError(`no shift ${shiftId}`);
      const claim = await this.idempotency.claim(tx, { operationId: 'recordCashMovement', principalId: actor!.principalId, key: idempotencyKey, request: { shiftId, ...body, amountPesewas: body.amountPesewas.toString() } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<CashMovementView>;
      if (shift.status !== 'OPEN') throw new ShiftNotOpenError(shift.status);
      const now = this.clock.now();
      const reason = body.reasonCode === undefined ? undefined : (await this.refs.reasonCodesIn(tx, [body.reasonCode])).get(body.reasonCode);
      const witnessId = body.witnessId ?? null;
      const witnessIsSupervisor = witnessId !== null && (await this.holdsAt(tx, witnessId, APPROVE, shift.branchId));
      const position = await this.position(tx, shift);
      const broken: TillRule[] = judgeCashMovement({
        kind: body.kind,
        amount: Money.ofPesewas(body.amountPesewas),
        reasonCode: body.reasonCode ?? null,
        reasonDomain: reason?.domain ?? null,
        reasonNeedsNote: reason?.requiresNote ?? false,
        note: body.note ?? null,
        witnessId,
        cashierId: shift.cashierId,
        actorId: actor!.principalId,
        witnessIsSupervisor,
        tillHolds: position.expected,
      });
      if (!isUuidV7(body.id)) broken.push({ field: '/id', rule: 'ID_NOT_UUID_V7' });
      if (!withinTolerance(body.occurredAt, now)) broken.push({ field: '/occurredAt', rule: 'OCCURRED_AT_OUT_OF_WINDOW' });
      if (broken.length > 0) throw new CashMovementInvalidError(broken);
      const record: CashMovementRecord = {
        id: body.id,
        shiftId,
        kind: body.kind,
        amountPesewas: body.amountPesewas,
        reasonCode: body.reasonCode!,
        note: body.note ?? null,
        witnessId,
        occurredAt: now,
        recordedAt: now,
        actorId: actor!.principalId,
      };
      try {
        await this.store.insertCashMovement(tx, record);
      } catch (error) {
        if (sqlStateOf(error) === UNIQUE_VIOLATION) throw new IdempotencyKeyReusedError('the cash movement id is already recorded');
        throw error;
      }
      const register = (await this.store.registers(tx, [shift.registerId]))[0]!;
      const event = MOVEMENT_EVENTS[body.kind];
      const payload: CashMoved = {
        shiftId,
        subjectId: body.id,
        branchId: shift.branchId,
        register: { id: register.id, code: register.code },
        cashierId: shift.cashierId,
        reasonCode: record.reasonCode,
        movementId: body.id,
        kind: body.kind,
        witnessId,
        actorId: actor!.principalId,
        occurredAt: now.toISOString(),
        amountsPesewas: { [event.key]: pesewas(body.amountPesewas) } as CashMoved['amountsPesewas'],
      };
      await this.events.publish(tx, { type: event.type, subjectType: 'CashMovement', subjectId: body.id, branchId: shift.branchId, payload, occurredAt: now });
      const [view] = await this.movementViews(tx, [record]);
      await this.audit.record(tx, { module: 'pos', action: body.kind, entityType: 'CashMovement', entityId: body.id, branchId: shift.branchId, before: null, after: { ...view! } });
      const response: StoredResponse<CashMovementView> = { status: 201, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** `getShiftXReport` (FR-POS-017): a reading of the shift as it stands; it shows no expected cash. */
  xReport(actor: Actor | undefined, id: string): Promise<ShiftReportView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const shift = await this.readable(tx, actor, REPORT, id);
      return this.report(tx, shift, 'X', this.clock.now());
    });
  }

  /** `getShiftZReport` (FR-POS-017): the report frozen at the sign-off; a shift not yet signed off has none. */
  zReport(actor: Actor | undefined, id: string): Promise<ShiftReportView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.readable(tx, actor, REPORT, id);
      const stored = await this.store.zReport(tx, id);
      if (stored === null) throw new NotFoundError(`shift ${id} has no Z report until its count is signed off`);
      return stored.totals as unknown as ShiftReportView;
    });
  }

  /**
   * `closeShift` (FR-POS-018): the cashier declares the count of their own open shift, blind, one figure per payment
   * method counted and cash always. The shift is then CLOSING; nothing more can be sold or moved on it.
   */
  close(actor: Actor | undefined, id: string, body: ShiftCloseRequest, idempotencyKey: string): Promise<StoredResponse<ShiftView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const shift = await this.store.lockShift(tx, id);
      await this.authoriser.authorise(tx, actor, CLOSE, await this.scopeOf(tx, shift));
      if (shift === null) throw new NotFoundError(`no shift ${id}`);
      if (shift.cashierId !== actor!.principalId) throw new ForbiddenError(`${CLOSE} refused: only the shift's own cashier declares its count`);
      const claim = await this.idempotency.claim(tx, { operationId: 'closeShift', principalId: actor!.principalId, key: idempotencyKey, request: { id, declared: body.declared.map((d) => ({ ...d, declaredPesewas: d.declaredPesewas.toString() })), lastDeviceCounter: body.lastDeviceCounter ?? null } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ShiftView>;
      if (shift.status !== 'OPEN') throw new ShiftNotOpenError(shift.status);
      const methods = await this.refs.paymentMethodsIn(tx, body.declared.map((d) => d.paymentMethodId));
      const broken: TillRule[] = [];
      const seen = new Set<string>();
      for (const [i, d] of body.declared.entries()) {
        if (seen.has(d.paymentMethodId)) broken.push({ field: `/declared/${i}/paymentMethodId`, rule: 'METHOD_DECLARED_TWICE' });
        seen.add(d.paymentMethodId);
        if (!methods.has(d.paymentMethodId)) broken.push({ field: `/declared/${i}/paymentMethodId`, rule: 'METHOD_UNKNOWN' });
      }
      const cash = body.declared.filter((d) => methods.get(d.paymentMethodId)?.kind === 'CASH');
      if (cash.length !== 1) broken.push({ field: '/declared', rule: 'CASH_NOT_DECLARED' });
      if ((body.lastDeviceCounter ?? 0) > shift.lastDeviceCounter) broken.push({ field: '/lastDeviceCounter', rule: 'DEVICE_SALES_NOT_SYNCED' });
      if (broken.length > 0) throw new ShiftInvalidError(broken);
      const now = this.clock.now();
      await this.store.declare(tx, id, { declaredCashPesewas: cash[0]!.declaredPesewas, at: now, actorId: actor!.principalId });
      await this.store.insertTenderCounts(
        tx,
        body.declared.map((d) => ({ shiftId: id, paymentMethodId: d.paymentMethodId, declaredPesewas: d.declaredPesewas, expectedPesewas: null, variancePesewas: null, varianceDirection: null })),
        actor!.principalId,
        now,
      );
      const [view] = await this.views(tx, await this.store.shifts(tx, [id]));
      await this.audit.record(tx, { module: 'pos', action: 'DECLARE', entityType: 'Shift', entityId: id, branchId: shift.branchId, before: { status: shift.status }, after: { status: 'CLOSING', declared: body.declared.map((d) => ({ paymentMethodId: d.paymentMethodId, declaredPesewas: pesewas(d.declaredPesewas) })) } });
      const response: StoredResponse<ShiftView> = { status: 200, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * `approveShiftClose` (FR-POS-018, FR-POS-019): a supervisor who is not the cashier signs off the declared count. The
   * expected figures are computed from the records now, the over or short posts to 6900 (◆ `pos.ShiftClosed`), what was
   * counted goes to the safe, the shift is CLOSED and frozen, and the Z report is stored.
   */
  approveClose(actor: Actor | undefined, id: string, body: { readonly reason: string }, idempotencyKey: string): Promise<StoredResponse<ShiftView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const shift = await this.store.lockShift(tx, id);
      await this.authoriser.authorise(tx, actor, APPROVE, await this.scopeOf(tx, shift));
      if (shift === null) throw new NotFoundError(`no shift ${id}`);
      const claim = await this.idempotency.claim(tx, { operationId: 'approveShiftClose', principalId: actor!.principalId, key: idempotencyKey, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ShiftView>;
      if (!judgeCountSignOff(shift.cashierId, actor!.principalId).ok) throw new ShiftCloseSamePersonError();
      if (shift.status !== 'CLOSING') throw new ShiftInvalidError([{ field: '/status', rule: 'SHIFT_NOT_CLOSING' }]);
      const now = this.clock.now();
      const position = await this.position(tx, shift);
      const counts = await this.store.tenderCounts(tx, [id]);
      const methods = await this.refs.paymentMethodsIn(tx, counts.map((c) => c.paymentMethodId));
      for (const c of counts) {
        const expected = methods.get(c.paymentMethodId)?.kind === 'CASH' ? position.expected : takenBy(position.totals, c.paymentMethodId);
        const variance = overShort(Money.ofPesewas(c.declaredPesewas), expected);
        await this.store.completeTenderCount(tx, { ...c, expectedPesewas: expected.pesewas, variancePesewas: variance.amount.pesewas, varianceDirection: variance.direction });
      }
      const declared = Money.ofPesewas(shift.declaredCashPesewas!);
      const difference = overShort(declared, position.expected);
      await this.store.close(tx, id, { expectedCashPesewas: position.expected.pesewas, overShortPesewas: difference.amount.pesewas, overShortDirection: difference.direction, approvedBy: actor!.principalId, at: now });
      const register = (await this.store.registers(tx, [shift.registerId]))[0]!;
      const amounts = closeAmounts(declared, position.expected);
      const payload: ShiftClosed = {
        shiftId: id,
        subjectId: id,
        branchId: shift.branchId,
        register: { id: register.id, code: register.code },
        cashierId: shift.cashierId,
        reasonCode: null,
        shiftNo: shift.shiftNo,
        approvedBy: actor!.principalId,
        reason: body.reason,
        declaredCashPesewas: declared.toJsonInteger(),
        expectedCashPesewas: position.expected.toJsonInteger(),
        overShortPesewas: difference.amount.toJsonInteger(),
        overShortDirection: difference.direction,
        closedAt: now.toISOString(),
        abuseCases: [SHIFT_OVER_SHORT_ABUSE],
        amountsPesewas: { expected: amounts.expected.toJsonInteger(), returnedToSafe: amounts.returnedToSafe.toJsonInteger(), short: amounts.short.toJsonInteger(), over: amounts.over.toJsonInteger() },
      };
      await this.events.publish(tx, { type: SHIFT_CLOSED, subjectType: 'Shift', subjectId: id, branchId: shift.branchId, payload, occurredAt: now });
      const [closed] = await this.store.shifts(tx, [id]);
      await this.store.insertReport(tx, { id: this.nextId(), shiftId: id, kind: 'Z', totals: await this.report(tx, closed!, 'Z', now), actorId: actor!.principalId, at: now });
      const [view] = await this.views(tx, [closed!]);
      await this.audit.record(tx, { module: 'pos', action: 'APPROVE_CLOSE', entityType: 'Shift', entityId: id, branchId: shift.branchId, before: { status: shift.status }, after: { ...view!, reason: body.reason } });
      const response: StoredResponse<ShiftView> = { status: 200, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** Where a shift's till sells from: its branch and location, which a grant to a location must cover (ADR-0017). */
  private async scopeOf(tx: Transaction, shift: ShiftRecord | null | undefined): Promise<{ branchId?: string; locationId?: string }> {
    if (shift === null || shift === undefined) return {};
    const register = (await this.store.registers(tx, [shift.registerId]))[0]!;
    return { branchId: register.branchId, locationId: register.locationId };
  }

  /** A shift the actor may read: found, at a till their grant reaches, and their own unless they supervise. */
  private async readable(tx: Transaction, actor: Actor | undefined, permission: string, id: string): Promise<ShiftRecord> {
    const [shift] = await this.store.shifts(tx, [id]);
    await this.authoriser.authorise(tx, actor, permission, shift === undefined ? {} : { ...(await this.scopeOf(tx, shift)), owner: { principalId: shift.cashierId, anyPermission: READ_ANY } });
    if (shift === undefined) throw new NotFoundError(`no shift ${id}`);
    return shift;
  }

  /** Whether a principal holds a permission at the branch now, for a drop's witness (A-273 (d)). */
  private async holdsAt(tx: Transaction, principalId: string, permission: string, branchId: string): Promise<boolean> {
    // The witness is not the caller: their grants are read by id, as the caller's would be, and nothing is refused.
    const witness: Actor = { principalId, kind: 'USER', displayName: '', realm: 'STAFF', sessionId: null, steppedUpAt: null };
    return (await this.authoriser.scopes(tx, witness, permission)).some((s) => s.branchId === branchId);
  }

  /** What the till should hold from its records (FR-POS-019): the float, its cash payments less refunds, its movements. */
  private async position(tx: Transaction, shift: ShiftRecord): Promise<TillPosition> {
    const totals = await this.payments.shiftTotalsIn(tx, shift.id);
    const movements = await this.store.cashMovementTotals(tx, shift.id);
    const cash = totals.filter((t) => t.methodKind === 'CASH').reduce((sum, t) => sum.plus(Money.ofPesewas(t.amountPesewas)).minus(Money.ofPesewas(t.refundedPesewas)), Money.zero());
    const of = (kind: CashMovementKind) => Money.ofPesewas(movements.get(kind) ?? 0n);
    const expected = expectedCash({ float: of('FLOAT_IN'), cashTaken: cash, payIns: of('PAY_IN'), drops: of('CASH_DROP'), payOuts: of('PAY_OUT') });
    if (!expected.ok) throw new Error(`shift ${shift.id}: its records take out more cash than came in`);
    return { totals, movements, expected: expected.value };
  }

  private async report(tx: Transaction, shift: ShiftRecord, kind: 'X' | 'Z', at: Date): Promise<ShiftReportView> {
    const position = await this.position(tx, shift);
    const sales = await this.orders.shiftSalesIn(tx, shift.id);
    const register = (await this.store.registers(tx, [shift.registerId]))[0]!;
    const names = await this.principals.refs(tx, [shift.cashierId]);
    const methods = await this.refs.paymentMethodsIn(tx, position.totals.map((t) => t.paymentMethodId));
    const order: readonly CashMovementKind[] = ['FLOAT_IN', 'CASH_DROP', 'PAY_OUT', 'PAY_IN'];
    return {
      kind,
      shift: { id: shift.id, code: shift.shiftNo, name: `${register.name}, ${names.get(shift.cashierId)?.displayName ?? 'Unknown'}` },
      generatedAt: at.toISOString(),
      salesCount: sales.salesCount,
      grossSalesPesewas: pesewas(sales.grossSalesPesewas),
      voidsCount: sales.voidsCount,
      voidsPesewas: pesewas(sales.voidsPesewas),
      overridesCount: sales.overridesCount,
      overridesPesewas: pesewas(sales.overridesPesewas),
      refundsPesewas: pesewas(position.totals.reduce((sum, t) => sum + t.refundedPesewas, 0n)),
      byMethod: position.totals.map((t) => ({ paymentMethod: methodRef(methods.get(t.paymentMethodId), t), count: t.count, amountPesewas: pesewas(t.amountPesewas) })),
      cashMovements: order.filter((k) => position.movements.has(k)).map((k) => ({ kind: k, amountPesewas: pesewas(position.movements.get(k)!) })),
      currency: 'GHS',
      documentId: null,
    };
  }

  private async views(tx: Transaction, shifts: readonly ShiftRecord[]): Promise<ShiftView[]> {
    if (shifts.length === 0) return [];
    const registers = new Map((await this.store.registers(tx, [...new Set(shifts.map((s) => s.registerId))])).map((r) => [r.id, r]));
    const names = await this.principals.refs(tx, [...new Set(shifts.flatMap((s) => [s.cashierId, ...(s.closeApprovedBy === null ? [] : [s.closeApprovedBy])]))]);
    const counts = await this.store.tenderCounts(tx, shifts.map((s) => s.id));
    const methods = await this.refs.paymentMethodsIn(tx, [...new Set(counts.map((c) => c.paymentMethodId))]);
    const views: ShiftView[] = [];
    for (const s of shifts) {
      const register = registers.get(s.registerId)!;
      const sales = await this.orders.shiftSalesIn(tx, s.id);
      // Blind: nothing expected is shown before the count is declared; once declared it is the records' figure now,
      // and once signed off it is what was frozen.
      const live = s.status === 'CLOSING' ? (await this.position(tx, s)).expected : null;
      const expected = s.status === 'CLOSED' ? s.expectedCashPesewas : (live?.pesewas ?? null);
      const difference = expected === null || s.declaredCashPesewas === null ? null : overShort(Money.ofPesewas(s.declaredCashPesewas), Money.ofPesewas(expected));
      const shiftCounts = counts.filter((c) => c.shiftId === s.id);
      const tenders = await Promise.all(shiftCounts.map(async (c) => this.countView(tx, s, c, methods, live)));
      views.push({
        id: s.id,
        shiftNo: s.shiftNo,
        status: s.status,
        register: { id: register.id, code: register.code, name: register.name },
        cashier: names.get(s.cashierId) ?? { id: s.cashierId, displayName: 'Unknown' },
        shiftSeq: s.shiftSeq,
        openedAt: s.openedAt.toISOString(),
        openingFloatPesewas: pesewas(s.openingFloatPesewas),
        closedAt: s.closedAt?.toISOString() ?? null,
        declaredCashPesewas: nullable(s.declaredCashPesewas),
        expectedCashPesewas: nullable(expected),
        overShortPesewas: difference === null ? null : pesewas(difference.amount.pesewas),
        overShortDirection: difference?.direction ?? null,
        closeApprovedBy: s.closeApprovedBy === null ? null : (names.get(s.closeApprovedBy) ?? { id: s.closeApprovedBy, displayName: 'Unknown' }),
        forceClosed: s.forceClosed,
        lastDeviceCounter: s.lastDeviceCounter,
        salesCount: sales.salesCount,
        tenders,
        currency: 'GHS',
        branchId: s.branchId,
        version: s.version,
      });
    }
    return views;
  }

  private async countView(tx: Transaction, s: ShiftRecord, c: TenderCountRecord, methods: ReadonlyMap<string, { readonly id: string; readonly code: string; readonly name: string; readonly kind: string }>, liveCash: Money | null): Promise<ShiftView['tenders'][number]> {
    const method = methods.get(c.paymentMethodId);
    let expected = c.expectedPesewas;
    if (expected === null && s.status === 'CLOSING') {
      expected = method?.kind === 'CASH' ? liveCash!.pesewas : takenBy((await this.position(tx, s)).totals, c.paymentMethodId).pesewas;
    }
    const variance = expected === null ? null : overShort(Money.ofPesewas(c.declaredPesewas), Money.ofPesewas(expected));
    return {
      paymentMethod: method === undefined ? { id: c.paymentMethodId, code: 'UNKNOWN', name: 'Unknown', kind: 'CASH' } : { id: method.id, code: method.code, name: method.name, kind: method.kind },
      declaredPesewas: pesewas(c.declaredPesewas),
      expectedPesewas: nullable(expected),
      variancePesewas: variance === null ? null : pesewas(variance.amount.pesewas),
      varianceDirection: variance?.direction ?? null,
    };
  }

  private async movementViews(tx: Transaction, records: readonly CashMovementRecord[]): Promise<CashMovementView[]> {
    const names = await this.principals.refs(tx, [...new Set(records.flatMap((m) => [m.actorId, ...(m.witnessId === null ? [] : [m.witnessId])]))]);
    const ref = (id: string): PrincipalRef => names.get(id) ?? { id, displayName: 'Unknown' };
    return records.map((m) => ({
      id: m.id,
      kind: m.kind,
      amountPesewas: pesewas(m.amountPesewas),
      reasonCode: m.reasonCode,
      note: m.note,
      witness: m.witnessId === null ? null : ref(m.witnessId),
      actor: ref(m.actorId),
      occurredAt: m.occurredAt.toISOString(),
    }));
  }
}

function takenBy(totals: readonly ShiftTenderTotal[], methodId: string): Money {
  const total = totals.find((t) => t.paymentMethodId === methodId);
  return total === undefined ? Money.zero() : Money.ofPesewas(total.amountPesewas - total.refundedPesewas);
}

function methodRef(method: { readonly id: string; readonly code: string; readonly name: string; readonly kind: string } | undefined, total: ShiftTenderTotal): MethodRef {
  return method === undefined ? { id: total.paymentMethodId, code: total.methodCode, name: total.methodName, kind: total.methodKind } : { id: method.id, code: method.code, name: method.name, kind: method.kind };
}
