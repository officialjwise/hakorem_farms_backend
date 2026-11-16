import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { DomainEvents } from '../../platform/events/domain-events';
import { CLOCK } from '../../platform/platform.module';
import { BilModule, Billing } from '../bil';
import { MasterDataRefs, MdmModule } from '../mdm';
import { PAYMENT_STORE, type PaymentStore } from './application/payment-store';
import { PAY_LEDGER_EVENTS, Payments } from './application/payments';
import { PgPaymentStore } from './infrastructure/pg-payment-store';

/**
 * PAY (layer 7): payments and their allocations (B9a). A selling module records a tender through `Payments.recordIn` in
 * its own serializable transaction; allocations move BIL's settlement summary through `Billing.settleIn`; the ledger
 * posts ◆ `pay.PaymentCleared` in the same transaction. The provider port, webhooks, refunds, store credit and
 * reconciliation follow in B09a continued (A-209).
 */
@Module({
  imports: [MdmModule, BilModule],
  providers: [
    { provide: PAYMENT_STORE, useClass: PgPaymentStore },
    {
      provide: Payments,
      useFactory: (store: PaymentStore, refs: MasterDataRefs, billing: Billing, documents: DocumentRegistry, events: DomainEvents, audit: AuditTrail, clock: Clock) =>
        new Payments(store, refs, billing, documents, events, audit, clock),
      inject: [PAYMENT_STORE, MasterDataRefs, Billing, DocumentRegistry, DomainEvents, AuditTrail, CLOCK],
    },
  ],
  exports: [Payments],
})
export class PayModule implements OnModuleInit {
  constructor(@Inject(DomainEvents) private readonly events: DomainEvents) {}

  /** Declares PAY's ◆ events for the ledger's boot assertion (ADR-0056). */
  onModuleInit(): void {
    this.events.declareLedgerEvents(PAY_LEDGER_EVENTS);
  }
}
