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
import { Approvals, Authoriser, IamModule } from '../iam';
import { MasterDataRefs, MdmModule, TaxService } from '../mdm';
import { BIL_LEDGER_EVENTS, Billing, CREDIT_NOTE_KIND } from './application/billing';
import { BILLING_STORE, type BillingStore } from './application/billing-store';
import { PgBillingStore } from './infrastructure/pg-billing-store';
import { BillingController } from './interface/billing.controller';

/**
 * BIL (layer 6): invoices, receipts, proformas, credit notes and debit notes (B08 continued 2). A selling module issues
 * a document through `Billing.issueIn` in its own serializable transaction; levy rows come from MDM's tax calculator,
 * numbers from the platform's gap-free series, and the ledger posts each ◆ event in the issuing transaction. Rendering,
 * the archive and reprints are DOC's (B08 continued 2b).
 */
@Module({
  imports: [IamModule, MdmModule],
  controllers: [BillingController],
  providers: [
    { provide: BILLING_STORE, useClass: PgBillingStore },
    {
      provide: Billing,
      useFactory: (
        uow: UnitOfWork,
        store: BillingStore,
        refs: MasterDataRefs,
        tax: TaxService,
        numbers: NumberSeries,
        documents: DocumentRegistry,
        events: DomainEvents,
        approvals: Approvals,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        cursors: Cursors,
        clock: Clock,
      ) => new Billing(uow, store, refs, tax, numbers, documents, events, approvals, authoriser, idempotency, audit, cursors, clock),
      inject: [UnitOfWork, BILLING_STORE, MasterDataRefs, TaxService, NumberSeries, DocumentRegistry, DomainEvents, Approvals, Authoriser, Idempotency, AuditTrail, Cursors, CLOCK],
    },
  ],
  exports: [Billing],
})
export class BilModule implements OnModuleInit {
  constructor(
    @Inject(Approvals) private readonly approvals: Approvals,
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(Billing) private readonly billing: Billing,
  ) {}

  /** Registers the CREDIT_NOTE approval handler (ADR-0017) and declares BIL's ◆ events for the boot assertion (ADR-0056). */
  onModuleInit(): void {
    this.approvals.registerHandler(CREDIT_NOTE_KIND, this.billing.creditNoteApprovals);
    this.events.declareLedgerEvents(BIL_LEDGER_EVENTS);
  }
}
