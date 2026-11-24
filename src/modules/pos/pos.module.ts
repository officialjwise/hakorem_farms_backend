import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import { AuditAnchorRequests } from '../../platform/audit/audit-anchor-requests';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { NumberSeries } from '../../platform/documents/number-series';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK } from '../../platform/platform.module';
import { Settings } from '../../platform/settings/settings';
import { APP_CONFIG, receiptLinkTemplate, type AppConfig } from '../../platform/config/app-config';
import { AudModule, BusinessProfiles } from '../aud';
import { Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { InvModule, StockQueries, StockUnits } from '../inv';
import { LivModule, Weighing } from '../liv';
import { MasterDataRefs, MdmModule, PricingService, TaxService } from '../mdm';
import { BilModule, Billing } from '../bil';
import { FinModule, Ledger } from '../fin';
import { OrdModule, Orders, SalePosting } from '../ord';
import { PayModule, Payments, TillShiftRegistry, UnverifiedTenders } from '../pay';
import { CounterSales } from './application/counter-sales';
import { Devices } from './application/devices';
import { HeldSales } from './application/held-sales';
import { OfflinePacks } from './application/offline-packs';
import { OfflineSync } from './application/offline-sync';
import { Registers } from './application/registers';
import { POS_LEDGER_EVENTS, Shifts } from './application/shifts';
import { TillCash } from './application/till-cash';
import { TILL_STORE, type TillStore } from './application/till-store';
import { PgTillStore } from './infrastructure/pg-till-store';
import { PIN_STORE, type PinStore } from './application/pin-store';
import { TillPins } from './application/till-pins';
import { PgPinStore } from './infrastructure/pg-pin-store';
import { PosController } from './interface/pos.controller';
import { ReceiptsController } from './interface/receipts.controller';
import { TillInvoicesController } from './interface/till-invoices.controller';
import { TillInvoicePayments } from './application/till-invoices';
import { OwnOpenShift } from './application/own-open-shift';
import { TillDriverCash } from './application/till-driver-cash';
import { DelModule, DriverCashReconciliations } from '../del';
import { ReceiptLinks } from './application/receipt-links';
import { RECEIPT_LINK_STORE, type ReceiptLinkStore } from './application/receipt-link-store';
import { PgReceiptLinkStore } from './infrastructure/pg-receipt-link-store';

/**
 * POS (layer 10): the till. B9b builds registers and shifts: the opening float, cash drops, pay-outs and pay-ins, the
 * X and Z reports, and the blind close signed off by a supervisor, which posts the over or short. A sale on the till
 * posts through ORD's one sale path; its cash is PAY's payment against the shift. Device enrolment, the counter sale's
 * endpoint and the offline sync follow (A-273 (a)). B09b continued registers `TillCash`, POS's answer to PAY's
 * `TillShiftCheck` port, so no PAY path takes or pays out a till's cash outside its open shift (ADR-0077). B09b
 * continued 2 adds the offline pack (`OfflinePacks`), reading INV's stock standing at the till.
 */
@Module({
  imports: [IamModule, AudModule, MdmModule, FinModule, InvModule, LivModule, BilModule, PayModule, DelModule, OrdModule],
  controllers: [PosController, ReceiptsController, TillInvoicesController],
  providers: [
    { provide: TILL_STORE, useClass: PgTillStore },
    { provide: PIN_STORE, useClass: PgPinStore },
    {
      provide: TillPins,
      useFactory: (
        uow: UnitOfWork,
        pins: PinStore,
        store: TillStore,
        devices: Devices,
        authoriser: Authoriser,
        principals: PrincipalNames,
        idempotency: Idempotency,
        settings: Settings,
        events: DomainEvents,
        audit: AuditTrail,
        clock: Clock,
      ) => new TillPins(uow, pins, store, devices, authoriser, principals, idempotency, settings, events, audit, clock),
      inject: [UnitOfWork, PIN_STORE, TILL_STORE, Devices, Authoriser, PRINCIPAL_NAMES, Idempotency, Settings, DomainEvents, AuditTrail, CLOCK],
    },
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
      provide: HeldSales,
      useFactory: (uow: UnitOfWork, store: TillStore, devices: Devices, pricing: PricingService, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, principals: PrincipalNames, cursors: Cursors, clock: Clock) =>
        new HeldSales(uow, store, devices, pricing, authoriser, idempotency, audit, principals, cursors, clock),
      inject: [UnitOfWork, TILL_STORE, Devices, PricingService, Authoriser, Idempotency, AuditTrail, PRINCIPAL_NAMES, Cursors, CLOCK],
    },
    {
      provide: CounterSales,
      useFactory: (
        uow: UnitOfWork,
        store: TillStore,
        devices: Devices,
        posting: SalePosting,
        orders: Orders,
        billing: Billing,
        refs: MasterDataRefs,
        authoriser: Authoriser,
        idempotency: Idempotency,
        events: DomainEvents,
        clock: Clock,
        pricing: PricingService,
        settings: Settings,
      ) => new CounterSales(uow, store, devices, posting, orders, billing, refs, authoriser, idempotency, events, clock, pricing, settings),
      inject: [UnitOfWork, TILL_STORE, Devices, SalePosting, Orders, Billing, MasterDataRefs, Authoriser, Idempotency, DomainEvents, CLOCK, PricingService, Settings],
    },
    {
      provide: OfflinePacks,
      useFactory: (
        uow: UnitOfWork,
        store: TillStore,
        devices: Devices,
        pricing: PricingService,
        tax: TaxService,
        refs: MasterDataRefs,
        stock: StockQueries,
        units: StockUnits,
        authoriser: Authoriser,
        settings: Settings,
        audit: AuditTrail,
        clock: Clock,
        config: AppConfig,
        weighing: Weighing,
      ) => new OfflinePacks(uow, store, devices, pricing, tax, refs, stock, units, authoriser, settings, audit, clock, weighing, receiptLinkTemplate(config)),
      inject: [UnitOfWork, TILL_STORE, Devices, PricingService, TaxService, MasterDataRefs, StockQueries, StockUnits, Authoriser, Settings, AuditTrail, CLOCK, APP_CONFIG, Weighing],
    },
    {
      provide: OfflineSync,
      useFactory: (
        uow: UnitOfWork,
        store: TillStore,
        devices: Devices,
        posting: SalePosting,
        orders: Orders,
        refs: MasterDataRefs,
        pricing: PricingService,
        authoriser: Authoriser,
        ledger: Ledger,
        settings: Settings,
        events: DomainEvents,
        audit: AuditTrail,
        clock: Clock,
        payments: Payments,
        unverified: UnverifiedTenders,
        pins: TillPins,
        receipts: ReceiptLinks,
        units: StockUnits,
        weighing: Weighing,
      ) => new OfflineSync(uow, store, devices, posting, orders, refs, pricing, authoriser, ledger, settings, events, audit, clock, payments, unverified, pins, receipts, units, weighing),
      inject: [UnitOfWork, TILL_STORE, Devices, SalePosting, Orders, MasterDataRefs, PricingService, Authoriser, Ledger, Settings, DomainEvents, AuditTrail, CLOCK, Payments, UnverifiedTenders, TillPins, ReceiptLinks, StockUnits, Weighing],
    },
    { provide: RECEIPT_LINK_STORE, useClass: PgReceiptLinkStore },
    {
      provide: OwnOpenShift,
      useFactory: (store: TillStore, devices: Devices, authoriser: Authoriser) => new OwnOpenShift(store, devices, authoriser),
      inject: [TILL_STORE, Devices, Authoriser],
    },
    {
      provide: TillInvoicePayments,
      useFactory: (uow: UnitOfWork, ownShift: OwnOpenShift, billing: Billing, payments: Payments, idempotency: Idempotency, audit: AuditTrail, clock: Clock) =>
        new TillInvoicePayments(uow, ownShift, billing, payments, idempotency, audit, clock),
      inject: [UnitOfWork, OwnOpenShift, Billing, Payments, Idempotency, AuditTrail, CLOCK],
    },
    {
      provide: TillDriverCash,
      useFactory: (uow: UnitOfWork, ownShift: OwnOpenShift, cash: DriverCashReconciliations, idempotency: Idempotency, audit: AuditTrail) => new TillDriverCash(uow, ownShift, cash, idempotency, audit),
      inject: [UnitOfWork, OwnOpenShift, DriverCashReconciliations, Idempotency, AuditTrail],
    },
    {
      provide: ReceiptLinks,
      useFactory: (uow: UnitOfWork, store: ReceiptLinkStore, orders: Orders, billing: Billing, refs: MasterDataRefs, profiles: BusinessProfiles, clock: Clock, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, principals: PrincipalNames) =>
        new ReceiptLinks(uow, store, orders, billing, refs, profiles, clock, createUuidV7Generator(clock), authoriser, idempotency, audit, principals),
      inject: [UnitOfWork, RECEIPT_LINK_STORE, Orders, Billing, MasterDataRefs, BusinessProfiles, CLOCK, Authoriser, Idempotency, AuditTrail, PRINCIPAL_NAMES],
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
        anchors: AuditAnchorRequests,
        held: HeldSales,
        settings: Settings,
        devices: Devices,
        pins: TillPins,
      ) => new Shifts(uow, store, refs, authoriser, idempotency, audit, events, documents, numbers, principals, cursors, payments, orders, clock, anchors, held, settings, devices, pins),
      inject: [UnitOfWork, TILL_STORE, MasterDataRefs, Authoriser, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, NumberSeries, PRINCIPAL_NAMES, Cursors, Payments, Orders, CLOCK, AuditAnchorRequests, HeldSales, Settings, Devices, TillPins],
    },
  ],
  // ReceiptLinks for NTF's receipt SMS (B11 continued 12): `issueMessageLinkIn` only, the parent session's leave.
  exports: [Registers, Shifts, Devices, TillPins, ReceiptLinks],
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
