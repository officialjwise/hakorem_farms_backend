/**
 * ORD's public door (MODULE_BOUNDARIES, ORD card). B9a builds `SalePosting`, the `Orders` interface's "complete a sale":
 * `postIn` posts a sale on any channel in the caller's serializable transaction, with `locksFor` naming its series
 * locks. B09a continued 2b adds `Orders` (the order record's reads, entry and confirmation) and the
 * `OrderConfirmationPolicy` port WHL implements (B10). Events are in `events.ts`.
 */
export { OrdModule } from './ord.module';
export { SalePosting, ORDER_COMPLETED, POST_SALE_OPERATION, type SaleLineRequest, type SaleRequest, type SaleTenderRequest, type SaleView } from './application/sale-posting';
export { PriceOverrideNeedsApprovalError, QuoteRequiredError, SaleInvalidError } from './application/errors';
export { canMove, paymentStatusOf, ORDER_STATUSES, type OrderStatus, type PaymentStatus } from './domain/order';
export { Orders, ORDER_CONFIRMED, ORDER_PLACED, type SalesOrderView } from './application/orders';
export { ORDER_CONFIRMATION_POLICIES, type OrderConfirmationPolicy } from './application/order-confirmation-policy';
export type { OrderCompleted, OrderConfirmed, OrderPlaced } from './events';
