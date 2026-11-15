/**
 * INV's public door (MODULE_BOUNDARIES, INV card). Higher modules import only from here. B5 publishes the ledger:
 * `Stock.postIn` posts a movement in the caller's serializable transaction and returns the value the database carried;
 * `Lineage.linkIn` records genealogy and `Lineage.trace` answers both directions; `BalanceReconciliation` is the nightly
 * recompute. The stock invariants are the database's (migration 0044); a refusal arrives as one of the errors below.
 */
export { InvModule } from './inv.module';
export { Stock, type MovementRequest, type PostedMovement, type StockPostingPayload } from './application/stock';
export { Lineage, type Trace, type TracedUnit } from './application/lineage';
export { BalanceReconciliation, type DriftFound } from './application/reconciliation';
export type { CostElement, LinkType, WeightSource } from './application/stock-store';
export {
  InsufficientStockError,
  StockMovementAlreadyReversedError,
  StockMovementInvalidError,
  StockUnitNotAvailableError,
  StockUnitOnHoldError,
  StockUnitReservedError,
} from './application/errors';
export { capitalise, emptyPool, issue, receive, type CostPool, type IssueResult } from './domain/valuation/cost-pool';
