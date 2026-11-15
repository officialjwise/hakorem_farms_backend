import { Module } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK, LOGGER } from '../../platform/platform.module';
import { Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { MasterDataRefs, MdmModule } from '../mdm';
import { GOODS_RECEIPT_STORE, type GoodsReceiptStore } from './application/goods-receipt-store';
import { GoodsReceipts } from './application/goods-receipts';
import { Lineage } from './application/lineage';
import { BalanceReconciliation } from './application/reconciliation';
import { Stock } from './application/stock';
import { StockQueries } from './application/stock-queries';
import { STOCK_READ_STORE, type StockReadStore } from './application/stock-read-store';
import { STOCK_STORE, type StockStore } from './application/stock-store';
import { PgGoodsReceiptStore } from './infrastructure/pg-goods-receipt-store';
import { PgStockReadStore } from './infrastructure/pg-stock-read-store';
import { PgStockStore } from './infrastructure/pg-stock-store';
import { GoodsReceiptsController } from './interface/goods-receipts.controller';
import { StockController } from './interface/stock.controller';

/**
 * INV (layer 5): the stock movement ledger (ADR-0002) whose invariants live in migration 0044's triggers, the
 * in-transaction `Stock.postIn` other modules post through, lineage and its trace, and the nightly balance
 * recompute (B5); goods receipts, stock on hand at cost, stock units and the trace over HTTP (B05 continued).
 */
@Module({
  imports: [IamModule, MdmModule],
  controllers: [GoodsReceiptsController, StockController],
  providers: [
    { provide: STOCK_STORE, useClass: PgStockStore },
    { provide: GOODS_RECEIPT_STORE, useClass: PgGoodsReceiptStore },
    { provide: STOCK_READ_STORE, useClass: PgStockReadStore },
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
  ],
  exports: [Stock, Lineage, BalanceReconciliation, GoodsReceipts, StockQueries],
})
export class InvModule {}
