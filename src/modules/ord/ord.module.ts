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
import { InvModule, Reservations, Stock, StockAdjustments, StockExceptions, StockMovements, StockQueries, StockUnits } from '../inv';
import { Deliveries, DelModule, DELIVERY_COMPLETED, DELIVERY_FAILED, DELIVERY_REASSIGNED, DELIVERY_RESCHEDULED } from '../del';
import { MasterDataRefs, MdmModule, PricingService, Storefront } from '../mdm';
import { PayModule, Payments, ProviderPayments, Receipts, Refunds } from '../pay';
import { Dispatches } from './application/dispatches';
import { FULFILMENT_STORE, type FulfilmentStore } from './application/fulfilment-store';
import { Fulfilments } from './application/fulfilments';
import { OnlineOrders } from './application/online-orders';
import { ORDER_CONFIRMATION_POLICIES, type OrderConfirmationPolicy } from './application/order-confirmation-policy';
import { OrderReversals, SALE_VOID_KIND } from './application/order-reversals';
import { ORDER_STORE, type OrderStore } from './application/order-store';
import { Orders } from './application/orders';
import { RETURN_STORE, type ReturnStore } from './application/return-store';
import { RETURN_KIND, Returns } from './application/returns';
import { PRICE_OVERRIDE_KIND, PriceOverrides } from './application/price-overrides';
import { SalePosting } from './application/sale-posting';
import { PgFulfilmentStore } from './infrastructure/pg-fulfilment-store';
import { PgOrderStore } from './infrastructure/pg-order-store';
import { PgReturnStore } from './infrastructure/pg-return-store';
import { MyOrdersController, OrderTrackingController } from './interface/online-orders.controller';
import { FulfilmentsController, MyOrderConsentController, OrderFulfilmentController } from './interface/fulfilments.controller';
import { OrdersController } from './interface/orders.controller';
import { ReturnsController } from './interface/returns.controller';
import { VanReturnsController } from './interface/van-returns.controller';
import { VAN_RETURN_STORE, type VanReturnStore } from './application/van-return-store';
import { VanReturns } from './application/van-returns';
import { PgVanReturnStore } from './infrastructure/pg-van-return-store';

/**
 * ORD (layer 9): the one order record of every channel and the sale posting that issues stock, the billing document
 * and the tenders in one serializable transaction (B9a). B09a continued 2b adds `Orders` (the order record's reads, entry and
 * confirmation) and the `OrderConfirmationPolicy` port; cancellation, voids, returns, price override approvals and online
 * placement follow in B09a continued 2c (A-225), which adds `OrderReversals` (cancellation and the void under `SALE_VOID`), B09a continued 2d adds `Returns` (returns against the sale under `RETURN`, A-228), and B09a continued 2e adds `PriceOverrides` (`PRICE_OVERRIDE`, A-230) and the proforma; POS's counter sale (B9b) and fulfilment's dispatch (B11) call `SalePosting.postIn`.
 */
