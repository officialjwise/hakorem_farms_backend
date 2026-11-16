/**
 * PAY's public door (MODULE_BOUNDARIES, PAY card). B9a builds `Payments.recordIn`: a tender recorded and allocated in
 * the caller's serializable transaction (the port ORD's sale posting calls), with the reads of the payments it took.
 * Events are in `events.ts`.
 */
export { PayModule } from './pay.module';
export { Payments, PAYMENT_CLEARED, type PaymentView, type SalesChannel, type TenderRequest } from './application/payments';
export { PaymentInvalidError, PaymentRequiresVerificationError } from './application/errors';
export type { PaymentCleared, RegisterRefPayload } from './events';
