import { Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { IsolationLevelError, type Transaction } from '../../../platform/database/unit-of-work';
import { UnauthenticatedError } from '../../../platform/errors/api-error';
import type { Settings } from '../../../platform/settings/settings';
import type { BankAccounts } from '../../fin';
import type { MasterDataRefs } from '../../mdm';
import { maskPhone } from '../domain/charge';
import { planTender } from '../domain/tender';
import { unverifiedUrgentFrom } from '../domain/unverified';
import type { Breaks } from './breaks';
import { PaymentInvalidError } from './errors';
import type { Payments, PaymentView } from './payments';

/** `pay.unverified_window_days` (OFFLINE_SYNC 5.2, A-277 (b)): days an unverified tender may stay unmatched before it is urgent. */
export const UNVERIFIED_WINDOW_SETTING = 'pay.unverified_window_days';
export const UNVERIFIED_WINDOW_DAYS = 3;
/** A forged mobile money confirmation (THREAT_MODEL abuse case 4). */
const ABUSE_FORGED_CONFIRMATION = 4;

/**
 * A mobile money tender a till took with no network, approved by a supervisor on the device, to be recorded at sync
 * as an `UNVERIFIED` payment (OFFLINE_SYNC 5.3 and 9.9, B09b continued 2c).
 */
export interface UnverifiedTenderRequest {
  readonly branchId: string;
  readonly paymentMethodId: string;
  readonly amountPesewas: bigint;
  readonly customerId: string | null;
  readonly orderDocumentId: string;
  readonly shiftDocumentId: string;
  /** The till that took it: its shift is asked through `TillShiftCheck` (ADR-0077), and the tender is held against it. */
  readonly register: { readonly id: string; readonly code: string };
  /** When the customer paid, as the till recorded it. */
  readonly receivedAt: Date;
  readonly allocations: readonly { readonly billingDocumentId: string; readonly amountPesewas: bigint }[];
  readonly payerPhone: string;
  readonly network: 'MTN' | 'TELECEL' | 'AIRTELTIGO';
  /** The transaction id the customer showed, if any. */
  readonly providerReference: string | null;
  /** Who the till says approved it; their PIN on the device is B09b continued 3's, so this is the till's word. */
  readonly approvedById: string;
  /** REVIEW, or URGENT when the pack did not offer the method or the approver is no supervisor (the caller judges it). */
  readonly severity: 'REVIEW' | 'URGENT';
  /** The selling module's facts for the break: the cashier, the till, the shift, the sale, what it found. */
  readonly facts: Readonly<Record<string, unknown>>;
}

/**
 * The unverified tender (ADR-0027 principle 8, OFFLINE_SYNC 9.9, abuse case 4, A-279 (g) to (i)), in the caller's
 * serializable transaction: written PENDING with `verification = UNVERIFIED` (the database never lets an unverified
 * payment be CLEARED, `ck_payment_verified`, nor a mobile money payment be written otherwise than PENDING), through
 * `Payments.writeIn`, the one door every payment takes, after POS's `TillShiftCheck` has answered for its shift
 * (ADR-0077); allocated to the receipt and posted at receipt by ◆ `pay.PaymentCleared` marked `unverified`, as a cheque
 * is (Dr 1110 Mobile money wallets against the farm's wallet, never 1120, since no provider took it; Cr 1200); and an `UNVERIFIED_PAYMENT` reconciliation
 * break raised for it, with its severity and the day it becomes urgent if still unmatched (`pay.unverified_window_days`).
 * The payment itself never clears: the break is its verification record, resolved by a person against a settlement or
 * statement line, and a payment that never arrived is reversed under approval. It authorises nothing; the caller's
 * command has.
 */
export class UnverifiedTenders {
  constructor(
    private readonly payments: Payments,
    private readonly breaks: Breaks,
    private readonly refs: MasterDataRefs,
    private readonly bankAccounts: BankAccounts,
    private readonly settings: Settings,
    private readonly audit: AuditTrail,
    private readonly clock: Clock,
    private readonly nextId: () => string,
  ) {}

  /** The wallet an unverified tender at this branch would be held in; null when the farm has none, so none can be taken. */
  walletIn(tx: Transaction, branchId: string): Promise<{ readonly id: string; readonly name: string } | null> {
    return this.bankAccounts.mobileMoneyWalletIn(tx, branchId);
  }

  async recordIn(tx: Transaction, actor: Actor | undefined, request: UnverifiedTenderRequest, field = ''): Promise<{ readonly payment: PaymentView; readonly breakRaised: boolean }> {
    if (tx.isolation !== 'serializable') throw new IsolationLevelError(tx.isolation);
    if (actor === undefined) throw new UnauthenticatedError('a payment needs an actor');
    const method = (await this.refs.paymentMethodsIn(tx, [request.paymentMethodId])).get(request.paymentMethodId);
    if (method === undefined) throw new PaymentInvalidError([{ field: `${field}/paymentMethodId`, rule: 'METHOD_UNKNOWN' }]);
    if (method.kind !== 'MOBILE_MONEY') throw new PaymentInvalidError([{ field: `${field}/paymentMethodId`, rule: 'NOT_MOBILE_MONEY' }]);
    const plan = planTender(Money.ofPesewas(request.amountPesewas), request.allocations.map((a) => Money.ofPesewas(a.amountPesewas)));
    if (!plan.ok) throw new PaymentInvalidError([{ field: `${field}/amountPesewas`, rule: plan.error }]);
    const wallet = await this.walletIn(tx, request.branchId);
    if (wallet === null) throw new PaymentInvalidError([{ field: `${field}/paymentMethodId`, rule: 'NO_MOBILE_MONEY_WALLET' }]);
    // Money taken at a till goes onto that till's own open shift only (ADR-0077); the database holds it too (0239).
    await this.payments.tillCashIn(tx, { shiftDocumentId: request.shiftDocumentId, registerId: request.register.id, branchId: request.branchId, actorId: actor.principalId, direction: 'IN' }, `${field}/paymentMethodId`);

    const id = this.nextId();
    const payerPhoneMasked = maskPhone(request.payerPhone);
    await this.payments.writeIn(
      tx,
      actor.principalId,
      {
        id,
        paymentMethodId: method.id,
        methodKind: 'MOBILE_MONEY',
        amountPesewas: request.amountPesewas,
        customerId: request.customerId,
        orderDocumentId: request.orderDocumentId,
        shiftDocumentId: request.shiftDocumentId,
        register: request.register,
        externalReference: request.providerReference,
        bankAccountId: wallet.id,
        payerPhoneMasked,
        verification: 'UNVERIFIED',
        status: 'PENDING',
        receivedAt: request.receivedAt,
        clearedAt: null,
        branchId: request.branchId,
        actorId: actor.principalId,
        allocations: request.allocations,
        postsAtReceipt: true,
      },
      `${field}/register`,
    );
    const windowDays = await this.settings.integer(UNVERIFIED_WINDOW_SETTING, UNVERIFIED_WINDOW_DAYS);
    const urgentFrom = unverifiedUrgentFrom(request.receivedAt, windowDays);
    const details = {
      ...request.facts,
      severity: request.severity,
      method: method.code,
      wallet: { id: wallet.id, name: wallet.name },
      network: request.network,
      payerPhoneMasked,
      reference: request.providerReference,
      approvedById: request.approvedById,
      approvalVerified: false,
      receivedAt: request.receivedAt.toISOString(),
      unverifiedWindowDays: windowDays,
      urgentFrom: urgentFrom.toISOString(),
      urgentFromDate: toBusinessDate(urgentFrom),
    };
    const breakRaised = await this.breaks.raiseIn(
      tx,
      actor.principalId,
      { kind: 'UNVERIFIED_PAYMENT', branchId: request.branchId, paymentId: id, refundId: null, provider: null, reference: request.providerReference, amountPesewas: request.amountPesewas, details },
      { severity: request.severity, abuseCases: [ABUSE_FORGED_CONFIRMATION] },
    );
    const [view] = await this.payments.viewsIn(tx, [id]);
    await this.audit.record(tx, { module: 'pay', action: 'RECORD_UNVERIFIED', entityType: 'Payment', entityId: id, branchId: request.branchId, before: null, after: { ...view!, breakRaised, severity: request.severity, approvedById: request.approvedById, recordedAt: this.clock.now().toISOString() } });
    return { payment: view!, breakRaised };
  }
}
