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
  type LatePostingReason,
  type Severity,
} from '../domain/offline-sync';
import { shiftOverrideRoom } from '../domain/till';
import type { DeviceCounterGap, OfflineSaleFlagged, OfflineSaleRejected } from '../events';
import type { Devices } from './devices';
import { SyncBatchTooLargeError } from './errors';
import { OFFLINE_UNVERIFIED_MOBILE_MONEY } from './offline-packs';
import type { RegisterRecord, SaleSyncRecord, ShiftRecord, TillStore } from './till-store';

export const OFFLINE_SALE_FLAGGED = 'pos.OfflineSaleFlagged';
export const OFFLINE_SALE_REJECTED = 'pos.OfflineSaleRejected';
export const DEVICE_COUNTER_GAP = 'pos.DeviceCounterGap';
const SELL = 'pos.sale.create';
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
}

/** A tender of a queued sale as the device sent it (the contract's `TenderInput`). */
export interface OfflineTenderInput {
  readonly paymentMethodId: string;
  readonly amountPesewas: number;
  readonly paymentId?: string | undefined;
  readonly tenderedPesewas?: number | undefined;
  readonly unverifiedMobileMoney?: object | undefined;
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
  readonly cashMovements?: readonly { readonly id: string }[] | undefined;
}

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

/** The cash movements of a batch are not taken at sync yet (B09b continued 2c, A-278 (a)): each is answered so. */
const CASH_MOVEMENT_NOT_TAKEN = 'CASH_MOVEMENT_NOT_TAKEN_AT_SYNC';

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
        after: { deviceId, cashierId: shift.cashierId, sales: results.length, outcomes: countOutcomes(results), counterGaps: after, newlyMissing: fresh },
      });
      return after;
    });
    return {
      shiftId: shift.id,
      results,
      cashMovementResults: (body.cashMovements ?? []).map((m) => ({ clientId: m.id, outcome: 'REJECTED' as const, reason: CASH_MOVEMENT_NOT_TAKEN })),
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
    const takesCash = tillTakesCash(shift);
    const tenders: SaleTenderRequest[] = [];
    for (const tender of sale.tenders) {
      const method = methods.get(tender.paymentMethodId)!;
      if (takesCash && takenAtSync(method)) {
        tenders.push({ methodCode: method.code, amountPesewas: BigInt(tender.amountPesewas), register: { id: register.id, code: register.code } });
        continue;
      }
      if (takenAtSync(method)) {
        flags.push({ kind: 'OFFLINE_CASH_NOT_TAKEN', severity: 'URGENT', summary: `Cash of ${tender.amountPesewas} pesewas was not put on the shift, because the shift is ${shift.forceClosed ? 'force-closed' : shift.status.toLowerCase()}; the receipt stays outstanding`, amountPesewas: tender.amountPesewas, fact: { method: method.code, shiftStatus: shift.status, forceClosed: shift.forceClosed }, abuseCases: [ABUSE_SHORT], toTill: true });
        continue;
      }
      const permitted = method.kind === 'MOBILE_MONEY' && unverifiedAllowed;
      flags.push({
        kind: 'UNMATCHED_PAYMENT',
        severity: permitted ? 'REVIEW' : 'URGENT',
        summary: permitted ? `A mobile money tender of ${tender.amountPesewas} pesewas was taken unverified; it is not recorded until it is matched` : `A ${method.code} tender of ${tender.amountPesewas} pesewas is not taken offline; it is not recorded`,
        amountPesewas: tender.amountPesewas,
        fact: { method: method.code, kind: method.kind, permittedOffline: permitted, ...(tender.unverifiedMobileMoney === undefined ? {} : { unverifiedMobileMoney: tender.unverifiedMobileMoney }) },
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
    for (const finding of posted.findings) flags.push(flagOf(finding, grossPesewas));
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

function flagOf(finding: OfflineSaleFinding, grossPesewas: number): Flag {
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
    case 'PRICE_OVERRIDE':
      return {
        kind: 'PRICE_OVERRIDE',
        severity: 'REVIEW',
        summary: `Line ${finding.lineNo}: the price given (${finding.variancePesewas} pesewas from list) is beyond what the cashier may give now (${finding.reason}); a manager reviews it`,
        amountPesewas: finding.variancePesewas,
        fact: { ...finding },
        abuseCases: [ABUSE_OVERRIDE],
        toTill: true,
      };
    case 'NOT_PRICED_AT_SYNC':
      return { kind: 'NOT_PRICED_AT_SYNC', severity: 'REVIEW', summary: `Line ${finding.lineNo}: no price list prices this line now; the price the till agreed stands and a manager reviews it`, amountPesewas: finding.agreedUnitPricePesewas, fact: { ...finding }, abuseCases: [ABUSE_OVERRIDE], toTill: true };
  }
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

function countOutcomes(results: readonly SyncResultItemView[]): Record<string, number> {
  return tally(results.map((r) => r.outcome));
}
