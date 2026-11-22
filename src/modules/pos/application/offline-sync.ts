import { createHash } from 'node:crypto';
import { createUuidV7Generator, Money, parseUuidV7, toBusinessDate, uuidV7Timestamp, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import { sqlStateOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import { ForbiddenError, NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import { IdempotencyKeyReusedError } from '../../../platform/idempotency/idempotency';
import type { Settings } from '../../../platform/settings/settings';
import type { Ledger } from '../../fin';
import type { Authoriser } from '../../iam';
import { defaultLineUom, type MasterDataRefs, type PaymentMethodFacts, type PricingService } from '../../mdm';
import { SaleInvalidError, type OfflineSaleFinding, type Orders, type SalePosting, type SaleTenderRequest } from '../../ord';
import type { Payments, UnverifiedTenders } from '../../pay';
import { CLOCK_TOLERANCE_SECONDS, CLOCK_TOLERANCE_SETTING, isUuidV7 } from '../domain/client-time';
import {
  counterGaps,
  inCounterOrder,
  lineNoOf,
  tally,
  latePostingReason,
  MAX_SALE_AGE_HOURS,
  MAX_SALE_AGE_SETTING,
  MAX_SYNC_BATCH,
  newGaps,
  provisionalRef,
  saleTooOld,
  secondsBetween,
  severityOfLatePosting,
  tillClockVerdict,
  tillTakesCash,
  lateEntrySeverity,
  lateEntryShiftState,
  type LatePostingReason,
  type Severity,
} from '../domain/offline-sync';
import { cashMovementTimeAtSync, inMovementOrder, priorMovementAnswer, unverifiedTenderVerdict, type MovementContent } from '../domain/offline-queue';
import { expectedCash, isUnwitnessedDrop, judgeCashMovement, lateEntryAdjustment, lateEntryEffect, shiftOverrideRoom, type CashMovementKind, type LateEntryKind } from '../domain/till';
import type { TillPins } from './till-pins';
import { offlineOverrideVerdict, witnessPinRule, type OfflineOverrideVerdict, type PinApprovalVerdict } from '../domain/till-pin';
import type { CashMoved, DeviceCounterGap, OfflineCashMovementFlagged, OfflineSaleFlagged, OfflineSaleRejected, ShiftLateEntryPosted } from '../events';
import type { Devices } from './devices';
import { SyncBatchTooLargeError } from './errors';
import { OFFLINE_UNVERIFIED_MOBILE_MONEY } from './offline-packs';
import { MOVEMENT_EVENTS, SHIFT_LATE_ENTRY_POSTED } from './shifts';
import type { RegisterRecord, SaleSyncRecord, ShiftRecord, TillStore } from './till-store';

export const OFFLINE_SALE_FLAGGED = 'pos.OfflineSaleFlagged';
export const OFFLINE_SALE_REJECTED = 'pos.OfflineSaleRejected';
export const DEVICE_COUNTER_GAP = 'pos.DeviceCounterGap';
export const OFFLINE_CASH_MOVEMENT_FLAGGED = 'pos.OfflineCashMovementFlagged';
const SELL = 'pos.sale.create';
const MOVE = 'pos.cash.move';
/** The supervisor's permission: who may approve an unverified tender on the device (OFFLINE_SYNC 5.3) or witness a drop. */
const SUPERVISE = 'pos.shift.close.approve';
/** The manager recovering a till syncs its queue under their own session (OFFLINE_SYNC 6.5, 11). */
const RECOVER = 'pos.shift.force_close';
/** Abuse cases the offline findings carry (THREAT_MODEL section 4). */
const ABUSE_TENDER = 4;
const ABUSE_COUNTER_GAP = 10;
const ABUSE_STOCK = 11;
const ABUSE_OVERRIDE = 3;
const ABUSE_SHORT = 17;

/** A line of a queued sale as the device sent it (the contract's `CounterSaleLine`), amounts as JSON integers. */
export interface OfflineSaleLineInput {
  readonly productId: string;
  readonly stockUnitId?: string | undefined;
  readonly quantity: string;
  readonly uom?: string | undefined;
  readonly weightKg?: string | undefined;
  readonly weightSource?: 'SCALE' | 'MANUAL' | 'ESTIMATE' | undefined;
  readonly gradeId?: string | undefined;
  readonly agreedUnitPricePesewas: number;
  readonly varianceReasonCode?: string | undefined;
  /** A price beyond the cashier's own limit approved on the till by a supervisor's PIN (the owner on 2026-11-18). */
  readonly overrideApproval?: { readonly approvedById: string; readonly approvedByPinVersion: number } | undefined;
}

/** A tender of a queued sale as the device sent it (the contract's `TenderInput`). */
export interface OfflineTenderInput {
  readonly paymentMethodId: string;
  readonly amountPesewas: number;
  readonly paymentId?: string | undefined;
  readonly tenderedPesewas?: number | undefined;
  readonly unverifiedMobileMoney?: { readonly payerPhone: string; readonly network: 'MTN' | 'TELECEL' | 'AIRTELTIGO'; readonly providerReference?: string | undefined; readonly approvedById: string; readonly approvedByPinVersion?: number | undefined } | undefined;
}

/** A queued sale as the device sent it (the contract's `OfflineSale`), exactly as received, so its hash can be recomputed. */
export interface OfflineSaleInput {
  readonly id: string;
  readonly deviceCounter: number;
  readonly provisionalRef: string;
  readonly occurredAt: string;
  readonly customerPhone?: string | undefined;
  readonly lines: readonly OfflineSaleLineInput[];
  readonly tenders: readonly OfflineTenderInput[];
  readonly payloadHash: string;
}

/** The contract's `OfflineSyncBatch`. */
export interface OfflineSyncBatchInput {
  readonly deviceId: string;
  readonly shiftId: string;
  readonly sales: readonly OfflineSaleInput[];
  readonly cashMovements?: readonly OfflineCashMovementInput[] | undefined;
}

/** A cash movement of a batch as the device sent it (the contract's `CashMovementCreate`). */
export interface OfflineCashMovementInput {
  readonly id: string;
  readonly kind: 'CASH_DROP' | 'PAY_OUT' | 'PAY_IN';
  readonly amountPesewas: bigint;
  readonly reasonCode?: string | undefined;
  readonly note?: string | undefined;
  readonly witnessId?: string | undefined;
  readonly witnessPinVersion?: number | undefined;
  readonly occurredAt: Date;
}

type MovementAnswer = OfflineSyncResultView['cashMovementResults'][number];

export interface SyncExceptionView {
  readonly kind: string;
  readonly summary: string;
}

/** The contract's `SyncResultItem`. */
export interface SyncResultItemView {
  readonly clientSaleId: string;
  readonly deviceCounter: number;
  readonly outcome: SaleSyncRecord['outcome'];
  readonly orderId: string | null;
  readonly orderNo: string | null;
  readonly receiptNo: string | null;
  readonly grossPesewas: number | null;
  readonly currency: 'GHS';
  readonly exceptions: readonly SyncExceptionView[];
}

/** The contract's `OfflineSyncResult`. */
export interface OfflineSyncResultView {
  readonly shiftId: string;
  readonly results: readonly SyncResultItemView[];
  readonly cashMovementResults: readonly { readonly clientId: string; readonly outcome: 'APPLIED' | 'DUPLICATE' | 'REJECTED'; readonly reason: string | null }[];
  readonly counterGaps: readonly number[];
  readonly serverTime: string;
}

/** A finding about a sale before it reaches the event: what the report shows and what the till is told. */
interface Flag {
  readonly kind: OfflineSaleFlagged['exceptionKind'];
  readonly severity: Severity;
  readonly summary: string;
  /** The amount the finding is about; null for the sale's whole gross as the server recorded it. */
  readonly amountPesewas: number | null;
  readonly fact: Readonly<Record<string, unknown>>;
  readonly abuseCases: readonly number[];
  /** Whether the till is told in the sale's result; a late posting for a locked period is not (OFFLINE_SYNC 9.4.1). */
  readonly toTill: boolean;
}

/** Why a sale must be tried again in a fresh transaction: another request posted it, or claimed its id, meanwhile. */
class SyncRace extends Error {}


const pesewas = (n: bigint) => Money.ofPesewas(n).toJsonInteger();
const hex = (b: Buffer) => b.toString('hex');

/**
 * `syncOfflineSales` (FR-POS-011 to FR-POS-014, ADR-0027, OFFLINE_SYNC 6 to 9, B09b continued 2b): the sales a till
 * queued while it had no network, applied exactly once by their client UUIDv7, each in its own serializable transaction
 * in ascending device counter, so official numbers follow the counter. The batch is refused whole only for who sends it
 * (the shift's cashier holding `pos.sale.create` at the till, or a holder of `pos.shift.force_close` at its branch
 * recovering it; an enrolled, unrevoked device of the shift's till) and its size. A sale is refused only for integrity:
 * an id that is not a UUIDv7, content that no longer matches its hash, an id or a counter already applied to other
 * content, or a sale the catalogue cannot read. Everything else records the sale and raises an exception: stock gone,
 * held, reserved or negative; a price beyond the limits or no longer priced; a unit not sold; tenders that do not
 * match; a tender not taken offline; a shift closed or force-closed (its cash is not taken, ADR-0077); a period
 * locked; a till clock outside the tolerance; a sale older than the bound; a grant revoked while offline. Each sale is
 * attributed to the shift's cashier. Every submission is logged in `pos.sale_sync`; the counter's gaps are answered
 * and each newly missing value is raised once.
 */
export class OfflineSync {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: TillStore,
    private readonly devices: Devices,
    private readonly posting: SalePosting,
    private readonly orders: Orders,
    private readonly refs: MasterDataRefs,
    private readonly pricing: PricingService,
    private readonly authoriser: Authoriser,
    private readonly ledger: Ledger,
    private readonly settings: Settings,
    private readonly events: DomainEvents,
    private readonly audit: AuditTrail,
    private readonly clock: Clock,
    private readonly payments: Payments,
    private readonly unverified: UnverifiedTenders,
    private readonly pins: TillPins,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  async sync(actor: Actor | undefined, body: OfflineSyncBatchInput, deviceCredential: string | undefined): Promise<OfflineSyncResultView> {
    const { shift, register, deviceId, gapsBefore } = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const [found] = await this.store.shifts(tx, [body.shiftId]);
      const till = found === undefined ? null : ((await this.store.registers(tx, [found.registerId]))[0] ?? null);
      await this.authoriser.authorise(tx, actor, SELL, till === null ? {} : { branchId: till.branchId, locationId: till.locationId });
      if (found === undefined || till === null) throw new NotFoundError(`no shift ${body.shiftId}`);
      // The shift's cashier syncs their own queue; anyone else only as a manager recovering the till (OFFLINE_SYNC 6.5).
      if (found.cashierId !== actor!.principalId) await this.authoriser.authorise(tx, actor, RECOVER, { branchId: till.branchId });
      const device = await this.devices.deviceOfIn(tx, deviceCredential, till.id);
      if (device.id !== body.deviceId) throw new ForbiddenError(`the batch names device ${body.deviceId}, but the credential is device ${device.id}`);
      if (body.sales.length > MAX_SYNC_BATCH) throw new SyncBatchTooLargeError(body.sales.length, MAX_SYNC_BATCH);
      return { shift: found, register: till, deviceId: device.id, gapsBefore: counterGaps(await this.store.receivedCounters(tx, found.id)) };
    });

    // Strictly in ascending device counter, whatever order they came in (OFFLINE_SYNC 6.2).
    const ordered = inCounterOrder(body.sales);
    const results: SyncResultItemView[] = [];
    for (const sale of ordered) results.push(await this.syncSale(actor!, register, shift, deviceId, sale));
    // The batch's cash movements after its sales, in the till's order (OFFLINE_SYNC 10, A-279 (d)), each on its own.
    const movements: MovementAnswer[] = [];
    for (const m of inMovementOrder(body.cashMovements ?? [])) movements.push(await this.syncMovement(actor!, register, shift.id, deviceId, m));

    const now = this.clock.now();
    const gaps = await this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const received = await this.store.receivedCounters(tx, shift.id);
      const after = counterGaps(received);
      const fresh = newGaps(gapsBefore, after);
      if (fresh.length > 0) {
        const gap: DeviceCounterGap = {
          shiftId: shift.id,
          branchId: register.branchId,
          register: { id: register.id, code: register.code },
          deviceId,
          cashierId: shift.cashierId,
          missing: fresh,
          highestSynced: received.reduce((max, c) => (c > max ? c : max), 0),
          exceptionKind: 'DEVICE_COUNTER_GAP',
          severity: 'URGENT',
          abuseCases: [ABUSE_COUNTER_GAP],
        };
        await this.events.publish(tx, { type: DEVICE_COUNTER_GAP, subjectType: 'Shift', subjectId: shift.id, branchId: register.branchId, payload: gap, occurredAt: now });
      }
      await this.store.noteDeviceSync(tx, deviceId, now, actor!.principalId);
      await this.audit.record(tx, {
        module: 'pos',
        action: 'SYNC',
        entityType: 'Shift',
        entityId: shift.id,
        branchId: register.branchId,
        before: null,
        after: { deviceId, cashierId: shift.cashierId, sales: results.length, outcomes: countOutcomes(results), cashMovements: movements.length, movementOutcomes: tally(movements.map((m) => m.outcome)), counterGaps: after, newlyMissing: fresh },
      });
      return after;
    });
    return {
      shiftId: shift.id,
      results,
      cashMovementResults: (body.cashMovements ?? []).map((m) => movements.find((a) => a.clientId === m.id)!),
      counterGaps: gaps,
      serverTime: now.toISOString(),
    };
  }

  /** One queued sale in its own transaction; tried once more if another request posted or claimed it meanwhile. */
  private async syncSale(actor: Actor, register: RegisterRecord, shift: ShiftRecord, deviceId: string, sale: OfflineSaleInput): Promise<SyncResultItemView> {
    const seriesLocks = this.posting.locksFor(register.branchId);
    const once = (retried: boolean) => this.uow.run({ isolation: 'serializable', seriesLocks }, async (tx) => this.syncSaleIn(tx, actor, register, shift.id, deviceId, sale, retried));
    try {
      return await once(false);
    } catch (error) {
      if (error instanceof SyncRace || sqlStateOf(error) === '23505') return once(true);
      throw error;
    }
  }

  private async syncSaleIn(tx: Transaction, actor: Actor, register: RegisterRecord, shiftId: string, deviceId: string, sale: OfflineSaleInput, retried: boolean): Promise<SyncResultItemView> {
    const shift = (await this.store.lockShift(tx, shiftId))!;
    const now = this.clock.now();
    const receivedHash = Buffer.from(sale.payloadHash, 'hex');
    const recomputed = payloadHashOf(sale);
    const occurredAt = new Date(sale.occurredAt);
    const base = { deviceId, shiftId, branchId: register.branchId, clientSaleId: sale.id, deviceCounter: sale.deviceCounter, provisionalRef: sale.provisionalRef, clientOccurredAt: occurredAt, payloadHash: receivedHash, receivedAt: now, actorId: actor.principalId };
    const reject = (rule: string, summary: string) => this.reject(tx, register, shift, base, sale, rule, summary, hex(recomputed));

    // Steps 5 to 8 of OFFLINE_SYNC 7: identity and integrity. Only these refuse a sale.
    if (!isUuidV7(sale.id)) return reject('ID_NOT_UUID_V7', 'The sale id is not a UUIDv7. The sale was not recorded.');
    const applied = (await this.store.appliedSales(tx, [sale.id])).get(sale.id);
    if (applied !== undefined) {
      if (!applied.payloadHash.equals(receivedHash) || !applied.payloadHash.equals(recomputed)) return reject('ID_REUSED_WITH_OTHER_CONTENT', 'This sale id was synced before with different content. The sale was not recorded again.');
      const duplicate: SaleSyncRecord = { ...base, ...applied, ...{ id: this.nextId(), outcome: 'DUPLICATE', receivedAt: now, actorId: actor.principalId, deviceId, shiftId: applied.shiftId, deviceCounter: applied.deviceCounter } };
      await this.store.insertSaleSync(tx, duplicate);
      return resultOf(duplicate);
    }
    const owner = await this.store.appliedCounterOwner(tx, shift.id, sale.deviceCounter);
    if (owner !== null) return reject('COUNTER_USED_BY_ANOTHER_SALE', `Device counter ${sale.deviceCounter} of this shift belongs to another sale. The sale was not recorded.`);
    if (!recomputed.equals(receivedHash)) return reject('PAYLOAD_HASH_MISMATCH', 'Payload hash does not match. The sale was not recorded.');
    const unreadable = unreadableLines(sale);
    if (unreadable !== null) return reject(unreadable, 'The sale cannot be read against the catalogue. The sale was not recorded.');

    // From here the sale is recorded; every finding becomes an exception (OFFLINE_SYNC 7 steps 9 to 11).
    const cashier: Actor = { principalId: shift.cashierId, kind: 'USER', displayName: '', realm: 'STAFF', sessionId: actor.sessionId, steppedUpAt: null };
    const flags: Flag[] = [];
    const claim = { source: 'POS_OFFLINE', shiftId: shift.id, shiftSeq: shift.shiftSeq, deviceCounter: sale.deviceCounter, provisionalRef: sale.provisionalRef, occurredAt: sale.occurredAt };
    const gross = null;

    const grants = await this.authoriser.scopes(tx, cashier, SELL);
    if (!grants.some((g) => g.branchId === register.branchId && (g.locationId === null || g.locationId === register.locationId))) {
      flags.push({ kind: 'AUTHORISATION_FAILURE', severity: 'URGENT', summary: 'The cashier no longer holds pos.sale.create at this till: the grant was revoked while the device was offline', amountPesewas: gross, fact: { permission: SELL, branchId: register.branchId }, abuseCases: [], toTill: true });
    }
    const tolerance = await this.settings.integer(CLOCK_TOLERANCE_SETTING, CLOCK_TOLERANCE_SECONDS);
    const parsed = parseUuidV7(sale.id);
    const idTime = parsed.ok ? uuidV7Timestamp(parsed.value) : occurredAt;
    // The till's clock is judged by the sale's time and by the time inside its id, both stamped by the till (OFFLINE_SYNC 4.1).
    const clock = tillClockVerdict(occurredAt, now, shift.openedAt, tolerance) ?? tillClockVerdict(idTime, now, shift.openedAt, tolerance);
    if (clock !== null) {
      flags.push({
        kind: 'TILL_CLOCK_OUT_OF_TOLERANCE',
        severity: 'REVIEW',
        summary: clock === 'AHEAD_OF_SERVER' ? `The till's clock was ahead of the server by more than ${tolerance} seconds` : `The till's time is more than ${tolerance} seconds before the shift opened`,
        amountPesewas: gross,
        fact: { verdict: clock, tillTime: sale.occurredAt, idTime: idTime.toISOString(), serverTime: now.toISOString(), shiftOpenedAt: shift.openedAt.toISOString(), differenceSeconds: secondsBetween(occurredAt, now), toleranceSeconds: tolerance },
        abuseCases: [],
        toTill: true,
      });
    }
    const maxAge = await this.settings.integer(MAX_SALE_AGE_SETTING, MAX_SALE_AGE_HOURS);
    const tooOld = saleTooOld(occurredAt, now, maxAge);
    if (tooOld) {
      flags.push({ kind: 'OFFLINE_SALE_TOO_OLD', severity: 'REVIEW', summary: `The sale reached the server more than ${maxAge} hours after it was made`, amountPesewas: gross, fact: { occurredAt: sale.occurredAt, receivedAt: now.toISOString(), ageSeconds: secondsBetween(now, occurredAt), maxHours: maxAge }, abuseCases: [], toTill: true });
    }
    const dated = await this.ledger.postingDateIn(tx, occurredAt, now);
    if (dated === null) throw new Error(`no open accounting period on ${toBusinessDate(occurredAt)} or ${toBusinessDate(now)}`);
    const late: LatePostingReason | null = latePostingReason({ occurredDate: toBusinessDate(occurredAt), postingDate: dated.postingDate, occurredAt, shift });
    if (late !== null) {
      flags.push({
        kind: 'OFFLINE_LATE_POSTING',
        severity: severityOfLatePosting(late),
        summary:
          late === 'PERIOD_LOCKED'
            ? `Sale of ${toBusinessDate(occurredAt)} posted ${dated.postingDate} because its period is no longer open`
            : late === 'AFTER_FORCE_CLOSE'
              ? 'The sale is dated after its shift was force-closed'
              : 'The sale reached the server after its shift had closed',
        amountPesewas: gross,
        fact: { reason: late, occurredDate: toBusinessDate(occurredAt), postingDate: dated.postingDate, shiftStatus: shift.status, forceClosed: shift.forceClosed, closedAt: shift.closedAt?.toISOString() ?? null },
        abuseCases: late === 'AFTER_FORCE_CLOSE' ? [ABUSE_SHORT] : [],
        toTill: late !== 'PERIOD_LOCKED',
      });
    }

    // Tenders: cash only, onto its own shift while open (ADR-0077 offline); any other is not taken, and a person looks.
    const methods = await this.refs.paymentMethodsIn(tx, sale.tenders.map((t) => t.paymentMethodId));
    if (sale.tenders.some((t) => !methods.has(t.paymentMethodId))) return reject('METHOD_UNKNOWN', 'A tender names a payment method the server does not know. The sale was not recorded.');
    const unverifiedAllowed = await this.settings.boolean(OFFLINE_UNVERIFIED_MOBILE_MONEY.key, OFFLINE_UNVERIFIED_MOBILE_MONEY.fallback, register.branchId);
    // ADR-0077 Amendments (the owner on 2026-11-18): the cash goes onto this shift, while open as any cash, once it has
    // stopped taking entries as a late entry recorded after the sale posts, never onto another shift and never nowhere.
    const onShift = tillTakesCash(shift) === 'ON_SHIFT';
    const tenders: SaleTenderRequest[] = [];
    const lateCash: OfflineTenderInput[] = [];
    const unverified: { readonly tender: OfflineTenderInput; readonly severity: 'REVIEW' | 'URGENT'; readonly approverIsSupervisor: boolean; readonly approval: PinApprovalVerdict | null; readonly offeredOffline: boolean }[] = [];
    for (const tender of sale.tenders) {
      const method = methods.get(tender.paymentMethodId)!;
      if (onShift && takenAtSync(method)) {
        tenders.push({ methodCode: method.code, amountPesewas: BigInt(tender.amountPesewas), register: { id: register.id, code: register.code } });
        continue;
      }
      if (takenAtSync(method)) {
        lateCash.push(tender);
        continue;
      }
      // Mobile money taken unverified, approved on the device, is recorded only while the branch allows it (OFFLINE_SYNC 9.9).
      const details = tender.unverifiedMobileMoney;
      // The approval is checked against the supervisor's PIN version the till used (CR-032 point 4): only a verified one is
      // a supervisor's approval; anything else is still recorded, and its break is URGENT.
      const approval =
        details === undefined
          ? null
          : await this.pins.approvalIn(tx, { approverId: details.approvedById, pinVersion: details.approvedByPinVersion ?? null, cashierId: shift.cashierId, actorId: null, branchId: register.branchId, at: occurredAt });
      const approverIsSupervisor = approval === 'VERIFIED';
      const offeredOffline = method.kind === 'MOBILE_MONEY' && method.isLive && method.channels.includes('POS');
      const walletKnown = method.kind === 'MOBILE_MONEY' && (await this.unverified.walletIn(tx, register.branchId)) !== null;
      const verdict = unverifiedTenderVerdict({ methodKind: method.kind, branchAllows: unverifiedAllowed, carriesDetails: details !== undefined, offeredOffline, shiftTakesMoney: onShift, approverIsSupervisor, walletKnown });
      if (verdict.take) {
        unverified.push({ tender, severity: verdict.severity, approverIsSupervisor, approval, offeredOffline });
        continue;
      }
      flags.push({
        kind: 'UNMATCHED_PAYMENT',
        severity: 'URGENT',
        summary: verdict.reason === 'SHIFT_NOT_OPEN' ? `A mobile money tender of ${tender.amountPesewas} pesewas was not recorded, because the shift is no longer open` : `A ${method.code} tender of ${tender.amountPesewas} pesewas is not taken offline; it is not recorded`,
        amountPesewas: tender.amountPesewas,
        fact: { method: method.code, kind: method.kind, permittedOffline: unverifiedAllowed && method.kind === 'MOBILE_MONEY', notTaken: verdict.reason, shiftStatus: shift.status, ...(details === undefined ? {} : { unverifiedMobileMoney: { ...details, payerPhone: undefined } }) },
        abuseCases: [ABUSE_TENDER],
        toTill: true,
      });
    }

    // Each line in its unit (CR-038): absent, the first unit the product is sold by; a unit not sold is recorded and flagged.
    const selling = new Map((await this.pricing.sellingUnitsIn(tx, { channel: 'POS', branchId: register.branchId, at: occurredAt, productIds: sale.lines.map((l) => l.productId) })).products.map((p) => [p.product.id, p] as const));
    const lines = sale.lines.map((l, i) => {
      const product = selling.get(l.productId);
      const uom = l.uom ?? (product === undefined ? undefined : defaultLineUom(product.baseUom, product.units.map((u) => u.uom)));
      if (l.uom !== undefined && !(product?.units.some((u) => u.uom === l.uom) ?? false)) {
        flags.push({ kind: 'UNIT_NOT_SOLD', severity: 'REVIEW', summary: `Line ${lineNoOf(i)} is sold in ${l.uom}, a unit this product is not sold by at the till`, amountPesewas: l.agreedUnitPricePesewas, fact: { lineNo: lineNoOf(i), uom: l.uom, sellingUnits: product?.units.map((u) => u.uom) ?? [] }, abuseCases: [], toTill: true });
      }
      return {
        productId: l.productId,
        stockUnitId: l.stockUnitId ?? null,
        fromLocationId: register.locationId,
        quantity: l.quantity,
        ...(uom === undefined ? {} : { uom }),
        weightKg: l.weightKg ?? null,
        weightSource: l.weightSource ?? null,
        gradeId: l.gradeId ?? null,
        agreedUnitPricePesewas: BigInt(l.agreedUnitPricePesewas),
        varianceReasonCode: l.varianceReasonCode ?? null,
      };
    });
    const limit = await this.authoriser.limitIn(tx, cashier, 'PRICE_OVERRIDE_PER_SHIFT', register.branchId);
    const used = (await this.orders.shiftSalesIn(tx, shift.id)).overridesPesewas;
    const expected = provisionalRef(register.code, shift.shiftSeq, sale.deviceCounter);

    await tx.query('SAVEPOINT offline_sale');
    let posted: Awaited<ReturnType<SalePosting['postOfflineIn']>>;
    try {
      posted = await this.posting.postOfflineIn(tx, cashier, {
        orderId: sale.id,
        channel: 'POS',
        branchId: register.branchId,
        customerId: null,
        contactPhone: sale.customerPhone ?? null,
        fulfilmentMode: 'COUNTER',
        // Counter prices are shown with their tax in (A-274 (g), A-278 (i)).
        taxInclusive: true,
        occurredAt,
        issueDate: dated.postingDate,
        // The reference the till printed goes on the receipt when it is the one this shift and counter make (A-278 (j)).
        provisionalRef: sale.provisionalRef === expected ? sale.provisionalRef : null,
        claim,
        shiftDocumentId: shift.id,
        shiftOverrideRoomPesewas: shiftOverrideRoom(Money.ofPesewas(limit), Money.ofPesewas(used)).pesewas,
        lines,
        tenders,
      });
    } catch (error) {
      if (error instanceof IdempotencyKeyReusedError) {
        // Another request posted this sale meanwhile, or the id is another document's: tried once more, then refused.
        if (!retried) throw new SyncRace();
        await tx.query('ROLLBACK TO SAVEPOINT offline_sale');
        return reject('ID_ALREADY_USED', 'This sale id is already another document. The sale was not recorded.');
      }
      if (error instanceof SaleInvalidError) {
        await tx.query('ROLLBACK TO SAVEPOINT offline_sale');
        return reject(`SALE_UNREADABLE:${error.details.map((d) => d.code).join(',')}`.slice(0, 80), 'The sale cannot be read against the catalogue. The sale was not recorded.');
      }
      throw error;
    }
    await tx.query('RELEASE SAVEPOINT offline_sale');
    if (sale.provisionalRef !== expected) {
      flags.push({ kind: 'PROVISIONAL_REF_MISMATCH', severity: 'REVIEW', summary: `The till printed ${sale.provisionalRef}; this shift and counter make ${expected}, so the receipt carries no provisional reference`, amountPesewas: null, fact: { printed: sale.provisionalRef, expected }, abuseCases: [], toTill: true });
    }
    const grossPesewas = posted.sale.billingDocument!.grossPesewas;
    for (const finding of posted.findings) if (finding.kind !== 'PRICE_OVERRIDE') flags.push(flagOf(finding, grossPesewas));
    // Every offline override reaches the exception report's source; one beyond the cashier's own limit stands only with a
    // supervisor's PIN verified here and within that supervisor's own line limit (the owner on 2026-11-18, A-278 (h)).
    for (const line of posted.sale.lines) {
      if (line.variancePesewas === 0) continue;
      const finding = posted.findings.find((f): f is Extract<OfflineSaleFinding, { kind: 'PRICE_OVERRIDE' }> => f.kind === 'PRICE_OVERRIDE' && f.lineNo === line.lineNo);
      const sent = sale.lines.find((_, i) => lineNoOf(i) === line.lineNo)?.overrideApproval;
      const approval = sent === undefined ? null : await this.pins.approvalIn(tx, { approverId: sent.approvedById, pinVersion: sent.approvedByPinVersion, cashierId: shift.cashierId, actorId: null, branchId: register.branchId, at: occurredAt });
      const supervisorLimit = sent === undefined ? 0n : await this.authoriser.limitIn(tx, staffActor(sent.approvedById), 'PRICE_OVERRIDE_PER_LINE', register.branchId);
      flags.push(overrideFlag(line, finding ?? null, sent ?? null, approval, offlineOverrideVerdict({ beyondCashier: finding?.reason ?? null, approval, variancePesewas: BigInt(line.variancePesewas), supervisorLineLimitPesewas: supervisorLimit })));
    }
    // The unverified tenders, after the cash ORD applied first, each allocated to what the receipt still owes (OFFLINE_SYNC 9.9).
    const receiptGross = Money.fromJsonInteger(grossPesewas);
    let owed = receiptGross.minus(lesser(receiptGross, Money.sum(tenders.map((t) => Money.ofPesewas(t.amountPesewas)))));
    // Cash on a shift that has stopped taking entries: recorded on that shift as a late entry, by the cashier at the
    // till's time, allocated to what the receipt still owes; its post-close adjustment posts with it (ADR-0077 Amendments).
    for (const tender of lateCash) {
      const method = methods.get(tender.paymentMethodId)!;
      const amount = Money.fromJsonInteger(tender.amountPesewas);
      const applied = lesser(amount, owed);
      owed = owed.minus(applied);
      const payment = await this.payments.recordIn(tx, cashier, {
        branchId: register.branchId,
        channel: 'POS',
        methodCode: method.code,
        amountPesewas: amount.pesewas,
        customerId: null,
        orderDocumentId: sale.id,
        shiftDocumentId: shift.id,
        register: { id: register.id, code: register.code },
        receivedAt: occurredAt,
        allocations: applied.isZero() ? [] : [{ billingDocumentId: posted.sale.billingDocument!.id, amountPesewas: applied.pesewas }],
        lateEntry: true,
      });
      const entry = await this.lateEntryIn(tx, { shift, register, deviceId, kind: 'SALE_CASH', amount, paymentId: payment.id, orderId: sale.id, movementId: null, occurredAt, now, actorId: actor.principalId });
      flags.push({
        kind: 'OFFLINE_LATE_CASH',
        severity: entry.severity,
        summary: `Cash of ${tender.amountPesewas} pesewas was recorded on the shift as a late entry, because the shift is ${shift.forceClosed ? 'force-closed' : shift.status.toLowerCase()}; its over or short moved by ${tender.amountPesewas} pesewas ${entry.direction.toLowerCase()} for a supervisor to review`,
        amountPesewas: tender.amountPesewas,
        fact: { method: method.code, paymentId: payment.id, lateEntryId: entry.id, shiftState: entry.shiftState, adjustment: entry.direction, closedAt: shift.closedAt?.toISOString() ?? null, tillTime: sale.occurredAt },
        abuseCases: [ABUSE_SHORT],
        toTill: true,
      });
    }
    for (const u of unverified) {
      const amount = Money.fromJsonInteger(u.tender.amountPesewas);
      const applied = lesser(amount, owed);
      owed = owed.minus(applied);
      const details = u.tender.unverifiedMobileMoney!;
      await this.unverified.recordIn(tx, cashier, {
        branchId: register.branchId,
        paymentMethodId: u.tender.paymentMethodId,
        amountPesewas: amount.pesewas,
        customerId: null,
        orderDocumentId: sale.id,
        shiftDocumentId: shift.id,
        register: { id: register.id, code: register.code },
        receivedAt: occurredAt,
        allocations: applied.isZero() ? [] : [{ billingDocumentId: posted.sale.billingDocument!.id, amountPesewas: applied.pesewas }],
        payerPhone: details.payerPhone,
        network: details.network,
        providerReference: details.providerReference ?? null,
        approvedById: details.approvedById,
        approvalVerified: u.approval === 'VERIFIED',
        severity: u.severity,
        facts: {
          saleId: sale.id,
          shiftId: shift.id,
          register: { id: register.id, code: register.code },
          deviceId,
          cashierId: shift.cashierId,
          deviceCounter: sale.deviceCounter,
          provisionalRef: sale.provisionalRef,
          occurredAt: sale.occurredAt,
          approverIsSupervisor: u.approverIsSupervisor,
          approvalCheck: { pinVersion: details.approvedByPinVersion ?? null, verdict: u.approval },
          permittedOffline: u.offeredOffline,
        },
      });
    }
    // Tenders the till took that do not sum to the receipt the server issued: recorded as taken, and a person looks.
    const claimed = Money.sum(sale.tenders.map((t) => Money.fromJsonInteger(t.amountPesewas)));
    if (claimed.compareTo(Money.fromJsonInteger(grossPesewas)) !== 0) {
      flags.push({
        kind: 'TENDERS_DIFFER',
        severity: 'URGENT',
        summary: `The tenders the till took (${claimed.toJsonInteger()} pesewas) differ from the receipt (${grossPesewas} pesewas)`,
        amountPesewas: null,
        fact: { tenderedPesewas: claimed.toJsonInteger(), grossPesewas },
        abuseCases: [ABUSE_SHORT],
        toTill: true,
      });
    }

    const told = flags.filter((f) => f.toTill).map((f) => ({ kind: f.kind === 'STOCK_EXCEPTION' ? stockKindOf(f) : f.kind, summary: f.summary }));
    const record: SaleSyncRecord = {
      ...base,
      id: this.nextId(),
      outcome: told.length === 0 ? 'APPLIED' : 'APPLIED_WITH_EXCEPTION',
      orderDocumentId: sale.id,
      orderNo: posted.sale.orderNo,
      receiptNo: posted.sale.billingDocument!.documentNo,
      grossPesewas: BigInt(grossPesewas),
      exceptions: told,
      rejectionRule: null,
      postedLateReason: late,
      postingDate: dated.postingDate,
      clockVerdict: clock,
      tooOld,
    };
    await this.store.insertSaleSync(tx, record);
    await this.store.noteDeviceCounter(tx, shift.id, sale.deviceCounter, actor.principalId, now);
    const source = { saleId: sale.id, shiftId: shift.id, branchId: register.branchId, register: { id: register.id, code: register.code }, deviceId, cashierId: shift.cashierId, deviceCounter: sale.deviceCounter, provisionalRef: sale.provisionalRef, occurredAt: sale.occurredAt, recordedAt: now.toISOString() };
    for (const flag of flags) {
      const payload: OfflineSaleFlagged = { ...source, exceptionKind: flag.kind, severity: flag.severity, summary: flag.summary, amountPesewas: flag.amountPesewas ?? grossPesewas, claim, fact: flag.fact, abuseCases: flag.abuseCases };
      await this.events.publish(tx, { type: OFFLINE_SALE_FLAGGED, subjectType: 'SalesOrder', subjectId: sale.id, branchId: register.branchId, payload, occurredAt: now });
    }
    return resultOf(record);
  }

  /** Whether someone other than the caller holds a permission at the branch: their grants are read by id, nothing is refused. */
  private async holdsAt(tx: Transaction, principalId: string, permission: string, branchId: string): Promise<boolean> {
    const someone: Actor = { principalId, kind: 'USER', displayName: '', realm: 'STAFF', sessionId: null, steppedUpAt: null };
    return (await this.authoriser.scopes(tx, someone, permission)).some((g) => g.branchId === branchId);
  }

  /** One cash movement of the batch in its own transaction; tried once more if another request decided it meanwhile. */
  private async syncMovement(actor: Actor, register: RegisterRecord, shiftId: string, deviceId: string, m: OfflineCashMovementInput): Promise<MovementAnswer> {
    const once = () => this.uow.run({ isolation: 'serializable' }, async (tx) => this.syncMovementIn(tx, actor, register, shiftId, deviceId, m));
    try {
      return await once();
    } catch (error) {
      if (sqlStateOf(error) === '23505') return once();
      throw error;
    }
  }

  /**
   * A cash movement from the queue (OFFLINE_SYNC 10, ADR-0077, A-279 (d) to (f)): decided once by its client id and
   * answered the same on every later sync; put only on the batch's own shift while it is OPEN (the same deciding
   * function as a sale's cash, `tillTakesCash`), at the till's time though hours old, by the rules `recordCashMovement`
   * holds; a drop with no witness is recorded unwitnessed and marked, because the till cannot know who was signed in
   * (the witness's PIN is B09b continued 3's). Anything refused is recorded nowhere, answered with its reason and raised.
   */
  private async syncMovementIn(tx: Transaction, actor: Actor, register: RegisterRecord, shiftId: string, deviceId: string, m: OfflineCashMovementInput): Promise<MovementAnswer> {
    const shift = (await this.store.lockShift(tx, shiftId))!;
    const now = this.clock.now();
    const amount = m.amountPesewas;
    const amountJson = pesewas(amount);
    const content: MovementContent = { shiftId: shift.id, kind: m.kind, amountPesewas: amount };
    const tillTime = m.occurredAt;
    const base = { deviceId, shiftId: shift.id, branchId: register.branchId, clientMovementId: m.id, kind: m.kind, amountPesewas: amount, clientOccurredAt: tillTime, receivedAt: now, actorId: actor.principalId };
    const claim = { source: 'POS_OFFLINE', shiftId: shift.id, kind: m.kind, amountPesewas: amountJson, reasonCode: m.reasonCode ?? null, witnessId: m.witnessId ?? null, occurredAt: m.occurredAt.toISOString() };
    const raise = (flag: Pick<OfflineCashMovementFlagged, 'exceptionKind' | 'severity' | 'summary' | 'fact' | 'abuseCases'>, occurredAt: Date) => {
      const payload: OfflineCashMovementFlagged = { movementId: m.id, shiftId: shift.id, branchId: register.branchId, register: { id: register.id, code: register.code }, deviceId, cashierId: shift.cashierId, kind: m.kind, occurredAt: occurredAt.toISOString(), recordedAt: now.toISOString(), amountPesewas: amountJson, claim, ...flag };
      return this.events.publish(tx, { type: OFFLINE_CASH_MOVEMENT_FLAGGED, subjectType: 'CashMovement', subjectId: m.id, branchId: register.branchId, payload, occurredAt: now });
    };
    const refuse = async (reason: string, fact: Readonly<Record<string, unknown>>, answersId: string | null = null): Promise<MovementAnswer> => {
      await this.store.insertCashMovementSync(tx, { ...base, id: this.nextId(), outcome: 'REJECTED', reason, cashMovementId: null, answersId, clockVerdict: null });
      await raise({ exceptionKind: 'CASH_MOVEMENT_REJECTED', severity: 'URGENT', summary: `A ${m.kind.toLowerCase().replace('_', ' ')} of ${amountJson} pesewas from the till was not recorded (${reason}); the drawer may differ from the records by it`, fact: { reason, ...fact }, abuseCases: [ABUSE_SHORT] }, tillTime);
      await this.audit.record(tx, { module: 'pos', action: 'SYNC_CASH_MOVEMENT_REJECTED', entityType: 'Shift', entityId: shift.id, branchId: register.branchId, before: null, after: { movementId: m.id, reason, deviceId, submitted: claim } });
      return { clientId: m.id, outcome: 'REJECTED', reason };
    };

    // Exactly once by the client id: a movement decided before is answered as it was decided.
    const decided = (await this.store.decidedCashMovements(tx, [m.id])).get(m.id) ?? null;
    const prior = decided === null ? null : { shiftId: decided.shiftId, kind: decided.kind, amountPesewas: decided.amountPesewas, outcome: decided.outcome as 'APPLIED' | 'REJECTED', reason: decided.reason };
    const answer = priorMovementAnswer(prior, content);
    if (decided !== null && answer !== null) {
      if (answer.outcome === 'DUPLICATE') {
        await this.store.insertCashMovementSync(tx, { ...base, id: this.nextId(), outcome: 'DUPLICATE', reason: null, cashMovementId: decided.cashMovementId, answersId: decided.id, clockVerdict: null });
        return { clientId: m.id, outcome: 'DUPLICATE', reason: null };
      }
      // The same refusal again is answered, not raised again; other content under a decided id is a new finding.
      if (answer.reason === decided.reason && prior!.shiftId === content.shiftId && prior!.kind === content.kind && prior!.amountPesewas === content.amountPesewas) {
        await this.store.insertCashMovementSync(tx, { ...base, id: this.nextId(), outcome: 'REJECTED', reason: answer.reason, cashMovementId: null, answersId: decided.id, clockVerdict: null });
        return { clientId: m.id, outcome: 'REJECTED', reason: answer.reason };
      }
      return refuse(answer.reason!, { decidedAs: decided.outcome, decidedShiftId: decided.shiftId, decidedKind: decided.kind, decidedAmountPesewas: Number(decided.amountPesewas) }, decided.id);
    }
    // A movement the till recorded online before it lost the network is already on a shift.
    const [online] = await this.store.cashMovements(tx, [m.id]);
    if (online !== undefined) {
      if (online.shiftId === shift.id && online.kind === m.kind && online.amountPesewas === amount) {
        await this.store.insertCashMovementSync(tx, { ...base, id: this.nextId(), outcome: 'DUPLICATE', reason: null, cashMovementId: online.id, answersId: null, clockVerdict: null });
        return { clientId: m.id, outcome: 'DUPLICATE', reason: null };
      }
      return refuse('ID_REUSED_WITH_OTHER_CONTENT', { recordedShiftId: online.shiftId, recordedKind: online.kind, recordedAmountPesewas: Number(online.amountPesewas) });
    }
    if (!isUuidV7(m.id)) return refuse('ID_NOT_UUID_V7', {});
    // ADR-0077 Amendments: onto its own shift, decided where a sale's cash is decided; once that shift has stopped taking
    // entries, as a late entry on it (the owner on 2026-11-18), never onto another shift and never recorded nowhere.
    const late = tillTakesCash(shift) === 'LATE_ENTRY';

    const reason = m.reasonCode === undefined ? undefined : (await this.refs.reasonCodesIn(tx, [m.reasonCode])).get(m.reasonCode);
    const witnessId = m.witnessId ?? null;
    const witnessIsSupervisor = witnessId !== null && (await this.holdsAt(tx, witnessId, SUPERVISE, register.branchId));
    const broken = judgeCashMovement({
      kind: m.kind,
      amount: Money.ofPesewas(amount),
      reasonCode: m.reasonCode ?? null,
      reasonDomain: reason?.domain ?? null,
      reasonNeedsNote: reason?.requiresNote ?? false,
      note: m.note ?? null,
      witnessId,
      cashierId: shift.cashierId,
      actorId: shift.cashierId,
      witnessIsSupervisor,
      // Offline the till cannot know who was signed in at the branch: a drop with no witness is taken unwitnessed and marked.
      supervisorSignedIn: false,
      tillHolds: await this.tillHolds(tx, shift.id),
    });
    if (broken.length > 0) return refuse(broken[0]!.rule, { rules: broken.map((b) => b.rule) });
    // A queued drop's witness confirmed it with their PIN on the till; the version is checked as at the till's time (the
    // owner on 2026-11-18, CR-032 point 4). A named supervisor without a PIN in force is no witness: recorded nowhere.
    if (m.kind === 'CASH_DROP' && witnessId !== null) {
      const verdict = await this.pins.approvalIn(tx, { approverId: witnessId, pinVersion: m.witnessPinVersion ?? null, cashierId: shift.cashierId, actorId: null, branchId: register.branchId, at: tillTime });
      const rule = witnessPinRule(verdict);
      if (rule !== null) return refuse(rule, { witnessId, witnessPinVersion: m.witnessPinVersion ?? null, verdict });
    }

    const tolerance = await this.settings.integer(CLOCK_TOLERANCE_SETTING, CLOCK_TOLERANCE_SECONDS);
    const timed = cashMovementTimeAtSync(tillTime, now, shift.openedAt, tolerance);
    const unwitnessed = isUnwitnessedDrop({ kind: m.kind, witnessId, supervisorSignedIn: false });
    // Attributed to the shift's cashier, who made it on the till; the session that synced it is the audit's actor.
    await this.store.insertCashMovement(tx, { id: m.id, shiftId: shift.id, kind: m.kind, amountPesewas: amount, reasonCode: m.reasonCode!, note: m.note ?? null, witnessId, witnessPinVersion: witnessId === null ? null : (m.witnessPinVersion ?? null), unwitnessed, occurredAt: timed.occurredAt, recordedAt: now, actorId: shift.cashierId, ...(late ? { lateEntry: true } : {}) });
    const event = MOVEMENT_EVENTS[m.kind];
    const posting: CashMoved = {
      shiftId: shift.id,
      subjectId: m.id,
      branchId: register.branchId,
      register: { id: register.id, code: register.code },
      cashierId: shift.cashierId,
      reasonCode: m.reasonCode!,
      movementId: m.id,
      kind: m.kind,
      witnessId,
      actorId: shift.cashierId,
      occurredAt: timed.occurredAt.toISOString(),
      ...(unwitnessed ? { unwitnessed: true, abuseCases: [ABUSE_SHORT] } : {}),
      amountsPesewas: { [event.key]: amountJson } as CashMoved['amountsPesewas'],
    };
    await this.events.publish(tx, { type: event.type, subjectType: 'CashMovement', subjectId: m.id, branchId: register.branchId, payload: posting, occurredAt: timed.occurredAt });
    await this.store.insertCashMovementSync(tx, { ...base, id: this.nextId(), outcome: 'APPLIED', reason: null, cashMovementId: m.id, answersId: null, clockVerdict: timed.verdict });
    if (late) {
      const entry = await this.lateEntryIn(tx, { shift, register, deviceId, kind: m.kind, amount: Money.ofPesewas(amount), paymentId: null, orderId: null, movementId: m.id, occurredAt: timed.occurredAt, now, actorId: actor.principalId });
      await raise(
        {
          exceptionKind: 'OFFLINE_LATE_CASH',
          severity: entry.severity,
          summary: `A ${m.kind.toLowerCase().replace('_', ' ')} of ${amountJson} pesewas was recorded on the shift as a late entry, because the shift is ${shift.forceClosed ? 'force-closed' : shift.status.toLowerCase()}; its over or short moved by ${amountJson} pesewas ${entry.direction.toLowerCase()} for a supervisor to review`,
          fact: { lateEntryId: entry.id, shiftState: entry.shiftState, adjustment: entry.direction, closedAt: shift.closedAt?.toISOString() ?? null, tillTime: m.occurredAt.toISOString() },
          abuseCases: [ABUSE_SHORT],
        },
        timed.occurredAt,
      );
    }
    if (timed.verdict !== null) {
      await raise(
        {
          exceptionKind: 'TILL_CLOCK_OUT_OF_TOLERANCE',
          severity: 'REVIEW',
          summary: timed.verdict === 'AHEAD_OF_SERVER' ? `The till's clock was ahead of the server by more than ${tolerance} seconds; the server's time is recorded` : `The till's time is more than ${tolerance} seconds before the shift opened; the shift's opening is recorded`,
          fact: { verdict: timed.verdict, tillTime: m.occurredAt.toISOString(), recordedAt: timed.occurredAt.toISOString(), serverTime: now.toISOString(), shiftOpenedAt: shift.openedAt.toISOString(), toleranceSeconds: tolerance },
          abuseCases: [],
        },
        timed.occurredAt,
      );
    }
    if (!(await this.holdsAt(tx, shift.cashierId, MOVE, register.branchId))) {
      await raise({ exceptionKind: 'AUTHORISATION_FAILURE', severity: 'URGENT', summary: 'The cashier no longer holds pos.cash.move at this till: the grant was revoked while the device was offline', fact: { permission: MOVE, branchId: register.branchId }, abuseCases: [] }, timed.occurredAt);
    }
    await this.audit.record(tx, { module: 'pos', action: `SYNC_${m.kind}`, entityType: 'CashMovement', entityId: m.id, branchId: register.branchId, before: null, after: { ...posting, unwitnessed, deviceId, syncedBy: actor.principalId, clockVerdict: timed.verdict } });
    return { clientId: m.id, outcome: 'APPLIED', reason: null };
  }

  /**
   * A late entry on a shift that has stopped taking entries and its post-close adjustment (ADR-0077 Amendments, the owner
   * on 2026-11-18): the row in `pos.shift_late_entry` and ◆ `pos.ShiftLateEntryPosted`, moving the shift's over or short
   * by exactly the entry (short when it raises the expected cash, over when it lowers it). The shift is not reopened.
   */
  private async lateEntryIn(
    tx: Transaction,
    e: { readonly shift: ShiftRecord; readonly register: RegisterRecord; readonly deviceId: string; readonly kind: LateEntryKind; readonly amount: Money; readonly paymentId: string | null; readonly orderId: string | null; readonly movementId: string | null; readonly occurredAt: Date; readonly now: Date; readonly actorId: string },
  ): Promise<{ readonly id: string; readonly severity: Severity; readonly direction: 'SHORT' | 'OVER'; readonly shiftState: 'CLOSING' | 'CLOSED' | 'FORCE_CLOSED' }> {
    const id = this.nextId();
    const adjustment = lateEntryAdjustment(e.kind, e.amount);
    const severity = lateEntrySeverity(e.shift, e.occurredAt);
    const shiftState = lateEntryShiftState(e.shift);
    await this.store.insertShiftLateEntry(tx, {
      id,
      shiftId: e.shift.id,
      branchId: e.register.branchId,
      sourceKind: e.kind,
      paymentId: e.paymentId,
      orderDocumentId: e.orderId,
      cashMovementId: e.movementId,
      amountPesewas: e.amount.pesewas,
      expectedEffect: lateEntryEffect(e.kind),
      adjustmentDirection: adjustment.direction,
      shiftState,
      severity,
      occurredAt: e.occurredAt,
      recordedAt: e.now,
      actorId: e.actorId,
    });
    const payload: ShiftLateEntryPosted = {
      shiftId: e.shift.id,
      subjectId: id,
      branchId: e.register.branchId,
      register: { id: e.register.id, code: e.register.code },
      cashierId: e.shift.cashierId,
      reasonCode: null,
      lateEntryId: id,
      sourceKind: e.kind,
      paymentId: e.paymentId,
      orderId: e.orderId,
      movementId: e.movementId,
      deviceId: e.deviceId,
      amountPesewas: e.amount.toJsonInteger(),
      expectedEffect: lateEntryEffect(e.kind),
      adjustmentDirection: adjustment.direction,
      shiftState,
      severity,
      occurredAt: e.occurredAt.toISOString(),
      recordedAt: e.now.toISOString(),
      abuseCases: [ABUSE_SHORT],
      amountsPesewas: adjustment.amountsPesewas,
    };
    // Dated when the server recomputed it: the adjustment is made now, on the shift the cash belongs to.
    await this.events.publish(tx, { type: SHIFT_LATE_ENTRY_POSTED, subjectType: 'Shift', subjectId: e.shift.id, branchId: e.register.branchId, payload, occurredAt: e.now });
    await this.audit.record(tx, { module: 'pos', action: 'LATE_ENTRY', entityType: 'Shift', entityId: e.shift.id, branchId: e.register.branchId, before: null, after: { ...payload } });
    return { id, severity, direction: adjustment.direction, shiftState };
  }

  /** What the till holds by its records now (FR-POS-019), for a movement's limit: the float, its cash less refunds, its movements. */
  private async tillHolds(tx: Transaction, shiftId: string): Promise<Money> {
    const totals = await this.payments.shiftTotalsIn(tx, shiftId);
    const movements = await this.store.cashMovementTotals(tx, shiftId);
    const cash = totals.filter((t) => t.methodKind === 'CASH').reduce((sum, t) => sum.plus(Money.ofPesewas(t.amountPesewas)).minus(Money.ofPesewas(t.refundedPesewas)), Money.zero());
    const of = (kind: CashMovementKind) => Money.ofPesewas(movements.get(kind) ?? 0n);
    // The records the close left out are the shift's late entries; they still count for what the drawer held (ADR-0077 Amendments).
    const net = await this.store.lateEntryNet(tx, shiftId);
    const expected = expectedCash({ float: of('FLOAT_IN'), cashTaken: net > 0n ? cash.plus(Money.ofPesewas(net)) : cash, payIns: of('PAY_IN'), drops: net < 0n ? of('CASH_DROP').plus(Money.ofPesewas(-net)) : of('CASH_DROP'), payOuts: of('PAY_OUT') });
    if (!expected.ok) throw new Error(`shift ${shiftId}: its records take out more cash than came in`);
    return expected.value;
  }

  /** A sale refused for integrity (OFFLINE_SYNC 9.8): logged, kept as evidence in the audit and the event, nothing posted. */
  private async reject(
    tx: Transaction,
    register: RegisterRecord,
    shift: ShiftRecord,
    base: Omit<SaleSyncRecord, 'id' | 'outcome' | 'orderDocumentId' | 'orderNo' | 'receiptNo' | 'grossPesewas' | 'exceptions' | 'rejectionRule' | 'postedLateReason' | 'postingDate' | 'clockVerdict' | 'tooOld'>,
    sale: OfflineSaleInput,
    rule: string,
    summary: string,
    recomputedHash: string,
  ): Promise<SyncResultItemView> {
    const record: SaleSyncRecord = {
      ...base,
      id: this.nextId(),
      outcome: 'REJECTED_INTEGRITY',
      orderDocumentId: null,
      orderNo: null,
      receiptNo: null,
      grossPesewas: null,
      exceptions: [{ kind: 'SYNC_REJECTED', summary }],
      rejectionRule: rule,
      postedLateReason: null,
      postingDate: null,
      clockVerdict: null,
      tooOld: false,
    };
    await this.store.insertSaleSync(tx, record);
    const amount = Money.sum(sale.tenders.map((t) => Money.fromJsonInteger(t.amountPesewas))).toJsonInteger();
    const payload: OfflineSaleRejected = {
      saleId: sale.id,
      shiftId: shift.id,
      branchId: register.branchId,
      register: { id: register.id, code: register.code },
      deviceId: base.deviceId,
      cashierId: shift.cashierId,
      deviceCounter: sale.deviceCounter,
      provisionalRef: sale.provisionalRef,
      occurredAt: sale.occurredAt,
      recordedAt: base.receivedAt.toISOString(),
      exceptionKind: 'SYNC_REJECTED',
      severity: 'URGENT',
      rule,
      receivedHash: sale.payloadHash,
      recomputedHash,
      submitted: sale,
      amountPesewas: amount,
      abuseCases: [ABUSE_COUNTER_GAP],
    };
    await this.events.publish(tx, { type: OFFLINE_SALE_REJECTED, subjectType: 'Shift', subjectId: shift.id, branchId: register.branchId, payload, occurredAt: base.receivedAt });
    await this.audit.record(tx, { module: 'pos', action: 'SYNC_REJECTED', entityType: 'Shift', entityId: shift.id, branchId: register.branchId, before: null, after: { rule, deviceId: base.deviceId, receivedHash: sale.payloadHash, recomputedHash, submitted: sale } });
    return resultOf(record);
  }
}

