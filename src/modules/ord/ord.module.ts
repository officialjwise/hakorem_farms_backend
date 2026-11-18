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
import { OnlineOrders } from './application/online-orders';
import { ORDER_CONFIRMATION_POLICIES, type OrderConfirmationPolicy } from './application/order-confirmation-policy';
import { OrderReversals, SALE_VOID_KIND } from './application/order-reversals';
import { ORDER_STORE, type OrderStore } from './application/order-store';
import { Orders } from './application/orders';
import { RETURN_STORE, type ReturnStore } from './application/return-store';
import { RETURN_KIND, Returns } from './application/returns';
import { PRICE_OVERRIDE_KIND, PriceOverrides } from './application/price-overrides';
import { SalePosting } from './application/sale-posting';
import { PgOrderStore } from './infrastructure/pg-order-store';
import { PgReturnStore } from './infrastructure/pg-return-store';
import { MyOrdersController, OrderTrackingController } from './interface/online-orders.controller';
import { OrdersController } from './interface/orders.controller';
import { ReturnsController } from './interface/returns.controller';

/**
 * ORD (layer 9): the one order record of every channel and the sale posting that issues stock, the billing document
 * and the tenders in one serializable transaction (B9a). B09a continued 2b adds `Orders` (the order record's reads, entry and
 * confirmation) and the `OrderConfirmationPolicy` port; cancellation, voids, returns, price override approvals and online
 * placement follow in B09a continued 2c (A-225), which adds `OrderReversals` (cancellation and the void under `SALE_VOID`), B09a continued 2d adds `Returns` (returns against the sale under `RETURN`, A-228), and B09a continued 2e adds `PriceOverrides` (`PRICE_OVERRIDE`, A-230) and the proforma; POS's counter sale (B9b) and fulfilment's dispatch (B11) call `SalePosting.postIn`.
 */
@Module({
  imports: [IamModule, MdmModule, InvModule, BilModule, PayModule],
  controllers: [OrdersController, ReturnsController, MyOrdersController, OrderTrackingController],
  providers: [
    { provide: ORDER_STORE, useClass: PgOrderStore },
    { provide: RETURN_STORE, useClass: PgReturnStore },
    // The OrderConfirmationPolicy port (MODULE_BOUNDARIES section 6): WHL adds its credit policy to this list when it loads (B10 continued).
    { provide: ORDER_CONFIRMATION_POLICIES, useValue: [] satisfies OrderConfirmationPolicy[] },
    {
      provide: PriceOverrides,
      useFactory: (store: OrderStore, approvals: Approvals, authoriser: Authoriser, events: DomainEvents, audit: AuditTrail, clock: Clock) =>
        new PriceOverrides(store, approvals, authoriser, events, audit, clock),
      inject: [ORDER_STORE, Approvals, Authoriser, DomainEvents, AuditTrail, CLOCK],
    },
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
        overrides: PriceOverrides,
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
          overrides,
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
        PriceOverrides,
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
      provide: OnlineOrders,
      useFactory: (
        uow: UnitOfWork,
        store: OrderStore,
        orders: Orders,
        reversals: OrderReversals,
        refs: MasterDataRefs,
        pricing: PricingService,
        reservations: Reservations,
        payments: Payments,
        numbers: NumberSeries,
        documents: DocumentRegistry,
        events: DomainEvents,
        audit: AuditTrail,
        cursors: Cursors,
        clock: Clock,
      ) => new OnlineOrders(uow, store, orders, reversals, refs, pricing, reservations, payments, numbers, documents, events, audit, cursors, clock),
      inject: [UnitOfWork, ORDER_STORE, Orders, OrderReversals, MasterDataRefs, PricingService, Reservations, Payments, NumberSeries, DocumentRegistry, DomainEvents, AuditTrail, Cursors, CLOCK],
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
        overrides: PriceOverrides,
        queries: StockQueries,
      ) => new SalePosting(store, refs, pricing, stock, units, reservations, billing, payments, numbers, documents, events, idempotency, audit, clock, overrides, queries),
      inject: [ORDER_STORE, MasterDataRefs, PricingService, Stock, StockUnits, Reservations, Billing, Payments, NumberSeries, DocumentRegistry, DomainEvents, Idempotency, AuditTrail, CLOCK, PriceOverrides, StockQueries],
    },
  ],
  exports: [SalePosting, Orders, OrderReversals, Returns, OnlineOrders, ORDER_CONFIRMATION_POLICIES],
})
export class OrdModule implements OnModuleInit {
  constructor(
    @Inject(Approvals) private readonly approvals: Approvals,
    @Inject(OrderReversals) private readonly reversals: OrderReversals,
    @Inject(Returns) private readonly returns: Returns,
    @Inject(PriceOverrides) private readonly overrides: PriceOverrides,
    @Inject(OnlineOrders) private readonly online: OnlineOrders,
    @Inject(DomainEvents) private readonly events: DomainEvents,
  ) {}

  /**
   * Registers the `SALE_VOID`, `RETURN` and `PRICE_OVERRIDE` approval handlers, and the online order's transactional
   * subscribers (ADR-0010: a module keeping its own aggregate consistent with a lower module's fact, A-232): the
   * order's own money confirms it, a failed charge or a checkout's hold that ends first cancels it.
   */
  onModuleInit(): void {
    this.events.subscribeInTransaction('pay.PaymentCleared', (tx, event) => this.online.paymentClearedIn(tx, event));
    this.events.subscribeInTransaction('pay.PaymentFailed', (tx, event) => this.online.paymentFailedIn(tx, event));
    this.events.subscribeInTransaction('inv.ReservationExpired', (tx, event) => this.online.holdEndedIn(tx, event));
    this.events.subscribeInTransaction('inv.ReservationReleased', (tx, event) => this.online.holdEndedIn(tx, event));
    this.approvals.registerHandler(SALE_VOID_KIND, this.reversals.approvalHandler);
    this.approvals.registerHandler(RETURN_KIND, this.returns.approvalHandler);
    this.approvals.registerHandler(PRICE_OVERRIDE_KIND, this.overrides.approvalHandler);
  }
}
