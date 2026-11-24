/** The distribution rules (ADR-0028, NFR-015: this folder is held at 100 percent coverage). */
export { UNIT_SCALE, formatUnits, parseUnits, sharePercent, unitsFor } from './units';
export { daysInPeriod, heldOn, judgeWithdrawal, unitDaysByInvestor, type Period, type UnitMovement } from './unit-days';
export { distributableProfit, type DistributableProfit } from './profit';
export { allocateDistribution, investorTieKey, type AllocatedLine, type WeightedInvestor } from './allocation';
export { DAY_COUNT_CONVENTION, judgeRunAction, type RunAction, type RunRefusal, type RunStatus } from './lifecycle';
export { judgeDistributionPayment } from './payment';
