/**
 * CST's public door (MODULE_BOUNDARIES, CST card). No other module imports CST: it answers HTTP, posts through INV and
 * keeps its projections. The module and its services are exported for the application's wiring, the worker, the seed
 * and the tests. Events are in `events.ts`.
 */
export { CstModule } from './cst.module';
export { CostingProjections, PROJECTION_DRIFT_DETECTED, type DriftReport } from './application/costing-projections';
export { CostingReports } from './application/costing-reports';
export { OverheadAllocations, OVERHEAD_ALLOCATION, OVERHEAD_CAPITALISE, type OverheadAllocationRunView } from './application/overhead-allocations';
export type { ProjectionDriftDetected } from './events';
