/**
 * PUR's public door (MODULE_BOUNDARIES, PUR card). B7 publishes `PurchaseOrders` (the `Purchasing` interface),
 * `SupplierInvoices` and `SupplierPayments`, for the seed and later callers; no module below calls them. Events are in
 * `events.ts`. `Suppliers` (profiles, payout details, documents and scores) arrives with B07 continued.
 */
export { PurModule } from './pur.module';
export { PurchaseOrders, type PurchaseOrderCreate, type PurchaseOrderView } from './application/purchase-orders';
export { SupplierInvoices, type SupplierInvoiceCreate, type SupplierInvoiceView } from './application/supplier-invoices';
export { SupplierPayments, type SupplierPaymentCreate, type SupplierPaymentView } from './application/supplier-payments';
export type { PurchaseOrderApproved, PurchaseOrderSent, SupplierInvoiceApproved, SupplierInvoiceMismatched, SupplierPaymentMade } from './events';
