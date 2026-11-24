import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { NumberSeries } from '../../platform/documents/number-series';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { SubjectKeys } from '../../platform/crypto/subject-keys';
import { CLOCK, LOGGER } from '../../platform/platform.module';
import { FileStore } from '../../platform/storage/file-store';
import type { Logger } from 'pino';
import { DocModule, Documents } from '../doc';
import { BankAccounts, FinancialStatements, FinModule, Journals, Periods } from '../fin';
import { AccessAdmin, Approvals, Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { MasterDataRefs, MdmModule } from '../mdm';
import { CAP_STORE, type CapStore } from './application/cap-store';
import { Capital, CAPITAL_CONTRIBUTED, CAPITAL_WITHDRAWAL, CAPITAL_WITHDRAWN } from './application/capital';
import { DISTRIBUTION_DECLARED, DISTRIBUTION_PAID, Distributions, INVESTOR_DISTRIBUTION } from './application/distributions';
import { CAP_BOOKS_STORE, type CapBooksStore } from './application/cap-books-store';
import { Financing, FINANCING, FINANCING_LEDGER_EVENTS } from './application/financing';
import { InvestorPortal } from './application/investor-portal';
import { INVESTOR_PAYOUT_CHANGE, InvestorProfiles } from './application/investor-profiles';
import { InvestorReturns } from './application/investor-returns';
import { PgCapBooksStore } from './infrastructure/pg-cap-books-store';
import { PgCapStore } from './infrastructure/pg-cap-store';
import { InvestorBooksController } from './interface/investor-books.controller';
import { InvestorPortalController } from './interface/investor-portal.controller';
import { CapitalController } from './interface/capital.controller';
import { DistributionsController } from './interface/distributions.controller';

/**
 * CAP (layer 11): capital, investors and profit sharing. B12 builds the investor register, capital contributions and
 * withdrawals with their units (`Capital`, the `CAPITAL_WITHDRAWAL` approval) and distribution runs (`Distributions`,
 * the `INVESTOR_DISTRIBUTION` approval, the schedule archived by DOC), each ◆ event posted by FIN in the publisher's
 * transaction (ADR-0003, ADR-0028). B12 continued adds the sealed payout details and identity number, documents and the
 * portal login (`InvestorProfiles`, the `INVESTOR_PAYOUT_CHANGE` approval), statements and return metrics
 * (`InvestorReturns`), the investor portal's read model (`InvestorPortal`) and loans and grants (`Financing`, the
 * `FINANCING` approval, the daily accrual job), ADR-0101.
 */
@Module({
  imports: [IamModule, MdmModule, DocModule, FinModule],
  controllers: [CapitalController, DistributionsController, InvestorBooksController, InvestorPortalController],
  providers: [
    { provide: CAP_STORE, useClass: PgCapStore },
    { provide: CAP_BOOKS_STORE, useClass: PgCapBooksStore },
    {
      provide: InvestorProfiles,
      useFactory: (
        uow: UnitOfWork,
        store: CapStore,
        books: CapBooksStore,
        capital: Capital,
        subjectKeys: SubjectKeys,
        files: FileStore,
        access: AccessAdmin,
        approvals: Approvals,
        registry: DocumentRegistry,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        cursors: Cursors,
        clock: Clock,
      ) => {
        const profiles = new InvestorProfiles(uow, store, books, capital, subjectKeys, files, access, approvals, registry, idempotency, audit, events, cursors, clock);
        capital.attachProfiles(profiles);
        return profiles;
      },
      inject: [UnitOfWork, CAP_STORE, CAP_BOOKS_STORE, Capital, SubjectKeys, FileStore, AccessAdmin, Approvals, DocumentRegistry, Idempotency, AuditTrail, DomainEvents, Cursors, CLOCK],
    },
    {
      provide: InvestorReturns,
      useFactory: (uow: UnitOfWork, store: CapStore, books: CapBooksStore, capital: Capital, statements: FinancialStatements, clock: Clock) => new InvestorReturns(uow, store, books, capital, statements, clock),
      inject: [UnitOfWork, CAP_STORE, CAP_BOOKS_STORE, Capital, FinancialStatements, CLOCK],
    },
    {
      provide: InvestorPortal,
      useFactory: (uow: UnitOfWork, store: CapStore, books: CapBooksStore, capital: Capital, returns: InvestorReturns, profiles: InvestorProfiles, files: FileStore, audit: AuditTrail, cursors: Cursors, clock: Clock) =>
        new InvestorPortal(uow, store, books, capital, returns, profiles, files, audit, cursors, clock),
      inject: [UnitOfWork, CAP_STORE, CAP_BOOKS_STORE, Capital, InvestorReturns, InvestorProfiles, FileStore, AuditTrail, Cursors, CLOCK],
    },
    {
      provide: Financing,
      useFactory: (
        uow: UnitOfWork,
        store: CapStore,
        books: CapBooksStore,
        capital: Capital,
        refs: MasterDataRefs,
        bankAccounts: BankAccounts,
        periods: Periods,
        journals: Journals,
        files: FileStore,
        registry: DocumentRegistry,
        numbers: NumberSeries,
        approvals: Approvals,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        cursors: Cursors,
        clock: Clock,
        logger: Logger,
      ) => new Financing(uow, store, books, capital, refs, bankAccounts, periods, journals, files, registry, numbers, approvals, idempotency, audit, events, cursors, clock, logger),
      inject: [UnitOfWork, CAP_STORE, CAP_BOOKS_STORE, Capital, MasterDataRefs, BankAccounts, Periods, Journals, FileStore, DocumentRegistry, NumberSeries, Approvals, Idempotency, AuditTrail, DomainEvents, Cursors, CLOCK, LOGGER],
    },
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
  exports: [Capital, Distributions, InvestorProfiles, InvestorReturns, InvestorPortal, Financing],
})
export class CapModule implements OnModuleInit {
  constructor(
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(Approvals) private readonly approvals: Approvals,
    @Inject(Capital) private readonly capital: Capital,
    @Inject(Distributions) private readonly distributions: Distributions,
    @Inject(InvestorProfiles) private readonly profiles: InvestorProfiles,
    @Inject(Financing) private readonly financing: Financing,
  ) {}

  onModuleInit(): void {
    this.approvals.registerHandler(CAPITAL_WITHDRAWAL, this.capital.withdrawalHandler);
    this.approvals.registerHandler(INVESTOR_DISTRIBUTION, this.distributions.approvalHandler);
    this.approvals.registerHandler(INVESTOR_PAYOUT_CHANGE, this.profiles.payoutChangeHandler);
    this.approvals.registerHandler(FINANCING, this.financing.approvalHandler);
    this.events.registerConsumer(this.distributions.archiveLinks);
    // ◆ ADR-0003: FIN posts each in the publisher's transaction (migration 0354).
    this.events.declareLedgerEvents([CAPITAL_CONTRIBUTED, CAPITAL_WITHDRAWN, DISTRIBUTION_DECLARED, DISTRIBUTION_PAID, ...FINANCING_LEDGER_EVENTS]);
  }
}
