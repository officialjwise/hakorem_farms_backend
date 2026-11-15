import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK } from '../../platform/platform.module';
import { FileStore } from '../../platform/storage/file-store';
import { Approvals, Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { InvModule, Stock, StockHolds, StockUnits } from '../inv';
import { MasterDataRefs, MdmModule, PricingService } from '../mdm';
import { Animals, FOLLOWED_EVENTS } from './application/animals';
import { Feeding } from './application/feeding';
import { HealthRecords } from './application/health';
import { LIVESTOCK_STORE, type LivestockStore } from './application/livestock-store';
import { MORTALITY_WRITE_OFF, MortalityRecords } from './application/mortality';
import { CostSpreader } from './application/spread';
import { Weighing } from './application/weights';
import { PgLivestockStore } from './infrastructure/pg-livestock-store';
import { LivestockController } from './interface/livestock.controller';

/**
 * LIV (layer 6): livestock management. B06 continued builds the animal register, which follows each animal's stock
 * unit through INV's events in their own transactions, weights, health events with withdrawal holds and veterinary
 * cost, mortality and culls with the second approver, rations and feed with the head-days spread. Stock, holds and cost
 * move only through INV's `Stock`, `StockHolds` and `StockUnits`; batches and breeding are B06 continued 2's.
 */
@Module({
  imports: [IamModule, MdmModule, InvModule],
  controllers: [LivestockController],
  providers: [
    { provide: LIVESTOCK_STORE, useClass: PgLivestockStore },
    {
      provide: CostSpreader,
      useFactory: (store: LivestockStore, refs: MasterDataRefs, units: StockUnits, stock: Stock) => new CostSpreader(store, refs, units, stock),
      inject: [LIVESTOCK_STORE, MasterDataRefs, StockUnits, Stock],
    },
    {
      provide: Animals,
      useFactory: (uow: UnitOfWork, store: LivestockStore, refs: MasterDataRefs, units: StockUnits, pricing: PricingService, authoriser: Authoriser, events: DomainEvents, audit: AuditTrail, cursors: Cursors, clock: Clock) =>
        new Animals(uow, store, refs, units, pricing, authoriser, events, audit, cursors, clock),
      inject: [UnitOfWork, LIVESTOCK_STORE, MasterDataRefs, StockUnits, PricingService, Authoriser, DomainEvents, AuditTrail, Cursors, CLOCK],
    },
    {
      provide: Weighing,
      useFactory: (uow: UnitOfWork, store: LivestockStore, refs: MasterDataRefs, units: StockUnits, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, events: DomainEvents, principals: PrincipalNames, cursors: Cursors, clock: Clock) =>
        new Weighing(uow, store, refs, units, authoriser, idempotency, audit, events, principals, cursors, clock),
      inject: [UnitOfWork, LIVESTOCK_STORE, MasterDataRefs, StockUnits, Authoriser, Idempotency, AuditTrail, DomainEvents, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: HealthRecords,
      useFactory: (
        uow: UnitOfWork,
        store: LivestockStore,
        refs: MasterDataRefs,
        units: StockUnits,
        stock: Stock,
        holds: StockHolds,
        spreader: CostSpreader,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        documents: DocumentRegistry,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new HealthRecords(uow, store, refs, units, stock, holds, spreader, authoriser, idempotency, audit, events, documents, principals, cursors, clock),
      inject: [UnitOfWork, LIVESTOCK_STORE, MasterDataRefs, StockUnits, Stock, StockHolds, CostSpreader, Authoriser, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: MortalityRecords,
      useFactory: (
        uow: UnitOfWork,
        store: LivestockStore,
        refs: MasterDataRefs,
        units: StockUnits,
        stock: Stock,
        approvals: Approvals,
        files: FileStore,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        documents: DocumentRegistry,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new MortalityRecords(uow, store, refs, units, stock, approvals, files, authoriser, idempotency, audit, events, documents, principals, cursors, clock),
      inject: [UnitOfWork, LIVESTOCK_STORE, MasterDataRefs, StockUnits, Stock, Approvals, FileStore, Authoriser, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: Feeding,
      useFactory: (
        uow: UnitOfWork,
        store: LivestockStore,
        refs: MasterDataRefs,
        units: StockUnits,
        stock: Stock,
        spreader: CostSpreader,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        documents: DocumentRegistry,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new Feeding(uow, store, refs, units, stock, spreader, authoriser, idempotency, audit, events, documents, principals, cursors, clock),
      inject: [UnitOfWork, LIVESTOCK_STORE, MasterDataRefs, StockUnits, Stock, CostSpreader, Authoriser, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
  ],
  exports: [Animals, Weighing, HealthRecords, MortalityRecords, Feeding],
})
export class LivModule implements OnModuleInit {
  constructor(
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(Approvals) private readonly approvals: Approvals,
    @Inject(Animals) private readonly animals: Animals,
    @Inject(MortalityRecords) private readonly mortality: MortalityRecords,
  ) {}

  /**
   * Keeps the register in step with inventory (ADR-0010: a module keeping its own aggregate consistent with a lower
   * module's fact subscribes in the publisher's transaction), and registers the mortality write-off's approval handler
   * (ADR-0017).
   */
  onModuleInit(): void {
    this.events.subscribeInTransaction('inv.StockUnitRegistered', this.animals.register);
    for (const type of FOLLOWED_EVENTS) this.events.subscribeInTransaction(type, this.animals.follow);
    this.approvals.registerHandler(MORTALITY_WRITE_OFF, this.mortality);
  }
}
