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
import { BilModule, Billing } from '../bil';
import { Approvals, Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { MasterDataRefs, MdmModule, PartiesAdmin } from '../mdm';
import { ORDER_CONFIRMATION_POLICIES, OrdModule, Orders, type OrderConfirmationPolicy } from '../ord';
import { ACCOUNT_STORE, type AccountStore } from './application/account-store';
import { ACCOUNT_RELEASE_KIND, BusinessAccounts, CREDIT_LIMIT_CHANGE_KIND } from './application/business-accounts';
import { CREDIT_OVERRIDE_KIND, CreditControl } from './application/credit-control';
import { AccountHolds } from './application/account-holds';
import { PgAccountStore } from './infrastructure/pg-account-store';
import { BusinessAccountsController } from './interface/business-accounts.controller';
import { STATEMENT_STORE, type StatementStore } from './application/statement-store';
import { Statements } from './application/statements';
import { PgStatementStore } from './infrastructure/pg-statement-store';
import { AllocationsAsAt, PayModule } from '../pay';
import { Ageing } from './application/ageing';
import { Dunning } from './application/dunning';
import { DUNNING_STORE, type DunningStore } from './application/dunning-store';
import { PgDunningStore } from './infrastructure/pg-dunning-store';
import { ReceivablesController } from './interface/receivables.controller';
import { StatementsController } from './interface/statements.controller';
import { BAD_DEBT_STORE, type BadDebtStore } from './application/bad-debt-store';
import { BAD_DEBT_WRITE_OFF_KIND, BAD_DEBT_WRITTEN_OFF, BadDebts } from './application/bad-debts';
import { STANDING_ORDER_STORE, type StandingOrderStore } from './application/standing-order-store';
import { StandingOrders } from './application/standing-orders';
import { PgBadDebtStore } from './infrastructure/pg-bad-debt-store';
import { PgStandingOrderStore } from './infrastructure/pg-standing-order-store';
import { StandingOrdersController } from './interface/standing-orders.controller';

/**
 * WHL (layer 10): wholesale and business accounts. B08 continued 2d builds customer statements: the customer's trade
 * receivables at a branch for a period, read from the ledger through FIN's door, numbered from their own series,
 * rendered and archived by DOC after commit (ADR-0085). B10 continued builds business accounts and credit control:
 * `BusinessAccounts` (with the `ACCOUNT_RELEASE` and `CREDIT_LIMIT_CHANGE` approvals and the overdue hold, run by the
 * worker as `AccountHolds`) and `CreditControl`, ORD's `OrderConfirmationPolicy` with the `CREDIT_OVERRIDE` approval.
 * B10 continued 2 builds `Ageing` (as at a date, from BIL's documents, PAY's dated allocations and FIN's 1200, ADR-0089)
 * with the statement's ageing summary, and `Dunning` (the levels, the notices and the worker's `dunning` job).
 */
@Module({
  imports: [IamModule, MdmModule, DocModule, FinModule, BilModule, PayModule, OrdModule],
  controllers: [StatementsController, BusinessAccountsController, ReceivablesController, StandingOrdersController],
  providers: [
    { provide: STATEMENT_STORE, useClass: PgStatementStore },
    { provide: ACCOUNT_STORE, useClass: PgAccountStore },
    { provide: DUNNING_STORE, useClass: PgDunningStore },
    { provide: STANDING_ORDER_STORE, useClass: PgStandingOrderStore },
    { provide: BAD_DEBT_STORE, useClass: PgBadDebtStore },
    {
      provide: StandingOrders,
      useFactory: (
        uow: UnitOfWork,
        store: StandingOrderStore,
        accounts: AccountStore,
        credit: CreditControl,
        orders: Orders,
        refs: MasterDataRefs,
        registry: DocumentRegistry,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        cursors: Cursors,
        clock: Clock,
      ) => new StandingOrders(uow, store, accounts, credit, orders, refs, registry, authoriser, idempotency, audit, cursors, clock),
      inject: [UnitOfWork, STANDING_ORDER_STORE, ACCOUNT_STORE, CreditControl, Orders, MasterDataRefs, DocumentRegistry, Authoriser, Idempotency, AuditTrail, Cursors, CLOCK],
    },
    {
      provide: BadDebts,
      useFactory: (
        uow: UnitOfWork,
        store: BadDebtStore,
        billing: Billing,
        journals: Journals,
        refs: MasterDataRefs,
        registry: DocumentRegistry,
        approvals: Approvals,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        clock: Clock,
      ) => new BadDebts(uow, store, billing, journals, refs, registry, approvals, authoriser, idempotency, audit, events, clock),
      inject: [UnitOfWork, BAD_DEBT_STORE, Billing, Journals, MasterDataRefs, DocumentRegistry, Approvals, Authoriser, Idempotency, AuditTrail, DomainEvents, CLOCK],
    },
    {
      provide: Ageing,
      useFactory: (
        uow: UnitOfWork,
        store: DunningStore,
        billing: Billing,
        allocations: AllocationsAsAt,
        journals: Journals,
        refs: MasterDataRefs,
        authoriser: Authoriser,
        cursors: Cursors,
        clock: Clock,
        writeOffs: BadDebtStore,
      ) => new Ageing(uow, store, billing, allocations, journals, refs, authoriser, cursors, clock, writeOffs),
      inject: [UnitOfWork, DUNNING_STORE, Billing, AllocationsAsAt, Journals, MasterDataRefs, Authoriser, Cursors, CLOCK, BAD_DEBT_STORE],
    },
    {
      provide: Dunning,
      useFactory: (
        uow: UnitOfWork,
        store: DunningStore,
        billing: Billing,
        refs: MasterDataRefs,
        registry: DocumentRegistry,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        cursors: Cursors,
        clock: Clock,
      ) => new Dunning(uow, store, billing, refs, registry, authoriser, idempotency, audit, events, cursors, clock),
      inject: [UnitOfWork, DUNNING_STORE, Billing, MasterDataRefs, DocumentRegistry, Authoriser, Idempotency, AuditTrail, DomainEvents, Cursors, CLOCK],
    },
    {
      provide: CreditControl,
      useFactory: (
        uow: UnitOfWork,
        store: AccountStore,
        orders: Orders,
        billing: Billing,
        approvals: Approvals,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        refs: MasterDataRefs,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new CreditControl(uow, store, orders, billing, approvals, authoriser, idempotency, audit, events, refs, principals, cursors, clock),
      inject: [UnitOfWork, ACCOUNT_STORE, Orders, Billing, Approvals, Authoriser, Idempotency, AuditTrail, DomainEvents, MasterDataRefs, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: BusinessAccounts,
      useFactory: (
        uow: UnitOfWork,
        store: AccountStore,
        credit: CreditControl,
        refs: MasterDataRefs,
        parties: PartiesAdmin,
        approvals: Approvals,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        registry: DocumentRegistry,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
        writeOffs: BadDebtStore,
      ) => new BusinessAccounts(uow, store, credit, refs, parties, approvals, authoriser, idempotency, audit, events, registry, principals, cursors, clock, writeOffs),
      inject: [UnitOfWork, ACCOUNT_STORE, CreditControl, MasterDataRefs, PartiesAdmin, Approvals, Authoriser, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, PRINCIPAL_NAMES, Cursors, CLOCK, BAD_DEBT_STORE],
    },
    { provide: AccountHolds, useFactory: (accounts: BusinessAccounts) => new AccountHolds(accounts), inject: [BusinessAccounts] },
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
        ageing: Ageing,
        events: DomainEvents,
      ) => new Statements(uow, store, refs, authoriser, idempotency, audit, registry, numbers, journals, documents, cursors, clock, ageing, events),
      inject: [UnitOfWork, STATEMENT_STORE, MasterDataRefs, Authoriser, Idempotency, AuditTrail, DocumentRegistry, NumberSeries, Journals, Documents, Cursors, CLOCK, Ageing, DomainEvents],
    },
  ],
  exports: [Statements, BusinessAccounts, CreditControl, AccountHolds, Ageing, Dunning, StandingOrders, BadDebts],
})
export class WhlModule implements OnModuleInit {
  constructor(
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(Statements) private readonly statements: Statements,
    @Inject(Approvals) private readonly approvals: Approvals,
    @Inject(BusinessAccounts) private readonly accounts: BusinessAccounts,
    @Inject(CreditControl) private readonly credit: CreditControl,
    @Inject(ORDER_CONFIRMATION_POLICIES) private readonly policies: OrderConfirmationPolicy[],
    @Inject(BadDebts) private readonly badDebts: BadDebts,
  ) {}

  onModuleInit(): void {
    this.events.registerConsumer(this.statements.archiveLinks);
    this.events.registerConsumer(this.accounts.paymentReleases);
    this.approvals.registerHandler(CREDIT_OVERRIDE_KIND, this.credit.approvalHandler);
    this.approvals.registerHandler(ACCOUNT_RELEASE_KIND, this.accounts.releaseHandler);
    this.approvals.registerHandler(CREDIT_LIMIT_CHANGE_KIND, this.accounts.limitHandler);
    this.approvals.registerHandler(BAD_DEBT_WRITE_OFF_KIND, this.badDebts.approvalHandler);
    this.events.registerConsumer(this.badDebts.recoveries);
    // ◆ ADR-0003: FIN posts the write-off (Dr 6940, Cr 1200 against the customer) in the approving transaction.
    this.events.declareLedgerEvents([BAD_DEBT_WRITTEN_OFF]);
    // ORD's OrderConfirmationPolicy port (MODULE_BOUNDARIES section 6): WHL answers for credit orders.
    if (!this.policies.includes(this.credit)) this.policies.push(this.credit);
  }
}
