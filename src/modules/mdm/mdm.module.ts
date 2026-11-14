import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK } from '../../platform/platform.module';
import { Authoriser, IamModule, ScopeNamesRegistry } from '../iam';
import { ProductCatalogue } from './application/product-catalogue';
import { PRODUCT_STORE, type ProductStore } from './application/product-store';
import { DrizzleProductStore } from './infrastructure/drizzle-product-store';
import { MdmScopeNames } from './infrastructure/scope-names';
import { ProductsController } from './interface/products.controller';

/**
 * MDM (layer 3). In B3 it holds the Product slice, the exemplar every later module copies, and answers IAM's
 * ScopeNames port; the rest of master data, pricing and tax arrive in B4.
 */
@Module({
  imports: [IamModule],
  controllers: [ProductsController],
  providers: [
    { provide: PRODUCT_STORE, useClass: DrizzleProductStore },
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
})
export class MdmModule implements OnModuleInit {
  constructor(
    @Inject(ScopeNamesRegistry) private readonly scopeNames: ScopeNamesRegistry,
    @Inject(MdmScopeNames) private readonly implementation: MdmScopeNames,
  ) {}

  /** Registers MDM's implementation of IAM's ScopeNames port (MODULE_BOUNDARIES section 6, ADR-0031). */
  onModuleInit(): void {
    this.scopeNames.register(this.implementation);
  }
}
