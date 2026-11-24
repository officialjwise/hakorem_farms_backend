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
import { BankAccounts, FinancialStatements, FinModule, Journals, Periods } from '../fin';
import { Approvals, Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { MasterDataRefs, MdmModule } from '../mdm';
import { CAP_STORE, type CapStore } from './application/cap-store';
import { Capital, CAPITAL_CONTRIBUTED, CAPITAL_WITHDRAWAL, CAPITAL_WITHDRAWN } from './application/capital';
import { DISTRIBUTION_DECLARED, DISTRIBUTION_PAID, Distributions, INVESTOR_DISTRIBUTION } from './application/distributions';
import { PgCapStore } from './infrastructure/pg-cap-store';
import { CapitalController } from './interface/capital.controller';
import { DistributionsController } from './interface/distributions.controller';

/**
 * CAP (layer 11): capital, investors and profit sharing. B12 builds the investor register, capital contributions and
 * withdrawals with their units (`Capital`, the `CAPITAL_WITHDRAWAL` approval) and distribution runs (`Distributions`,
 * the `INVESTOR_DISTRIBUTION` approval, the schedule archived by DOC), each ◆ event posted by FIN in the publisher's
 * transaction (ADR-0003, ADR-0028). Loans and grants, investor documents, payout details, returns and the investor
 * portal are B12 continued's (A-380).
 */
@Module({
  imports: [IamModule, MdmModule, DocModule, FinModule],
  controllers: [CapitalController, DistributionsController],
  providers: [
    { provide: CAP_STORE, useClass: PgCapStore },
    {
      provide: Capital,
      useFactory: (
        uow: UnitOfWork,
        store: CapStore,
        refs: MasterDataRefs,
        bankAccounts: BankAccounts,
        periods: Periods,
        journals: Journals,
        registry: DocumentRegistry,
        numbers: NumberSeries,
        approvals: Approvals,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        names: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new Capital(uow, store, refs, bankAccounts, periods, journals, registry, numbers, approvals, authoriser, idempotency, audit, events, names, cursors, clock),
      inject: [UnitOfWork, CAP_STORE, MasterDataRefs, BankAccounts, Periods, Journals, DocumentRegistry, NumberSeries, Approvals, Authoriser, Idempotency, AuditTrail, DomainEvents, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: Distributions,
      useFactory: (
        uow: UnitOfWork,
        store: CapStore,
        capital: Capital,
        statements: FinancialStatements,
        periods: Periods,
        journals: Journals,
        bankAccounts: BankAccounts,
        archive: Documents,
        refs: MasterDataRefs,
        registry: DocumentRegistry,
        numbers: NumberSeries,
        approvals: Approvals,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        cursors: Cursors,
        clock: Clock,
      ) => new Distributions(uow, store, capital, statements, periods, journals, bankAccounts, archive, refs, registry, numbers, approvals, idempotency, audit, events, cursors, clock),
      inject: [UnitOfWork, CAP_STORE, Capital, FinancialStatements, Periods, Journals, BankAccounts, Documents, MasterDataRefs, DocumentRegistry, NumberSeries, Approvals, Idempotency, AuditTrail, DomainEvents, Cursors, CLOCK],
    },
  ],
  exports: [Capital, Distributions],
})
export class CapModule implements OnModuleInit {
  constructor(
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(Approvals) private readonly approvals: Approvals,
    @Inject(Capital) private readonly capital: Capital,
    @Inject(Distributions) private readonly distributions: Distributions,
  ) {}

  onModuleInit(): void {
    this.approvals.registerHandler(CAPITAL_WITHDRAWAL, this.capital.withdrawalHandler);
    this.approvals.registerHandler(INVESTOR_DISTRIBUTION, this.distributions.approvalHandler);
    this.events.registerConsumer(this.distributions.archiveLinks);
    // ◆ ADR-0003: FIN posts each in the publisher's transaction (migration 0354).
    this.events.declareLedgerEvents([CAPITAL_CONTRIBUTED, CAPITAL_WITHDRAWN, DISTRIBUTION_DECLARED, DISTRIBUTION_PAID]);
  }
}
