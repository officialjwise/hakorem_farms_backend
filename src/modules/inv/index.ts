/**
 * INV's public door (MODULE_BOUNDARIES, INV card). Higher modules import only from here. B5 publishes the ledger:
 * `Stock.postIn` posts a movement in the caller's serializable transaction and returns the value the database carried;
 * `Lineage.linkIn` records genealogy and `Lineage.trace` answers both directions; `BalanceReconciliation` is the nightly
 * recompute. The stock invariants are the database's (migration 0044); a refusal arrives as one of the errors below.
 * B05 continued adds `GoodsReceipts` (with `createIn` and `postIn` for the seed and later callers) and `StockQueries`.
 * B05 continued 2 adds `StockMovements` (reads and reversal), `StockTransfers` and `StockAdjustments` (with `createIn`).
 * B05 continued 3 adds `StockTakes` and `StockHolds`, whose `placeIn` is the `Holds` interface: LIV places a withdrawal
 * hold through it in the treatment's transaction.
 */
export { InvModule } from './inv.module';
export { Stock, type MovementRequest, type PostedMovement, type StockPostingPayload } from './application/stock';
export { Lineage, type Trace, type TracedUnit } from './application/lineage';
export { BalanceReconciliation, type DriftFound } from './application/reconciliation';
export { GoodsReceipts, type GoodsReceiptCreateRequest, type GoodsReceiptView, type ReceiptLineInput } from './application/goods-receipts';
export { StockQueries, type StockOnHandPageView, type StockTraceView, type StockUnitView } from './application/stock-queries';
export { StockMovements, type ReversalRequest } from './application/stock-movements';
export { StockTransfers, type StockTransferView, type TransferCreateRequest, type TransferReceiveRequest } from './application/stock-transfers';
export { StockAdjustments, type AdjustmentCreateRequest, type StockAdjustmentView } from './application/stock-adjustments';
export { StockTakes, type StockTakeView } from './application/stock-takes';
export { StockHolds, type HoldPlacementRequest, type StockHoldView } from './application/stock-holds';
export type { StockUnitRegistered } from './events';
export type { CostElement, LinkType, WeightSource } from './application/stock-store';
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
} from './application/errors';
export { capitalise, emptyPool, issue, receive, valueAtAverage, type CostPool, type IssueResult } from './domain/valuation/cost-pool';
