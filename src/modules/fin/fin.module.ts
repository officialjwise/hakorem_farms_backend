import { Inject, Module, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { NumberSeries } from '../../platform/documents/number-series';
import { DomainEvents } from '../../platform/events/domain-events';
import { CLOCK, LOGGER } from '../../platform/platform.module';
import { MasterDataRefs, MdmModule } from '../mdm';
import { LedgerCatalogueIncompleteError } from './application/errors';
import { Ledger } from './application/ledger';
import { LEDGER_STORE, type LedgerStore } from './application/ledger-store';
import { LedgerPostings } from './application/postings';
import { LedgerReconciliation, SubledgerSources } from './application/reconciliation';
import { FinancialStatements } from './application/statements';
import { PgLedgerStore } from './infrastructure/pg-ledger-store';

/**
 * FIN (layer 4): the general ledger. B8 builds its core: the chart of accounts, posting rules and account determination
 * as data, the insert-only journal with the database's balance, period and line rules (migration 0123), a transactional
 * posting handler for every event in `fin.posting_event_type` with the boot assertion (ADR-0003), the nightly
 * reconciliation against the subledgers higher modules register, and the trial balance. No module calls FIN to post.
 */
@Module({
  imports: [MdmModule],
  providers: [
    { provide: LEDGER_STORE, useClass: PgLedgerStore },
    {
      provide: Ledger,
      useFactory: (store: LedgerStore, documents: DocumentRegistry, numbers: NumberSeries, refs: MasterDataRefs, clock: Clock) => new Ledger(store, documents, numbers, refs, clock),
      inject: [LEDGER_STORE, DocumentRegistry, NumberSeries, MasterDataRefs, CLOCK],
    },
    {
      provide: LedgerPostings,
      useFactory: (ledger: Ledger, store: LedgerStore, refs: MasterDataRefs, documents: DocumentRegistry, clock: Clock) => new LedgerPostings(ledger, store, refs, documents, clock),
      inject: [Ledger, LEDGER_STORE, MasterDataRefs, DocumentRegistry, CLOCK],
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
  exports: [Ledger, LedgerPostings, SubledgerSources, LedgerReconciliation, FinancialStatements],
})
export class FinModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(LedgerPostings) private readonly postings: LedgerPostings,
    @Inject(UnitOfWork) private readonly uow: UnitOfWork,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Subscribes the posting handlers inside every publisher's transaction (ADR-0003). */
  onModuleInit(): void {
    this.postings.registerIn(this.events);
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
