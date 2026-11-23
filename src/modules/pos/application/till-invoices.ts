import { Money, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { UnitOfWork } from '../../../platform/database/unit-of-work';
import { ForbiddenError, NotFoundError } from '../../../platform/errors/api-error';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Billing } from '../../bil';
import type { Authoriser } from '../../iam';
import type { Payments } from '../../pay';
import { tillTakesCash } from '../domain/offline-sync';
import { judgeTillInvoicePayment } from '../domain/till-invoice';
import type { Devices } from './devices';
import { ShiftNotOpenError, TillInvoicePaymentInvalidError } from './errors';
import type { TillStore } from './till-store';

/** Taking money at the till on one's own open shift: the counter sale's permission (A-285 (h)). */
const COLLECT = 'pos.sale.create';
/** The method an invoice is paid by at the till: cash only (A-212 (a)); mobile money and card go through the provider. */
const CASH = 'CASH';

/** The contract's `TillInvoicePaymentCreate`. */
export interface TillInvoicePaymentRequest {
  readonly billingDocumentId: string;
  readonly amountPesewas: bigint;
  readonly tenderedPesewas?: bigint | undefined;
}

/** The contract's `TillInvoicePayment`. */
export interface TillInvoicePaymentView {
  readonly paymentId: string;
  readonly shiftId: string;
  readonly billingDocument: { readonly id: string; readonly documentNo: string };
  readonly amountPesewas: number;
  readonly tenderedPesewas: number;
  readonly changeDuePesewas: number;
  readonly outstandingPesewas: number;
  readonly currency: 'GHS';
}

/**
 * `payInvoiceAtTill` (the owner on A-212 (a), 2026-11-16: cash enters only through a till shift; A-285 (g)): a customer
 * pays an issued invoice in cash at the till, taken onto the cashier's own open shift from an enrolled device of that
 * till, and counted at its close as any cash the shift took. The shift is judged by the till's one deciding function
 * (`tillTakesCash`): only `ON_SHIFT` is taken online, so a closing, closed or force-closed shift takes nothing; and the
 * cash is written through PAY's one door (`Payments.recordIn`, so `writeIn` and POS's `TillCash` judge the shift again
 * under its lock, ADR-0077), allocated to the invoice, posting Dr 1000 (the till) Cr 1200 (the customer). PAY's own
 * `recordPayment` still refuses cash (`TENDER_NOT_AVAILABLE`): there is no second path.
 */
export class TillInvoicePayments {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: TillStore,
    private readonly devices: Devices,
    private readonly billing: Billing,
    private readonly payments: Payments,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly clock: Clock,
  ) {}

  pay(actor: Actor | undefined, shiftId: string, body: TillInvoicePaymentRequest, idempotencyKey: string, deviceCredential: string | undefined): Promise<StoredResponse<TillInvoicePaymentView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const shift = await this.store.lockShift(tx, shiftId);
      const register = shift === null ? null : (await this.store.registers(tx, [shift.registerId]))[0]!;
      await this.authoriser.authorise(tx, actor, COLLECT, register === null ? {} : { branchId: register.branchId, locationId: register.locationId });
      if (shift === null || register === null) throw new NotFoundError(`no shift ${shiftId}`);
      // Cash goes only onto the cashier's own shift: nobody takes it on another cashier's (A-212 (a), ADR-0077).
      if (shift.cashierId !== actor!.principalId) throw new ForbiddenError(`${COLLECT} refused: the shift is another cashier's`);
      await this.devices.deviceOfIn(tx, deviceCredential, register.id);
      const request = { shiftId, billingDocumentId: body.billingDocumentId, amountPesewas: body.amountPesewas.toString(), tenderedPesewas: body.tenderedPesewas?.toString() ?? null };
      const claim = await this.idempotency.claim(tx, { operationId: 'payInvoiceAtTill', principalId: actor!.principalId, key: idempotencyKey, request });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<TillInvoicePaymentView>;
      // Online only cash on the shift is taken; a late entry is the queue's alone (ADR-0077 Amendments).
      if (tillTakesCash(shift) !== 'ON_SHIFT') throw new ShiftNotOpenError(shift.status);

      const document = (await this.billing.settleableIn(tx, [body.billingDocumentId])).get(body.billingDocumentId);
      if (document === undefined) throw new NotFoundError(`no billing document ${body.billingDocumentId}`);
      const amount = Money.ofPesewas(body.amountPesewas);
      const tendered = body.tenderedPesewas === undefined ? null : Money.ofPesewas(body.tenderedPesewas);
      const judged = judgeTillInvoicePayment({ document, branchId: register.branchId, amount, tendered });
      if (!judged.ok) throw new TillInvoicePaymentInvalidError(judged.error.map((rule) => ({ field: rule === 'TENDERED_BELOW_AMOUNT' ? '/tenderedPesewas' : rule === 'AMOUNT_NOT_POSITIVE' || rule === 'AMOUNT_EXCEEDS_OUTSTANDING' ? '/amountPesewas' : '/billingDocumentId', rule })));

      const payment = await this.payments.recordIn(tx, actor, {
        branchId: register.branchId,
        channel: 'POS',
        methodCode: CASH,
        amountPesewas: body.amountPesewas,
        customerId: document.customerId,
        orderDocumentId: null,
        shiftDocumentId: shift.id,
        register: { id: register.id, code: register.code },
        receivedAt: this.clock.now(),
        allocations: [{ billingDocumentId: document.id, amountPesewas: body.amountPesewas }],
      });
      const view: TillInvoicePaymentView = {
        paymentId: payment.id,
        shiftId: shift.id,
        billingDocument: { id: document.id, documentNo: document.documentNo! },
        amountPesewas: amount.toJsonInteger(),
        tenderedPesewas: (tendered ?? amount).toJsonInteger(),
        changeDuePesewas: judged.value.change.toJsonInteger(),
        outstandingPesewas: judged.value.outstandingAfter.toJsonInteger(),
        currency: 'GHS',
      };
      await this.audit.record(tx, { module: 'pos', action: 'COLLECT_INVOICE', entityType: 'Shift', entityId: shift.id, branchId: register.branchId, before: null, after: { ...view } });
      const response: StoredResponse<TillInvoicePaymentView> = { status: 201, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }
}
