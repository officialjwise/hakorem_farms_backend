import { Module } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DomainEvents } from '../../platform/events/domain-events';
import { CLOCK, LOGGER } from '../../platform/platform.module';
import { Authoriser, IamModule } from '../iam';
import { Lineage } from './application/lineage';
import { BalanceReconciliation } from './application/reconciliation';
import { Stock } from './application/stock';
import { STOCK_STORE, type StockStore } from './application/stock-store';
import { PgStockStore } from './infrastructure/pg-stock-store';

/**
 * INV (layer 5): from B5, the stock movement ledger (ADR-0002) whose invariants live in migration 0044's triggers,
 * the in-transaction `Stock.postIn` other modules post through, lineage and its trace, and the nightly balance
 * recompute. The stock documents, their endpoints and the opening stock sheet arrive in B5 continued.
 */
@Module({
  imports: [IamModule],
  providers: [
    { provide: STOCK_STORE, useClass: PgStockStore },
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
  ],
  exports: [Stock, Lineage, BalanceReconciliation],
})
export class InvModule {}
