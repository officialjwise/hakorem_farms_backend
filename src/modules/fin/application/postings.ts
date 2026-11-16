import { toBusinessDate, type Clock } from '@hakorem/kernel';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { DomainEvents, EventEnvelope } from '../../../platform/events/domain-events';
import type { MasterDataRefs } from '../../mdm';
import { manualPostingAmounts } from '../domain/manual-journal';
import type { ManualJournalApproved } from '../events';
import {
  stockMovementAmounts,
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
      ['fin.ManualJournalApproved', (tx, event) => this.manualJournal(tx, event.payload as unknown as ManualJournalApproved)],
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

  private async payment(tx: Transaction, payload: PaymentPosting): Promise<Translated> {
    return {
      amounts: supplierPaymentAmounts(payload, await this.supplier(tx, payload.supplierId)),
      sourceDocumentId: payload.supplierPaymentId,
      eventSubjectId: payload.supplierPaymentId,
    };
  }
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
}
