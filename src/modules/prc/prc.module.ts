import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK } from '../../platform/platform.module';
import { Approvals, Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { InvModule, Lineage, Stock, StockMovements, StockUnits } from '../inv';
import { MasterDataRefs, MdmModule, PricingService } from '../mdm';
import { Packs } from './application/packs';
import { Processing, PROCESSING_REVERSAL } from './application/processing';
import { PROCESSING_STORE, type ProcessingStore } from './application/processing-store';
import { YieldStandards } from './application/yield-standards';
import { PgProcessingStore } from './infrastructure/pg-processing-store';
import { PacksController } from './interface/packs.controller';
import { ProcessingController } from './interface/processing.controller';

/**
 * PRC (layer 6): processing and production. B6 builds processing orders, with the cost of the input animals and the
 * direct cost split across the output lots by relative sales value, and yield standards. Stock moves only through
 * INV's `Stock`, `StockUnits` and `Lineage`; PRC does not import LIV (MODULE_BOUNDARIES, PRC card). B06 continued 3
 * adds packs and their labels (`Packs`) and the reversing order; B06r puts the reversal under approval.
 */
@Module({
  imports: [IamModule, MdmModule, InvModule],
  controllers: [ProcessingController, PacksController],
  providers: [
    { provide: PROCESSING_STORE, useClass: PgProcessingStore },
    {
      provide: Processing,
      useFactory: (
        uow: UnitOfWork,
        store: ProcessingStore,
        refs: MasterDataRefs,
        pricing: PricingService,
        units: StockUnits,
        stock: Stock,
        lineage: Lineage,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        documents: DocumentRegistry,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
        movements: StockMovements,
        approvals: Approvals,
      ) => new Processing(uow, store, refs, pricing, units, stock, lineage, authoriser, idempotency, audit, events, documents, principals, cursors, clock, movements, approvals),
      inject: [UnitOfWork, PROCESSING_STORE, MasterDataRefs, PricingService, StockUnits, Stock, Lineage, Authoriser, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, PRINCIPAL_NAMES, Cursors, CLOCK, StockMovements, Approvals],
    },
    {
      provide: YieldStandards,
      useFactory: (uow: UnitOfWork, store: ProcessingStore, refs: MasterDataRefs, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, cursors: Cursors, clock: Clock) =>
        new YieldStandards(uow, store, refs, authoriser, idempotency, audit, cursors, clock),
      inject: [UnitOfWork, PROCESSING_STORE, MasterDataRefs, Authoriser, Idempotency, AuditTrail, Cursors, CLOCK],
    },
    {
      provide: Packs,
      useFactory: (uow: UnitOfWork, store: ProcessingStore, refs: MasterDataRefs, units: StockUnits, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, cursors: Cursors, clock: Clock) =>
        new Packs(uow, store, refs, units, authoriser, idempotency, audit, cursors, clock),
      inject: [UnitOfWork, PROCESSING_STORE, MasterDataRefs, StockUnits, Authoriser, Idempotency, AuditTrail, Cursors, CLOCK],
    },
  ],
  exports: [Processing, YieldStandards, Packs],
})
export class PrcModule implements OnModuleInit {
  constructor(
    @Inject(Approvals) private readonly approvals: Approvals,
    @Inject(Processing) private readonly processing: Processing,
  ) {}

  /** A reversal at or above the adjustment threshold waits for a different approver (ADR-0017, ADR-0048 pattern; B06r). */
  onModuleInit(): void {
    this.approvals.registerHandler(PROCESSING_REVERSAL, this.processing);
  }
}
