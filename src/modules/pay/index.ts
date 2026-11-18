/**
 * PAY's public door (MODULE_BOUNDARIES, PAY card). `Payments.recordIn`: a tender recorded and allocated in the caller's
 * serializable transaction (the port ORD's sale posting calls), with the reads of the payments it took;
 * `ProviderPayments.releaseChargeIn`: the port an order calls when it stops waiting for a provider payment (A-210).
 * `UnverifiedTenders.recordIn`: an offline mobile money tender recorded `UNVERIFIED` with its break (B09b continued 2c).
 * `TillShiftRegistry`: the `TillShiftCheck` port POS implements, asked before any cash moves into or out of a till (ADR-0077).
 * Events are in `events.ts`.
 */
export { PayModule } from './pay.module';
export { Payments, PAYMENT_CLEARED, type ClearedTenderRequest, type PaymentView, type SalesChannel, type ShiftTenderTotal, type TenderRequest } from './application/payments';
export { ProviderPayments } from './application/provider-payments';
export { Refunds } from './application/refunds';
export { TillShiftRegistry, type TillCashAnswer, type TillCashDirection, type TillCashRefusal, type TillCashRequest, type TillShiftCheck } from './application/till-shifts';
export { Receipts } from './application/receipts';
export { UnverifiedTenders, type UnverifiedTenderRequest } from './application/unverified-tenders';
export { PaymentInvalidError, PaymentRequiresVerificationError } from './application/errors';
export type { DepositAllocated, PaymentCleared, PaymentFailed, RefundPaid, RegisterRefPayload } from './events';
