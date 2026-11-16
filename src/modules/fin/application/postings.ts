import { Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { DomainEvents, EventEnvelope } from '../../../platform/events/domain-events';
import type { MasterDataRefs } from '../../mdm';
import { manualPostingAmounts } from '../domain/manual-journal';
import { depreciationPostingAmounts, disposalPostingAmounts } from '../domain/fixed-asset';
import type { DepreciationRunPosted, FixedAssetDisposed, ManualJournalApproved, YearClosed } from '../events';
import {
  creditNoteIssuedAmounts,
  customerParty,
  debitNoteIssuedAmounts,
  depositAllocatedAmounts,
  chequeClearedAmounts,
  refundPaidAmounts,
  invoiceIssuedAmounts,
  paymentClearedAmounts,
  type PaymentClearedFields,
  providerSettledAmounts,
  unidentifiedReceiptAmounts,
  stockMovementAmounts,
  type BillingLevy,
  type BillingLine,
  supplierCreditNoteAmounts,
  supplierInvoiceAmounts,
  supplierPaymentAmounts,
  valueAmount,
  type PurchaseLevy,
  type PurchaseLine,
  type StockPostingFields,
} from '../domain/event-amounts';
import type { PostingAmount, SubledgerRef } from '../domain/posting';
import { postingCatalogueGaps } from '../domain/rule-set';
import type { BankAccounts } from './bank-accounts';
import { LedgerCatalogueIncompleteError } from './errors';
import type { Ledger, PostingRequest } from './ledger';
import type { LedgerStore } from './ledger-store';

/** What a handler takes from an event: the amounts, the document that caused it, and what it is about. */
interface Translated {
  readonly amounts: readonly PostingAmount[];
  readonly sourceDocumentId: string;
  readonly eventSubjectId: string;
  readonly branchId?: string | null;
  readonly reversesSubjectId?: string | null;
  readonly manual?: PostingRequest['manual'];
  readonly closing?: PostingRequest['closing'];
  readonly postingDate?: string | null;
}

type Translator = (tx: Transaction, event: EventEnvelope) => Promise<Translated>;

/** The fields of INV's stock posting payload FIN reads (`inv.StockPostingPayload`). */
interface StockPosting extends StockPostingFields {
  readonly movementId: string;
  readonly productId: string;
  readonly reasonCode: string | null;
  readonly sourceDocumentId: string;
  readonly reversesMovementId: string | null;
}

interface SupplierInvoicePosting {
  readonly supplierInvoiceId: string;
  readonly supplierId: string;
  readonly grossPesewas: number;
  readonly lines: readonly PurchaseLine[];
  readonly levies: readonly PurchaseLevy[];
}

/** INV's stock posting events (movement types with a posting event, migration 0044): one translator for all. */
export const STOCK_POSTING_EVENTS = [
  'inv.GoodsReceived',
  'inv.ProductionReceived',
  'inv.OpeningStockLoaded',
  'inv.CostCapitalised',
  'inv.StockConsumedInProcessing',
  'inv.ProcessingOutputReceived',
  'inv.StockIssuedForSale',
  'inv.SaleReturnReceived',
  'inv.StockWrittenOff',
  'inv.StockGainRecorded',
  'inv.SupplierReturnIssued',
] as const;

/**
 * FIN's transactional subscribers: one handler for every event in `fin.posting_event_type` (ADR-0003). Each reads the
 * published payload, names its amounts and determinants (the product's GL group and a reason's loss group from MDM,
 * the supplier's name for the subledger), and posts through `Ledger.postIn` in the publisher's transaction, so a
 * posting failure rolls the business operation back. `assertCatalogueIn` is the boot assertion.
 */
export class LedgerPostings {
  private readonly translators: ReadonlyMap<string, Translator>;
  /** Set once the boot assertion has passed; until then the first posting runs it in its own transaction. */
  private verified = false;

  constructor(
    private readonly ledger: Ledger,
    private readonly store: LedgerStore,
    private readonly refs: MasterDataRefs,
    private readonly documents: DocumentRegistry,
    private readonly bankAccounts: BankAccounts,
    private readonly clock: Clock,
  ) {
    const stock: Translator = (tx, event) => this.stockMovement(tx, event.payload as unknown as StockPosting);
    const invoice: Translator = (tx, event) => this.supplierInvoice(tx, event.payload as unknown as SupplierInvoicePosting);
    this.translators = new Map<string, Translator>([
      ...STOCK_POSTING_EVENTS.map((code) => [code, stock] as const),
      ['inv.UpkeepExpensed', async (_tx, event) => this.upkeep(event.payload as unknown as UpkeepPosting)],
      ['prc.DirectCostIncurred', async (_tx, event) => this.directCost(event.payload as unknown as DirectCostPosting)],
      ['prc.ProcessingOrderReversed', async (_tx, event) => this.processingReversed(event.payload as unknown as ProcessingReversedPosting)],
      ['pur.SupplierInvoiceMatched', invoice],
      ['pur.ExpenseInvoiceApproved', invoice],
      ['pur.SupplierCreditNoteApproved', (tx, event) => this.creditNote(tx, event.payload as unknown as CreditNotePosting)],
      ['pur.SupplierPaymentMade', (tx, event) => this.payment(tx, event.payload as unknown as PaymentPosting)],
      ['bil.InvoiceIssued', (tx, event) => this.billing(tx, event.payload as unknown as BillingPosting, invoiceIssuedAmounts)],
      ['bil.CreditNoteIssued', (tx, event) => this.billing(tx, event.payload as unknown as BillingPosting, creditNoteIssuedAmounts)],
      ['bil.DebitNoteIssued', (tx, event) => this.billing(tx, event.payload as unknown as BillingPosting, debitNoteIssuedAmounts)],
      ['pay.PaymentCleared', (tx, event) => this.paymentCleared(tx, event.payload as unknown as PaymentClearedPosting)],
      ['pay.DepositAllocated', (tx, event) => this.depositAllocated(tx, event.payload as unknown as DepositAllocatedPosting)],
      ['pay.RefundPaid', (tx, event) => this.refundPaid(tx, event.payload as unknown as RefundPaidPosting)],
      ['pay.ChequeCleared', (tx, event) => this.chequeCleared(tx, event.payload as unknown as ChequeClearedPosting)],
      ['pay.PaymentReversed', async (_tx, event) => this.paymentReversed(event.payload as unknown as PaymentReversedPosting)],
      ['pay.ProviderSettled', (tx, event) => this.providerSettled(tx, event.payload as unknown as ProviderSettledPosting)],
      ['pay.UnidentifiedReceiptHeld', (tx, event) => this.unidentifiedReceipt(tx, event.payload as unknown as UnidentifiedReceiptPosting)],
      ['fin.ManualJournalApproved', (tx, event) => this.manualJournal(tx, event.payload as unknown as ManualJournalApproved)],
      ['fin.YearClosed', async (_tx, event) => this.yearClose(event.payload as unknown as YearClosed)],
      ['fin.DepreciationRun', async (_tx, event) => this.depreciationRun(event.payload as unknown as DepreciationRunPosted)],
      ['fin.FixedAssetDisposed', (tx, event) => this.disposal(tx, event.payload as unknown as FixedAssetDisposed)],
    ]);
  }

  handledTypes(): string[] {
    return [...this.translators.keys()].sort();
  }

  /** Subscribes a posting handler for every event FIN posts from, inside the publisher's transaction. */
  registerIn(events: DomainEvents): void {
    for (const [code, translate] of this.translators) {
      events.subscribeInTransaction(code, async (tx, event) => {
        if (!this.verified) {
          await this.assertCatalogueIn(tx, events.declaredLedgerEvents());
        }
        const translated = await translate(tx, event);
        const branchId = event.branchId ?? translated.branchId ?? (await this.documents.branchOf(tx, translated.sourceDocumentId));
        if (branchId === null) {
          throw new Error(`${code} ${event.id}: no branch on the event or its source document`);
        }
        await this.ledger.postIn(tx, {
          eventCode: code,
          eventId: event.id,
          eventSubjectId: translated.eventSubjectId,
          occurredAt: event.occurredAt,
          recordedAt: event.recordedAt,
          branchId,
          sourceDocumentId: translated.sourceDocumentId,
          actorId: event.actorId,
          amounts: translated.amounts,
          reversesSubjectId: translated.reversesSubjectId ?? null,
          manual: translated.manual ?? null,
          closing: translated.closing ?? null,
          postingDate: translated.postingDate ?? null,
        });
      });
    }
  }

  /**
   * ADR-0003 safeguard one (FR-FIN-005): every event a module declares as posting is catalogued, every catalogued event
   * has a handler here, and every amount has a rule in force today on both sides. A gap throws, naming each event.
   * It runs at boot; if the database could not be reached then, the first posting runs it before posting anything.
   */
  async assertCatalogueIn(tx: Transaction, declared: readonly string[], handled: readonly string[] = this.handledTypes()): Promise<void> {
    const { eventTypes, rules } = await this.store.catalogue(tx, toBusinessDate(this.clock.now()));
    const gaps = postingCatalogueGaps({ declared, handled, eventTypes, rules });
    if (gaps.length > 0) {
      throw new LedgerCatalogueIncompleteError(gaps);
    }
    this.verified = true;
  }

  private async stockMovement(tx: Transaction, payload: StockPosting): Promise<Translated> {
    const product = (await this.refs.productsIn(tx, [payload.productId])).get(payload.productId);
    if (product === undefined) {
      throw new Error(`stock movement ${payload.movementId}: product ${payload.productId} does not exist`);
    }
    const reason = payload.reasonCode === null ? undefined : (await this.refs.reasonCodesIn(tx, [payload.reasonCode])).get(payload.reasonCode);
    return {
      amounts: stockMovementAmounts(payload, { glGroup: product.glGroup, lossGroup: reason?.lossAccountGroup ?? null }),
      sourceDocumentId: payload.sourceDocumentId,
      eventSubjectId: payload.movementId,
      reversesSubjectId: payload.reversesMovementId,
    };
  }

  private upkeep(payload: UpkeepPosting): Translated {
    return {
      amounts: valueAmount('value', payload.valuePesewas, payload.stockUnitId),
      sourceDocumentId: payload.sourceDocumentId,
      eventSubjectId: payload.stockUnitId,
      branchId: payload.branchId,
    };
  }

  private directCost(payload: DirectCostPosting): Translated {
    return {
      amounts: valueAmount('value', payload.valuePesewas, payload.processingOrderId),
      sourceDocumentId: payload.sourceDocumentId,
      eventSubjectId: payload.processingCostId,
      branchId: payload.branchId,
    };
  }

  private processingReversed(payload: ProcessingReversedPosting): Translated {
    return {
      amounts: valueAmount('directCost', payload.directCostPesewas, payload.processingOrderId),
      sourceDocumentId: payload.processingReversalId,
      eventSubjectId: payload.processingReversalId,
      branchId: payload.branchId,
    };
  }

  private async supplier(tx: Transaction, supplierId: string): Promise<SubledgerRef> {
    const supplier = (await this.refs.suppliersIn(tx, [supplierId])).get(supplierId);
    if (supplier === undefined) {
      throw new Error(`supplier ${supplierId} does not exist`);
    }
    return { kind: 'SUPPLIER', refId: supplier.id, displayName: supplier.name };
  }

  private async supplierInvoice(tx: Transaction, payload: SupplierInvoicePosting): Promise<Translated> {
    return {
      amounts: supplierInvoiceAmounts(payload, await this.supplier(tx, payload.supplierId)),
      sourceDocumentId: payload.supplierInvoiceId,
      eventSubjectId: payload.supplierInvoiceId,
    };
  }

  private async creditNote(tx: Transaction, payload: CreditNotePosting): Promise<Translated> {
    return {
      amounts: supplierCreditNoteAmounts(payload, await this.supplier(tx, payload.supplierId)),
      sourceDocumentId: payload.creditNoteId,
      eventSubjectId: payload.creditNoteId,
    };
  }

  /** Billing's ◆ events (ADR-0003, A-200): the document's amounts against its customer, the walk-in party if none. */
  private async billing(tx: Transaction, payload: BillingPosting, amountsOf: (payload: BillingPosting, customer: SubledgerRef) => PostingAmount[]): Promise<Translated> {
    const customer = payload.customerId === null ? undefined : (await this.refs.customersIn(tx, [payload.customerId])).get(payload.customerId);
    if (payload.customerId !== null && customer === undefined) {
      throw new Error(`billing document ${payload.billingDocumentId}: customer ${payload.customerId} does not exist`);
    }
    return {
      amounts: amountsOf(payload, customerParty(payload.customerId, customer?.name ?? null)),
      sourceDocumentId: payload.billingDocumentId,
      eventSubjectId: payload.billingDocumentId,
      branchId: payload.branchId,
      postingDate: payload.issueDate,
    };
  }

  /** PAY's ◆ event (ADR-0003): the tender, and the part allocated and the part held, against the customer or walk-in party. */
  private async paymentCleared(tx: Transaction, payload: PaymentClearedPosting): Promise<Translated> {
    const customer = payload.customerId === null ? undefined : (await this.refs.customersIn(tx, [payload.customerId])).get(payload.customerId);
    if (payload.customerId !== null && customer === undefined) {
      throw new Error(`payment ${payload.paymentId}: customer ${payload.customerId} does not exist`);
    }
    const bankAccount = payload.bankAccountId === undefined || payload.bankAccountId === null || payload.methodKind !== 'BANK_TRANSFER' ? null : await this.bankAccounts.subledgerRefIn(tx, payload.bankAccountId);
    return {
      amounts: paymentClearedAmounts(payload, customerParty(payload.customerId, customer?.name ?? null), bankAccount),
      sourceDocumentId: payload.paymentId,
      eventSubjectId: payload.paymentId,
      branchId: payload.branchId,
      ...(payload.clearedOn === undefined || payload.clearedOn === null ? {} : { postingDate: payload.clearedOn }),
    };
  }

  /** PAY's ◆ event (ADR-0003, ADR-0065): a settlement's matched payments out of 1120 into the bank, less the fee, on the day settled. */
  private async providerSettled(tx: Transaction, payload: ProviderSettledPosting): Promise<Translated> {
    return {
      amounts: providerSettledAmounts(payload, await this.bankAccounts.subledgerRefIn(tx, payload.bankAccountId)),
      sourceDocumentId: payload.settlementReportId,
      eventSubjectId: payload.settlementReportId,
      branchId: payload.branchId,
      postingDate: payload.settledOn,
    };
  }

  /** PAY's ◆ event (FR-PAY-010, ADR-0065): an unknown payer's money held in 2290 on an approved break resolution, once per line. */
  private async unidentifiedReceipt(tx: Transaction, payload: UnidentifiedReceiptPosting): Promise<Translated> {
    return {
      amounts: unidentifiedReceiptAmounts(payload, await this.bankAccounts.subledgerRefIn(tx, payload.bankAccountId)),
      sourceDocumentId: payload.sourceDocumentId,
      eventSubjectId: payload.lineId,
      branchId: payload.branchId,
    };
  }

  /** PAY's ◆ event (A-210): a deposit applied to a document or taken off it, against the customer or walk-in party. */
  private async depositAllocated(tx: Transaction, payload: DepositAllocatedPosting): Promise<Translated> {
    return {
      amounts: depositAllocatedAmounts(payload, await this.customerOf(tx, payload.customerId, `allocation ${payload.allocationId}`)),
      sourceDocumentId: payload.paymentId,
      eventSubjectId: payload.allocationId,
      branchId: payload.branchId,
    };
  }

  /** PAY's ◆ event (A-210): a refund paid out of the deposit to the original tender. */
  private async refundPaid(tx: Transaction, payload: RefundPaidPosting): Promise<Translated> {
    return {
      amounts: refundPaidAmounts(payload, await this.customerOf(tx, payload.customerId, `refund ${payload.refundId}`)),
      sourceDocumentId: payload.refundId,
      eventSubjectId: payload.refundId,
      branchId: payload.branchId,
    };
  }

  /** PAY's ◆ event (ADR-0064): a cheque out of 1130 into the bank account it was paid into, on the day it cleared. */
  private async chequeCleared(tx: Transaction, payload: ChequeClearedPosting): Promise<Translated> {
    return {
      amounts: chequeClearedAmounts(payload, await this.bankAccounts.subledgerRefIn(tx, payload.bankAccountId)),
      sourceDocumentId: payload.paymentId,
      eventSubjectId: payload.clearanceRef,
      branchId: payload.branchId,
      postingDate: payload.clearedOn,
    };
  }

  /**
   * PAY's ◆ event (ADR-0003 "Reverse of the original", ADR-0056, ADR-0064): the mirror of the entry its subject names,
   * nothing recomputed. The amount is the original's, so an entry that is missing refuses the reversal.
   */
  private paymentReversed(payload: PaymentReversedPosting): Translated {
    return {
      amounts: [{ key: 'reversed', amount: Money.fromJsonInteger(payload.amountPesewas) }],
      sourceDocumentId: payload.reversingPaymentId,
      eventSubjectId: payload.reversingPaymentId,
      branchId: payload.branchId,
      reversesSubjectId: payload.reversesSubjectId,
    };
  }

  private async customerOf(tx: Transaction, customerId: string | null, what: string): Promise<ReturnType<typeof customerParty>> {
    const customer = customerId === null ? undefined : (await this.refs.customersIn(tx, [customerId])).get(customerId);
    if (customerId !== null && customer === undefined) {
      throw new Error(`${what}: customer ${customerId} does not exist`);
    }
    return customerParty(customerId, customer?.name ?? null);
  }

  /** FIN's own event (A-190): each line to the account entered for it, its party as entered, on the journal's own date. */
  private async manualJournal(tx: Transaction, payload: ManualJournalApproved): Promise<Translated> {
    const lines = payload.lines.map((l) => ({ accountId: l.accountId, side: l.side, amountPesewas: l.amountPesewas, subledgerPartyId: l.subledgerPartyId, memo: l.memo }));
    const parties = await this.store.subledgerParties(tx, [...new Set(lines.flatMap((l) => (l.subledgerPartyId === null ? [] : [l.subledgerPartyId])))]);
    return {
      amounts: manualPostingAmounts(lines, parties),
      sourceDocumentId: payload.manualJournalId,
      eventSubjectId: payload.manualJournalId,
      manual: { kind: payload.kind, description: payload.description, postingDate: payload.postingDate },
    };
  }

  /** FIN's own event (ADR-0058): each balance to the account it closes, as the branch's CLOSING entry on the year's last day. */
  private yearClose(payload: YearClosed): Translated {
    return {
      amounts: payload.amounts.map((a) => ({
        key: a.key,
        amount: Money.fromJsonInteger(a.amountPesewas),
        ...(a.accountId === null ? {} : { closedAccountId: a.accountId }),
        subledgers: a.subledger === null ? [] : [a.subledger as SubledgerRef],
        memo: `Year close ${payload.fiscalYear}`,
      })),
      sourceDocumentId: payload.yearCloseId,
      eventSubjectId: payload.yearCloseId,
      closing: { description: `Year close ${payload.fiscalYear}: income and expenses to retained earnings`, postingDate: payload.postingDate },
    };
  }

  /** FIN's own event (ADR-0059): Dr 6500, Cr 1590 per asset, on the period's last day or not at all. */
  private depreciationRun(payload: DepreciationRunPosted): Translated {
    return {
      amounts: depreciationPostingAmounts(payload.lines.map((l) => ({ fixedAssetId: l.fixedAssetId, assetNo: l.assetNo, category: l.category, amount: Money.fromJsonInteger(l.amountPesewas) }))),
      sourceDocumentId: payload.depreciationRunId,
      eventSubjectId: payload.depreciationRunId,
      postingDate: payload.postingDate,
    };
  }

  /** FIN's own event (ADR-0059): cost and depreciation out, proceeds in, the gain or loss to 4920, on the disposal date. */
  private async disposal(tx: Transaction, payload: FixedAssetDisposed): Promise<Translated> {
    const bankAccount = payload.bankAccountId === null ? null : await this.bankAccounts.subledgerRefIn(tx, payload.bankAccountId);
    return {
      amounts: disposalPostingAmounts(
        {
          fixedAssetId: payload.fixedAssetId,
          assetNo: payload.assetNo,
          category: payload.category,
          cost: Money.fromJsonInteger(payload.costPesewas),
          accumulated: Money.fromJsonInteger(payload.accumulatedPesewas),
          proceeds: Money.fromJsonInteger(payload.proceedsPesewas),
        },
        { method: payload.proceedsMethod, bankAccount },
      ),
      sourceDocumentId: payload.disposalId,
      eventSubjectId: payload.fixedAssetId,
      postingDate: payload.disposedOn,
    };
  }

  /** A payment naming the account it left from posts to that account's own party; one naming none as A-185 says (A-194). */
  private async payment(tx: Transaction, payload: PaymentPosting): Promise<Translated> {
    const bankAccountId = payload.bankAccountId ?? null;
    const bankAccount = bankAccountId === null ? null : await this.bankAccounts.subledgerRefIn(tx, bankAccountId);
    return {
      amounts: supplierPaymentAmounts({ ...payload, bankAccount }, await this.supplier(tx, payload.supplierId)),
      sourceDocumentId: payload.supplierPaymentId,
      eventSubjectId: payload.supplierPaymentId,
    };
  }
}

/** The fields of PAY's `pay.DepositAllocated` FIN reads. */
interface DepositAllocatedPosting {
  readonly allocationId: string;
  readonly paymentId: string;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly appliedPesewas: number;
  readonly unappliedPesewas: number;
}

/** The fields of PAY's `pay.RefundPaid` FIN reads. */
interface RefundPaidPosting {
  readonly refundId: string;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly amountPesewas: number;
  readonly methodKind: string;
  readonly register: { readonly id: string; readonly code: string } | null;
  readonly provider: string | null;
}

/** The fields of PAY's `pay.ChequeCleared` FIN reads. */
interface ChequeClearedPosting {
  readonly paymentId: string;
  readonly clearanceRef: string;
  readonly branchId: string;
  readonly bankAccountId: string;
  readonly amountPesewas: number;
  readonly clearedOn: string;
}

/** The fields of PAY's `pay.PaymentReversed` FIN reads. */
interface PaymentReversedPosting {
  readonly reversingPaymentId: string;
  readonly reversesSubjectId: string;
  readonly branchId: string;
  readonly amountPesewas: number;
}

/** The fields of PAY's `pay.PaymentCleared` FIN reads. */
interface PaymentClearedPosting extends PaymentClearedFields {
  readonly paymentId: string;
  readonly branchId: string;
  readonly customerId: string | null;
  /** The bank account a bank transfer landed in (ADR-0065). */
  readonly bankAccountId?: string | null;
  /** The business date a bank transfer's statement line is valued, its posting date. */
  readonly clearedOn?: string | null;
}

/** The fields of PAY's `pay.ProviderSettled` FIN reads. */
interface ProviderSettledPosting {
  readonly settlementReportId: string;
  readonly branchId: string;
  readonly provider: string;
  readonly bankAccountId: string;
  readonly grossPesewas: number;
  readonly feePesewas: number;
  readonly netPesewas: number;
  readonly settledOn: string;
}

/** The fields of PAY's `pay.UnidentifiedReceiptHeld` FIN reads. */
interface UnidentifiedReceiptPosting {
  readonly lineId: string;
  readonly sourceDocumentId: string;
  readonly branchId: string;
  readonly bankAccountId: string;
  readonly amountPesewas: number;
  readonly feePesewas: number;
}

/** The fields of BIL's `bil.InvoiceIssued`, `bil.CreditNoteIssued` and `bil.DebitNoteIssued` FIN reads. */
interface BillingPosting {
  readonly billingDocumentId: string;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly issueDate: string;
  readonly netPesewas: number;
  readonly grossPesewas: number;
  readonly lines: readonly BillingLine[];
  readonly levies: readonly BillingLevy[];
}

interface UpkeepPosting {
  readonly stockUnitId: string;
  readonly branchId: string;
  readonly valuePesewas: number;
  readonly sourceDocumentId: string;
}

interface DirectCostPosting {
  readonly processingOrderId: string;
  readonly processingCostId: string;
  readonly valuePesewas: number;
  readonly branchId: string;
  readonly sourceDocumentId: string;
}

interface ProcessingReversedPosting {
  readonly processingOrderId: string;
  readonly processingReversalId: string;
  readonly branchId: string;
  readonly directCostPesewas: number;
}

interface CreditNotePosting {
  readonly creditNoteId: string;
  readonly supplierId: string;
  readonly purchaseOrderId: string | null;
  readonly grossPesewas: number;
  readonly lines: readonly PurchaseLine[];
  readonly levies: readonly PurchaseLevy[];
  readonly returns: readonly { readonly costPesewas: number }[];
}

interface PaymentPosting {
  readonly supplierPaymentId: string;
  readonly supplierId: string;
  readonly method: string;
  readonly amountPesewas: number;
  /** v1 events published before B08 continued 1b2 carry no such field (A-185). */
  readonly bankAccountId?: string | null;
}
