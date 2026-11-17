import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { NumberSeries } from '../../platform/documents/number-series';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK } from '../../platform/platform.module';
import { Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { MasterDataRefs, MdmModule } from '../mdm';
import { OrdModule, Orders } from '../ord';
import { PayModule, Payments, TillShiftRegistry } from '../pay';
import { Devices } from './application/devices';
import { Registers } from './application/registers';
import { POS_LEDGER_EVENTS, Shifts } from './application/shifts';
import { TillCash } from './application/till-cash';
import { TILL_STORE, type TillStore } from './application/till-store';
import { PgTillStore } from './infrastructure/pg-till-store';
import { PosController } from './interface/pos.controller';

/**
 * POS (layer 10): the till. B9b builds registers and shifts: the opening float, cash drops, pay-outs and pay-ins, the
 * X and Z reports, and the blind close signed off by a supervisor, which posts the over or short. A sale on the till
 * posts through ORD's one sale path; its cash is PAY's payment against the shift. Device enrolment, the counter sale's
 * endpoint and the offline sync follow (A-273 (a)). B09b continued registers `TillCash`, POS's answer to PAY's
 * `TillShiftCheck` port, so no PAY path takes or pays out a till's cash outside its open shift (ADR-0077).
 */
@Module({
  imports: [IamModule, MdmModule, PayModule, OrdModule],
  controllers: [PosController],
  providers: [
    { provide: TILL_STORE, useClass: PgTillStore },
    {
      provide: Registers,
      useFactory: (uow: UnitOfWork, store: TillStore, refs: MasterDataRefs, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, principals: PrincipalNames, cursors: Cursors, clock: Clock) =>
        new Registers(uow, store, refs, authoriser, idempotency, audit, principals, cursors, clock, createUuidV7Generator(clock)),
      inject: [UnitOfWork, TILL_STORE, MasterDataRefs, Authoriser, Idempotency, AuditTrail, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: Devices,
      useFactory: (uow: UnitOfWork, store: TillStore, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, principals: PrincipalNames, cursors: Cursors, clock: Clock) =>
        new Devices(uow, store, authoriser, idempotency, audit, principals, cursors, clock, createUuidV7Generator(clock)),
      inject: [UnitOfWork, TILL_STORE, Authoriser, Idempotency, AuditTrail, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: Shifts,
      useFactory: (
        uow: UnitOfWork,
        store: TillStore,
        refs: MasterDataRefs,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        documents: DocumentRegistry,
        numbers: NumberSeries,
        principals: PrincipalNames,
        cursors: Cursors,
        payments: Payments,
        orders: Orders,
        clock: Clock,
      ) => new Shifts(uow, store, refs, authoriser, idempotency, audit, events, documents, numbers, principals, cursors, payments, orders, clock),
      inject: [UnitOfWork, TILL_STORE, MasterDataRefs, Authoriser, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, NumberSeries, PRINCIPAL_NAMES, Cursors, Payments, Orders, CLOCK],
    },
  ],
  exports: [Registers, Shifts, Devices],
})
export class PosModule implements OnModuleInit {
  constructor(
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(TillShiftRegistry) private readonly tills: TillShiftRegistry,
    @Inject(TILL_STORE) private readonly store: TillStore,
    @Inject(Authoriser) private readonly authoriser: Authoriser,
  ) {}

  onModuleInit(): void {
    this.events.declareLedgerEvents(POS_LEDGER_EVENTS);
    // PAY asks POS before any cash moves into or out of a till (ADR-0077).
    this.tills.register(new TillCash(this.store, this.authoriser));
  }
}
