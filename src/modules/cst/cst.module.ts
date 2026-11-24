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
import { FinancialStatements, FinModule } from '../fin';
import { Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { InvModule, Stock, StockUnits } from '../inv';
import { Animals, Batches, LivModule } from '../liv';
import { MasterDataRefs, MdmModule } from '../mdm';
import { CostingProjections } from './application/costing-projections';
import { CostingReports } from './application/costing-reports';
import { COSTING_STORE, type CostingStore } from './application/costing-store';
import { OverheadAllocations } from './application/overhead-allocations';
import { PgCostingStore } from './infrastructure/pg-costing-store';
import { CostingController } from './interface/costing.controller';

/**
 * CST (layer 11): costing and profitability (ADR-0018, ADR-0102). It owns no cost of record: inventory holds the value of
 * stock. B12 continued 2 builds the labour and overhead allocation (`OverheadAllocations`, posted as value-only
 * movements through INV's `Stock`), the projections of cost by element, margin and loss facts maintained by an
 * asynchronous consumer over the published views and rebuilt by the same statements (`CostingProjections`, with the
 * nightly tie to the ledger), and the reads over them (`CostingReports`).
 */
@Module({
  imports: [IamModule, MdmModule, FinModule, InvModule, LivModule],
  controllers: [CostingController],
  providers: [
    { provide: COSTING_STORE, useClass: PgCostingStore },
    {
      provide: OverheadAllocations,
      useFactory: (
        uow: UnitOfWork,
        store: CostingStore,
        refs: MasterDataRefs,
        units: StockUnits,
        stock: Stock,
        animals: Animals,
        authoriser: Authoriser,
        names: PrincipalNames,
        registry: DocumentRegistry,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        cursors: Cursors,
        clock: Clock,
      ) => new OverheadAllocations(uow, store, refs, units, stock, animals, authoriser, names, registry, idempotency, audit, events, cursors, clock),
      inject: [UnitOfWork, COSTING_STORE, MasterDataRefs, StockUnits, Stock, Animals, Authoriser, PRINCIPAL_NAMES, DocumentRegistry, Idempotency, AuditTrail, DomainEvents, Cursors, CLOCK],
    },
    {
      provide: CostingReports,
      useFactory: (
        uow: UnitOfWork,
        store: CostingStore,
        refs: MasterDataRefs,
        units: StockUnits,
        batches: Batches,
        statements: FinancialStatements,
        authoriser: Authoriser,
        names: PrincipalNames,
        registry: DocumentRegistry,
        cursors: Cursors,
        clock: Clock,
      ) => new CostingReports(uow, store, refs, units, batches, statements, authoriser, names, registry, cursors, clock),
      inject: [UnitOfWork, COSTING_STORE, MasterDataRefs, StockUnits, Batches, FinancialStatements, Authoriser, PRINCIPAL_NAMES, DocumentRegistry, Cursors, CLOCK],
    },
    {
      provide: CostingProjections,
      useFactory: (uow: UnitOfWork, store: CostingStore, statements: FinancialStatements, events: DomainEvents, clock: Clock, logger: Logger) =>
        new CostingProjections(uow, store, statements, events, clock, logger),
      inject: [UnitOfWork, COSTING_STORE, FinancialStatements, DomainEvents, CLOCK, LOGGER],
    },
  ],
  exports: [OverheadAllocations, CostingReports, CostingProjections],
})
export class CstModule implements OnModuleInit {
  constructor(
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(CostingProjections) private readonly projections: CostingProjections,
  ) {}

  onModuleInit(): void {
    this.events.registerConsumer(this.projections.consumer);
  }
}