/** SHA-256 over the sale as received less its hash, in canonical JSON (OFFLINE_SYNC 4.4: RFC 8785 for these values). */
export function payloadHashOf(sale: OfflineSaleInput): Buffer {
  const { payloadHash: _hash, ...content } = sale;
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest();
}

/** A rule the till's own sale never breaks, so the server cannot tell what happened (A-278 (k)); null when readable. */
function unreadableLines(sale: OfflineSaleInput): string | null {
  if (sale.lines.length === 0) return 'NO_LINES';
  if (sale.tenders.length === 0) return 'NO_TENDERS';
  if (sale.lines.some((l) => /^0+\.0+$/.test(l.quantity))) return 'QUANTITY_NOT_POSITIVE';
  return null;
}

/** A method the till takes at sync: cash only (PAY records a cash tender into its till; abuse case 4). */
function takenAtSync(method: PaymentMethodFacts): boolean {
  return method.kind === 'CASH' && method.isLive && method.allowedOffline;
}

function flagOf(finding: Exclude<OfflineSaleFinding, { kind: 'PRICE_OVERRIDE' }>, grossPesewas: number): Flag {
  switch (finding.kind) {
    case 'STOCK_EXCEPTION': {
      // An animal sold twice, or one under a veterinary withdrawal, is URGENT; the rest are for review (OFFLINE_SYNC 8).
      const holds = (finding.fact['holds'] ?? []) as readonly { readonly kind: string }[];
      const urgent = finding.stockExceptionKind === 'SERIAL_CONFLICT' || (finding.stockExceptionKind === 'HOLD_CONFLICT' && holds.some((h) => h.kind === 'WITHDRAWAL'));
      const unit = finding.fact['stockUnit'] === undefined ? 'the stock ' : `${String(finding.fact['stockUnit'])} `;
      const summary =
        finding.stockExceptionKind === 'NEGATIVE_STOCK'
          ? finding.moved
            ? `Line ${finding.lineNo}: stock at the till went below zero by ${finding.qty ?? ''} after this sale`
            : `Line ${finding.lineNo}: no lot at the till to issue ${finding.qty ?? ''} from`
          : finding.stockExceptionKind === 'HOLD_CONFLICT'
            ? `Line ${finding.lineNo}: ${unit}is under a hold; no stock moved`
            : finding.stockExceptionKind === 'RESERVATION_CONFLICT'
              ? `Line ${finding.lineNo}: ${unit}is reserved for another order`
              : `Line ${finding.lineNo}: ${unit}was already sold or is not at this till; no stock moved`;
      return { kind: 'STOCK_EXCEPTION', severity: urgent ? 'URGENT' : 'REVIEW', summary, amountPesewas: grossPesewas, fact: { ...finding.fact, stockExceptionId: finding.stockExceptionId, stockExceptionKind: finding.stockExceptionKind, lineNo: finding.lineNo, moved: finding.moved }, abuseCases: [ABUSE_STOCK], toTill: true };
    }
    case 'NOT_PRICED_AT_SYNC':
      return { kind: 'NOT_PRICED_AT_SYNC', severity: 'REVIEW', summary: `Line ${finding.lineNo}: no price list prices this line now; the price the till agreed stands and a manager reviews it`, amountPesewas: finding.agreedUnitPricePesewas, fact: { ...finding }, abuseCases: [ABUSE_OVERRIDE], toTill: true };
  }
}

