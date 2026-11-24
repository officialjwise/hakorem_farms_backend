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
  unverifiedVerifiedAmounts,
  negativeStockCostedAmounts,
  negativeStockTrueUpAmounts,
  refundPaidAmounts,
  invoiceIssuedAmounts,
  paymentClearedAmounts,
  type PaymentClearedFields,
  providerSettledAmounts,
  unidentifiedReceiptAmounts,
  stockMovementAmounts,
  tillAmounts,
  type TillPostingFields,
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

/** The fields of WHL's `whl.BadDebtWrittenOff` FIN reads. */
interface BadDebtPosting {
  readonly writeOffId: string;
  readonly customerId: string;
  readonly branchId: string;
  readonly amountPesewas: number;
}

/** The fields of DEL's `del.CodCollected` FIN reads (migration 0305): the cash a driver took on delivery. */
interface CodCollectedPosting {
  readonly proofId: string;
  readonly deliveryId: string;
  readonly driverId: string;
  readonly driverName: string;
  readonly customerId: string | null;
  readonly branchId: string;
  readonly collectedPesewas: number;
}

/** The fields of DEL's `del.DriverCashRemitted` FIN reads (migration 0315): a driver's cash counted into a till. */
interface DriverCashRemittedPosting {
  readonly reconciliationId: string;
  readonly driverId: string;
  readonly driverName: string;
  readonly register: { readonly id: string; readonly code: string };
  readonly branchId: string;
  readonly expectedPesewas: number;
  readonly receivedPesewas: number;
  readonly shortPesewas: number;
  readonly overPesewas: number;
}

/** The fields of CAP's `cap.CapitalContributed` and `cap.CapitalWithdrawn` FIN reads (migration 0354). */
interface CapitalPosting {
  readonly transactionId: string;
  readonly investorId: string;
  readonly investorName: string;
  readonly bankAccountId: string;
  readonly branchId: string;
  readonly amountPesewas: number;
  readonly postingDate: string;
}

/** The fields of CAP's `cap.DistributionDeclared` FIN reads (migration 0354): each investor's line of the run. */
interface DistributionDeclaredPosting {
  readonly runId: string;
  readonly branchId: string;
  readonly lines: readonly {
    readonly investorId: string;
    readonly investorName: string;
    readonly allocatedPesewas: number;
    readonly withheldPesewas: number;
    readonly netPayablePesewas: number;
  }[];
}

/** The fields of CAP's `cap.DistributionPaid` FIN reads (migration 0354). */
interface DistributionPaidPosting {
  readonly paymentId: string;
  readonly runId: string;
  readonly investorId: string;
  readonly investorName: string;
  readonly bankAccountId: string;
  readonly branchId: string;
  readonly amountPesewas: number;
}

/** The fields of CAP's `cap.LoanDrawn` and `cap.GrantReceived` FIN reads (migration 0360, ADR-0101). */
interface FinancingDrawnPosting {
  readonly financingId: string;
  readonly lenderPartyId: string;
  readonly lenderName: string;
  readonly bankAccountId: string;
  readonly branchId: string;
  readonly amountPesewas: number;
  readonly postingDate: string;
}

/** The fields of CAP's `cap.InterestAccrued` and `cap.GrantRecognised` FIN reads (migration 0360). */
interface FinancingAccrualPosting {
  readonly accrualId: string;
  readonly financingId: string;
  readonly branchId: string;
  readonly amountPesewas: number;
  readonly postingDate: string;
}

/** The fields of CAP's `cap.LoanRepaid` FIN reads (migration 0360): interest first, then principal. */
interface LoanRepaidPosting {
  readonly repaymentId: string;
  readonly financingId: string;
  readonly lenderPartyId: string;
  readonly lenderName: string;
  readonly bankAccountId: string;
  readonly branchId: string;
  readonly principalPesewas: number;
  readonly interestPesewas: number;
  readonly postingDate: string;
}

