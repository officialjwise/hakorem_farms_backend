/**
 * POS's public door (MODULE_BOUNDARIES, POS card). No other module imports POS: it answers HTTP only. The module and
 * `Shifts` are exported for the application's wiring and the seed (a till's shift opened for the seeded trading day).
 * Events are in `events.ts`.
 */
export { PosModule } from './pos.module';
export { Shifts, SHIFT_CLOSED, SHIFT_FORCE_CLOSED, SHIFT_OPENED, CASH_DROPPED, CASH_PAID_IN, CASH_PAID_OUT, type ShiftView } from './application/shifts';
export { Registers } from './application/registers';
export type { CashMoved, ShiftClosed, ShiftForceClosed, ShiftOpened } from './events';
