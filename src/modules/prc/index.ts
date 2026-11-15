/**
 * PRC's public door (MODULE_BOUNDARIES, PRC card). B6 publishes `Processing` (processing orders, with `createIn` for the
 * seed and later callers) and `YieldStandards` (with `createIn`); `Packs` arrives with packing and labels (B06
 * continued). Events are in `events.ts`.
 */
export { PrcModule } from './prc.module';
export { Processing, type ProcessingOrderCreateRequest, type ProcessingOrderView } from './application/processing';
export { Packs, type PackLabelSheetView, type PackView } from './application/packs';
export { YieldStandards, type YieldStandardCreateRequest, type YieldStandardView } from './application/yield-standards';
export type { DirectCostIncurred, ProcessingOrderCompleted, ProcessingOrderReversed, ProcessingOrderStarted, YieldVarianceFlagged } from './events';
export { InputOnHoldError, ProcessingOrderInvalidError, YieldStandardInvalidError } from './application/errors';
