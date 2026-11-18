/**
 * ORD's public door (MODULE_BOUNDARIES, ORD card). B9a builds `SalePosting`, the `Orders` interface's "complete a sale":
 * `postIn` posts a sale on any channel in the caller's serializable transaction, with `locksFor` naming its series
 * locks. B09a continued 2b adds `Orders` (the order record's reads, entry and confirmation) and the
 * `OrderConfirmationPolicy` port WHL implements (B10). B09a continued 2c adds `OrderReversals` (cancelOrder, and voidOrder
 * under the `SALE_VOID` approval). B09a continued 2d adds `Returns`; 2e adds the `PRICE_OVERRIDE` approval and the
 * sale posting's `requestOverrideIn` (A-230). Events are in `events.ts`.
 */
export { OrdModule } from './ord.module';
export { SalePosting, ORDER_COMPLETED, POST_SALE_OPERATION, type OfflineSaleFinding, type OfflineSaleOutcome, type OfflineSaleRequest, type SaleLineRequest, type SaleRequest, type SaleTenderRequest, type SaleView } from './application/sale-posting';
export { PriceOverrideNeedsApprovalError, QuoteRequiredError, SaleInvalidError } from './application/errors';
export { canMove, paymentStatusOf, ORDER_STATUSES, type OrderStatus, type PaymentStatus } from './domain/order';
export { Orders, ORDER_CONFIRMED, ORDER_PLACED, type QuoteOrderLine, type QuoteOrderRequest, type SalesOrderView } from './application/orders';
export type { ShiftSalesSummary } from './application/order-store';
export { OnlineOrders, type OnlinePlacement, type OnlinePlacementLine, type PlacedOrder } from './application/online-orders';
export { ORDER_CONFIRMATION_POLICIES, type OrderConfirmationPolicy } from './application/order-confirmation-policy';
export { OrderReversals, ORDER_CANCELLED, ORDER_VOIDED, SALE_VOID_KIND, SALE_VOID_REQUESTED } from './application/order-reversals';
export type { OrderCancelled, OrderCompleted, OrderConfirmed, OrderPlaced, OrderVoided, SaleVoidRequested } from './events';
export { Returns, RETURN_COMPLETED, RETURN_KIND, RETURN_SUBMITTED, type OrderReturnView } from './application/returns';
export type { ReturnCompleted, ReturnSubmitted } from './events';
export { PRICE_OVERRIDE_APPROVED, PRICE_OVERRIDE_REQUESTED } from './application/price-overrides';
export { PRICE_OVERRIDE_KIND } from './domain/price-override';
export type { PriceOverrideApproved, PriceOverrideRequested } from './events';
