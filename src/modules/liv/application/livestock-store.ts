import type { Transaction } from '../../../platform/database/unit-of-work';
import type { AnimalStatus } from '../domain/animal';
import type { Treatment } from '../domain/cost-spread';
import type { MortalityKind } from '../domain/mortality';

export type WeightSource = 'SCALE' | 'MANUAL' | 'ESTIMATE';
export type Sex = 'MALE' | 'FEMALE' | 'UNKNOWN';
export type Purpose = 'GROWING' | 'BREEDING';
export type HealthKind = 'VACCINATION' | 'TREATMENT' | 'CHECK' | 'DEWORMING';
export type MortalityStatus = 'REPORTED' | 'PENDING_APPROVAL' | 'POSTED' | 'REJECTED';

/**
 * What a list may show the actor (ADR-0035): records at a branch where a branch-wide grant holds the permission, at a
 * location a location grant names, or of a stock unit standing at one of those locations now.
 */
export interface ReadScope {
  readonly branchIds: readonly string[];
  readonly locationIds: readonly string[];
  readonly unitIds: readonly string[];
}

export interface AnimalRecord {
  readonly stockUnitId: string;
  readonly tagNo: string;
  readonly speciesId: string;
  readonly productId: string;
  readonly branchId: string;
  readonly breed: string | null;
  readonly sex: Sex;
  readonly dateOfBirth: string | null;
  readonly acquiredOn: string;
  readonly source: 'PURCHASE' | 'BIRTH' | 'OPENING';
  readonly supplierId: string | null;
  readonly acquisitionCostPesewas: bigint;
  readonly damId: string | null;
  readonly sireId: string | null;
  readonly purpose: Purpose;
  readonly status: AnimalStatus;
  readonly exitValuePesewas: bigint | null;
  readonly version: number;
  readonly createdAt: Date;
}

export type NewAnimal = Omit<AnimalRecord, 'status' | 'exitValuePesewas' | 'version' | 'createdAt'>;

export interface AnimalFilters {
  readonly q?: string | undefined;
  readonly speciesId?: string | undefined;
  readonly status?: AnimalStatus | undefined;
  readonly purpose?: Purpose | undefined;
  /** Only these stock units (the animals standing at a location); undefined for no such filter. */
  readonly unitIds?: readonly string[] | undefined;
}

export interface WeightRecord {
  readonly id: string;
  readonly stockUnitId: string;
  readonly branchId: string;
  readonly weightKg: string;
  readonly weightSource: WeightSource;
  readonly headWeighed: number;
  readonly measuredAt: Date;
  readonly actorId: string;
}

export interface WeightFilters {
  readonly stockUnitId?: string | undefined;
  readonly unitIds?: readonly string[] | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

export interface CostAllocationRecord {
  readonly stockUnitId: string;
  readonly headDays: bigint;
  readonly amountPesewas: bigint;
  readonly treatment: Treatment;
  readonly movementId: string | null;
}

export interface HealthEventRecord {
  readonly id: string;
  readonly kind: HealthKind;
  readonly branchId: string;
  readonly stockUnitId: string | null;
  readonly locationId: string | null;
  readonly productId: string | null;
  readonly dose: string | null;
  readonly qtyUsed: string | null;
  readonly withdrawalDays: number;
  readonly withdrawalEndsAt: Date | null;
  readonly stockHoldId: string | null;
  readonly holdsPlaced: number;
  readonly costPesewas: bigint;
  readonly medicationValuePesewas: bigint;
  readonly issueMovementId: string | null;
  readonly administeredBy: string | null;
  readonly notes: string | null;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly actorId: string;
}

export type NewHealthEvent = Omit<HealthEventRecord, 'recordedAt'>;

export interface HealthFilters {
  readonly stockUnitId?: string | undefined;
  readonly locationId?: string | undefined;
  readonly kind?: HealthKind | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

export interface MortalityRecord {
  readonly id: string;
  readonly kind: MortalityKind;
  readonly stockUnitId: string;
  readonly locationId: string;
  readonly head: number;
  readonly reasonCode: string;
  readonly foundAt: Date;
  readonly reportedBy: string;
  readonly photoFileId: string | null;
  readonly valuePesewas: bigint;
  readonly thresholdPesewas: bigint | null;
  readonly approvalRequestId: string | null;
  readonly movementId: string | null;
  readonly disposalNote: string | null;
  readonly status: MortalityStatus;
  readonly branchId: string;
  readonly version: number;
}

export type NewMortality = Omit<MortalityRecord, 'status' | 'version' | 'thresholdPesewas' | 'approvalRequestId' | 'movementId'>;

export interface MortalityFilters {
  readonly status?: MortalityStatus | undefined;
  readonly kind?: MortalityKind | undefined;
  readonly reportedBy?: string | undefined;
  readonly locationId?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

export interface RationRecord {
  readonly id: string;
  readonly name: string;
  readonly speciesId: string;
  readonly feedProductId: string;
  readonly qtyPerHeadPerDay: string;
  readonly stage: string | null;
  readonly version: number;
}

export interface FeedConsumptionRecord {
  readonly id: string;
  readonly locationId: string;
  readonly fromLocationId: string;
  readonly feedProductId: string;
  readonly qty: string;
  readonly consumedOn: string;
  readonly rationId: string | null;
  readonly valuePesewas: bigint | null;
  readonly issueMovementId: string | null;
  readonly status: 'DRAFT' | 'POSTED';
  readonly branchId: string;
  readonly postedAt: Date | null;
  readonly createdBy: string;
  readonly allocations: readonly CostAllocationRecord[];
}

export interface FeedFilters {
  readonly locationId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export const LIVESTOCK_STORE = Symbol('LivestockStore');

/** LIV's tables (docs/data-model/liv.md). Reads and writes only schema `liv`; lists come in id order after a cursor. */
export interface LivestockStore {
  insertAnimal(tx: Transaction, animal: NewAnimal, actorId: string): Promise<void>;
  animals(tx: Transaction, ids: readonly string[]): Promise<AnimalRecord[]>;
  lockAnimal(tx: Transaction, id: string): Promise<AnimalRecord | null>;
  /** The live animal carrying the tag, if any (FR-LIV-001: one live animal per tag). */
  liveAnimalByTag(tx: Transaction, tagNo: string): Promise<string | null>;
  setAnimalStatus(tx: Transaction, id: string, status: AnimalStatus, exitValuePesewas: bigint | null, at: Date, actorId: string): Promise<void>;
  /** Animals matching the filters in id order after `after`; `limit` rows at most. */
  listAnimals(tx: Transaction, filters: AnimalFilters, scope: ReadScope, after: string | null, limit: number): Promise<AnimalRecord[]>;

