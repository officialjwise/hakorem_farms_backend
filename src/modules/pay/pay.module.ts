import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
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
import { Approvals, Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { MasterDataRefs, MdmModule } from '../mdm';
import { Breaks } from './application/breaks';
import { PAYMENT_STORE, type PaymentStore } from './application/payment-store';
import { PAY_LEDGER_EVENTS, Payments } from './application/payments';
import { ProviderPayments } from './application/provider-payments';
import { REFUND_KIND, Refunds } from './application/refunds';
import { PaymentWebhooks } from './application/webhooks';
import { PgPaymentStore } from './infrastructure/pg-payment-store';
import { PaymentsController, RefundsController, WebhooksController } from './interface/payments.controller';

/**
 * PAY (layer 7): payments, their allocations, the provider port's charges and webhooks, refunds and the break queue
 * (B9a, B09a continued). A selling module records a tender through `Payments.recordIn` in its own serializable
 * transaction; a provider payment clears only through `ProviderPayments.settleIn` on the provider's own answer; the
 * ledger posts PAY's ◆ events in the same transaction. Manual receipts, cheques, store credit, reversals and settlement
 * reconciliation follow in B09a continued 1b (A-211).
 */
@Module({
  imports: [IamModule, MdmModule, BilModule],
  controllers: [PaymentsController, RefundsController, WebhooksController],
  providers: [
    { provide: PAYMENT_STORE, useClass: PgPaymentStore },
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
      ) => new Payments(store, refs, billing, documents, events, audit, clock, uow, authoriser, idempotency, cursors),
      inject: [PAYMENT_STORE, MasterDataRefs, Billing, DocumentRegistry, DomainEvents, AuditTrail, CLOCK, UnitOfWork, Authoriser, Idempotency, Cursors],
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
      ) => new Refunds(store, payments, refs, documents, events, audit, breaks, uow, authoriser, idempotency, approvals, principals, cursors, provider, clock, logger),
      inject: [PAYMENT_STORE, Payments, MasterDataRefs, DocumentRegistry, DomainEvents, AuditTrail, Breaks, UnitOfWork, Authoriser, Idempotency, Approvals, PRINCIPAL_NAMES, Cursors, PAYMENT_PROVIDER, CLOCK, LOGGER],
    },
  ],
  exports: [Payments, ProviderPayments, Refunds],
})
export class PayModule implements OnModuleInit {
  constructor(
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(Approvals) private readonly approvals: Approvals,
    @Inject(Refunds) private readonly refunds: Refunds,
  ) {}

  /** Declares PAY's ◆ events for the ledger's boot assertion (ADR-0056) and registers the `REFUND` approval handler. */
  onModuleInit(): void {
    this.events.declareLedgerEvents(PAY_LEDGER_EVENTS);
    this.approvals.registerHandler(REFUND_KIND, this.refunds.approvalHandler);
  }
}
