import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK, LOGGER } from '../../platform/platform.module';
import { Approvals, Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { MasterDataRefs, MdmModule } from '../mdm';
import { GOODS_RECEIPT_STORE, type GoodsReceiptStore } from './application/goods-receipt-store';
import { GoodsReceipts } from './application/goods-receipts';
import { Lineage } from './application/lineage';
import { BalanceReconciliation } from './application/reconciliation';
import { Stock } from './application/stock';
import { STOCK_DOCUMENTS_STORE, type StockDocumentsStore } from './application/stock-documents-store';
import { STOCK_WRITE_OFF, StockAdjustments } from './application/stock-adjustments';
import { STOCK_REVERSAL, StockMovements } from './application/stock-movements';
import { StockQueries } from './application/stock-queries';
import { StockTransfers } from './application/stock-transfers';
import { STOCK_TAKE_STORE, type StockTakeStore } from './application/stock-take-store';
import { StockTakes } from './application/stock-takes';
import { STOCK_HOLD_STORE, type StockHoldStore } from './application/stock-hold-store';
import { StockHolds } from './application/stock-holds';
import { StockWriteOffs } from './application/stock-write-offs';
import { STOCK_READ_STORE, type StockReadStore } from './application/stock-read-store';
import { STOCK_STORE, type StockStore } from './application/stock-store';
import { PgGoodsReceiptStore } from './infrastructure/pg-goods-receipt-store';
import { PgStockDocumentsStore } from './infrastructure/pg-stock-documents-store';
import { PgStockReadStore } from './infrastructure/pg-stock-read-store';
import { PgStockStore } from './infrastructure/pg-stock-store';
import { PgStockTakeStore } from './infrastructure/pg-stock-take-store';
import { PgStockHoldStore } from './infrastructure/pg-stock-hold-store';
import { GoodsReceiptsController } from './interface/goods-receipts.controller';
import { StockControlController } from './interface/stock-control.controller';
import { StockController } from './interface/stock.controller';
import { StockTakesController } from './interface/stock-takes.controller';
import { StockHoldsController } from './interface/stock-holds.controller';
import { StockExceptionsController } from './interface/stock-exceptions.controller';
import { STOCK_EXCEPTION_STORE, type StockExceptionStore } from './application/stock-exception-store';
import { StockExceptions } from './application/stock-exceptions';
import { PgStockExceptionStore } from './infrastructure/pg-stock-exception-store';
import { StockReservationsController } from './interface/stock-reservations.controller';
import { STOCK_RESERVATION_STORE, type StockReservationStore } from './application/stock-reservation-store';
import { ReservationExpiry, Reservations } from './application/reservations';
import { PgStockReservationStore } from './infrastructure/pg-stock-reservation-store';

/**
 * INV (layer 5): the stock movement ledger (ADR-0002) whose invariants live in migration 0044's triggers, the
 * in-transaction `Stock.postIn` other modules post through, lineage and its trace, and the nightly balance
 * recompute (B5); goods receipts, stock on hand at cost, stock units and the trace over HTTP (B05 continued); the
 * movement reads and reversal, transfers and adjustments, and their two approval handlers (B05 continued 2); stock takes
 * and cycle counts, and holds with the in-process `StockHolds.placeIn` LIV calls (B05 continued 3); reservations with
 * their expiry job, the exception queue with the held transfer variance, availability and the stock unit list
 * (B05 continued 3b).
 */
@Module({
  imports: [IamModule, MdmModule],
  controllers: [GoodsReceiptsController, StockController, StockControlController, StockTakesController, StockHoldsController, StockExceptionsController, StockReservationsController],
  providers: [
    { provide: STOCK_STORE, useClass: PgStockStore },
    { provide: GOODS_RECEIPT_STORE, useClass: PgGoodsReceiptStore },
    { provide: STOCK_READ_STORE, useClass: PgStockReadStore },
    { provide: STOCK_DOCUMENTS_STORE, useClass: PgStockDocumentsStore },
    { provide: STOCK_TAKE_STORE, useClass: PgStockTakeStore },
    { provide: STOCK_HOLD_STORE, useClass: PgStockHoldStore },
    { provide: STOCK_EXCEPTION_STORE, useClass: PgStockExceptionStore },
    { provide: STOCK_RESERVATION_STORE, useClass: PgStockReservationStore },
    {
      provide: Reservations,
      useFactory: (
        uow: UnitOfWork,
        store: StockReservationStore,
        documentsStore: StockDocumentsStore,
        refs: MasterDataRefs,
        stock: Stock,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        documents: DocumentRegistry,
        cursors: Cursors,
        clock: Clock,
      ) => new Reservations(uow, store, documentsStore, refs, stock, authoriser, idempotency, audit, events, documents, cursors, clock),
      inject: [UnitOfWork, STOCK_RESERVATION_STORE, STOCK_DOCUMENTS_STORE, MasterDataRefs, Stock, Authoriser, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, Cursors, CLOCK],
    },
    {
      provide: ReservationExpiry,
      useFactory: (uow: UnitOfWork, store: StockReservationStore, reservations: Reservations, clock: Clock) => new ReservationExpiry(uow, store, reservations, clock),
      inject: [UnitOfWork, STOCK_RESERVATION_STORE, Reservations, CLOCK],
    },
    {
      provide: Stock,
      useFactory: (store: StockStore, events: DomainEvents, clock: Clock) => new Stock(store, events, clock),
      inject: [STOCK_STORE, DomainEvents, CLOCK],
    },
    {
      provide: Lineage,
      useFactory: (uow: UnitOfWork, store: StockStore, authoriser: Authoriser) => new Lineage(uow, store, authoriser),
      inject: [UnitOfWork, STOCK_STORE, Authoriser],
    },
    {
      provide: BalanceReconciliation,
      useFactory: (uow: UnitOfWork, store: StockStore, events: DomainEvents, logger: Logger) => new BalanceReconciliation(uow, store, events, logger),
      inject: [UnitOfWork, STOCK_STORE, DomainEvents, LOGGER],
    },
    {
      provide: GoodsReceipts,
      useFactory: (
        uow: UnitOfWork,
        store: GoodsReceiptStore,
        refs: MasterDataRefs,
        stock: Stock,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        documents: DocumentRegistry,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new GoodsReceipts(uow, store, refs, stock, authoriser, idempotency, audit, events, documents, principals, cursors, clock),
      inject: [UnitOfWork, GOODS_RECEIPT_STORE, MasterDataRefs, Stock, Authoriser, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: StockQueries,
      useFactory: (uow: UnitOfWork, store: StockReadStore, refs: MasterDataRefs, lineage: Lineage, authoriser: Authoriser, documents: DocumentRegistry, cursors: Cursors, clock: Clock) =>
        new StockQueries(uow, store, refs, lineage, authoriser, documents, cursors, clock),
      inject: [UnitOfWork, STOCK_READ_STORE, MasterDataRefs, Lineage, Authoriser, DocumentRegistry, Cursors, CLOCK],
    },
    {
      provide: StockMovements,
      useFactory: (
        uow: UnitOfWork,
        store: StockDocumentsStore,
        refs: MasterDataRefs,
        stock: Stock,
        authoriser: Authoriser,
        approvals: Approvals,
        idempotency: Idempotency,
        audit: AuditTrail,
        documents: DocumentRegistry,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new StockMovements(uow, store, refs, stock, authoriser, approvals, idempotency, audit, documents, principals, cursors, clock),
      inject: [UnitOfWork, STOCK_DOCUMENTS_STORE, MasterDataRefs, Stock, Authoriser, Approvals, Idempotency, AuditTrail, DocumentRegistry, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: StockAdjustments,
      useFactory: (
        uow: UnitOfWork,
        store: StockDocumentsStore,
        refs: MasterDataRefs,
        stock: Stock,
        authoriser: Authoriser,
        approvals: Approvals,
        idempotency: Idempotency,
        audit: AuditTrail,
        documents: DocumentRegistry,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new StockAdjustments(uow, store, refs, stock, authoriser, approvals, idempotency, audit, documents, principals, cursors, clock),
      inject: [UnitOfWork, STOCK_DOCUMENTS_STORE, MasterDataRefs, Stock, Authoriser, Approvals, Idempotency, AuditTrail, DocumentRegistry, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: StockTransfers,
      useFactory: (
        uow: UnitOfWork,
        store: StockDocumentsStore,
        refs: MasterDataRefs,
        stock: Stock,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        documents: DocumentRegistry,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new StockTransfers(uow, store, refs, stock, authoriser, idempotency, audit, documents, principals, cursors, clock),
      inject: [UnitOfWork, STOCK_DOCUMENTS_STORE, MasterDataRefs, Stock, Authoriser, Idempotency, AuditTrail, DocumentRegistry, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: StockTakes,
      useFactory: (
        uow: UnitOfWork,
        store: StockTakeStore,
        documentsStore: StockDocumentsStore,
        refs: MasterDataRefs,
        stock: Stock,
        authoriser: Authoriser,
        approvals: Approvals,
        idempotency: Idempotency,
        audit: AuditTrail,
        documents: DocumentRegistry,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new StockTakes(uow, store, documentsStore, refs, stock, authoriser, approvals, idempotency, audit, documents, principals, cursors, clock),
      inject: [UnitOfWork, STOCK_TAKE_STORE, STOCK_DOCUMENTS_STORE, MasterDataRefs, Stock, Authoriser, Approvals, Idempotency, AuditTrail, DocumentRegistry, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: StockHolds,
      useFactory: (
        uow: UnitOfWork,
        store: StockHoldStore,
        documentsStore: StockDocumentsStore,
        refs: MasterDataRefs,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        documents: DocumentRegistry,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new StockHolds(uow, store, documentsStore, refs, authoriser, idempotency, audit, documents, principals, cursors, clock),
      inject: [UnitOfWork, STOCK_HOLD_STORE, STOCK_DOCUMENTS_STORE, MasterDataRefs, Authoriser, Idempotency, AuditTrail, DocumentRegistry, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: StockExceptions,
      useFactory: (
        uow: UnitOfWork,
        store: StockExceptionStore,
        documentsStore: StockDocumentsStore,
        refs: MasterDataRefs,
        adjustments: StockAdjustments,
        stock: Stock,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        documents: DocumentRegistry,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new StockExceptions(uow, store, documentsStore, refs, adjustments, stock, authoriser, idempotency, audit, documents, principals, cursors, clock),
      inject: [UnitOfWork, STOCK_EXCEPTION_STORE, STOCK_DOCUMENTS_STORE, MasterDataRefs, StockAdjustments, Stock, Authoriser, Idempotency, AuditTrail, DocumentRegistry, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
  ],
  exports: [Stock, Lineage, BalanceReconciliation, GoodsReceipts, StockQueries, StockMovements, StockTransfers, StockAdjustments, StockTakes, StockHolds, StockExceptions, Reservations, ReservationExpiry],
})
export class InvModule implements OnModuleInit {
  constructor(
    @Inject(Approvals) private readonly approvals: Approvals,
    @Inject(StockAdjustments) private readonly adjustments: StockAdjustments,
    @Inject(StockMovements) private readonly movements: StockMovements,
    @Inject(StockTakes) private readonly takes: StockTakes,
    @Inject(DocumentRegistry) private readonly documents: DocumentRegistry,
  ) {}

  /**
   * Registers INV's approval handlers (ADR-0017): a stock write-off (an adjustment, or a stock take's variances, told
   * apart by the subject's document type) and a movement reversal.
   */
  onModuleInit(): void {
    this.approvals.registerHandler(STOCK_WRITE_OFF, new StockWriteOffs(this.documents, { STOCK_ADJUSTMENT: this.adjustments, STOCK_TAKE: this.takes }));
    this.approvals.registerHandler(STOCK_REVERSAL, this.movements);
  }
}
