import { Money, type Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { UnitOfWork } from '../../../platform/database/unit-of-work';
import { ForbiddenError, NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Billing, BillingDocumentView } from '../../bil';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import type { Orders, SalePosting, SaleRequest, SalesOrderView } from '../../ord';
import { PaymentRequiresVerificationError } from '../../pay';
import { CLOCK_TOLERANCE_SECONDS, isUuidV7, secondsAhead, withinTolerance } from '../domain/client-time';
import { changeDue, shiftOverrideRoom, type TenderKind } from '../domain/till';
import type { TillClockOutOfTolerance } from '../events';
import type { Devices } from './devices';
import { CounterSaleInvalidError, ShiftNotOpenError, type TillRule } from './errors';
import type { TillStore } from './till-store';

export const TILL_CLOCK_OUT_OF_TOLERANCE = 'pos.TillClockOutOfTolerance';
const SELL = 'pos.sale.create';

/** A counter sale's line as the contract's `CounterSaleLine` carries it. */
export interface CounterSaleLineRequest {
  readonly productId: string;
  readonly stockUnitId?: string | undefined;
  readonly quantity: string;
  readonly weightKg?: string | undefined;
  readonly weightSource?: 'SCALE' | 'MANUAL' | 'ESTIMATE' | undefined;
  readonly gradeId?: string | undefined;
  readonly agreedUnitPricePesewas: bigint;
  readonly varianceReasonCode?: string | undefined;
}

/** A tender as the contract's `TenderInput` carries it. */
export interface CounterTenderRequest {
  readonly paymentMethodId: string;
  readonly amountPesewas: bigint;
  readonly paymentId?: string | undefined;
  readonly tenderedPesewas?: bigint | undefined;
  readonly unverifiedMobileMoney?: object | undefined;
}

/** The contract's `CounterSale`. */
export interface CounterSaleRequest {
  readonly id: string;
  readonly shiftId: string;
  readonly customerId?: string | undefined;
  readonly customerPhone?: string | undefined;
  readonly lines: readonly CounterSaleLineRequest[];
  readonly tenders: readonly CounterTenderRequest[];
  readonly occurredAt: Date;
}

/** The contract's `CounterSaleResult`. Nothing prints yet (A-273 (b)): `escPosBase64` is null. */
export interface CounterSaleResultView {
  readonly order: SalesOrderView;
  readonly receipt: BillingDocumentView;
  readonly changeDuePesewas: number;
  readonly currency: 'GHS';
  readonly escPosBase64: null;
}

/**
 * `completeCounterSale` (FR-POS-001 to FR-POS-006, B09b continued, A-274): a sale taken on the cashier's own OPEN shift,
 * locked for the sale, from an enrolled device of that till that is not revoked, posted through ORD's one sale path
 * (`SalePosting.postIn`: stock, receipt, payment and ledger in one serializable transaction) with the till's location,
 * channel POS and the shift's remaining per-shift override room. Change is given from cash only (`changeDue`). A mobile
 * money or card tender is refused unless it names a payment the provider cleared, and that is not yet accepted at the
 * counter (A-274): such a sale is taken in cash. A till clock outside tolerance never refuses the sale (the owner on A-273
 * (g)): it posts at the server's time and the difference reaches the daily exception report's source.
 */
export class CounterSales {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: TillStore,
    private readonly devices: Devices,
    private readonly posting: SalePosting,
    private readonly orders: Orders,
    private readonly billing: Billing,
    private readonly refs: MasterDataRefs,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly events: DomainEvents,
    private readonly clock: Clock,
  ) {}

  async complete(actor: Actor | undefined, body: CounterSaleRequest, idempotencyKey: string, deviceCredential: string | undefined): Promise<StoredResponse<CounterSaleResultView>> {
    // The sale's series are locked before the transaction starts (A-186), so its branch is read first.
    const located = await this.uow.run({ isolation: 'read committed' }, async (tx) => (await this.store.shifts(tx, [body.shiftId]))[0]?.branchId ?? null);
    const seriesLocks = located === null ? [] : this.posting.locksFor(located);
    return this.uow.run({ isolation: 'serializable', seriesLocks }, async (tx) => {
      const shift = await this.store.lockShift(tx, body.shiftId);
      const register = shift === null ? null : (await this.store.registers(tx, [shift.registerId]))[0]!;
      await this.authoriser.authorise(tx, actor, SELL, register === null ? {} : { branchId: register.branchId, locationId: register.locationId });
      if (shift === null || register === null) throw new NotFoundError(`no shift ${body.shiftId}`);
      // A sale belongs to the cashier's own shift (FR-POS-001): nobody sells on another cashier's.
      if (shift.cashierId !== actor!.principalId) throw new ForbiddenError(`${SELL} refused: the shift is another cashier's`);
      const device = await this.devices.deviceOfIn(tx, deviceCredential, register.id);
      const claim = await this.idempotency.claim(tx, { operationId: 'completeCounterSale', principalId: actor!.principalId, key: idempotencyKey, request: hashable(body) });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<CounterSaleResultView>;
      if (shift.status !== 'OPEN') throw new ShiftNotOpenError(shift.status);

      const broken: TillRule[] = [];
      if (!isUuidV7(body.id)) broken.push({ field: '/id', rule: 'ID_NOT_UUID_V7' });
      if (idempotencyKey !== body.id) broken.push({ field: '/id', rule: 'ID_DIFFERS_FROM_KEY' });
      const methods = await this.refs.paymentMethodsIn(tx, body.tenders.map((t) => t.paymentMethodId));
      const kinds: { readonly kind: TenderKind; readonly amount: Money; readonly tendered: Money | null }[] = [];
      for (const [i, tender] of body.tenders.entries()) {
        const method = methods.get(tender.paymentMethodId);
        if (method === undefined) {
          broken.push({ field: `/tenders/${i}/paymentMethodId`, rule: 'METHOD_UNKNOWN' });
          continue;
        }
        if (tender.unverifiedMobileMoney !== undefined) broken.push({ field: `/tenders/${i}/unverifiedMobileMoney`, rule: 'OFFLINE_TENDER_ONLY' });
        if (tender.paymentId !== undefined) broken.push({ field: `/tenders/${i}/paymentId`, rule: 'PROVIDER_PAYMENT_NOT_AVAILABLE' });
        kinds.push({ kind: method.kind as TenderKind, amount: Money.ofPesewas(tender.amountPesewas), tendered: tender.tenderedPesewas === undefined ? null : Money.ofPesewas(tender.tenderedPesewas) });
      }
      const change = changeDue(kinds);
      if (!change.ok) broken.push({ field: '/tenders', rule: change.error });
      if (broken.length > 0) throw new CounterSaleInvalidError(broken);
      // No screen accepts "paid" on the cashier's word (FR-POS-006, abuse case 4).
      const unverified = body.tenders.findIndex((t) => ['MOBILE_MONEY', 'CARD'].includes(methods.get(t.paymentMethodId)!.kind));
      if (unverified >= 0) throw new PaymentRequiresVerificationError(`/tenders/${unverified}/paymentMethodId`);

      const now = this.clock.now();
      const limit = await this.authoriser.limitIn(tx, actor!, 'PRICE_OVERRIDE_PER_SHIFT', register.branchId);
      const used = (await this.orders.shiftSalesIn(tx, shift.id)).overridesPesewas;
      const request: SaleRequest = {
        orderId: body.id,
        channel: 'POS',
        branchId: register.branchId,
        customerId: body.customerId ?? null,
        contactPhone: body.customerPhone ?? null,
        fulfilmentMode: 'COUNTER',
        // Counter prices are shown with their tax in (A-274); the offline pack reads it from the price list (CR-031).
        taxInclusive: true,
        occurredAt: now,
        shiftDocumentId: shift.id,
        shiftOverrideRoomPesewas: shiftOverrideRoom(Money.ofPesewas(limit), Money.ofPesewas(used)).pesewas,
        lines: body.lines.map((l) => ({
          productId: l.productId,
          stockUnitId: l.stockUnitId ?? null,
          fromLocationId: register.locationId,
          quantity: l.quantity,
          weightKg: l.weightKg ?? null,
          weightSource: l.weightSource ?? null,
          gradeId: l.gradeId ?? null,
          agreedUnitPricePesewas: l.agreedUnitPricePesewas,
          varianceReasonCode: l.varianceReasonCode ?? null,
        })),
        tenders: body.tenders.map((t) => ({ methodCode: methods.get(t.paymentMethodId)!.code, amountPesewas: t.amountPesewas, register: { id: register.id, code: register.code } })),
      };
      const sale = await this.posting.postIn(tx, actor, request);
      if (!withinTolerance(body.occurredAt, now)) {
        const skew: TillClockOutOfTolerance = {
          saleId: sale.id,
          shiftId: shift.id,
          branchId: register.branchId,
          register: { id: register.id, code: register.code },
          deviceId: device.id,
          cashierId: shift.cashierId,
          tillTime: body.occurredAt.toISOString(),
          serverTime: now.toISOString(),
          differenceSeconds: secondsAhead(body.occurredAt, now),
          toleranceSeconds: CLOCK_TOLERANCE_SECONDS,
          exceptionKind: 'TILL_CLOCK_OUT_OF_TOLERANCE',
        };
        await this.events.publish(tx, { type: TILL_CLOCK_OUT_OF_TOLERANCE, subjectType: 'SalesOrder', subjectId: sale.id, branchId: register.branchId, payload: skew, occurredAt: now });
      }
      const order = await this.orders.viewOf(tx, sale.id);
      const [receipt] = await this.billing.viewsIn(tx, [sale.billingDocument!.id]);
      const response: StoredResponse<CounterSaleResultView> = { status: 201, body: { order, receipt: receipt!, changeDuePesewas: (change.ok ? change.value : Money.zero()).toJsonInteger(), currency: 'GHS', escPosBase64: null } };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }
}

/** The request as its idempotency key binds it: amounts as strings, the time as ISO. */
function hashable(body: CounterSaleRequest): unknown {
  return JSON.parse(JSON.stringify(body, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)));
}
