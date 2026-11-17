import { Module } from '@nestjs/common';
import type { Clock } from '@hakorem/kernel';
import { AuditTrail } from '../../platform/audit/audit-trail';
import { UnitOfWork } from '../../platform/database/unit-of-work';
import { DocumentRegistry } from '../../platform/documents/document-registry';
import { NumberSeries } from '../../platform/documents/number-series';
import { DomainEvents } from '../../platform/events/domain-events';
import { Cursors } from '../../platform/http/cursor';
import { Idempotency } from '../../platform/idempotency/idempotency';
import { CLOCK } from '../../platform/platform.module';
import { BilModule, Billing } from '../bil';
import { Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { InvModule, Reservations, Stock, StockExceptions, StockQueries, StockUnits } from '../inv';
import { MasterDataRefs, MdmModule, PricingService } from '../mdm';
import { PayModule, Payments } from '../pay';
import { ORDER_CONFIRMATION_POLICIES, type OrderConfirmationPolicy } from './application/order-confirmation-policy';
import { ORDER_STORE, type OrderStore } from './application/order-store';
import { Orders } from './application/orders';
import { SalePosting } from './application/sale-posting';
import { PgOrderStore } from './infrastructure/pg-order-store';
import { OrdersController } from './interface/orders.controller';

/**
 * ORD (layer 9): the one order record of every channel and the sale posting that issues stock, the billing document
 * and the tenders in one serializable transaction (B9a). B09a continued 2b adds `Orders` (the order record's reads, entry and
 * confirmation) and the `OrderConfirmationPolicy` port; cancellation, voids, returns, price override approvals and online
 * placement follow in B09a continued 2c (A-225); POS's counter sale (B9b) and fulfilment's dispatch (B11) call `SalePosting.postIn`.
 */
@Module({
  imports: [IamModule, MdmModule, InvModule, BilModule, PayModule],
  controllers: [OrdersController],
  providers: [
    { provide: ORDER_STORE, useClass: PgOrderStore },
    // The OrderConfirmationPolicy port (MODULE_BOUNDARIES section 6): WHL registers its credit policy in B10; none yet.
    { provide: ORDER_CONFIRMATION_POLICIES, useValue: [] satisfies OrderConfirmationPolicy[] },
    {
      provide: Orders,
      useFactory: (
        uow: UnitOfWork,
        store: OrderStore,
        refs: MasterDataRefs,
        pricing: PricingService,
        units: StockUnits,
        queries: StockQueries,
        reservations: Reservations,
        exceptions: StockExceptions,
        billing: Billing,
        payments: Payments,
        policies: OrderConfirmationPolicy[],
        numbers: NumberSeries,
        documents: DocumentRegistry,
        events: DomainEvents,
        idempotency: Idempotency,
        audit: AuditTrail,
        authoriser: Authoriser,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) =>
        new Orders(
          uow,
          store,
          refs,
          pricing,
          units,
          queries,
          reservations,
          exceptions,
          billing,
          payments,
          policies,
          numbers,
          documents,
          events,
          idempotency,
          audit,
          authoriser,
          principals,
          cursors,
          clock,
        ),
      inject: [
        UnitOfWork,
        ORDER_STORE,
        MasterDataRefs,
        PricingService,
        StockUnits,
        StockQueries,
        Reservations,
        StockExceptions,
        Billing,
        Payments,
        ORDER_CONFIRMATION_POLICIES,
        NumberSeries,
        DocumentRegistry,
        DomainEvents,
        Idempotency,
        AuditTrail,
        Authoriser,
        PRINCIPAL_NAMES,
        Cursors,
        CLOCK,
      ],
    },
    {
      provide: SalePosting,
      useFactory: (
        store: OrderStore,
        refs: MasterDataRefs,
        pricing: PricingService,
        stock: Stock,
        units: StockUnits,
        reservations: Reservations,
        billing: Billing,
        payments: Payments,
        numbers: NumberSeries,
        documents: DocumentRegistry,
        events: DomainEvents,
        idempotency: Idempotency,
        audit: AuditTrail,
        clock: Clock,
      ) => new SalePosting(store, refs, pricing, stock, units, reservations, billing, payments, numbers, documents, events, idempotency, audit, clock),
      inject: [ORDER_STORE, MasterDataRefs, PricingService, Stock, StockUnits, Reservations, Billing, Payments, NumberSeries, DocumentRegistry, DomainEvents, Idempotency, AuditTrail, CLOCK],
    },
  ],
  exports: [SalePosting, Orders],
})
export class OrdModule {}
