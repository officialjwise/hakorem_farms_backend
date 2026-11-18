import { createUuidV7Generator, Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditAnchorRequests } from '../../../platform/audit/audit-anchor-requests';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { sqlStateOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { NumberSeries } from '../../../platform/documents/number-series';
import { ForbiddenError, NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import { IdempotencyKeyReusedError, type Idempotency, type StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Settings } from '../../../platform/settings/settings';
import type { Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import type { Orders } from '../../ord';
import type { Payments, ShiftTenderTotal } from '../../pay';
import { closeAmounts, expectedCash, isUnwitnessedDrop, judgeCashMovement, judgeCountSignOff, judgeForceClose, judgeLateCount, overShort, type CashMovementKind } from '../domain/till';
import { CLOCK_TOLERANCE_SECONDS, CLOCK_TOLERANCE_SETTING, isUuidV7, withinTolerance } from '../domain/client-time';
import { oneMore } from './paging';
import type { CashMoved, OfflineShiftFlagged, ShiftClosed, ShiftForceClosed, ShiftOpened } from '../events';
import { offlineShiftOpenTime, type ShiftOpenClockVerdict } from '../domain/offline-queue';
import { MAX_SALE_AGE_HOURS, MAX_SALE_AGE_SETTING } from '../domain/offline-sync';
import type { Devices } from './devices';
import { CashMovementInvalidError, ShiftAlreadyOpenError, ShiftCloseSamePersonError, ShiftInvalidError, ShiftNotOpenError, type TillRule } from './errors';
import type { CashMovementRecord, LateCountRecord, ShiftRecord, ShiftStatus, TenderCountRecord, TillStore } from './till-store';
import type { HeldSales } from './held-sales';

export const SHIFT_OPENED = 'pos.ShiftOpened';
export const CASH_DROPPED = 'pos.CashDropped';
export const CASH_PAID_IN = 'pos.CashPaidIn';
export const CASH_PAID_OUT = 'pos.CashPaidOut';
export const SHIFT_CLOSED = 'pos.ShiftClosed';
export const SHIFT_FORCE_CLOSED = 'pos.ShiftForceClosed';
export const OFFLINE_SHIFT_FLAGGED = 'pos.OfflineShiftFlagged';
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
/** A manager closing an abandoned shift (FR-POS-020), seeded with step-up to the Owner and the Manager (A-274 (d)). */
const FORCE_CLOSE = 'pos.shift.force_close';
const UNIQUE_VIOLATION = '23505';
/** Abuse case 17, a shift closed short (THREAT_MODEL section 4): every sign-off reaches the daily exception report's source. */
const SHIFT_OVER_SHORT_ABUSE = 17;
export const MOVEMENT_EVENTS: Readonly<Record<'CASH_DROP' | 'PAY_IN' | 'PAY_OUT', { readonly type: string; readonly key: 'drop' | 'payIn' | 'payOut' }>> = {
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
  /** Why it was force-closed (FR-POS-020); null on every other shift. */
  readonly forceCloseReason: string | null;
  /** Who counted a force-closed shift's drawer, and when (A-275); null until then and on every other shift. */
  readonly countedBy: PrincipalRef | null;
  readonly countedAt: string | null;
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
  /** A drop taken while no supervisor was signed in at the branch (A-273 (d)). */
  readonly unwitnessed: boolean;
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
  /** Drops taken unwitnessed because no supervisor was signed in at the branch (A-273 (d)). */
  readonly unwitnessedDropsCount: number;
  readonly unwitnessedDropsPesewas: number;
  /** The shift was force-closed by a manager (FR-POS-020: flagged on every report). */
  readonly forceClosed: boolean;
  readonly currency: 'GHS';
  readonly documentId: string | null;
}

export interface LateCountRequest {
  readonly declaredCashPesewas: bigint;
  readonly reason: string;
}

export interface ShiftOpenRequest {
  readonly id: string;
  readonly registerId: string;
  readonly openingFloatPesewas: bigint;
  readonly openedAt: Date;
  /** The sequence the till printed in its references offline, from its last pack (OFFLINE_SYNC 10); the server's stands. */
  readonly shiftSeq?: number | undefined;
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
    private readonly anchors: AuditAnchorRequests,
    private readonly held: HeldSales,
    private readonly settings: Settings,
    private readonly devices: Devices,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /**
   * `openShift`: one open shift per register and per cashier; the float moves from the safe to the till (FR-POS-015).
   * Sent by an enrolled device of the till (`X-Device-Credential`), it may be a shift the till opened offline and kept
   * in its queue (OFFLINE_SYNC 10, B09b continued 2c, A-279 (a) to (c)): applied once by its id at the till's
   * `openedAt` though hours old, its sequence the server's, a till time outside the tolerance recorded at the server's
   * time and flagged, never refused; a second shift opened offline on a till that already has one is refused as
   * online (422 `SHIFT_ALREADY_OPEN`) and raised. Without a device credential it is an online open, as B9b built it.
   */
  async open(actor: Actor | undefined, body: ShiftOpenRequest, idempotencyKey: string, deviceCredential?: string): Promise<StoredResponse<ShiftView>> {
    const refusal: { value: RefusedOpen | null } = { value: null };
    try {
      return await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        refusal.value = null;
        const register = await this.store.lockRegister(tx, body.registerId);
        await this.authoriser.authorise(tx, actor, OPEN, register === null ? {} : { branchId: register.branchId, locationId: register.locationId });
        if (register === null) throw new NotFoundError(`no register ${body.registerId}`);
        const claim = await this.idempotency.claim(tx, { operationId: 'openShift', principalId: actor!.principalId, key: idempotencyKey, request: { ...body, openingFloatPesewas: body.openingFloatPesewas.toString() } });
        if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ShiftView>;
        const now = this.clock.now();
        // A till's own device may send a shift it opened offline; the credential is checked before anything is judged.
        const device = deviceCredential === undefined ? null : await this.devices.deviceOfIn(tx, deviceCredential, register.id);
        const tolerance = await this.settings.integer(CLOCK_TOLERANCE_SETTING, CLOCK_TOLERANCE_SECONDS);
        const broken: TillRule[] = [];
        if (!isUuidV7(body.id)) broken.push({ field: '/id', rule: 'ID_NOT_UUID_V7' });
        if (register.status !== 'ACTIVE') broken.push({ field: '/registerId', rule: 'REGISTER_RETIRED' });
        const timed =
          device === null
            ? { openedAt: now, verdict: null, tooOld: false }
            : offlineShiftOpenTime({ tillOpenedAt: body.openedAt, receivedAt: now, previousClosedAt: await this.store.lastClosedAt(tx, register.id), toleranceSeconds: tolerance, maxAgeHours: await this.settings.integer(MAX_SALE_AGE_SETTING, MAX_SALE_AGE_HOURS) });
        if (device === null && !withinTolerance(body.openedAt, now, tolerance)) broken.push({ field: '/openedAt', rule: 'OPENED_AT_OUT_OF_WINDOW' });
        if (broken.length > 0) throw new ShiftInvalidError(broken);
        const holder = (await this.store.unclosedShifts(tx, [register.id])).get(register.id) ?? null;
        if (holder !== null) {
          if (device !== null) refusal.value = { register, deviceId: device.id, cashierId: actor!.principalId, at: now, holder };
          throw new ShiftAlreadyOpenError('/registerId');
        }
        if ((await this.store.unclosedShiftOfCashier(tx, actor!.principalId)) !== null) {
          if (device !== null) refusal.value = { register, deviceId: device.id, cashierId: actor!.principalId, at: now, holder: null };
          throw new ShiftAlreadyOpenError('/cashier');
        }
        const openedAt = timed.openedAt;
        const year = toBusinessDate(openedAt).slice(0, 4);
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
          openedAt,
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
            unwitnessed: false,
            occurredAt: openedAt,
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
            openedAt: openedAt.toISOString(),
            amountsPesewas: { float: pesewas(body.openingFloatPesewas) },
          };
          await this.events.publish(tx, { type: SHIFT_OPENED, subjectType: 'Shift', subjectId: body.id, branchId: register.branchId, payload, occurredAt: openedAt });
        }
        if (device !== null) {
          const flags = offlineShiftFlags({ tillOpenedAt: body.openedAt, recordedOpenedAt: openedAt, receivedAt: now, verdict: timed.verdict, tooOld: timed.tooOld, tillSeq: body.shiftSeq ?? null, serverSeq: shiftSeq, toleranceSeconds: tolerance });
          for (const flag of flags) {
            const payload: OfflineShiftFlagged = {
              shiftId: body.id,
              branchId: register.branchId,
              register: { id: register.id, code: register.code },
              deviceId: device.id,
              cashierId: actor!.principalId,
              ...flag,
              amountPesewas: pesewas(body.openingFloatPesewas),
              claim: { source: 'POS_OFFLINE', openedAt: body.openedAt.toISOString(), shiftSeq: body.shiftSeq ?? null, openingFloatPesewas: pesewas(body.openingFloatPesewas) },
            };
            await this.events.publish(tx, { type: OFFLINE_SHIFT_FLAGGED, subjectType: 'Shift', subjectId: body.id, branchId: register.branchId, payload, occurredAt: now });
          }
        }
        const [view] = await this.views(tx, await this.store.shifts(tx, [body.id]));
        await this.audit.record(tx, {
          module: 'pos',
          action: 'OPEN',
          entityType: 'Shift',
          entityId: body.id,
          branchId: register.branchId,
          before: null,
          after: { ...view!, ...(device === null ? {} : { deviceId: device.id, tillOpenedAt: body.openedAt.toISOString(), tillShiftSeq: body.shiftSeq ?? null }) },
        });
        const response: StoredResponse<ShiftView> = { status: 201, body: view! };
        await this.idempotency.complete(tx, claim.id, response);
        return response;
      });
    } catch (error) {
      // A second shift opened offline on one till is refused as online, and raised for the manager who closes one
      // (OFFLINE_SYNC 10): the refusal rolled back, so it is recorded in a transaction of its own.
      if (error instanceof ShiftAlreadyOpenError && refusal.value !== null) await this.raiseRefusedOpen(actor!, body, refusal.value);
      throw error;
    }
  }

  private async raiseRefusedOpen(
    actor: Actor,
    body: ShiftOpenRequest,
    r: RefusedOpen,
  ): Promise<void> {
    await this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const fact = r.holder === null ? { rule: 'CASHIER_HAS_OPEN_SHIFT' } : { rule: 'REGISTER_HAS_OPEN_SHIFT', openShiftId: r.holder.id, openShiftNo: r.holder.shiftNo, openShiftCashierId: r.holder.cashierId, openShiftOpenedAt: r.holder.openedAt.toISOString() };
      const payload: OfflineShiftFlagged = {
        shiftId: body.id,
        branchId: r.register.branchId,
        register: { id: r.register.id, code: r.register.code },
        deviceId: r.deviceId,
        cashierId: r.cashierId,
        exceptionKind: 'OFFLINE_SHIFT_REFUSED',
        severity: 'URGENT',
        summary: r.holder === null ? 'A shift the till opened offline was refused: its cashier already has a shift open' : `A shift the till opened offline was refused: the till already has shift ${r.holder.shiftNo} open; a manager closes one`,
        amountPesewas: pesewas(body.openingFloatPesewas),
        claim: { source: 'POS_OFFLINE', openedAt: body.openedAt.toISOString(), shiftSeq: body.shiftSeq ?? null, openingFloatPesewas: pesewas(body.openingFloatPesewas) },
        fact,
        abuseCases: [SHIFT_OVER_SHORT_ABUSE],
      };
      await this.events.publish(tx, { type: OFFLINE_SHIFT_FLAGGED, subjectType: 'Register', subjectId: r.register.id, branchId: r.register.branchId, payload, occurredAt: r.at });
      await this.audit.record(tx, { module: 'pos', action: 'OPEN_REFUSED', entityType: 'Register', entityId: r.register.id, branchId: r.register.branchId, before: null, after: { shiftId: body.id, deviceId: r.deviceId, cashierId: actor.principalId, ...fact } });
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
      // A supervisor present at the branch witnesses a drop; with none signed in it goes unwitnessed (A-273 (d)).
      const supervisorSignedIn = body.kind === 'CASH_DROP' && (await this.authoriser.signedInHoldersIn(tx, APPROVE, shift.branchId)).some((p) => p !== shift.cashierId && p !== actor!.principalId);
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
        supervisorSignedIn,
        tillHolds: position.expected,
      });
      const unwitnessed = isUnwitnessedDrop({ kind: body.kind, witnessId, supervisorSignedIn });
      if (!isUuidV7(body.id)) broken.push({ field: '/id', rule: 'ID_NOT_UUID_V7' });
      if (!withinTolerance(body.occurredAt, now, await this.settings.integer(CLOCK_TOLERANCE_SETTING, CLOCK_TOLERANCE_SECONDS))) broken.push({ field: '/occurredAt', rule: 'OCCURRED_AT_OUT_OF_WINDOW' });
      if (broken.length > 0) throw new CashMovementInvalidError(broken);
      const record: CashMovementRecord = {
        id: body.id,
        shiftId,
        kind: body.kind,
        amountPesewas: body.amountPesewas,
        reasonCode: body.reasonCode!,
        note: body.note ?? null,
        witnessId,
        unwitnessed,
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
        ...(unwitnessed ? { unwitnessed: true, abuseCases: [SHIFT_OVER_SHORT_ABUSE] } : {}),
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
      // Nothing more is sold on a closing shift: the sales still held on it lapse (FR-POS-007, A-276).
      await this.held.lapseIn(tx, shift, 'SHIFT_CLOSED', now);
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
      // The worker anchors the audit chain once this sign-off is sealed into it (ADR-0006, A-275).
      await this.anchors.requestIn(tx, { reason: 'SHIFT_CLOSE', subjectType: 'Shift', subjectId: id, actorId: actor!.principalId });
      const response: StoredResponse<ShiftView> = { status: 200, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * `forceCloseShift` (FR-POS-020, OFFLINE_SYNC 11): a manager who is not the cashier, with a fresh step-up and a reason,
   * closes an abandoned OPEN shift at the cash its records say it holds, flagged force-closed. Nothing is declared and
   * nothing posts: the drawer has not been counted. From now on no cash moves through it (ADR-0077). The expected cash
   * stays hidden, as for any close, until the drawer is counted (`countForceClosedShift`).
   */
  forceClose(actor: Actor | undefined, id: string, body: { readonly reason: string }, idempotencyKey: string): Promise<StoredResponse<ShiftView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const shift = await this.store.lockShift(tx, id);
      await this.authoriser.authorise(tx, actor, FORCE_CLOSE, await this.scopeOf(tx, shift));
      if (shift === null) throw new NotFoundError(`no shift ${id}`);
      const claim = await this.idempotency.claim(tx, { operationId: 'forceCloseShift', principalId: actor!.principalId, key: idempotencyKey, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ShiftView>;
      const judged = judgeForceClose(shift, actor!.principalId);
      if (!judged.ok && judged.error === 'FORCE_CLOSER_IS_CASHIER') throw new ShiftCloseSamePersonError({ field: '/cashier', rule: 'FORCE_CLOSER_IS_CASHIER' });
      if (!judged.ok) throw new ShiftNotOpenError(shift.status);
      const now = this.clock.now();
      const position = await this.position(tx, shift);
      await this.held.lapseIn(tx, shift, 'SHIFT_FORCE_CLOSED', now);
      await this.store.forceClose(tx, id, { expectedCashPesewas: position.expected.pesewas, reason: body.reason, closedBy: actor!.principalId, at: now });
      const register = (await this.store.registers(tx, [shift.registerId]))[0]!;
      const payload: ShiftForceClosed = {
        shiftId: id,
        branchId: shift.branchId,
        register: { id: register.id, code: register.code },
        cashierId: shift.cashierId,
        shiftNo: shift.shiftNo,
        forceClosedBy: actor!.principalId,
        reason: body.reason,
        expectedCashPesewas: position.expected.toJsonInteger(),
        closedAt: now.toISOString(),
        abuseCases: [SHIFT_OVER_SHORT_ABUSE],
        exceptionKind: 'SHIFT_FORCE_CLOSED',
      };
      await this.events.publish(tx, { type: SHIFT_FORCE_CLOSED, subjectType: 'Shift', subjectId: id, branchId: shift.branchId, payload, occurredAt: now });
      const [view] = await this.views(tx, await this.store.shifts(tx, [id]));
      await this.audit.record(tx, {
        module: 'pos',
        action: 'FORCE_CLOSE',
        entityType: 'Shift',
        entityId: id,
        branchId: shift.branchId,
        before: { status: shift.status, forceClosed: false },
        after: { status: 'CLOSED', forceClosed: true, reason: body.reason, expectedCashPesewas: position.expected.toJsonInteger(), forceClosedBy: actor!.principalId },
      });
      const response: StoredResponse<ShiftView> = { status: 200, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * `countForceClosedShift` (FR-POS-020, A-275): a supervisor who neither ran the shift nor force-closed it, with a
   * fresh step-up, counts its drawer. The over or short is the count less the cash the shift was closed at and posts as
   * a sign-off does (◆ `pos.ShiftClosed`: Cr 1000 expected, Dr 1010 counted, 6900 the difference); the Z report is
   * stored and the audit chain anchored. Once only.
   */
  countLate(actor: Actor | undefined, id: string, body: LateCountRequest, idempotencyKey: string): Promise<StoredResponse<ShiftView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const shift = await this.store.lockShift(tx, id);
      await this.authoriser.authorise(tx, actor, APPROVE, await this.scopeOf(tx, shift));
      if (shift === null) throw new NotFoundError(`no shift ${id}`);
      const claim = await this.idempotency.claim(tx, { operationId: 'countForceClosedShift', principalId: actor!.principalId, key: idempotencyKey, request: { id, declaredCashPesewas: body.declaredCashPesewas.toString(), reason: body.reason } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ShiftView>;
      const counted = (await this.store.lateCounts(tx, [id])).has(id);
      const judged = judgeLateCount({ status: shift.status, forceClosed: shift.forceClosed, cashierId: shift.cashierId, forceClosedBy: shift.forceClosed ? shift.closeApprovedBy : null, counted }, actor!.principalId);
      if (!judged.ok && (judged.error === 'COUNTER_IS_CASHIER' || judged.error === 'COUNTER_IS_FORCE_CLOSER')) throw new ShiftCloseSamePersonError({ field: '/countedBy', rule: judged.error });
      if (!judged.ok) throw new ShiftInvalidError([{ field: '/status', rule: judged.error }]);
      const now = this.clock.now();
      const expected = Money.ofPesewas(shift.expectedCashPesewas!);
      const declared = Money.ofPesewas(body.declaredCashPesewas);
      const difference = overShort(declared, expected);
      const count: LateCountRecord = {
        shiftId: id,
        declaredCashPesewas: declared.pesewas,
        expectedCashPesewas: expected.pesewas,
        overShortPesewas: difference.amount.pesewas,
        overShortDirection: difference.direction,
        reason: body.reason,
        countedAt: now,
        actorId: actor!.principalId,
      };
      await this.store.insertLateCount(tx, count);
      const register = (await this.store.registers(tx, [shift.registerId]))[0]!;
      const amounts = closeAmounts(declared, expected);
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
        expectedCashPesewas: expected.toJsonInteger(),
        overShortPesewas: difference.amount.toJsonInteger(),
        overShortDirection: difference.direction,
        closedAt: now.toISOString(),
        abuseCases: [SHIFT_OVER_SHORT_ABUSE],
        forceClosed: true,
        forceClosedBy: shift.closeApprovedBy!,
        amountsPesewas: { expected: amounts.expected.toJsonInteger(), returnedToSafe: amounts.returnedToSafe.toJsonInteger(), short: amounts.short.toJsonInteger(), over: amounts.over.toJsonInteger() },
      };
      await this.events.publish(tx, { type: SHIFT_CLOSED, subjectType: 'Shift', subjectId: id, branchId: shift.branchId, payload, occurredAt: now });
      await this.store.insertReport(tx, { id: this.nextId(), shiftId: id, kind: 'Z', totals: await this.report(tx, shift, 'Z', now), actorId: actor!.principalId, at: now });
      const [view] = await this.views(tx, [shift]);
      await this.audit.record(tx, { module: 'pos', action: 'COUNT_FORCE_CLOSED', entityType: 'Shift', entityId: id, branchId: shift.branchId, before: { status: shift.status, counted: false }, after: { ...view!, reason: body.reason } });
      await this.anchors.requestIn(tx, { reason: 'SHIFT_CLOSE', subjectType: 'Shift', subjectId: id, actorId: actor!.principalId });
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
    const unwitnessedDrops = await this.store.unwitnessedDrops(tx, shift.id);
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
      unwitnessedDropsCount: unwitnessedDrops.count,
      unwitnessedDropsPesewas: pesewas(unwitnessedDrops.amountPesewas),
      forceClosed: shift.forceClosed,
      currency: 'GHS',
      documentId: null,
    };
  }

  private async views(tx: Transaction, shifts: readonly ShiftRecord[]): Promise<ShiftView[]> {
    if (shifts.length === 0) return [];
    const registers = new Map((await this.store.registers(tx, [...new Set(shifts.map((s) => s.registerId))])).map((r) => [r.id, r]));
    const late = await this.store.lateCounts(tx, shifts.filter((s) => s.forceClosed).map((s) => s.id));
    const names = await this.principals.refs(tx, [
      ...new Set(shifts.flatMap((s) => [s.cashierId, ...(s.closeApprovedBy === null ? [] : [s.closeApprovedBy]), ...(late.has(s.id) ? [late.get(s.id)!.actorId] : [])])),
    ]);
    const counts = await this.store.tenderCounts(tx, shifts.map((s) => s.id));
    const methods = await this.refs.paymentMethodsIn(tx, [...new Set(counts.map((c) => c.paymentMethodId))]);
    const views: ShiftView[] = [];
    for (const s of shifts) {
      const register = registers.get(s.registerId)!;
      const sales = await this.orders.shiftSalesIn(tx, s.id);
      // Blind: nothing expected is shown before the count is declared; once declared it is the records' figure now,
      // and once signed off it is what was frozen.
      // A force-closed shift is blind too: what it was closed at shows only once its drawer is counted (A-275).
      const count = late.get(s.id) ?? null;
      const live = s.status === 'CLOSING' ? (await this.position(tx, s)).expected : null;
      const declaredCash = s.forceClosed ? (count?.declaredCashPesewas ?? null) : s.declaredCashPesewas;
      const expected = s.forceClosed ? (count?.expectedCashPesewas ?? null) : s.status === 'CLOSED' ? s.expectedCashPesewas : (live?.pesewas ?? null);
      const difference = expected === null || declaredCash === null ? null : overShort(Money.ofPesewas(declaredCash), Money.ofPesewas(expected));
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
        declaredCashPesewas: nullable(declaredCash),
        expectedCashPesewas: nullable(expected),
        overShortPesewas: difference === null ? null : pesewas(difference.amount.pesewas),
        overShortDirection: difference?.direction ?? null,
        closeApprovedBy: s.closeApprovedBy === null ? null : (names.get(s.closeApprovedBy) ?? { id: s.closeApprovedBy, displayName: 'Unknown' }),
        forceClosed: s.forceClosed,
        forceCloseReason: s.forceCloseReason,
        countedBy: count === null ? null : (names.get(count.actorId) ?? { id: count.actorId, displayName: 'Unknown' }),
        countedAt: count?.countedAt.toISOString() ?? null,
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
      unwitnessed: m.unwitnessed,
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

/** A second shift its till opened offline, refused, with what the report's source needs (OFFLINE_SYNC 10). */
interface RefusedOpen {
  readonly register: { readonly id: string; readonly code: string; readonly branchId: string };
  readonly deviceId: string;
  readonly cashierId: string;
  readonly at: Date;
  readonly holder: ShiftRecord | null;
}

/** What a shift its till sent is flagged for (A-279 (b), (c)): each finding with its severity, for the report's source. */
function offlineShiftFlags(f: {
  readonly tillOpenedAt: Date;
  readonly recordedOpenedAt: Date;
  readonly receivedAt: Date;
  readonly verdict: ShiftOpenClockVerdict | null;
  readonly tooOld: boolean;
  readonly tillSeq: number | null;
  readonly serverSeq: number;
  readonly toleranceSeconds: number;
}): Pick<OfflineShiftFlagged, 'exceptionKind' | 'severity' | 'summary' | 'fact' | 'abuseCases'>[] {
  const flags: Pick<OfflineShiftFlagged, 'exceptionKind' | 'severity' | 'summary' | 'fact' | 'abuseCases'>[] = [];
  const times = { tillOpenedAt: f.tillOpenedAt.toISOString(), recordedOpenedAt: f.recordedOpenedAt.toISOString(), serverTime: f.receivedAt.toISOString(), toleranceSeconds: f.toleranceSeconds };
  if (f.verdict !== null) {
    flags.push({
      exceptionKind: 'TILL_CLOCK_OUT_OF_TOLERANCE',
      severity: 'REVIEW',
      summary: f.verdict === 'AHEAD_OF_SERVER' ? `The till's clock was ahead of the server by more than ${f.toleranceSeconds} seconds when it opened the shift; the server's time is recorded` : `The till's time is more than ${f.toleranceSeconds} seconds before the till's previous shift closed; the server's time is recorded`,
      fact: { verdict: f.verdict, ...times },
      abuseCases: [],
    });
  }
  if (f.tooOld) flags.push({ exceptionKind: 'OFFLINE_SHIFT_TOO_OLD', severity: 'REVIEW', summary: 'The shift reached the server longer after it was opened than an offline till may work', fact: times, abuseCases: [] });
  if (f.tillSeq !== null && f.tillSeq !== f.serverSeq) {
    flags.push({ exceptionKind: 'SHIFT_SEQ_DIFFERS', severity: 'REVIEW', summary: `The till printed shift sequence ${f.tillSeq} in its references; the server gave ${f.serverSeq}`, fact: { tillShiftSeq: f.tillSeq, serverShiftSeq: f.serverSeq }, abuseCases: [] });
  }
  return flags;
}