/** An offline override as raised (the owner on 2026-11-18): the cashier's own, a supervisor's by PIN, or outside the rules. */
function overrideFlag(
  line: { readonly lineNo: number; readonly variancePesewas: number; readonly varianceDirection: 'BELOW' | 'ABOVE' | null; readonly resolvedUnitPricePesewas: number; readonly agreedUnitPricePesewas: number; readonly varianceReasonCode: string | null },
  finding: Extract<OfflineSaleFinding, { kind: 'PRICE_OVERRIDE' }> | null,
  sent: { readonly approvedById: string; readonly approvedByPinVersion: number } | null,
  approval: PinApprovalVerdict | null,
  verdict: OfflineOverrideVerdict,
): Flag {
  const why =
    verdict.basis === 'WITHIN_CASHIER_LIMIT'
      ? "within the cashier's own limit"
      : verdict.basis === 'SUPERVISOR_PIN'
        ? "beyond the cashier's limit, approved on the till by a supervisor's PIN"
        : `outside the rules (${verdict.reason ?? ''}); a manager reviews it`;
  return {
    kind: 'PRICE_OVERRIDE',
    severity: verdict.severity,
    summary: `Line ${line.lineNo}: a price ${line.variancePesewas} pesewas from list was given offline, ${why}`,
    amountPesewas: line.variancePesewas,
    fact: {
      lineNo: line.lineNo,
      variancePesewas: line.variancePesewas,
      direction: line.varianceDirection,
      listUnitPricePesewas: line.resolvedUnitPricePesewas,
      agreedUnitPricePesewas: line.agreedUnitPricePesewas,
      varianceReasonCode: line.varianceReasonCode,
      beyondCashier: finding?.reason ?? null,
      ...(finding === null ? {} : { band: finding.band }),
      basis: verdict.basis,
      reason: verdict.reason,
      approvedById: sent?.approvedById ?? null,
      approvalCheck: { pinVersion: sent?.approvedByPinVersion ?? null, verdict: approval },
    },
    abuseCases: [ABUSE_OVERRIDE],
    // The till is told of an override beyond the cashier's own limit; one within it reaches the source only.
    toTill: verdict.basis !== 'WITHIN_CASHIER_LIMIT',
  };
}

/** A principal read by id for their grants and limits, as the caller's would be; it is not the caller. */
function staffActor(principalId: string): Actor {
  return { principalId, kind: 'USER', displayName: '', realm: 'STAFF', sessionId: null, steppedUpAt: null };
}

/** The kind the till is told for a stock exception: the exception's own kind (`SERIAL_CONFLICT`, `NEGATIVE_STOCK`, ...). */
function stockKindOf(flag: Flag): string {
  return String(flag.fact['stockExceptionKind']);
}

function resultOf(r: SaleSyncRecord): SyncResultItemView {
  return {
    clientSaleId: r.clientSaleId,
    deviceCounter: r.deviceCounter,
    outcome: r.outcome,
    orderId: r.orderDocumentId,
    orderNo: r.orderNo,
    receiptNo: r.receiptNo,
    grossPesewas: r.grossPesewas === null ? null : pesewas(r.grossPesewas),
    currency: 'GHS',
    exceptions: r.exceptions,
  };
}

const lesser = (a: Money, b: Money): Money => (a.compareTo(b) <= 0 ? a : b);

function countOutcomes(results: readonly SyncResultItemView[]): Record<string, number> {
  return tally(results.map((r) => r.outcome));
}