/** POS's till events (migrations 0228 and 0281): one translator for all, each amount against the till's register. */
export const TILL_POSTING_EVENTS = ['pos.ShiftOpened', 'pos.CashDropped', 'pos.CashPaidIn', 'pos.CashPaidOut', 'pos.ShiftClosed', 'pos.ShiftLateEntryPosted'] as const;

interface TillPosting extends TillPostingFields {
  readonly shiftId: string;
  /** The shift for an open or a close, the cash movement for the rest: what posts once. */
  readonly subjectId: string;
  readonly branchId: string;
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
  // B12 continued 2 (migration 0364, ADR-0102): a share of a period's labour or overhead capitalised by CST.
  'inv.OverheadAbsorbed',
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
      ['inv.NegativeStockCosted', (tx, event) => this.negativeStock(tx, event.payload as unknown as NegativeStockPosting, 'costed')],
      ['inv.NegativeStockTrueUp', (tx, event) => this.negativeStock(tx, event.payload as unknown as NegativeStockPosting, 'trueUp')],
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
      ['pay.UnverifiedPaymentVerified', (tx, event) => this.unverifiedVerified(tx, event.payload as unknown as UnverifiedVerifiedPosting)],
      ['pay.PaymentReversed', async (_tx, event) => this.paymentReversed(event.payload as unknown as PaymentReversedPosting)],
      ['pay.ProviderSettled', (tx, event) => this.providerSettled(tx, event.payload as unknown as ProviderSettledPosting)],
      ['pay.UnidentifiedReceiptHeld', (tx, event) => this.unidentifiedReceipt(tx, event.payload as unknown as UnidentifiedReceiptPosting)],
      ...TILL_POSTING_EVENTS.map((code) => [code, async (_tx: Transaction, event: EventEnvelope) => this.till(event.payload as unknown as TillPosting)] as const),
      ['del.CodCollected', (tx, event) => this.codCollected(tx, event.payload as unknown as CodCollectedPosting)],
      ['del.DriverCashRemitted', async (_tx, event) => this.driverCashRemitted(event.payload as unknown as DriverCashRemittedPosting)],
      ['whl.BadDebtWrittenOff', (tx, event) => this.badDebt(tx, event.payload as unknown as BadDebtPosting)],
      ['cap.CapitalContributed', (tx, event) => this.capital(tx, event.payload as unknown as CapitalPosting)],
      ['cap.CapitalWithdrawn', (tx, event) => this.capital(tx, event.payload as unknown as CapitalPosting)],
      ['cap.DistributionDeclared', async (_tx, event) => this.distributionDeclared(event.payload as unknown as DistributionDeclaredPosting)],
      ['cap.DistributionPaid', (tx, event) => this.distributionPaid(tx, event.payload as unknown as DistributionPaidPosting)],
      ['cap.LoanDrawn', (tx, event) => this.financingDrawn(tx, event.payload as unknown as FinancingDrawnPosting)],
      ['cap.GrantReceived', (tx, event) => this.financingDrawn(tx, event.payload as unknown as FinancingDrawnPosting)],
      ['cap.InterestAccrued', async (_tx, event) => this.financingAccrual(event.payload as unknown as FinancingAccrualPosting)],
      ['cap.GrantRecognised', async (_tx, event) => this.financingAccrual(event.payload as unknown as FinancingAccrualPosting)],
      ['cap.LoanRepaid', (tx, event) => this.loanRepaid(tx, event.payload as unknown as LoanRepaidPosting)],
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

