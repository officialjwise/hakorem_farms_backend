import { createUuidV7Generator, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { AsyncConsumer, DomainEvents, EventEnvelope } from '../../../platform/events/domain-events';
import { STOCK_POSTING_EVENTS, type FinancialStatements } from '../../fin';
import { processingOrderCost, type ElementAmounts } from '../domain/cost-object';
import type { ProjectionDriftDetected } from '../events';
import type { CostingStore, ProcessingFlow } from './costing-store';

export const PROJECTION_DRIFT_DETECTED = 'cst.ProjectionDriftDetected';
const NEGATIVE_STOCK_EVENTS = ['inv.NegativeStockCosted', 'inv.NegativeStockTrueUp'] as const;
const BILLING_EVENTS = ['bil.InvoiceIssued', 'bil.CreditNoteIssued', 'bil.DebitNoteIssued'] as const;
const PROCESSING_EVENTS = ['prc.ProcessingOrderCompleted', 'prc.ProcessingOrderReversed'] as const;
/** The first day the ledger's rules are valid from (migration 0123): the nightly comparison covers everything since. */
const LEDGER_FROM = '2020-01-01';
const DAY_MS = 86_400_000;

/** Accounts FR-CST-004 ties the margin projection to: sales 4000 to 4030, less returns, variances and promotions. */
const SALES_ACCOUNTS = ['4000', '4010', '4020', '4030'];
const SALES_DEDUCTIONS = ['4200', '4210', '4220'];
const COST_OF_SALES_ACCOUNTS = ['5000', '5010', '5020', '5030'];

export interface DriftReport {
  readonly from: string;
  readonly to: string;
  readonly revenue: { readonly projected: bigint; readonly ledger: bigint };
  readonly costOfSales: { readonly projected: bigint; readonly ledger: bigint };
  readonly drifted: boolean;
}

/**
 * CST's projections (FR-CST-001, FR-CST-003, FR-CST-004, FR-CST-007, FR-CST-008, ADR-0023, ADR-0102). Each is written
 * only by CST's refresh functions in the database, which read the published views of INV, BIL, ORD and MDM, so the
 * asynchronous consumer and a rebuild run the same statements: the consumer for the keys an event names (a stock unit
 * and a movement, a billing document, a processing order), a rebuild for every key. The nightly comparison ties the
 * margin projection's net revenue and cost of sales to the ledger and, on any difference, publishes
 * `cst.ProjectionDriftDetected` and corrects nothing.
 */
export class CostingProjections {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: CostingStore,
    private readonly statements: FinancialStatements,
    private readonly events: DomainEvents,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** The asynchronous projector: one delivery per event, idempotent (a refresh replaces the rows of its keys). */
  readonly consumer: AsyncConsumer = {
    name: 'cst.costing-projections',
    eventTypes: [...STOCK_POSTING_EVENTS, ...NEGATIVE_STOCK_EVENTS, ...BILLING_EVENTS, ...PROCESSING_EVENTS],
    isolation: 'read committed',
    handle: (tx, event) => this.project(tx, event),
  };

  private async project(tx: Transaction, event: EventEnvelope): Promise<void> {
    const p = event.payload as Record<string, unknown>;
    if ((BILLING_EVENTS as readonly string[]).includes(event.type)) {
      await this.store.refreshMarginRevenue(tx, [p['billingDocumentId'] as string]);
    } else if ((PROCESSING_EVENTS as readonly string[]).includes(event.type)) {
      await this.refreshProcessingOrdersIn(tx, [p['processingOrderId'] as string]);
    } else if (event.type === 'inv.NegativeStockCosted') {
      await this.store.refreshMarginCost(tx, [p['movementId'] as string]);
    } else if (event.type === 'inv.NegativeStockTrueUp') {
      await this.store.refreshMarginCost(tx, [p['trueUpMovementId'] as string]);
    } else {
      const movementId = p['movementId'] as string;
      const stockUnitId = (p['stockUnitId'] as string | null) ?? null;
      if (stockUnitId !== null) await this.store.refreshUnits(tx, [stockUnitId]);
      await this.store.refreshMarginCost(tx, [movementId]);
      await this.store.refreshLosses(tx, [movementId]);
    }
  }

  /** Every projection rebuilt from the published views (FR-CST-008), in one transaction: the same figures each time. */
  rebuild(): Promise<{ readonly units: number; readonly processingOrders: number; readonly marginFacts: number; readonly lossFacts: number }> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const units = await this.store.refreshUnits(tx, null);
      const processingOrders = await this.refreshProcessingOrdersIn(tx, null);
      const marginFacts = (await this.store.refreshMarginRevenue(tx, null)) + (await this.store.refreshMarginCost(tx, null));
      const lossFacts = await this.store.refreshLosses(tx, null);
      return { units, processingOrders, marginFacts, lossFacts };
    });
  }

  /**
   * A processing order's cost by element (FR-CST-001): its inputs' units refreshed first, then each consumed unit's
   * signed value split by that unit's elements, plus the outputs' value less the inputs' as its direct processing cost.
   */
  async refreshProcessingOrdersIn(tx: Transaction, orderIds: readonly string[] | null): Promise<number> {
    const flows = await this.store.processingFlows(tx, orderIds);
    const unitIds = [...new Set(flows.flatMap((f) => (f.stockUnitId === null ? [] : [f.stockUnitId])))];
    if (orderIds !== null) await this.store.refreshUnits(tx, unitIds);
    const units = new Map((await this.store.summaries(tx, 'STOCK_UNIT', unitIds)).map((s) => [s.objectId, s.elements] as const));
    const orders = new Map<string, ProcessingFlow[]>();
    for (const f of flows) orders.set(f.orderId, [...(orders.get(f.orderId) ?? []), f]);
    const none: ElementAmounts = { PURCHASE: 0n, FEED: 0n, VETERINARY: 0n, LABOUR: 0n, OVERHEAD: 0n, PROCESSING: 0n };
    const rows = [...orders.entries()].map(([orderId, list]) => ({
      objectId: orderId,
      branchId: list[0]!.branchId,
      elements: processingOrderCost(
        list.filter((f) => f.kind === 'CONSUME').map((f) => ({ consumed: f.signedValue, unit: (f.stockUnitId === null ? undefined : units.get(f.stockUnitId)) ?? none })),
        list.filter((f) => f.kind === 'OUTPUT').reduce((sum, f) => sum + f.signedValue, 0n),
      ),
    }));
    return this.store.putProcessingOrders(tx, orderIds, rows);
  }

  /**
   * FR-CST-004: the margin projection's net revenue and cost of sales against the ledger for the same dates: sales
   * 4000 to 4030 less 4200, 4210 and 4220, and cost of sales 5000 to 5030, closing entries left out. A difference
   * publishes `cst.ProjectionDriftDetected` with both figures and is logged; nothing is corrected.
   */
  async compareWithLedger(range: { readonly from: string; readonly to: string }): Promise<DriftReport> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const projected = await this.store.marginTotals(tx, { from: range.from, to: range.to, branchIds: null });
      const ledger = await this.statements.tradedNetDebitsIn(tx, { from: range.from, to: range.to, branchId: null });
      const net = (codes: readonly string[]) => codes.reduce((sum, code) => sum + (ledger.get(code)?.netDebit ?? 0n), 0n);
      const report: DriftReport = {
        from: range.from,
        to: range.to,
        revenue: { projected: projected.revenueSales - projected.revenueCredits, ledger: -net(SALES_ACCOUNTS) - net(SALES_DEDUCTIONS) },
        costOfSales: { projected: projected.costSales - projected.costCredits, ledger: net(COST_OF_SALES_ACCOUNTS) },
        drifted: false,
      };
      const drifted = report.revenue.projected !== report.revenue.ledger || report.costOfSales.projected !== report.costOfSales.ledger;
      if (drifted) {
        const id = this.nextId();
        const payload: ProjectionDriftDetected = {
          projection: 'cst.margin_fact',
          from: range.from,
          to: range.to,
          revenueProjectedPesewas: report.revenue.projected.toString(),
          revenueLedgerPesewas: report.revenue.ledger.toString(),
          costOfSalesProjectedPesewas: report.costOfSales.projected.toString(),
          costOfSalesLedgerPesewas: report.costOfSales.ledger.toString(),
        };
        await this.events.publish<ProjectionDriftDetected>(tx, { type: PROJECTION_DRIFT_DETECTED, subjectType: 'CostingProjection', subjectId: id, occurredAt: this.clock.now(), payload });
        this.logger.error({ ...payload }, 'the margin projection does not tie to the ledger: nothing was corrected');
      }
      return { ...report, drifted };
    });
  }

  /** The nightly job: everything the ledger holds up to yesterday, Africa/Accra (ADR-0067: from the clock). */
  async nightly(): Promise<{ readonly drifted: boolean }> {
    const today = toBusinessDate(this.clock.now());
    const to = new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
    return { drifted: (await this.compareWithLedger({ from: LEDGER_FROM, to })).drifted };
  }
}
