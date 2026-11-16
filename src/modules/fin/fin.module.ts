import { Inject, Module, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { NumberSeries } from '../../platform/documents/number-series';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import type { KeyRing } from '../../platform/crypto/key-ring';
import { CLOCK, KEY_RING, LOGGER } from '../../platform/platform.module';
import { Approvals, Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { MasterDataRefs, MdmModule } from '../mdm';
import { BankAccounts } from './application/bank-accounts';
import { BANK_ACCOUNT_STORE, type BankAccountStore } from './application/bank-account-store';
import { ChartOfAccounts } from './application/chart';
import { CHART_STORE, type ChartStore } from './application/chart-store';
import { LedgerCatalogueIncompleteError } from './application/errors';
import { Ledger } from './application/ledger';
import { LEDGER_STORE, type LedgerStore } from './application/ledger-store';
import { PERIOD_REOPEN, Periods } from './application/periods';
import { LedgerPostings } from './application/postings';
import { LedgerReconciliation, SubledgerSources } from './application/reconciliation';
import { FinancialStatements } from './application/statements';
import { JOURNAL_STORE, type JournalStore } from './application/journal-store';
import { Journals } from './application/journals';
import { MANUAL_JOURNAL, MANUAL_JOURNAL_APPROVED, ManualJournals } from './application/manual-journals';
import { POSTING_RULE_CHANGE, PostingRules } from './application/posting-rules';
import { PgBankAccountStore } from './infrastructure/pg-bank-account-store';
import { PgChartStore } from './infrastructure/pg-chart-store';
import { PgJournalStore } from './infrastructure/pg-journal-store';
import { PgLedgerStore } from './infrastructure/pg-ledger-store';
import { AccountsController } from './interface/accounts.controller';
import { BankAccountsController } from './interface/bank-accounts.controller';
import { JournalsController } from './interface/journals.controller';
import { ManualJournalsController } from './interface/manual-journals.controller';
import { PeriodsController } from './interface/periods.controller';
import { PostingRulesController } from './interface/posting-rules.controller';

/**
 * FIN (layer 4): the general ledger. B8 builds its core: the chart of accounts, posting rules and account determination
 * as data, the insert-only journal with the database's balance, period and line rules (migration 0123), a transactional
 * posting handler for every event in `fin.posting_event_type` with the boot assertion (ADR-0003), the nightly
 * reconciliation against the subledgers higher modules register, and the trial balance. No module calls FIN to post.
 * B08 continued adds its interface, first the chart of accounts and the accounting periods with lock, close and the
 * reopen under approval (PERIOD_REOPEN); B08 continued 1b journals read only, manual journals (MANUAL_JOURNAL, posted
 * from FIN's own ◆ event `fin.ManualJournalApproved`) and posting rule and determination changes (POSTING_RULE_CHANGE);
 * B08 continued 1b2 the business's bank accounts, each number sealed with a data key of its own (ADR-0057).
 */
@Module({
  imports: [IamModule, MdmModule],
  controllers: [AccountsController, BankAccountsController, PeriodsController, JournalsController, ManualJournalsController, PostingRulesController],
  providers: [
    { provide: LEDGER_STORE, useClass: PgLedgerStore },
    { provide: CHART_STORE, useClass: PgChartStore },
    { provide: JOURNAL_STORE, useClass: PgJournalStore },
    { provide: BANK_ACCOUNT_STORE, useClass: PgBankAccountStore },
    {
      provide: BankAccounts,
      useFactory: (
        uow: UnitOfWork,
        store: BankAccountStore,
        ledgerStore: LedgerStore,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        refs: MasterDataRefs,
        keyRing: KeyRing,
        cursors: Cursors,
        clock: Clock,
        config: AppConfig,
      ) => new BankAccounts(uow, store, ledgerStore, authoriser, idempotency, audit, refs, keyRing, cursors, clock, Buffer.from(config.LOOKUP_HMAC_KEY, 'base64')),
      inject: [UnitOfWork, BANK_ACCOUNT_STORE, LEDGER_STORE, Authoriser, Idempotency, AuditTrail, MasterDataRefs, KEY_RING, Cursors, CLOCK, APP_CONFIG],
    },
    {
      provide: Journals,
      useFactory: (uow: UnitOfWork, store: JournalStore, authoriser: Authoriser, documents: DocumentRegistry, names: PrincipalNames, cursors: Cursors) =>
        new Journals(uow, store, authoriser, documents, names, cursors),
      inject: [UnitOfWork, JOURNAL_STORE, Authoriser, DocumentRegistry, PRINCIPAL_NAMES, Cursors],
    },
    {
      provide: ManualJournals,
      useFactory: (
        uow: UnitOfWork,
        store: JournalStore,
        ledgerStore: LedgerStore,
        authoriser: Authoriser,
        approvals: Approvals,
        idempotency: Idempotency,
        audit: AuditTrail,
        documents: DocumentRegistry,
        events: DomainEvents,
        refs: MasterDataRefs,
        names: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new ManualJournals(uow, store, ledgerStore, authoriser, approvals, idempotency, audit, documents, events, refs, names, cursors, clock),
      inject: [UnitOfWork, JOURNAL_STORE, LEDGER_STORE, Authoriser, Approvals, Idempotency, AuditTrail, DocumentRegistry, DomainEvents, MasterDataRefs, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: PostingRules,
      useFactory: (
        uow: UnitOfWork,
        store: JournalStore,
        ledgerStore: LedgerStore,
        authoriser: Authoriser,
        approvals: Approvals,
        idempotency: Idempotency,
        audit: AuditTrail,
        documents: DocumentRegistry,
        refs: MasterDataRefs,
        cursors: Cursors,
        clock: Clock,
        postings: LedgerPostings,
      ) => new PostingRules(uow, store, ledgerStore, authoriser, approvals, idempotency, audit, documents, refs, cursors, clock, () => postings.handledTypes()),
      inject: [UnitOfWork, JOURNAL_STORE, LEDGER_STORE, Authoriser, Approvals, Idempotency, AuditTrail, DocumentRegistry, MasterDataRefs, Cursors, CLOCK, LedgerPostings],
    },
    {
      provide: ChartOfAccounts,
      useFactory: (uow: UnitOfWork, store: ChartStore, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, cursors: Cursors, clock: Clock) =>
        new ChartOfAccounts(uow, store, authoriser, idempotency, audit, cursors, clock),
      inject: [UnitOfWork, CHART_STORE, Authoriser, Idempotency, AuditTrail, Cursors, CLOCK],
    },
    {
      provide: Periods,
      useFactory: (
        uow: UnitOfWork,
        store: ChartStore,
        authoriser: Authoriser,
        approvals: Approvals,
        idempotency: Idempotency,
        audit: AuditTrail,
        documents: DocumentRegistry,
        refs: MasterDataRefs,
        names: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new Periods(uow, store, authoriser, approvals, idempotency, audit, documents, refs, names, cursors, clock),
      inject: [UnitOfWork, CHART_STORE, Authoriser, Approvals, Idempotency, AuditTrail, DocumentRegistry, MasterDataRefs, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: Ledger,
      useFactory: (store: LedgerStore, documents: DocumentRegistry, numbers: NumberSeries, refs: MasterDataRefs, clock: Clock) => new Ledger(store, documents, numbers, refs, clock),
      inject: [LEDGER_STORE, DocumentRegistry, NumberSeries, MasterDataRefs, CLOCK],
    },
    {
      provide: LedgerPostings,
      useFactory: (ledger: Ledger, store: LedgerStore, refs: MasterDataRefs, documents: DocumentRegistry, bankAccounts: BankAccounts, clock: Clock) =>
        new LedgerPostings(ledger, store, refs, documents, bankAccounts, clock),
      inject: [Ledger, LEDGER_STORE, MasterDataRefs, DocumentRegistry, BankAccounts, CLOCK],
    },
    { provide: SubledgerSources, useFactory: () => new SubledgerSources() },
    {
      provide: LedgerReconciliation,
      useFactory: (uow: UnitOfWork, store: LedgerStore, sources: SubledgerSources, numbers: NumberSeries, events: DomainEvents, clock: Clock, logger: Logger) =>
        new LedgerReconciliation(uow, store, sources, numbers, events, clock, logger),
      inject: [UnitOfWork, LEDGER_STORE, SubledgerSources, NumberSeries, DomainEvents, CLOCK, LOGGER],
    },
    { provide: FinancialStatements, useFactory: (store: LedgerStore) => new FinancialStatements(store), inject: [LEDGER_STORE] },
  ],
  exports: [Ledger, LedgerPostings, SubledgerSources, LedgerReconciliation, FinancialStatements, Periods, BankAccounts],
})
export class FinModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(LedgerPostings) private readonly postings: LedgerPostings,
    @Inject(UnitOfWork) private readonly uow: UnitOfWork,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(Approvals) private readonly approvals: Approvals,
    @Inject(Periods) private readonly periods: Periods,
    @Inject(ManualJournals) private readonly manualJournals: ManualJournals,
    @Inject(PostingRules) private readonly postingRules: PostingRules,
  ) {}

  /** Subscribes the posting handlers inside every publisher's transaction (ADR-0003), and FIN's approval kinds. */
  onModuleInit(): void {
    this.events.declareLedgerEvents([MANUAL_JOURNAL_APPROVED]);
    this.postings.registerIn(this.events);
    this.approvals.registerHandler(PERIOD_REOPEN, this.periods);
    this.approvals.registerHandler(MANUAL_JOURNAL, this.manualJournals);
    this.approvals.registerHandler(POSTING_RULE_CHANGE, this.postingRules);
  }

  /**
   * Safeguard one: the application does not start while a posting event lacks a handler or a complete rule set. When
   * the database cannot be reached at boot the application still starts (its health check reports the database), and
   * the first posting runs the assertion instead.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.uow.run({ isolation: 'read committed' }, (tx) => this.postings.assertCatalogueIn(tx, this.events.declaredLedgerEvents()));
    } catch (error) {
      if (error instanceof LedgerCatalogueIncompleteError) {
        throw error;
      }
      this.logger.warn({ err: error }, 'the ledger boot assertion could not read the database; the first posting will run it');
    }
  }
}
