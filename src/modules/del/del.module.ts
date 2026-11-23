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
import { FileStore } from '../../platform/storage/file-store';
import { Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { MasterDataRefs, MdmModule, Storefront } from '../mdm';
import { DriverCash, PayModule } from '../pay';
import { DEL_LEDGER_EVENTS, Deliveries } from './application/deliveries';
import { DELIVERY_STORE, type DeliveryStore } from './application/delivery-store';
import { PgDeliveryStore } from './infrastructure/pg-delivery-store';
import { DeliveriesController, DriverDeliveriesController } from './interface/deliveries.controller';
import { SLOT_STORE, type SlotStore } from './application/slot-store';
import { Slots } from './application/slots';
import { PgSlotStore } from './infrastructure/pg-slot-store';
import { SlotsController } from './interface/slots.controller';

/**
 * DEL (layer 8): delivery and logistics. B07 continued 2 builds its first pass, as ADR-0026's delivery split decides:
 * `del.delivery_slot` and slot generation, so the storefront checkout's foreign key exists. B11 continued adds
 * deliveries made at dispatch, the driver's own reads and the proof of delivery with the cash collected (`Deliveries`);
 * booking against capacity, cut-offs, routes, failures and the driver's cash reconciliation follow in B11 continued 2.
 */
@Module({
  imports: [IamModule, MdmModule, PayModule],
  controllers: [SlotsController, DeliveriesController, DriverDeliveriesController],
  providers: [
    { provide: SLOT_STORE, useClass: PgSlotStore },
    { provide: DELIVERY_STORE, useClass: PgDeliveryStore },
    {
      provide: Deliveries,
      useFactory: (
        uow: UnitOfWork,
        store: DeliveryStore,
        refs: MasterDataRefs,
        storefront: Storefront,
        driverCash: DriverCash,
        files: FileStore,
        numbers: NumberSeries,
        documents: DocumentRegistry,
        events: DomainEvents,
        idempotency: Idempotency,
        audit: AuditTrail,
        authoriser: Authoriser,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new Deliveries(uow, store, refs, storefront, driverCash, files, numbers, documents, events, idempotency, audit, authoriser, principals, cursors, clock),
      inject: [UnitOfWork, DELIVERY_STORE, MasterDataRefs, Storefront, DriverCash, FileStore, NumberSeries, DocumentRegistry, DomainEvents, Idempotency, AuditTrail, Authoriser, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: Slots,
      useFactory: (uow: UnitOfWork, store: SlotStore, refs: MasterDataRefs, storefront: Storefront, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, cursors: Cursors, clock: Clock) =>
        new Slots(uow, store, refs, storefront, authoriser, idempotency, audit, cursors, clock),
      inject: [UnitOfWork, SLOT_STORE, MasterDataRefs, Storefront, Authoriser, Idempotency, AuditTrail, Cursors, CLOCK],
    },
  ],
  exports: [Slots, Deliveries],
})
export class DelModule implements OnModuleInit {
  constructor(@Inject(DomainEvents) private readonly events: DomainEvents) {}

  onModuleInit(): void {
    this.events.declareLedgerEvents(DEL_LEDGER_EVENTS);
  }
}