  /** INV's ◆ events for stock sold ahead of receipt (ADR-0081): by the product's GL group, once per subject. */
  private async negativeStock(tx: Transaction, payload: NegativeStockPosting, kind: 'costed' | 'trueUp'): Promise<Translated> {
    const product = (await this.refs.productsIn(tx, [payload.productId])).get(payload.productId);
    if (product === undefined) throw new Error(`negative stock ${payload.movementId ?? payload.trueUpMovementId}: product ${payload.productId} does not exist`);
    return kind === 'costed'
      ? { amounts: negativeStockCostedAmounts({ valuePesewas: payload.valuePesewas!, stockUnitId: payload.stockUnitId }, product.glGroup), sourceDocumentId: payload.sourceDocumentId, eventSubjectId: payload.movementId!, branchId: payload.branchId }
      : {
          amounts: negativeStockTrueUpAmounts({ clearedPesewas: payload.clearedPesewas!, trueUpPesewas: payload.trueUpPesewas!, stockUnitId: payload.stockUnitId }, product.glGroup),
          sourceDocumentId: payload.sourceDocumentId,
          eventSubjectId: payload.trueUpMovementId!,
          branchId: payload.branchId,
        };
  }

  /** `whl.BadDebtWrittenOff` (ADR-0003, ADR-0090): Dr 6940 the amount; Cr 1200 against the customer. */
  private async badDebt(tx: Transaction, payload: BadDebtPosting): Promise<Translated> {
    const customer = (await this.refs.customersIn(tx, [payload.customerId])).get(payload.customerId);
    return {
      amounts: [{ key: 'amount', amount: Money.fromJsonInteger(payload.amountPesewas), subledgers: [customerParty(payload.customerId, customer?.name ?? null)] }],
      sourceDocumentId: payload.writeOffId,
      eventSubjectId: payload.writeOffId,
      branchId: payload.branchId,
    };
  }

  /**
   * `cap.CapitalContributed` and `cap.CapitalWithdrawn` (ADR-0003, migration 0354): the amount between the farm's own
   * bank or mobile money account (1100 or 1110 by the account's kind, read here, never from the event) and 3000 against
   * the investor, on the posting date CAP names (the value date, or the ledger's first day before it, A-380).
   */
  private async capital(tx: Transaction, payload: CapitalPosting): Promise<Translated> {
    return {
      amounts: [await this.investorCash(tx, payload.bankAccountId, payload.investorId, payload.investorName, payload.amountPesewas)],
      sourceDocumentId: payload.transactionId,
      eventSubjectId: payload.transactionId,
      branchId: payload.branchId,
      postingDate: payload.postingDate,
    };
  }

  /** `cap.DistributionDeclared` (ADR-0003, ADR-0028): Dr 3300 each allocation and Cr 2300 each net payable against the investor, Cr 2310 what is withheld. */
  private distributionDeclared(payload: DistributionDeclaredPosting): Translated {
    const amounts: PostingAmount[] = [];
    for (const line of payload.lines) {
      const investor: SubledgerRef = { kind: 'INVESTOR', refId: line.investorId, displayName: line.investorName };
      amounts.push({ key: 'allocated', amount: Money.fromJsonInteger(line.allocatedPesewas), subledgers: [investor] });
      if (line.netPayablePesewas > 0) amounts.push({ key: 'netPayable', amount: Money.fromJsonInteger(line.netPayablePesewas), subledgers: [investor] });
      if (line.withheldPesewas > 0) amounts.push({ key: 'withheld', amount: Money.fromJsonInteger(line.withheldPesewas) });
    }
    return { amounts, sourceDocumentId: payload.runId, eventSubjectId: payload.runId, branchId: payload.branchId };
  }

  /** `cap.DistributionPaid` (ADR-0003): Dr 2300 against the investor, Cr the farm's bank or mobile money account. */
  private async distributionPaid(tx: Transaction, payload: DistributionPaidPosting): Promise<Translated> {
    return {
      amounts: [await this.investorCash(tx, payload.bankAccountId, payload.investorId, payload.investorName, payload.amountPesewas)],
      sourceDocumentId: payload.runId,
      eventSubjectId: payload.paymentId,
      branchId: payload.branchId,
    };
  }

