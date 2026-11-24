import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import { AuditFindings } from '../../platform/audit/audit-findings';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { DomainEvents } from '../../platform/events/domain-events';
import { OutboxHistory } from '../../platform/events/outbox-history';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK } from '../../platform/platform.module';
import { Settings } from '../../platform/settings/settings';
import { Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { MasterDataRefs, MdmModule } from '../mdm';
import { PurchaseOrders, PurModule } from '../pur';
import { DASHBOARD_STORE, type DashboardStore } from './application/dashboard-store';
import { Dashboards } from './application/dashboards';
import { ExceptionProjector } from './application/exception-projector';
import { ExceptionReports } from './application/exception-reports';
import { EXCEPTION_STORE, type ExceptionStore } from './application/exception-store';
import { ExceptionSweep } from './application/exception-sweep';
import { PgDashboardStore } from './infrastructure/pg-dashboard-store';
import { PgExceptionStore } from './infrastructure/pg-exception-store';
import { DashboardController } from './interface/dashboard.controller';
import { ExceptionsController } from './interface/exceptions.controller';

/**
 * RPT (layer 11): reporting and dashboards. B05x builds the owner dashboard and the tiles whose data exists, each
 * read from other modules' published views only (ADR-0011, ADR-0023). B12 continued 3 builds the reporting schema's
 * first read model, the daily exception report (ADR-0103): the projector over the outbox (`ExceptionProjector`), the
 * sweep of the records that raise items without an event (`ExceptionSweep`) and the report, its items and their
 * reviews (`ExceptionReports`). Report definitions, runs, schedules, exports and the dashboard's move are B12
 * continued 4's.
 */
@Module({
  imports: [IamModule, MdmModule, PurModule],
  controllers: [DashboardController, ExceptionsController],
  providers: [
    { provide: DASHBOARD_STORE, useClass: PgDashboardStore },
    { provide: EXCEPTION_STORE, useClass: PgExceptionStore },
    { provide: AuditFindings, useFactory: () => new AuditFindings() },
    { provide: OutboxHistory, useFactory: () => new OutboxHistory() },
    {
      provide: Dashboards,
      useFactory: (uow: UnitOfWork, store: DashboardStore, authoriser: Authoriser, clock: Clock) => new Dashboards(uow, store, authoriser, clock),
      inject: [UnitOfWork, DASHBOARD_STORE, Authoriser, CLOCK],
    },
    {
      provide: ExceptionProjector,
      useFactory: (uow: UnitOfWork, store: ExceptionStore, refs: MasterDataRefs, history: OutboxHistory, clock: Clock, settings: Settings) => new ExceptionProjector(uow, store, refs, history, clock, settings),
      inject: [UnitOfWork, EXCEPTION_STORE, MasterDataRefs, OutboxHistory, CLOCK, Settings],
    },
    {
      provide: ExceptionSweep,
      useFactory: (uow: UnitOfWork, store: ExceptionStore, projector: ExceptionProjector, findings: AuditFindings, orders: PurchaseOrders, refs: MasterDataRefs, clock: Clock) =>
        new ExceptionSweep(uow, store, projector, findings, orders, refs, clock),
      inject: [UnitOfWork, EXCEPTION_STORE, ExceptionProjector, AuditFindings, PurchaseOrders, MasterDataRefs, CLOCK],
    },
    {
      provide: ExceptionReports,
      useFactory: (
        uow: UnitOfWork,
        store: ExceptionStore,
        authoriser: Authoriser,
        names: PrincipalNames,
        registry: DocumentRegistry,
        idempotency: Idempotency,
        audit: AuditTrail,
        cursors: Cursors,
        clock: Clock,
      ) => new ExceptionReports(uow, store, authoriser, names, registry, idempotency, audit, cursors, clock),
      inject: [UnitOfWork, EXCEPTION_STORE, Authoriser, PRINCIPAL_NAMES, DocumentRegistry, Idempotency, AuditTrail, Cursors, CLOCK],
    },
  ],
  exports: [Dashboards, ExceptionProjector, ExceptionSweep, ExceptionReports],
})
export class RptModule implements OnModuleInit {
  constructor(
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(ExceptionProjector) private readonly projector: ExceptionProjector,
  ) {}

  onModuleInit(): void {
    this.events.registerConsumer(this.projector.consumer);
  }
}
