import { createUuidV7Generator, Money, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { IsolationLevelError, type Transaction } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { Billing } from '../../bil';
import type { MasterDataRefs } from '../../mdm';
import { PaymentInvalidError, type PaymentRule } from './errors';
import type { Payments, PaymentView } from './payments';
import type { PaymentStore } from './payment-store';

/** The payment method a delivery's cash is recorded under: the seeded `COD` method, of kind CASH. */
export const COD_METHOD = 'COD';

/** Cash a driver collected on delivery, for the delivery's invoice or receipt (DEL's proof of delivery, FR-DEL-009). */
export interface DriverCashRequest {
  readonly branchId: string;
  readonly driverId: string;
  readonly customerId: string | null;
  readonly orderDocumentId: string;
  readonly billingDocumentId: string;
  readonly amountPesewas: bigint;
  readonly receivedAt: Date;
}

/** A driver's cash counted into a till shift by its own cashier (CR-057): the payment onto the shift that receives it. */
export interface HandInRequest {
  readonly branchId: string;
  /** The driver whose cash it is; never the cashier receiving it (the database holds it too). */
  readonly driverId: string;
  readonly shiftDocumentId: string;
  readonly register: { readonly id: string; readonly code: string };
  readonly amountPesewas: bigint;
  readonly receivedAt: Date;
}

/**
 * DriverCash (FR-DEL-009, ADR-0003's `del.CodCollected`, A-339): the cash a driver collects on delivery, recorded in the
 * caller's serializable transaction as a cleared cash payment held by that driver (`pay.payment.driver_id`, never a
 * till: `ck_payment_cash_holder`), allocated whole to the delivery's billing document through BIL's `Billing.settleIn`.
 * It publishes nothing: the ledger posts the collection from DEL's ◆ `del.CodCollected` (Dr 1020 against the driver,
 * Cr 1200), so no `pay.PaymentCleared` is published for it and nothing reaches a till until the driver hands the cash in
 * at a till shift (B11 continued 2). It never takes more than the document has outstanding (BIL's settlement refuses
 * it). It authorises nothing: DEL's proof of delivery has.
 */
export class DriverCash {
  private readonly nextId: () => string;

  constructor(
    private readonly store: PaymentStore,
    private readonly payments: Payments,
    private readonly billing: Billing,
    private readonly refs: MasterDataRefs,
    private readonly documents: DocumentRegistry,
    private readonly audit: AuditTrail,
    clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  async collectIn(tx: Transaction, actor: Actor, request: DriverCashRequest): Promise<PaymentView> {
    if (tx.isolation !== 'serializable') throw new IsolationLevelError(tx.isolation);
    const method = (await this.refs.paymentMethodsByCodeIn(tx, [COD_METHOD])).get(COD_METHOD);
    const broken: PaymentRule[] = [];
    if (method === undefined || method.kind !== 'CASH') throw new PaymentInvalidError([{ field: '/codCollectedPesewas', rule: 'METHOD_UNKNOWN' }]);
    if (!method.isLive) broken.push({ field: '/codCollectedPesewas', rule: 'METHOD_DISABLED' });
    if (request.amountPesewas <= 0n) broken.push({ field: '/codCollectedPesewas', rule: 'AMOUNT_NOT_POSITIVE' });
    if (broken.length > 0) throw new PaymentInvalidError(broken);

    const id = this.nextId();
    await this.documents.register(tx, { id, docType: 'PAYMENT', ownerModule: 'pay', branchId: request.branchId, actorId: actor.principalId });
    await this.store.insert(tx, {
      id,
      paymentMethodId: method!.id,
      methodKind: 'CASH',
      amountPesewas: request.amountPesewas,
      customerId: request.customerId,
      orderDocumentId: request.orderDocumentId,
      shiftDocumentId: null,
      register: null,
      driverId: request.driverId,
      verification: 'NOT_REQUIRED',
      status: 'CLEARED',
      receivedAt: request.receivedAt,
      clearedAt: request.receivedAt,
      branchId: request.branchId,
      actorId: actor.principalId,
    });
    await this.payments.capped('/codCollectedPesewas', () =>
      this.store.allocate(tx, { id: this.nextId(), paymentId: id, billingDocumentId: request.billingDocumentId, amountPesewas: request.amountPesewas, direction: 'APPLY', atReceipt: true, actorId: actor.principalId }),
    );
    await this.billing.settleIn(tx, request.billingDocumentId, request.amountPesewas, 'APPLY');
    const [view] = await this.payments.viewsIn(tx, [id]);
    await this.audit.record(tx, { module: 'pay', action: 'RECORD', entityType: 'Payment', entityId: id, branchId: request.branchId, before: null, after: { ...view!, driverId: request.driverId, amountPesewas: Money.ofPesewas(request.amountPesewas).toJsonInteger() } });
    return view!;
  }

  /**
   * A driver's cash handed in at a till (FR-DEL-010, CR-057, ADR-0092), in the caller's serializable transaction: a
   * cleared cash payment onto the receiving cashier's own open shift, written through `Payments.writeIn`, the one door
   * every till cash takes, so POS's `TillShiftCheck` and `trg_payment_a_till_shift` judge the shift under its lock again
   * and the shift's records and close count it. It names the driver it was received from and settles nothing: the
   * collections were allocated when the driver took them, so it is never allocated, linked, refunded or reversed
   * (migration 0313). It publishes nothing: DEL's ◆ `del.DriverCashRemitted` posts the move from 1020 into 1000. It
   * authorises nothing: POS's hand-in has.
   */
  async handInIn(tx: Transaction, actor: Actor, request: HandInRequest): Promise<PaymentView> {
    if (tx.isolation !== 'serializable') throw new IsolationLevelError(tx.isolation);
    const method = (await this.refs.paymentMethodsByCodeIn(tx, [COD_METHOD])).get(COD_METHOD);
    if (method === undefined || method.kind !== 'CASH') throw new PaymentInvalidError([{ field: '/declaredPesewas', rule: 'METHOD_UNKNOWN' }]);
    if (request.amountPesewas <= 0n) throw new PaymentInvalidError([{ field: '/declaredPesewas', rule: 'AMOUNT_NOT_POSITIVE' }]);
    const id = this.nextId();
    await this.payments.writeIn(
      tx,
      actor.principalId,
      {
        id,
        paymentMethodId: method.id,
        methodKind: 'CASH',
        amountPesewas: request.amountPesewas,
        customerId: null,
        orderDocumentId: null,
        shiftDocumentId: request.shiftDocumentId,
        register: request.register,
        receivedFromDriverId: request.driverId,
        verification: 'NOT_REQUIRED',
        status: 'CLEARED',
        receivedAt: request.receivedAt,
        clearedAt: request.receivedAt,
        branchId: request.branchId,
        actorId: actor.principalId,
        allocations: [],
        postsAtReceipt: false,
      },
      '/shiftId',
    );
    const [view] = await this.payments.viewsIn(tx, [id]);
    await this.audit.record(tx, { module: 'pay', action: 'RECEIVE_FROM_DRIVER', entityType: 'Payment', entityId: id, branchId: request.branchId, before: null, after: { ...view!, receivedFromDriverId: request.driverId } });
    return view!;
  }
}