  /**
   * `cap.LoanDrawn` and `cap.GrantReceived` (ADR-0003, ADR-0101): the money into the farm's own bank or mobile money
   * account (1100 or 1110 by its kind), against 2400 for the lender (an INVESTOR party) or 2450 deferred, on the start date.
   */
  private async financingDrawn(tx: Transaction, payload: FinancingDrawnPosting): Promise<Translated> {
    return {
      amounts: [await this.investorCash(tx, payload.bankAccountId, payload.lenderPartyId, payload.lenderName, payload.amountPesewas)],
      sourceDocumentId: payload.financingId,
      eventSubjectId: payload.financingId,
      branchId: payload.branchId,
      postingDate: payload.postingDate,
    };
  }

  /** `cap.InterestAccrued` (Dr 6930, Cr 2410) and `cap.GrantRecognised` (Dr 2450, Cr 4910), on the month's last day. */
  private financingAccrual(payload: FinancingAccrualPosting): Translated {
    return {
      amounts: [{ key: 'amount', amount: Money.fromJsonInteger(payload.amountPesewas) }],
      sourceDocumentId: payload.financingId,
      eventSubjectId: payload.accrualId,
      branchId: payload.branchId,
      postingDate: payload.postingDate,
    };
  }

  /** `cap.LoanRepaid` (ADR-0003): Dr 2400 the principal against the lender, Dr 2410 the interest, Cr the bank the total. */
  private async loanRepaid(tx: Transaction, payload: LoanRepaidPosting): Promise<Translated> {
    const lender: SubledgerRef = { kind: 'INVESTOR', refId: payload.lenderPartyId, displayName: payload.lenderName };
    const total = Money.fromJsonInteger(payload.principalPesewas).plus(Money.fromJsonInteger(payload.interestPesewas));
    const amounts: PostingAmount[] = [await this.investorCash(tx, payload.bankAccountId, payload.lenderPartyId, payload.lenderName, total.toJsonInteger())];
    if (payload.principalPesewas > 0) amounts.push({ key: 'principal', amount: Money.fromJsonInteger(payload.principalPesewas), subledgers: [lender] });
    if (payload.interestPesewas > 0) amounts.push({ key: 'interest', amount: Money.fromJsonInteger(payload.interestPesewas) });
    return { amounts, sourceDocumentId: payload.financingId, eventSubjectId: payload.repaymentId, branchId: payload.branchId, postingDate: payload.postingDate };
  }

  private async investorCash(tx: Transaction, bankAccountId: string, investorId: string, investorName: string, amountPesewas: number): Promise<PostingAmount> {
    const account = (await this.bankAccounts.payoutAccountsIn(tx, [bankAccountId])).get(bankAccountId);
    if (account === undefined) throw new Error(`bank account ${bankAccountId} does not exist`);
    return {
      key: 'amount',
      amount: Money.fromJsonInteger(amountPesewas),
      determinants: { PAYMENT_METHOD_KIND: account.kind },
      subledgers: [{ kind: 'INVESTOR', refId: investorId, displayName: investorName }, { kind: 'BANK_ACCOUNT', refId: account.id, displayName: account.name }],
    };
  }

  /** `del.CodCollected` (ADR-0003): Dr 1020 against the driver who holds the cash, Cr 1200 against the customer (A-339). */
  private async codCollected(tx: Transaction, payload: CodCollectedPosting): Promise<Translated> {
    const customer = payload.customerId === null ? undefined : (await this.refs.customersIn(tx, [payload.customerId])).get(payload.customerId);
    const driver: SubledgerRef = { kind: 'DRIVER', refId: payload.driverId, displayName: payload.driverName };
    return {
      amounts: [{ key: 'collected', amount: Money.fromJsonInteger(payload.collectedPesewas), subledgers: [driver, customerParty(payload.customerId, customer?.name ?? null)] }],
      sourceDocumentId: payload.deliveryId,
      eventSubjectId: payload.proofId,
      branchId: payload.branchId,
    };
  }

