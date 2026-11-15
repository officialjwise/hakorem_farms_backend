import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK } from '../../platform/platform.module';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { Approvals, Authoriser, IamModule, PRINCIPAL_NAMES, ScopeNamesRegistry, type PrincipalNames } from '../iam';
import { PRICE_LIST_ACTIVATION, PriceListAdmin } from './application/price-lists';
import { PRICE_LIST_STORE, type PriceListStore } from './application/price-list-store';
import { PricingService } from './application/pricing';
import { PRICING_STORE, type PricingStore } from './application/pricing-store';
import { PROMOTION_STORE, type PromotionStore } from './application/promotion-store';
import { PROMOTION_ACTIVATION, Promotions } from './application/promotions';
import { PgPromotionStore } from './infrastructure/pg-promotion-store';
import { PromotionsController } from './interface/promotions.controller';
import { PgPriceListStore } from './infrastructure/pg-price-list-store';
import { PgPricingStore } from './infrastructure/pg-pricing-store';
import { PriceListsController } from './interface/price-lists.controller';
import { PricingController } from './interface/pricing.controller';
import { ProductCatalogue } from './application/product-catalogue';
import { ProductGallery } from './application/product-gallery';
import { PRODUCT_STORE, type ProductStore } from './application/product-store';
import { DrizzleProductStore } from './infrastructure/drizzle-product-store';
import { MdmScopeNames } from './infrastructure/scope-names';
import { ProductsController } from './interface/products.controller';
import { Settings } from '../../platform/settings/settings';
import { FileStore } from '../../platform/storage/file-store';
import { TAX_SCHEME_ACTIVATION, TaxAdmin } from './application/tax-admin';
import { TaxService } from './application/tax-calculation';
import { TAX_STORE, type TaxStore } from './application/tax-store';
import { PgTaxStore } from './infrastructure/pg-tax-store';
import { TaxController } from './interface/tax.controller';
import { CatalogueAdmin } from './application/catalogue-admin';
import { CATALOGUE_STORE, type CatalogueStore } from './application/catalogue-store';
import { PgCatalogueStore } from './infrastructure/pg-catalogue-store';
import { CatalogueController } from './interface/catalogue.controller';
import { LocationsAdmin } from './application/locations-admin';
import { LOCATIONS_STORE, type LocationsStore } from './application/locations-store';
import { PartiesAdmin } from './application/parties-admin';
import { PARTIES_STORE, type PartiesStore } from './application/parties-store';
import { PgLocationsStore } from './infrastructure/pg-locations-store';
import { PgPartiesStore } from './infrastructure/pg-parties-store';
import { LocationsController } from './interface/locations.controller';
import { PartiesController } from './interface/parties.controller';
import { SubjectKeys } from '../../platform/crypto/subject-keys';
import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { ReferenceDataAdmin } from './application/reference-data-admin';
import { REFERENCE_DATA_STORE, type ReferenceDataStore } from './application/reference-data-store';
import { PgReferenceDataStore } from './infrastructure/pg-reference-data-store';
import { ReferenceDataController } from './interface/reference-data.controller';
import { MdmImports } from './application/imports';
import { CustomerSheet } from './application/import-sheets';
import { LocationSheet } from './application/location-sheet';
import { PriceEntrySheet } from './application/price-entry-sheet';
import { ProductSheet } from './application/product-sheet';
import { SupplierSheet } from './application/supplier-sheet';
import { IMPORT_STORE, SHEET_LOOKUPS, type ImportStore, type SheetLookups } from './application/import-store';
import { MASTER_DATA_REFS_STORE, MasterDataRefs, type MasterDataRefsStore } from './application/master-data-refs';
import { PgMasterDataRefsStore } from './infrastructure/pg-master-data-refs-store';
import { PgImportStore, PgSheetLookups } from './infrastructure/pg-import-store';
import { ImportsController } from './interface/imports.controller';

/**
 * MDM (layer 3): the Product slice and the catalogue's reference data (categories, units, species, grades, bands), branches and
 * locations, customers with their tiers, addresses and assigned price list (B04d continued 2), suppliers, payment
 * methods, delivery zones with the delivery quote and the fixed reason codes (B04d continued 3), the pricing sub-domain (price lists with maker-checker activation and the
 * engine, ADR-0004), the tax sub-domain (levies, scheme versions with maker-checker activation and the calculator,
 * ADR-0020), promotions and coupons (FR-MDM-018), IAM's ScopeNames port and the PRICE_LIST_ACTIVATION,
 * TAX_SCHEME_ACTIVATION and PROMOTION_ACTIVATION approval handlers.
 */
