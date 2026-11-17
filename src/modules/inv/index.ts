/**
 * INV's public door (MODULE_BOUNDARIES, INV card). Higher modules import only from here. B5 publishes the ledger:
 * `Stock.postIn` posts a movement in the caller's serializable transaction and returns the value the database carried;
 * `Lineage.linkIn` records genealogy and `Lineage.trace` answers both directions; `BalanceReconciliation` is the nightly
 * recompute. The stock invariants are the database's (migration 0044); a refusal arrives as one of the errors below.
 * B05 continued adds `GoodsReceipts` (with `createIn` and `postIn` for the seed and later callers) and `StockQueries`.
 * B05 continued 2 adds `StockMovements` (reads and reversal), `StockTransfers` and `StockAdjustments` (with `createIn`).
 * B05 continued 3 adds `StockTakes` and `StockHolds`, whose `placeIn` is the `Holds` interface: LIV places a withdrawal
 * hold through it in the treatment's transaction. B05 continued 3b adds `StockExceptions` (the queue and its
 * resolution, the held transfer variance of ADR-0048), `Reservations` (the in-process interface: `reserveIn`,
 * `consumeIn`, `releaseIn`) and `ReservationExpiry`, the scheduled job. B05 continued 4 adds `StockAlerts` (reorder
 * rules, the alerts `Stock.postIn` raises once per crossing, the published view `inv.pub_reorder_level`),
 * `StockAlertSweep` (the daily `stock-alerts` job), `ColdChain` (readings, with quarantine on an excursion) and the
 * `OPENING_STOCK` import sheet it registers with MDM's `MdmImports` (ADR-0050). B6 adds `StockUnits` (`factsIn`,
 * `activeIdentifiersIn`, `registerLotIn`), through which PRC checks its inputs and registers its output lots. B06 continued
 * 2 adds `registerSerialIn` (an animal born on the farm), `onHandAsOfIn` (where units stood at an instant, for growth)
 * and `setGradeIn` (an animal's grade). B07 continued 2 adds `StockQueries.promisableIn`, the balances SHP's catalogue and
 * checkout may promise to a remote buyer. B09a continued 2d adds `StockMovements.returnSaleIn`, a customer return of a
 * sale issue that the database values at its share of the issue (migration 0199).
 */
export { InvModule } from './inv.module';
export { Stock, type MovementRequest, type PostedMovement, type StockPostingPayload } from './application/stock';
export { Lineage, type Trace, type TracedUnit } from './application/lineage';
export { StockUnits, type LotRegistration, type SerialRegistration, type StockUnitFacts, type UnitOnHand } from './application/stock-units';
export { BalanceReconciliation, type DriftFound } from './application/reconciliation';
export { GoodsReceipts, type GoodsReceiptCreateRequest, type GoodsReceiptView, type ReceiptLineInput } from './application/goods-receipts';
export { StockQueries, type PromisableStock, type StockOnHandPageView, type StockTraceView, type StockUnitView } from './application/stock-queries';
export { StockMovements, type ReversalRequest, type SaleReturnRequest } from './application/stock-movements';
export { StockTransfers, type StockTransferView, type TransferCreateRequest, type TransferReceiveRequest } from './application/stock-transfers';
export { StockAdjustments, type AdjustmentCreateRequest, type StockAdjustmentView } from './application/stock-adjustments';
export { StockTakes, type StockTakeView } from './application/stock-takes';
export { StockHolds, type HoldPlacementRequest, type StockHoldView } from './application/stock-holds';
export { StockExceptions, type StockExceptionView } from './application/stock-exceptions';
export { StockAlerts, StockAlertSweep, type ReorderRuleView, type StockAlertRaised, type StockAlertView } from './application/stock-alerts';
export { ColdChain, type TemperatureExcursionRecorded, type TemperatureReadingView } from './application/cold-chain';
export { ReservationExpiry, Reservations, reservationLockKey, type ConsumeRequest, type ReservationRequest, type StockReservationView } from './application/reservations';
export type { ReservationEnded, StockUnitRegistered, UpkeepExpensed } from './events';
export type { CostElement, LinkType, WeightSource } from './application/stock-store';
export type { StockReservationRecord } from './application/stock-reservation-store';
export {
  InsufficientStockError,
  StockMovementAlreadyReversedError,
  StockMovementInvalidError,
  StockUnitNotAvailableError,
  StockUnitOnHoldError,
  StockUnitReservedError,
  GoodsReceiptInvalidError,
  StockAdjustmentInvalidError,
  StockReversalNotPossibleError,
  StockTransferInvalidError,
  TransferVarianceError,
  StockTakeInvalidError,
  StockTakeNotCountedError,
  StockHoldInvalidError,
  WithdrawalCannotBeReleasedError,
  StockExceptionInvalidError,
  ReorderRuleInvalidError,
  TemperatureReadingInvalidError,
  StockUnitExpiredError,
} from './application/errors';
export { capitalise, emptyPool, issue, receive, valueAtAverage, type CostPool, type IssueResult } from './domain/valuation/cost-pool';
