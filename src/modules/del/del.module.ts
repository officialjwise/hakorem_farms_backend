import { Module } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK } from '../../platform/platform.module';
import { Authoriser, IamModule } from '../iam';
import { MasterDataRefs, MdmModule, Storefront } from '../mdm';
import { SLOT_STORE, type SlotStore } from './application/slot-store';
import { Slots } from './application/slots';
import { PgSlotStore } from './infrastructure/pg-slot-store';
import { SlotsController } from './interface/slots.controller';

/**
 * DEL (layer 8): delivery and logistics. B07 continued 2 builds its first pass, as ADR-0026's delivery split decides:
 * `del.delivery_slot` and slot generation, so the storefront checkout's foreign key exists. B11 adds booking against
 * capacity, cut-offs, deliveries, routes, proof of delivery and driver cash around it.
 */
@Module({
  imports: [IamModule, MdmModule],
  controllers: [SlotsController],
  providers: [
    { provide: SLOT_STORE, useClass: PgSlotStore },
    {
      provide: Slots,
      useFactory: (uow: UnitOfWork, store: SlotStore, refs: MasterDataRefs, storefront: Storefront, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, cursors: Cursors, clock: Clock) =>
        new Slots(uow, store, refs, storefront, authoriser, idempotency, audit, cursors, clock),
      inject: [UnitOfWork, SLOT_STORE, MasterDataRefs, Storefront, Authoriser, Idempotency, AuditTrail, Cursors, CLOCK],
    },
  ],
  exports: [Slots],
})
export class DelModule {}