@Module({
  imports: [IamModule],
  controllers: [ProductsController, CatalogueController, LocationsController, PartiesController, ReferenceDataController, PricingController, PriceListsController, PromotionsController, TaxController, ImportsController],
  providers: [
    { provide: PRODUCT_STORE, useFactory: (files: FileStore) => new DrizzleProductStore(files), inject: [FileStore] },
    { provide: PRICING_STORE, useClass: PgPricingStore },
    { provide: PRICE_LIST_STORE, useClass: PgPriceListStore },
    { provide: PROMOTION_STORE, useClass: PgPromotionStore },
    {
      provide: PricingService,
      useFactory: (uow: UnitOfWork, store: PricingStore, promotions: PromotionStore, authoriser: Authoriser, clock: Clock) => new PricingService(uow, store, promotions, authoriser, clock),
      inject: [UnitOfWork, PRICING_STORE, PROMOTION_STORE, Authoriser, CLOCK],
    },
    {
      provide: Promotions,
      useFactory: (
        uow: UnitOfWork,
        store: PromotionStore,
        authoriser: Authoriser,
        approvals: Approvals,
        documents: DocumentRegistry,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        cursors: Cursors,
        clock: Clock,
      ) => new Promotions(uow, store, authoriser, approvals, documents, idempotency, audit, events, cursors, clock),
      inject: [UnitOfWork, PROMOTION_STORE, Authoriser, Approvals, DocumentRegistry, Idempotency, AuditTrail, DomainEvents, Cursors, CLOCK],
    },
    {
      provide: PriceListAdmin,
      useFactory: (
        uow: UnitOfWork,
        store: PriceListStore,
        authoriser: Authoriser,
        approvals: Approvals,
        principals: PrincipalNames,
        documents: DocumentRegistry,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        clock: Clock,
        cursors: Cursors,
      ) => new PriceListAdmin(uow, store, authoriser, approvals, principals, documents, idempotency, audit, events, clock, cursors),
      inject: [UnitOfWork, PRICE_LIST_STORE, Authoriser, Approvals, PRINCIPAL_NAMES, DocumentRegistry, Idempotency, AuditTrail, DomainEvents, CLOCK, Cursors],
    },
    { provide: TAX_STORE, useClass: PgTaxStore },
    { provide: CATALOGUE_STORE, useClass: PgCatalogueStore },
    { provide: LOCATIONS_STORE, useClass: PgLocationsStore },
    { provide: PARTIES_STORE, useClass: PgPartiesStore },
    { provide: REFERENCE_DATA_STORE, useClass: PgReferenceDataStore },
    {
      provide: ReferenceDataAdmin,
      useFactory: (
        uow: UnitOfWork,
        store: ReferenceDataStore,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        keys: SubjectKeys,
        cursors: Cursors,
        clock: Clock,
        settings: Settings,
        config: AppConfig,
      ) => new ReferenceDataAdmin(uow, store, authoriser, idempotency, audit, events, keys, cursors, clock, settings, Buffer.from(config.LOOKUP_HMAC_KEY, 'base64')),
      inject: [UnitOfWork, REFERENCE_DATA_STORE, Authoriser, Idempotency, AuditTrail, DomainEvents, SubjectKeys, Cursors, CLOCK, Settings, APP_CONFIG],
    },
    {
      provide: LocationsAdmin,
      useFactory: (uow: UnitOfWork, store: LocationsStore, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, cursors: Cursors, clock: Clock) =>
        new LocationsAdmin(uow, store, authoriser, idempotency, audit, cursors, clock),
      inject: [UnitOfWork, LOCATIONS_STORE, Authoriser, Idempotency, AuditTrail, Cursors, CLOCK],
    },
    {
      provide: PartiesAdmin,
      useFactory: (uow: UnitOfWork, store: PartiesStore, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, keys: SubjectKeys, cursors: Cursors, clock: Clock, config: AppConfig) =>
        new PartiesAdmin(uow, store, authoriser, idempotency, audit, keys, cursors, clock, Buffer.from(config.LOOKUP_HMAC_KEY, 'base64')),
      inject: [UnitOfWork, PARTIES_STORE, Authoriser, Idempotency, AuditTrail, SubjectKeys, Cursors, CLOCK, APP_CONFIG],
    },
    {
      provide: CatalogueAdmin,
      useFactory: (uow: UnitOfWork, store: CatalogueStore, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, cursors: Cursors, clock: Clock) =>
        new CatalogueAdmin(uow, store, authoriser, idempotency, audit, cursors, clock),
      inject: [UnitOfWork, CATALOGUE_STORE, Authoriser, Idempotency, AuditTrail, Cursors, CLOCK],
    },
    {
      provide: TaxAdmin,
      useFactory: (
        uow: UnitOfWork,
        store: TaxStore,
        authoriser: Authoriser,
        approvals: Approvals,
        principals: PrincipalNames,
        documents: DocumentRegistry,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        cursors: Cursors,
        clock: Clock,
      ) => new TaxAdmin(uow, store, authoriser, approvals, principals, documents, idempotency, audit, events, cursors, clock),
      inject: [UnitOfWork, TAX_STORE, Authoriser, Approvals, PRINCIPAL_NAMES, DocumentRegistry, Idempotency, AuditTrail, DomainEvents, Cursors, CLOCK],
    },
    {
      provide: TaxService,
      useFactory: (uow: UnitOfWork, store: TaxStore, authoriser: Authoriser, settings: Settings) => new TaxService(uow, store, authoriser, settings),
      inject: [UnitOfWork, TAX_STORE, Authoriser, Settings],
    },
    MdmScopeNames,
    {
      provide: ProductCatalogue,
      useFactory: (
        uow: UnitOfWork,
        store: ProductStore,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        events: DomainEvents,
        cursors: Cursors,
        clock: Clock,
      ) => new ProductCatalogue(uow, store, authoriser, idempotency, audit, events, cursors, clock),
      inject: [UnitOfWork, PRODUCT_STORE, Authoriser, Idempotency, AuditTrail, DomainEvents, Cursors, CLOCK],
    },
    {
      provide: ProductGallery,
      useFactory: (uow: UnitOfWork, store: ProductStore, files: FileStore, authoriser: Authoriser, idempotency: Idempotency, audit: AuditTrail, events: DomainEvents, clock: Clock) =>
        new ProductGallery(uow, store, files, authoriser, idempotency, audit, events, clock),
      inject: [UnitOfWork, PRODUCT_STORE, FileStore, Authoriser, Idempotency, AuditTrail, DomainEvents, CLOCK],
    },
    { provide: IMPORT_STORE, useClass: PgImportStore },
    { provide: SHEET_LOOKUPS, useClass: PgSheetLookups },
    {
      provide: MdmImports,
      useFactory: (
        uow: UnitOfWork,
        store: ImportStore,
        files: FileStore,
        authoriser: Authoriser,
        idempotency: Idempotency,
        audit: AuditTrail,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
        parties: PartiesAdmin,
        partiesStore: PartiesStore,
        lookups: SheetLookups,
        catalogue: ProductCatalogue,
        productStore: ProductStore,
        referenceData: ReferenceDataAdmin,
        referenceDataStore: ReferenceDataStore,
        locations: LocationsAdmin,
        locationsStore: LocationsStore,
        priceLists: PriceListAdmin,
        priceListStore: PriceListStore,
      ) =>
        new MdmImports(uow, store, files, authoriser, idempotency, audit, principals, cursors, clock, [
          new ProductSheet(catalogue, productStore, lookups),
          new CustomerSheet(parties, partiesStore, clock),
          new SupplierSheet(referenceData, referenceDataStore, lookups),
          new LocationSheet(locations, locationsStore, lookups, authoriser),
          new PriceEntrySheet(priceLists, priceListStore, lookups, authoriser, clock),
        ]),
      inject: [
        UnitOfWork,
        IMPORT_STORE,
        FileStore,
        Authoriser,
        Idempotency,
        AuditTrail,
        PRINCIPAL_NAMES,
        Cursors,
        CLOCK,
        PartiesAdmin,
        PARTIES_STORE,
        SHEET_LOOKUPS,
        ProductCatalogue,
        PRODUCT_STORE,
        ReferenceDataAdmin,
        REFERENCE_DATA_STORE,
        LocationsAdmin,
        LOCATIONS_STORE,
        PriceListAdmin,
        PRICE_LIST_STORE,
      ],
    },
    { provide: MASTER_DATA_REFS_STORE, useClass: PgMasterDataRefsStore },
    { provide: MasterDataRefs, useFactory: (store: MasterDataRefsStore) => new MasterDataRefs(store), inject: [MASTER_DATA_REFS_STORE] },
  ],
  exports: [PricingService, Promotions, TaxService, MasterDataRefs, MdmImports],
})
export class MdmModule implements OnModuleInit {
  constructor(
    @Inject(ScopeNamesRegistry) private readonly scopeNames: ScopeNamesRegistry,
    @Inject(MdmScopeNames) private readonly implementation: MdmScopeNames,
    @Inject(Approvals) private readonly approvals: Approvals,
    @Inject(PriceListAdmin) private readonly priceLists: PriceListAdmin,
    @Inject(TaxAdmin) private readonly tax: TaxAdmin,
    @Inject(Promotions) private readonly promotions: Promotions,
  ) {}

  /** Registers MDM's implementation of IAM's ScopeNames port (ADR-0033) and MDM's approval handlers (ADR-0017). */
  onModuleInit(): void {
    this.scopeNames.register(this.implementation);
    this.approvals.registerHandler(PRICE_LIST_ACTIVATION, this.priceLists);
    this.approvals.registerHandler(TAX_SCHEME_ACTIVATION, this.tax);
    this.approvals.registerHandler(PROMOTION_ACTIVATION, this.promotions);
  }
}