  /**
   * `del.DriverCashRemitted` (ADR-0003, ADR-0092): Dr 1000 against the till that counted it, Cr 1020 against the driver
   * for every collection handed in, the difference to 6900 (short a debit, over a credit), as a till's own close posts it.
   */
  private driverCashRemitted(payload: DriverCashRemittedPosting): Translated {
    const till: SubledgerRef = { kind: 'REGISTER', refId: payload.register.id, displayName: payload.register.code };
    const driver: SubledgerRef = { kind: 'DRIVER', refId: payload.driverId, displayName: payload.driverName };
    return {
      amounts: [
        { key: 'received', amount: Money.fromJsonInteger(payload.receivedPesewas), subledgers: [till] },
        { key: 'expected', amount: Money.fromJsonInteger(payload.expectedPesewas), subledgers: [driver] },
        { key: 'short', amount: Money.fromJsonInteger(payload.shortPesewas) },
        { key: 'over', amount: Money.fromJsonInteger(payload.overPesewas) },
      ],
      sourceDocumentId: payload.reconciliationId,
      eventSubjectId: payload.reconciliationId,
      branchId: payload.branchId,
    };
  }

  private till(payload: TillPosting): Translated {
    return { amounts: tillAmounts(payload), sourceDocumentId: payload.shiftId, eventSubjectId: payload.subjectId, branchId: payload.branchId };
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
    // A bank transfer lands in its bank account; an unverified offline mobile money tender is held in the wallet (OFFLINE_SYNC 9.9).
    const inAccount = payload.methodKind === 'BANK_TRANSFER' || (payload.unverified === true && payload.methodKind === 'MOBILE_MONEY');
    const bankAccount = payload.bankAccountId === undefined || payload.bankAccountId === null || !inAccount ? null : await this.bankAccounts.subledgerRefIn(tx, payload.bankAccountId);
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

  /** PAY's ◆ event (A-210, ADR-0066): a refund paid out of the deposit, or of receivables against a credit note, to the original tender or a bank payout. */
  private async refundPaid(tx: Transaction, payload: RefundPaidPosting): Promise<Translated> {
    const bankAccount = payload.bankAccountId === undefined || payload.bankAccountId === null || payload.methodKind !== 'BANK_TRANSFER' ? null : await this.bankAccounts.subledgerRefIn(tx, payload.bankAccountId);
    return {
      amounts: refundPaidAmounts(payload, await this.customerOf(tx, payload.customerId, `refund ${payload.refundId}`), bankAccount),
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
   * PAY's ◆ event (ADR-0003 Amendments, A-282): an unverified tender the provider confirmed, out of 1115 into the wallet
   * 1110 it was expected in, on the day it was verified; once per verification.
   */
  private async unverifiedVerified(tx: Transaction, payload: UnverifiedVerifiedPosting): Promise<Translated> {
    return {
      amounts: unverifiedVerifiedAmounts(payload, await this.bankAccounts.subledgerRefIn(tx, payload.bankAccountId)),
      sourceDocumentId: payload.paymentId,
      eventSubjectId: payload.verificationId,
      branchId: payload.branchId,
      postingDate: payload.verifiedOn,
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
  /** The credit note a refund draws on (Dr 1200), or null for a refund out of deposit (Dr 2200). */
  readonly creditNoteId?: string | null;
  /** The bank account a bank payout leaves from (tender `BANK_TRANSFER`). */
  readonly bankAccountId?: string | null;
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

/** The fields of INV's `inv.NegativeStockCosted` and `inv.NegativeStockTrueUp` FIN reads. */
interface NegativeStockPosting {
  readonly movementId?: string;
  readonly trueUpMovementId?: string;
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly branchId: string;
  readonly valuePesewas?: number;
  readonly clearedPesewas?: number;
  readonly trueUpPesewas?: number;
  readonly sourceDocumentId: string;
}

/** The fields of PAY's `pay.UnverifiedPaymentVerified` FIN reads. */
interface UnverifiedVerifiedPosting {
  readonly verificationId: string;
  readonly paymentId: string;
  readonly branchId: string;
  readonly bankAccountId: string;
  readonly amountPesewas: number;
  readonly verifiedOn: string;
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
