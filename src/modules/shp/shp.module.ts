import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK } from '../../platform/platform.module';
import { Settings } from '../../platform/settings/settings';
import { DelModule, Slots } from '../del';
import { IamModule } from '../iam';
import { InvModule, Reservations, StockQueries } from '../inv';
import { MasterDataRefs, MdmModule, PricingService, Storefront, TaxService } from '../mdm';
import { Carts } from './application/carts';
import { Catalogue, CatalogueListing } from './application/catalogue';
import { Checkouts } from './application/checkouts';
import { SHP_STORE, type ShpStore } from './application/shp-store';
import { PgShpStore } from './infrastructure/pg-shp-store';
import { ShopController } from './interface/shop.controller';

/**
 * SHP (layer 10): the online store. B07 continued 2 builds the public catalogue and its read model, guest carts with
 * prices re-resolved by MDM's engine and coupons, and checkout reserving every line through INV's `Reservations`
 * until the reservation lifetime ends. Order placement and payment are B09a; abandoned-cart messages B11.
 */
@Module({
  imports: [IamModule, MdmModule, InvModule, DelModule],
  controllers: [ShopController],
  providers: [
    { provide: SHP_STORE, useClass: PgShpStore },
    {
      provide: CatalogueListing,
      useFactory: (uow: UnitOfWork, store: ShpStore, storefront: Storefront, pricing: PricingService, refs: MasterDataRefs, stock: StockQueries, settings: Settings) =>
        new CatalogueListing(uow, store, storefront, pricing, refs, stock, settings),
      inject: [UnitOfWork, SHP_STORE, Storefront, PricingService, MasterDataRefs, StockQueries, Settings],
    },
    {
      provide: Catalogue,
      useFactory: (uow: UnitOfWork, store: ShpStore, listing: CatalogueListing, storefront: Storefront, cursors: Cursors) => new Catalogue(uow, store, listing, storefront, cursors),
      inject: [UnitOfWork, SHP_STORE, CatalogueListing, Storefront, Cursors],
    },
    {
      provide: Carts,
      useFactory: (
        uow: UnitOfWork,
        store: ShpStore,
        listing: CatalogueListing,
        storefront: Storefront,
        pricing: PricingService,
        refs: MasterDataRefs,
        stock: StockQueries,
        idempotency: Idempotency,
        audit: AuditTrail,
        clock: Clock,
        config: AppConfig,
      ) => new Carts(uow, store, listing, storefront, pricing, refs, stock, idempotency, audit, clock, Buffer.from(config.LOOKUP_HMAC_KEY, 'base64')),
      inject: [UnitOfWork, SHP_STORE, CatalogueListing, Storefront, PricingService, MasterDataRefs, StockQueries, Idempotency, AuditTrail, CLOCK, APP_CONFIG],
    },
    {
      provide: Checkouts,
      useFactory: (
        uow: UnitOfWork,
        store: ShpStore,
        carts: Carts,
        listing: CatalogueListing,
        storefront: Storefront,
        pricing: PricingService,
        tax: TaxService,
        stock: StockQueries,
        reservations: Reservations,
        slots: Slots,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        documents: DocumentRegistry,
        settings: Settings,
        clock: Clock,
      ) => new Checkouts(uow, store, carts, listing, storefront, pricing, tax, stock, reservations, slots, idempotency, audit, events, documents, settings, clock),
      inject: [UnitOfWork, SHP_STORE, Carts, CatalogueListing, Storefront, PricingService, TaxService, StockQueries, Reservations, Slots, Idempotency, AuditTrail, DomainEvents, DocumentRegistry, Settings, CLOCK],
    },
  ],
  exports: [CatalogueListing, Carts, Checkouts],
})
export class ShpModule implements OnModuleInit {
  constructor(
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(Checkouts) private readonly checkouts: Checkouts,
  ) {}

  /** A checkout ends in the transaction that ends one of its reservations (ADR-0010; MODULE_BOUNDARIES SHP card, A-178). */
  onModuleInit(): void {
    this.events.subscribeInTransaction('inv.ReservationExpired', (tx, event) => this.checkouts.reservationEndedIn(tx, event));
    this.events.subscribeInTransaction('inv.ReservationReleased', (tx, event) => this.checkouts.reservationEndedIn(tx, event));
  }
}
