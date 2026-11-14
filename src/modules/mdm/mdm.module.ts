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
import { PgPriceListStore } from './infrastructure/pg-price-list-store';
import { PgPricingStore } from './infrastructure/pg-pricing-store';
import { PriceListsController } from './interface/price-lists.controller';
import { PricingController } from './interface/pricing.controller';
import { ProductCatalogue } from './application/product-catalogue';
import { PRODUCT_STORE, type ProductStore } from './application/product-store';
import { DrizzleProductStore } from './infrastructure/drizzle-product-store';
import { MdmScopeNames } from './infrastructure/scope-names';
import { ProductsController } from './interface/products.controller';

/**
 * MDM (layer 3): the Product slice, the pricing sub-domain (price lists with maker-checker activation and the
 * engine, ADR-0004), IAM's ScopeNames port and the PRICE_LIST_ACTIVATION approval handler. Tax, promotions and the
 * rest of master data arrive with B04 continued.
 */
@Module({
  imports: [IamModule],
  controllers: [ProductsController, PricingController, PriceListsController],
  providers: [
    { provide: PRODUCT_STORE, useClass: DrizzleProductStore },
    { provide: PRICING_STORE, useClass: PgPricingStore },
    { provide: PRICE_LIST_STORE, useClass: PgPriceListStore },
    {
      provide: PricingService,
      useFactory: (uow: UnitOfWork, store: PricingStore, authoriser: Authoriser, clock: Clock) => new PricingService(uow, store, authoriser, clock),
      inject: [UnitOfWork, PRICING_STORE, Authoriser, CLOCK],
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
      ) => new PriceListAdmin(uow, store, authoriser, approvals, principals, documents, idempotency, audit, events, clock),
      inject: [UnitOfWork, PRICE_LIST_STORE, Authoriser, Approvals, PRINCIPAL_NAMES, DocumentRegistry, Idempotency, AuditTrail, DomainEvents, CLOCK],
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
  ],
  exports: [PricingService],
})
export class MdmModule implements OnModuleInit {
  constructor(
    @Inject(ScopeNamesRegistry) private readonly scopeNames: ScopeNamesRegistry,
    @Inject(MdmScopeNames) private readonly implementation: MdmScopeNames,
    @Inject(Approvals) private readonly approvals: Approvals,
    @Inject(PriceListAdmin) private readonly priceLists: PriceListAdmin,
  ) {}

  /** Registers MDM's implementation of IAM's ScopeNames port (ADR-0033) and MDM's approval handlers (ADR-0017). */
  onModuleInit(): void {
    this.scopeNames.register(this.implementation);
    this.approvals.registerHandler(PRICE_LIST_ACTIVATION, this.priceLists);
  }
}
