/**
 * LIV's public door (MODULE_BOUNDARIES, LIV card). B06 continued publishes `Animals` (the register, opened from
 * `inv.StockUnitRegistered` and following its unit's movements), `Weighing`, `HealthRecords`, `MortalityRecords` and
 * `Feeding`, each with the `...In` methods the seed and later callers use inside their own transaction. B06 continued 2
 * adds `AnimalCare` (edits, moves, the timeline), `Batches`, `Breeding` (matings and births) and `Growth`. Events are in
 * `events.ts`.
 */
export { LivModule } from './liv.module';
export { Animals, type AnimalView } from './application/animals';
export { Weighing, type WeightBatchView, type WeightInput } from './application/weights';
export { HealthRecords, type HealthEventCreateRequest, type HealthEventView } from './application/health';
export { MortalityEvidenceReturns, MortalityRecords, MORTALITY_CONFIRMATION, MORTALITY_WRITE_OFF, type MortalityRecordView, type MortalityReportRequest } from './application/mortality';
export { Feeding, type FeedConsumptionCreateRequest, type FeedConsumptionView, type RationCreateRequest, type RationView } from './application/feeding';
export { AnimalCare, type AnimalEventView, type AnimalMoveRequest, type AnimalUpdateRequest } from './application/animal-care';
export { Batches, type BatchCreateRequest, type BatchView } from './application/batches';
export { Breeding, type BirthRequest, type BreedingCreateRequest, type BreedingRecordView } from './application/breeding';
export { Growth, type GrowthRowView } from './application/growth';
export { LivestockRecordInvalidError, MortalityPhotoRequiredError, RationInvalidError } from './application/errors';
export type { AnimalMoved, AnimalUpdated, BatchClosed, BatchStarted, BirthRecorded, AnimalRegistered, AnimalWeighed, FeedConsumed, HealthEventRecorded, MortalityApproved, MortalityPhotoReused, MortalityReported, MortalityReturned, WithdrawalStarted } from './events';
