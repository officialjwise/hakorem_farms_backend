/**
 * ORD's public door (MODULE_BOUNDARIES, ORD card). B9a builds `SalePosting`, the `Orders` interface's "complete a sale":
 * `postIn` posts a sale on any channel in the caller's serializable transaction, with `locksFor` naming its series
 * locks. Events are in `events.ts`.
 */
export { OrdModule } from './ord.module';
export { SalePosting, ORDER_COMPLETED, POST_SALE_OPERATION, type SaleLineRequest, type SaleRequest, type SaleTenderRequest, type SaleView } from './application/sale-posting';
export { PriceOverrideNeedsApprovalError, QuoteRequiredError, SaleInvalidError } from './application/errors';
export { canMove, paymentStatusOf, ORDER_STATUSES, type OrderStatus, type PaymentStatus } from './domain/order';
export type { OrderCompleted } from './events';
