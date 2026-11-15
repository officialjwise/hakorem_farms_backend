/**
 * LIV's public door (MODULE_BOUNDARIES, LIV card). B06 continued publishes `Animals` (the register, opened from
 * `inv.StockUnitRegistered` and following its unit's movements), `Weighing`, `HealthRecords`, `MortalityRecords` and
 * `Feeding`, each with the `...In` methods the seed and later callers use inside their own transaction. `Batches` and
 * `Breeding` are B06 continued 2's. Events are in `events.ts`.
 */
export { LivModule } from './liv.module';
export { Animals, type AnimalView } from './application/animals';
export { Weighing, type WeightBatchView, type WeightInput } from './application/weights';
export { HealthRecords, type HealthEventCreateRequest, type HealthEventView } from './application/health';
export { MortalityRecords, MORTALITY_WRITE_OFF, type MortalityRecordView, type MortalityReportRequest } from './application/mortality';
export { Feeding, type FeedConsumptionCreateRequest, type FeedConsumptionView, type RationCreateRequest, type RationView } from './application/feeding';
export { LivestockRecordInvalidError, MortalityPhotoRequiredError, RationInvalidError } from './application/errors';
export type { AnimalRegistered, AnimalWeighed, FeedConsumed, HealthEventRecorded, MortalityApproved, MortalityReported, WithdrawalStarted } from './events';
