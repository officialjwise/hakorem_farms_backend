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
import { BilModule, Billing } from '../bil';
import { Approvals, Authoriser, IamModule, PRINCIPAL_NAMES, type PrincipalNames } from '../iam';
import { InvModule, Reservations, Stock, StockExceptions, StockMovements, StockQueries, StockUnits } from '../inv';
import { MasterDataRefs, MdmModule, PricingService } from '../mdm';
import { PayModule, Payments, ProviderPayments, Receipts, Refunds } from '../pay';
import { ORDER_CONFIRMATION_POLICIES, type OrderConfirmationPolicy } from './application/order-confirmation-policy';
import { OrderReversals, SALE_VOID_KIND } from './application/order-reversals';
import { ORDER_STORE, type OrderStore } from './application/order-store';
import { Orders } from './application/orders';
import { RETURN_STORE, type ReturnStore } from './application/return-store';
import { RETURN_KIND, Returns } from './application/returns';
import { SalePosting } from './application/sale-posting';
import { PgOrderStore } from './infrastructure/pg-order-store';
import { PgReturnStore } from './infrastructure/pg-return-store';
import { OrdersController } from './interface/orders.controller';
import { ReturnsController } from './interface/returns.controller';

/**
 * ORD (layer 9): the one order record of every channel and the sale posting that issues stock, the billing document
 * and the tenders in one serializable transaction (B9a). B09a continued 2b adds `Orders` (the order record's reads, entry and
 * confirmation) and the `OrderConfirmationPolicy` port; cancellation, voids, returns, price override approvals and online
 * placement follow in B09a continued 2c (A-225), which adds `OrderReversals` (cancellation and the void under `SALE_VOID`), and B09a continued 2d adds `Returns` (returns against the sale under `RETURN`, A-228); POS's counter sale (B9b) and fulfilment's dispatch (B11) call `SalePosting.postIn`.
 */
@Module({
  imports: [IamModule, MdmModule, InvModule, BilModule, PayModule],
  controllers: [OrdersController, ReturnsController],
  providers: [
    { provide: ORDER_STORE, useClass: PgOrderStore },
    { provide: RETURN_STORE, useClass: PgReturnStore },
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
      provide: OrderReversals,
      useFactory: (
        uow: UnitOfWork,
        store: OrderStore,
        orders: Orders,
        refs: MasterDataRefs,
        reservations: Reservations,
        movements: StockMovements,
        billing: Billing,
        payments: Payments,
        providerPayments: ProviderPayments,
        refunds: Refunds,
        receipts: Receipts,
        approvals: Approvals,
        authoriser: Authoriser,
        idempotency: Idempotency,
        events: DomainEvents,
        audit: AuditTrail,
        clock: Clock,
      ) => new OrderReversals(uow, store, orders, refs, reservations, movements, billing, payments, providerPayments, refunds, receipts, approvals, authoriser, idempotency, events, audit, clock),
      inject: [
        UnitOfWork,
        ORDER_STORE,
        Orders,
        MasterDataRefs,
        Reservations,
        StockMovements,
        Billing,
        Payments,
        ProviderPayments,
        Refunds,
        Receipts,
        Approvals,
        Authoriser,
        Idempotency,
        DomainEvents,
        AuditTrail,
        CLOCK,
      ],
    },
    {
      provide: Returns,
      useFactory: (
        uow: UnitOfWork,
        store: ReturnStore,
        orders: OrderStore,
        refs: MasterDataRefs,
        movements: StockMovements,
        billing: Billing,
        payments: Payments,
        refunds: Refunds,
        approvals: Approvals,
        authoriser: Authoriser,
        principals: PrincipalNames,
        numbers: NumberSeries,
        documents: DocumentRegistry,
        idempotency: Idempotency,
        events: DomainEvents,
        audit: AuditTrail,
        clock: Clock,
      ) => new Returns(uow, store, orders, refs, movements, billing, payments, refunds, approvals, authoriser, principals, numbers, documents, idempotency, events, audit, clock),
      inject: [
        UnitOfWork,
        RETURN_STORE,
        ORDER_STORE,
        MasterDataRefs,
        StockMovements,
        Billing,
        Payments,
        Refunds,
        Approvals,
        Authoriser,
        PRINCIPAL_NAMES,
        NumberSeries,
        DocumentRegistry,
        Idempotency,
        DomainEvents,
        AuditTrail,
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
  exports: [SalePosting, Orders, OrderReversals, Returns],
})
export class OrdModule implements OnModuleInit {
  constructor(
    @Inject(Approvals) private readonly approvals: Approvals,
    @Inject(OrderReversals) private readonly reversals: OrderReversals,
    @Inject(Returns) private readonly returns: Returns,
  ) {}

  /** Registers the `SALE_VOID` and `RETURN` approval handlers. */
  onModuleInit(): void {
    this.approvals.registerHandler(SALE_VOID_KIND, this.reversals.approvalHandler);
    this.approvals.registerHandler(RETURN_KIND, this.returns.approvalHandler);
  }
}
