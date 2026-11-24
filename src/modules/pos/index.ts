/**
 * POS's public door (MODULE_BOUNDARIES, POS card). No other module imports POS but NTF, for a receipt link sent by message (B11 continued 12); otherwise it answers HTTP only. The module and
 * `Shifts` are exported for the application's wiring and the seed (a till's shift opened for the seeded trading day).
 * Events are in `events.ts`.
 */
export { PosModule } from './pos.module';
export { Shifts, SHIFT_CLOSED, SHIFT_FORCE_CLOSED, SHIFT_OPENED, CASH_DROPPED, CASH_PAID_IN, CASH_PAID_OUT, type ShiftView } from './application/shifts';
export { Registers } from './application/registers';
// B11 continued 12 (CR-033 point 3, the parent session's leave of 2026-11-24): NTF's sending worker asks POS for a fresh
// receipt link for a synced sale (`ReceiptLinks.issueMessageLinkIn`), the only use another module makes of POS.
export { ReceiptLinks } from './application/receipt-links';
export type { CashMoved, ShiftClosed, ShiftForceClosed, ShiftOpened } from './events';
