/**
 * PAY's public door (MODULE_BOUNDARIES, PAY card). `Payments.recordIn`: a tender recorded and allocated in the caller's
 * serializable transaction (the port ORD's sale posting calls), with the reads of the payments it took;
 * `ProviderPayments.releaseChargeIn`: the port an order calls when it stops waiting for a provider payment (A-210).
 * Events are in `events.ts`.
 */
export { PayModule } from './pay.module';
export { Payments, PAYMENT_CLEARED, type PaymentView, type SalesChannel, type ShiftTenderTotal, type TenderRequest } from './application/payments';
export { ProviderPayments } from './application/provider-payments';
export { Refunds } from './application/refunds';
export { Receipts } from './application/receipts';
export { PaymentInvalidError, PaymentRequiresVerificationError } from './application/errors';
export type { DepositAllocated, PaymentCleared, PaymentFailed, RefundPaid, RegisterRefPayload } from './events';
