import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { NumberSeries } from '../../platform/documents/number-series';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK } from '../../platform/platform.module';
import { DocModule, Documents } from '../doc';
import { FinModule, Journals } from '../fin';
import { Authoriser, IamModule } from '../iam';
import { MasterDataRefs, MdmModule } from '../mdm';
import { STATEMENT_STORE, type StatementStore } from './application/statement-store';
import { Statements } from './application/statements';
import { PgStatementStore } from './infrastructure/pg-statement-store';
import { StatementsController } from './interface/statements.controller';

/**
 * WHL (layer 10): wholesale and business accounts. B08 continued 2d builds customer statements only: the customer's
 * trade receivables at a branch for a period, read from the ledger through FIN's door, numbered from their own series,
 * rendered and archived by DOC after commit (ADR-0085). Business accounts, credit control, standing orders, ageing and
 * dunning are B10's.
 */
@Module({
  imports: [IamModule, MdmModule, DocModule, FinModule],
  controllers: [StatementsController],
  providers: [
    { provide: STATEMENT_STORE, useClass: PgStatementStore },
    {
      provide: Statements,
      useFactory: (
        uow: UnitOfWork,
        store: StatementStore,
        refs: MasterDataRefs,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        registry: DocumentRegistry,
        numbers: NumberSeries,
        journals: Journals,
        documents: Documents,
        cursors: Cursors,
        clock: Clock,
      ) => new Statements(uow, store, refs, authoriser, idempotency, audit, registry, numbers, journals, documents, cursors, clock),
      inject: [UnitOfWork, STATEMENT_STORE, MasterDataRefs, Authoriser, Idempotency, AuditTrail, DocumentRegistry, NumberSeries, Journals, Documents, Cursors, CLOCK],
    },
  ],
  exports: [Statements],
})
export class WhlModule implements OnModuleInit {
  constructor(
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(Statements) private readonly statements: Statements,
  ) {}

  onModuleInit(): void {
    this.events.registerConsumer(this.statements.archiveLinks);
  }
}
