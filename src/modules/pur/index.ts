/**
 * PUR's public door (MODULE_BOUNDARIES, PUR card). B7 publishes `PurchaseOrders` (the `Purchasing` interface),
 * `SupplierInvoices` and `SupplierPayments`; B07 continued adds `Suppliers` (profiles, payout details, documents) and
 * `Requisitions`, for the seed and later callers; no module below calls them. Events are in `events.ts`.
 */
export { PurModule } from './pur.module';
export { PurchaseOrders, type PurchaseOrderCreate, type PurchaseOrderView } from './application/purchase-orders';
export { SupplierInvoices, type SupplierInvoiceCreate, type SupplierInvoiceView } from './application/supplier-invoices';
export { SupplierPayments, type SupplierPaymentCreate, type SupplierPaymentView } from './application/supplier-payments';
export { Suppliers, type SupplierProfileUpdate, type SupplierProfileView } from './application/suppliers';
export { Requisitions, type PurchaseRequisitionCreate, type PurchaseRequisitionView } from './application/requisitions';
export type { RequisitionSubmitted, SupplierCreditNoteApproved, SupplierPayoutChanged, SupplierPayoutChangeRequested, SupplierRemittanceReady } from './events';
export type { PurchaseOrderApproved, PurchaseOrderSent, SupplierInvoiceApproved, SupplierInvoiceMismatched, SupplierPaymentMade } from './events';
