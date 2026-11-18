import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { PAYMENT_PROVIDER } from '../../platform/payments/payment-provider';
import type { ResilientPaymentProvider } from '../../platform/payments/resilient-provider';
import { CLOCK, LOGGER } from '../../platform/platform.module';
import { Settings } from '../../platform/settings/settings';
import { BilModule, Billing } from '../bil';
import { BankAccounts, FinModule } from '../fin';
import { Approvals, Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { MasterDataRefs, MdmModule } from '../mdm';
import { Breaks } from './application/breaks';
import { UnverifiedTenders } from './application/unverified-tenders';
import { PAYMENT_STORE, type PaymentStore } from './application/payment-store';
import { PAY_LEDGER_EVENTS, Payments } from './application/payments';
import { ProviderPayments } from './application/provider-payments';
import { TillShiftRegistry } from './application/till-shifts';
import { PAYMENT_REVERSAL_KIND, Receipts } from './application/receipts';
import { Receivables } from './application/receivables';
import { StoreCredit } from './application/store-credit';
import { REFUND_KIND, Refunds } from './application/refunds';
import { PaymentWebhooks } from './application/webhooks';
import { BreakQueue, RECONCILIATION_BREAK_KIND } from './application/break-queue';
import { Reconciliation } from './application/reconciliation';
import { RECONCILIATION_STORE, type ReconciliationStore } from './application/reconciliation-store';
import { PgReconciliationStore } from './infrastructure/pg-reconciliation-store';
import { BankStatementLinesController, ReconciliationController } from './interface/reconciliation.controller';
import { FileStore } from '../../platform/storage/file-store';
import { PgPaymentStore } from './infrastructure/pg-payment-store';
import { MyStoreCreditController, PaymentsController, ReceivablesController, RefundsController, StoreCreditController, WebhooksController } from './interface/payments.controller';

/**
 * PAY (layer 7): payments, their allocations, the provider port's charges and webhooks, refunds and the break queue
 * (B9a, B09a continued). A selling module records a tender through `Payments.recordIn` in its own serializable
 * transaction; a provider payment clears only through `ProviderPayments.settleIn` on the provider's own answer; the
 * ledger posts PAY's ◆ events in the same transaction. B09a continued 1b adds receipts recorded by hand (cheques, bank
 * transfers, store credit), cheque clearing, reversals under approval, store credit and open items (ADR-0064); B09a
 * continued 1c settlement reports, bank statements and the break queue, each break resolved through approval (ADR-0065).
 */
@Module({
  imports: [IamModule, MdmModule, FinModule, BilModule],
  controllers: [PaymentsController, RefundsController, WebhooksController, StoreCreditController, MyStoreCreditController, ReceivablesController, ReconciliationController, BankStatementLinesController],
  providers: [
    { provide: PAYMENT_STORE, useClass: PgPaymentStore },
    { provide: RECONCILIATION_STORE, useClass: PgReconciliationStore },
    {
      provide: Reconciliation,
      useFactory: (
        store: ReconciliationStore,
        breaks: Breaks,
        bankAccounts: BankAccounts,
        refs: MasterDataRefs,
        files: FileStore,
        documents: DocumentRegistry,
        events: DomainEvents,
        audit: AuditTrail,
        uow: UnitOfWork,
        authoriser: Authoriser,
        idempotency: Idempotency,
        cursors: Cursors,
        clock: Clock,
      ) => new Reconciliation(store, breaks, bankAccounts, refs, files, documents, events, audit, uow, authoriser, idempotency, cursors, clock),
      inject: [RECONCILIATION_STORE, Breaks, BankAccounts, MasterDataRefs, FileStore, DocumentRegistry, DomainEvents, AuditTrail, UnitOfWork, Authoriser, Idempotency, Cursors, CLOCK],
    },
    {
      provide: BreakQueue,
      useFactory: (
        store: ReconciliationStore,
        refs: MasterDataRefs,
        documents: DocumentRegistry,
        events: DomainEvents,
        audit: AuditTrail,
        uow: UnitOfWork,
        authoriser: Authoriser,
        idempotency: Idempotency,
        approvals: Approvals,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new BreakQueue(store, refs, documents, events, audit, uow, authoriser, idempotency, approvals, principals, cursors, clock),
      inject: [RECONCILIATION_STORE, MasterDataRefs, DocumentRegistry, DomainEvents, AuditTrail, UnitOfWork, Authoriser, Idempotency, Approvals, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: Breaks,
      useFactory: (store: PaymentStore, events: DomainEvents, clock: Clock) => new Breaks(store, events, clock),
      inject: [PAYMENT_STORE, DomainEvents, CLOCK],
    },
    {
      provide: Payments,
      useFactory: (
        store: PaymentStore,
        refs: MasterDataRefs,
        billing: Billing,
        documents: DocumentRegistry,
        events: DomainEvents,
        audit: AuditTrail,
        clock: Clock,
        uow: UnitOfWork,
        authoriser: Authoriser,
        idempotency: Idempotency,
        cursors: Cursors,
        bankAccounts: BankAccounts,
        tills: TillShiftRegistry,
      ) => new Payments(store, refs, billing, documents, events, audit, clock, uow, authoriser, idempotency, cursors, bankAccounts, tills),
      inject: [PAYMENT_STORE, MasterDataRefs, Billing, DocumentRegistry, DomainEvents, AuditTrail, CLOCK, UnitOfWork, Authoriser, Idempotency, Cursors, BankAccounts, TillShiftRegistry],
    },
    { provide: TillShiftRegistry, useFactory: () => new TillShiftRegistry() },
    {
      provide: StoreCredit,
      useFactory: (store: PaymentStore, refs: MasterDataRefs, documents: DocumentRegistry, uow: UnitOfWork, authoriser: Authoriser, clock: Clock) => new StoreCredit(store, refs, documents, uow, authoriser, clock),
      inject: [PAYMENT_STORE, MasterDataRefs, DocumentRegistry, UnitOfWork, Authoriser, CLOCK],
    },
    {
      provide: Receipts,
      useFactory: (
        store: PaymentStore,
        payments: Payments,
        storeCredit: StoreCredit,
        refs: MasterDataRefs,
        billing: Billing,
        bankAccounts: BankAccounts,
        documents: DocumentRegistry,
        events: DomainEvents,
        audit: AuditTrail,
        uow: UnitOfWork,
        authoriser: Authoriser,
        idempotency: Idempotency,
        approvals: Approvals,
        clock: Clock,
      ) => new Receipts(store, payments, storeCredit, refs, billing, bankAccounts, documents, events, audit, uow, authoriser, idempotency, approvals, clock),
      inject: [PAYMENT_STORE, Payments, StoreCredit, MasterDataRefs, Billing, BankAccounts, DocumentRegistry, DomainEvents, AuditTrail, UnitOfWork, Authoriser, Idempotency, Approvals, CLOCK],
    },
    {
      provide: Receivables,
      useFactory: (billing: Billing, uow: UnitOfWork, authoriser: Authoriser, cursors: Cursors, refs: MasterDataRefs, clock: Clock) => new Receivables(billing, uow, authoriser, cursors, refs, clock),
      inject: [Billing, UnitOfWork, Authoriser, Cursors, MasterDataRefs, CLOCK],
    },
    {
      provide: ProviderPayments,
      useFactory: (
        store: PaymentStore,
        payments: Payments,
        refs: MasterDataRefs,
        documents: DocumentRegistry,
        events: DomainEvents,
        audit: AuditTrail,
        breaks: Breaks,
        uow: UnitOfWork,
        authoriser: Authoriser,
        idempotency: Idempotency,
        provider: ResilientPaymentProvider,
        config: AppConfig,
        clock: Clock,
        logger: Logger,
      ) => new ProviderPayments(store, payments, refs, documents, events, audit, breaks, uow, authoriser, idempotency, provider, config.PAYSTACK_PAYER_EMAIL ?? null, clock, logger),
      inject: [PAYMENT_STORE, Payments, MasterDataRefs, DocumentRegistry, DomainEvents, AuditTrail, Breaks, UnitOfWork, Authoriser, Idempotency, PAYMENT_PROVIDER, APP_CONFIG, CLOCK, LOGGER],
    },
    {
      provide: PaymentWebhooks,
      useFactory: (store: PaymentStore, providerPayments: ProviderPayments, provider: ResilientPaymentProvider, breaks: Breaks, events: DomainEvents, audit: AuditTrail, settings: Settings, uow: UnitOfWork, clock: Clock, logger: Logger) =>
        new PaymentWebhooks(store, providerPayments, provider, breaks, events, audit, settings, uow, clock, logger),
      inject: [PAYMENT_STORE, ProviderPayments, PAYMENT_PROVIDER, Breaks, DomainEvents, AuditTrail, Settings, UnitOfWork, CLOCK, LOGGER],
    },
    {
      provide: Refunds,
      useFactory: (
        store: PaymentStore,
        payments: Payments,
        refs: MasterDataRefs,
        documents: DocumentRegistry,
        events: DomainEvents,
        audit: AuditTrail,
        breaks: Breaks,
        uow: UnitOfWork,
        authoriser: Authoriser,
        idempotency: Idempotency,
        approvals: Approvals,
        principals: PrincipalNames,
        cursors: Cursors,
        provider: ResilientPaymentProvider,
        clock: Clock,
        logger: Logger,
        storeCredit: StoreCredit,
        billing: Billing,
      ) => new Refunds(store, payments, refs, documents, events, audit, breaks, uow, authoriser, idempotency, approvals, principals, cursors, provider, clock, logger, storeCredit, billing),
      inject: [PAYMENT_STORE, Payments, MasterDataRefs, DocumentRegistry, DomainEvents, AuditTrail, Breaks, UnitOfWork, Authoriser, Idempotency, Approvals, PRINCIPAL_NAMES, Cursors, PAYMENT_PROVIDER, CLOCK, LOGGER, StoreCredit, Billing],
    },
    {
      provide: UnverifiedTenders,
      useFactory: (payments: Payments, breaks: Breaks, refs: MasterDataRefs, bankAccounts: BankAccounts, settings: Settings, audit: AuditTrail, clock: Clock) =>
        new UnverifiedTenders(payments, breaks, refs, bankAccounts, settings, audit, clock, createUuidV7Generator(clock)),
      inject: [Payments, Breaks, MasterDataRefs, BankAccounts, Settings, AuditTrail, CLOCK],
    },
  ],
  exports: [Payments, ProviderPayments, Refunds, Receipts, StoreCredit, TillShiftRegistry, UnverifiedTenders],
})
export class PayModule implements OnModuleInit {
  constructor(
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(Approvals) private readonly approvals: Approvals,
    @Inject(Refunds) private readonly refunds: Refunds,
    @Inject(Receipts) private readonly receipts: Receipts,
    @Inject(BreakQueue) private readonly breakQueue: BreakQueue,
  ) {}

  /** Declares PAY's ◆ events for the ledger's boot assertion (ADR-0056) and registers the `REFUND`, `PAYMENT_REVERSAL` and `RECONCILIATION_BREAK` approval handlers. */
  onModuleInit(): void {
    this.events.declareLedgerEvents(PAY_LEDGER_EVENTS);
    this.approvals.registerHandler(REFUND_KIND, this.refunds.approvalHandler);
    this.approvals.registerHandler(PAYMENT_REVERSAL_KIND, this.receipts.approvalHandler);
    this.approvals.registerHandler(RECONCILIATION_BREAK_KIND, this.breakQueue.approvalHandler);
  }
}
