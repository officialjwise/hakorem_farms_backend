/**
 * PAY's public door (MODULE_BOUNDARIES, PAY card). `Payments.recordIn`: a tender recorded and allocated in the caller's
 * serializable transaction (the port ORD's sale posting calls), with the reads of the payments it took;
 * `ProviderPayments.releaseChargeIn`: the port an order calls when it stops waiting for a provider payment (A-210).
 * `UnverifiedTenders.recordIn`: an offline mobile money tender recorded `UNVERIFIED` with its break (B09b continued 2c).
 * `TillShiftRegistry`: the `TillShiftCheck` port POS implements, asked before any cash moves into or out of a till (ADR-0077).
 * `DriverCash.collectIn`: cash a driver collected on delivery, held by the driver and allocated to the delivery's document (B11 continued). `DriverCash.handInIn`: that cash handed in at a till shift by its own cashier, settling nothing (B11 continued 2).
 * `AllocationsAsAt`: what each billing document had applied to it by a business day, for WHL's ageing (ADR-0089).
 * Events are in `events.ts`.
 */
export { PayModule } from './pay.module';
export { Payments, PAYMENT_CLEARED, DEPOSIT_ALLOCATED, type ClearedTenderRequest, type PaymentView, type SalesChannel, type ShiftTenderTotal, type TenderRequest } from './application/payments';
export { DriverCash, type DriverCashRequest, type HandInRequest } from './application/driver-cash';
export { ProviderPayments } from './application/provider-payments';
export { Refunds } from './application/refunds';
export { TillShiftRegistry, type TillCashAnswer, type TillCashDirection, type TillCashRefusal, type TillCashRequest, type TillShiftCheck } from './application/till-shifts';
export { Receipts } from './application/receipts';
export { UnverifiedTenders, type UnverifiedTenderRequest } from './application/unverified-tenders';
export { UnverifiedOverdue } from './application/unverified-overdue';
export { AllocationsAsAt } from './application/allocations-as-at';
export { PaymentInvalidError, PaymentRequiresVerificationError } from './application/errors';
export type { DepositAllocated, PaymentCleared, PaymentFailed, RefundPaid, RegisterRefPayload } from './events';