  insertWeight(tx: Transaction, record: WeightRecord): Promise<void>;
  weights(tx: Transaction, ids: readonly string[]): Promise<WeightRecord[]>;
  latestWeights(tx: Transaction, stockUnitIds: readonly string[]): Promise<ReadonlyMap<string, WeightRecord>>;
  listWeights(tx: Transaction, filters: WeightFilters, scope: ReadScope, after: string | null, limit: number): Promise<WeightRecord[]>;

  insertHealthEvent(tx: Transaction, event: NewHealthEvent): Promise<void>;
  insertHealthAllocation(tx: Transaction, eventId: string, allocation: CostAllocationRecord, actorId: string): Promise<void>;
  healthEvents(tx: Transaction, ids: readonly string[]): Promise<HealthEventRecord[]>;
  listHealthEvents(tx: Transaction, filters: HealthFilters, scope: ReadScope, after: string | null, limit: number): Promise<HealthEventRecord[]>;

  insertMortality(tx: Transaction, record: NewMortality, actorId: string): Promise<void>;
  mortality(tx: Transaction, id: string): Promise<MortalityRecord | null>;
  lockMortality(tx: Transaction, id: string): Promise<MortalityRecord | null>;
  /** Sets the columns named, by their column names, and the actor; the status guard and the freeze decide what is allowed. */
  updateMortality(tx: Transaction, id: string, set: Readonly<Record<string, unknown>>, actorId: string): Promise<void>;
  /** A record of the stock unit waiting for approval, other than `exceptId`: the animal is already on its way out. */
  openMortalityOf(tx: Transaction, stockUnitId: string, exceptId: string | null): Promise<string | null>;
  listMortality(tx: Transaction, filters: MortalityFilters, scope: ReadScope, after: string | null, limit: number): Promise<MortalityRecord[]>;

  insertRation(tx: Transaction, ration: Omit<RationRecord, 'version'>, actorId: string): Promise<void>;
  ration(tx: Transaction, id: string): Promise<RationRecord | null>;
  updateRation(tx: Transaction, id: string, version: number, set: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean>;
  listRations(tx: Transaction, speciesId: string | undefined, after: string | null, limit: number): Promise<RationRecord[]>;

  insertFeedConsumption(tx: Transaction, record: Omit<FeedConsumptionRecord, 'allocations' | 'createdBy'>, actorId: string): Promise<void>;
  insertFeedAllocation(tx: Transaction, consumptionId: string, allocation: CostAllocationRecord, actorId: string): Promise<void>;
  feedConsumptions(tx: Transaction, ids: readonly string[]): Promise<FeedConsumptionRecord[]>;
  listFeedConsumptions(tx: Transaction, filters: FeedFilters, scope: ReadScope, after: string | null, limit: number): Promise<FeedConsumptionRecord[]>;
}