@Module({
  imports: [IamModule, MdmModule, InvModule, BilModule, PayModule, DelModule],
  controllers: [OrdersController, ReturnsController, MyOrdersController, OrderTrackingController, FulfilmentsController, OrderFulfilmentController, MyOrderConsentController, VanReturnsController],
  providers: [
    { provide: ORDER_STORE, useClass: PgOrderStore },
    { provide: RETURN_STORE, useClass: PgReturnStore },
    { provide: FULFILMENT_STORE, useClass: PgFulfilmentStore },
    { provide: VAN_RETURN_STORE, useClass: PgVanReturnStore },
    {
      provide: VanReturns,
      useFactory: (
        uow: UnitOfWork,
        store: VanReturnStore,
        orderStore: OrderStore,
        fulfilments: FulfilmentStore,
        refs: MasterDataRefs,
        stock: Stock,
        adjustments: StockAdjustments,
        billing: Billing,
        payments: Payments,
        refunds: Refunds,
        deliveries: Deliveries,
        idempotency: Idempotency,
        audit: AuditTrail,
        authoriser: Authoriser,
        clock: Clock,
      ) => new VanReturns(uow, store, orderStore, fulfilments, refs, stock, adjustments, billing, payments, refunds, deliveries, idempotency, audit, authoriser, clock),
      inject: [UnitOfWork, VAN_RETURN_STORE, ORDER_STORE, FULFILMENT_STORE, MasterDataRefs, Stock, StockAdjustments, Billing, Payments, Refunds, Deliveries, Idempotency, AuditTrail, Authoriser, CLOCK],
    },
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
        fulfilmentStore: FulfilmentStore,
        deliveries: Deliveries,
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
          fulfilmentStore,
          deliveries,
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
        FULFILMENT_STORE,
        Deliveries,
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
        fulfilments: FulfilmentStore,
      ) => new OrderReversals(uow, store, orders, refs, reservations, movements, billing, payments, providerPayments, refunds, receipts, approvals, authoriser, idempotency, events, audit, clock, fulfilments),
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
        FULFILMENT_STORE,
      ],
    },
    {
      provide: Fulfilments,
      useFactory: (
        uow: UnitOfWork,
        store: FulfilmentStore,
        orderStore: OrderStore,
        orders: Orders,
        reversals: OrderReversals,
        refs: MasterDataRefs,
        pricing: PricingService,
        units: StockUnits,
        queries: StockQueries,
        reservations: Reservations,
        numbers: NumberSeries,
        documents: DocumentRegistry,
        events: DomainEvents,
        idempotency: Idempotency,
        audit: AuditTrail,
        authoriser: Authoriser,
        principals: PrincipalNames,
        cursors: Cursors,
        clock: Clock,
      ) => new Fulfilments(uow, store, orderStore, orders, reversals, refs, pricing, units, queries, reservations, numbers, documents, events, idempotency, audit, authoriser, principals, cursors, clock),
      inject: [
        UnitOfWork,
        FULFILMENT_STORE,
        ORDER_STORE,
        Orders,
        OrderReversals,
        MasterDataRefs,
        PricingService,
        StockUnits,
        StockQueries,
        Reservations,
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
        fulfilments: Fulfilments,
        idempotency: Idempotency,
      ) => new OnlineOrders(uow, store, orders, reversals, refs, pricing, reservations, payments, numbers, documents, events, audit, cursors, clock, fulfilments, idempotency),
      inject: [UnitOfWork, ORDER_STORE, Orders, OrderReversals, MasterDataRefs, PricingService, Reservations, Payments, NumberSeries, DocumentRegistry, DomainEvents, AuditTrail, Cursors, CLOCK, Fulfilments, Idempotency],
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
    {
      provide: Dispatches,
      useFactory: (
        uow: UnitOfWork,
        store: FulfilmentStore,
        orderStore: OrderStore,
        fulfilments: Fulfilments,
        refs: MasterDataRefs,
        storefront: Storefront,
        units: StockUnits,
        stock: Stock,
        reservations: Reservations,
        billing: Billing,
        payments: Payments,
        refunds: Refunds,
        deliveries: Deliveries,
        vanReturns: VanReturns,
        events: DomainEvents,
        idempotency: Idempotency,
        audit: AuditTrail,
        authoriser: Authoriser,
        clock: Clock,
      ) => new Dispatches(uow, store, orderStore, fulfilments, refs, storefront, units, stock, reservations, billing, payments, refunds, deliveries, vanReturns, events, idempotency, audit, authoriser, clock),
      inject: [UnitOfWork, FULFILMENT_STORE, ORDER_STORE, Fulfilments, MasterDataRefs, Storefront, StockUnits, Stock, Reservations, Billing, Payments, Refunds, Deliveries, VanReturns, DomainEvents, Idempotency, AuditTrail, Authoriser, CLOCK],
    },
  ],
  exports: [SalePosting, Orders, OrderReversals, Returns, OnlineOrders, Fulfilments, Dispatches, ORDER_CONFIRMATION_POLICIES],
})
export class OrdModule implements OnModuleInit {
  constructor(
    @Inject(Approvals) private readonly approvals: Approvals,
    @Inject(OrderReversals) private readonly reversals: OrderReversals,
    @Inject(Returns) private readonly returns: Returns,
    @Inject(PriceOverrides) private readonly overrides: PriceOverrides,
    @Inject(OnlineOrders) private readonly online: OnlineOrders,
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(Dispatches) private readonly dispatches: Dispatches,
    @Inject(VanReturns) private readonly vanReturns: VanReturns,
  ) {}

  /**
   * Registers the `SALE_VOID`, `RETURN` and `PRICE_OVERRIDE` approval handlers, and the online order's transactional
   * subscribers (ADR-0010: a module keeping its own aggregate consistent with a lower module's fact, A-232): the
   * order's own money confirms it, a failed charge or a checkout's hold that ends first cancels it; a delivery DEL
   * completes issues the order's goods from the vehicle and moves it to DELIVERED (B11 continued).
   */
  onModuleInit(): void {
    this.events.subscribeInTransaction('pay.PaymentCleared', (tx, event) => this.online.paymentClearedIn(tx, event));
    this.events.subscribeInTransaction('pay.PaymentFailed', (tx, event) => this.online.paymentFailedIn(tx, event));
    this.events.subscribeInTransaction('inv.ReservationExpired', (tx, event) => this.online.holdEndedIn(tx, event));
    this.events.subscribeInTransaction('inv.ReservationReleased', (tx, event) => this.online.holdEndedIn(tx, event));
    this.events.subscribeInTransaction(DELIVERY_COMPLETED, (tx, event) => this.dispatches.deliveredIn(tx, event));
    this.events.subscribeInTransaction(DELIVERY_FAILED, (tx, event) => this.dispatches.failedIn(tx, event));
    // A van write-off's stock approval, and a van return's credit note approval, carry its goods and money on (A-360).
    this.events.subscribeInTransaction('iam.ApprovalDecided', (tx, event) => this.vanReturns.decidedIn(tx, event));
    // A reassigned delivery's goods follow it van to van; a reattempt sends the order out again (A-362).
    this.events.subscribeInTransaction(DELIVERY_REASSIGNED, (tx, event) => this.vanReturns.reassignedIn(tx, event));
    this.events.subscribeInTransaction(DELIVERY_RESCHEDULED, (tx, event) => this.vanReturns.rescheduledIn(tx, event));
    this.approvals.registerHandler(SALE_VOID_KIND, this.reversals.approvalHandler);
    this.approvals.registerHandler(RETURN_KIND, this.returns.approvalHandler);
    this.approvals.registerHandler(PRICE_OVERRIDE_KIND, this.overrides.approvalHandler);
  }
}
