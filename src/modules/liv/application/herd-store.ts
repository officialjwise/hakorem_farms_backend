import type { Transaction } from '../../../platform/database/unit-of-work';
import type { BreedingStatus } from '../domain/breeding';
import type { Treatment } from '../domain/cost-spread';
import type { AnimalRecord, ReadScope, Sex, WeightRecord } from './livestock-store';

export type BatchPurpose = 'GROWING' | 'BREEDING' | 'LAYING';
export type BatchStatus = 'ACTIVE' | 'CLOSED';

export interface BatchRecord {
  readonly id: string;
  readonly stockUnitId: string | null;
  readonly batchNo: string;
  readonly speciesId: string;
  readonly branchId: string;
  readonly locationId: string | null;
  readonly startedOn: string;
  readonly initialHead: number;
  readonly purpose: BatchPurpose;
  readonly status: BatchStatus;
  readonly closedAt: Date | null;
  readonly closeReason: string | null;
  readonly version: number;
}

export type NewBatch = Omit<BatchRecord, 'status' | 'closedAt' | 'closeReason' | 'version'>;

export interface BatchFilters {
  readonly status?: BatchStatus | undefined;
  readonly speciesId?: string | undefined;
}

export interface AnimalMoveRecord {
  readonly id: string;
  readonly stockUnitId: string;
  readonly branchId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly movementId: string;
  readonly note: string | null;
  readonly occurredAt: Date;
  readonly actorId: string;
}

export interface BreedingRecordRow {
  readonly id: string;
  readonly damId: string;
  readonly sireId: string | null;
  readonly matedOn: string;
  readonly expectedBirthOn: string | null;
  readonly actualBirthOn: string | null;
  readonly litterSize: number | null;
  readonly liveBirths: number | null;
  readonly stillbirths: number | null;
  readonly notes: string | null;
  readonly failReason: string | null;
  readonly status: BreedingStatus;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly postedAt: Date | null;
  readonly postedBy: string | null;
}

export type NewBreedingRecord = Pick<BreedingRecordRow, 'id' | 'damId' | 'sireId' | 'matedOn' | 'expectedBirthOn' | 'notes' | 'status' | 'branchId'>;

export interface BreedingFilters {
  readonly status?: BreedingStatus | undefined;
  readonly damId?: string | undefined;
  readonly dueBefore?: string | undefined;
}

export interface OffspringRow {
  readonly id: string;
  readonly tagNo: string;
  readonly sex: Sex;
  readonly breedingRecordId: string;
}

/** A health event as it touched one unit: the event itself, and the share of its cost the unit carried. */
export interface UnitHealthRow {
  readonly id: string;
  readonly kind: 'VACCINATION' | 'TREATMENT' | 'CHECK' | 'DEWORMING';
  readonly productId: string | null;
  readonly withdrawalDays: number;
  readonly occurredAt: Date;
  readonly actorId: string;
  readonly amountPesewas: bigint | null;
}

/** A feed consumption's share that one unit carried. */
export interface UnitFeedRow {
  readonly consumptionId: string;
  readonly locationId: string;
  readonly consumedOn: string;
  readonly postedAt: Date;
  readonly actorId: string;
  readonly amountPesewas: bigint;
  readonly treatment: Treatment;
}

/** A posted feed consumption in a window, with the head-days of every unit it was spread over. */
export interface WindowFeedRow {
  readonly locationId: string;
  readonly qty: string;
  readonly shares: ReadonlyArray<{ readonly stockUnitId: string; readonly headDays: bigint }>;
}

/** A posted death in a window: the unit, where it was found and how many head. */
export interface WindowDeathRow {
  readonly stockUnitId: string;
  readonly locationId: string;
  readonly head: number;
}

export interface UnitMortalityRow {
  readonly id: string;
  readonly kind: 'DEATH' | 'CULL';
  readonly status: string;
}

export const HERD_STORE = Symbol('HerdStore');

/** LIV's batch, move and breeding tables, and the reads growth and the timeline need (docs/data-model/liv.md). */
export interface HerdStore {
  /** Sets the editable columns of an animal at the version read; false if it moved on. */
  updateAnimal(tx: Transaction, id: string, version: number, set: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean>;
  /** Whether a breeding record names the animal as its dam (FR-LIV-002). */
  isDam(tx: Transaction, id: string): Promise<boolean>;

  insertBatch(tx: Transaction, batch: NewBatch, actorId: string): Promise<void>;
  batches(tx: Transaction, ids: readonly string[]): Promise<BatchRecord[]>;
  lockBatch(tx: Transaction, id: string): Promise<BatchRecord | null>;
  batchesOfUnits(tx: Transaction, stockUnitIds: readonly string[]): Promise<ReadonlyMap<string, BatchRecord>>;
  batchNoTaken(tx: Transaction, batchNo: string): Promise<boolean>;
  updateBatch(tx: Transaction, id: string, version: number, set: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean>;
  listBatches(tx: Transaction, filters: BatchFilters, scope: ReadScope, after: string | null, limit: number): Promise<BatchRecord[]>;
  /** Flock batches of the branches started by the date `toDay` and not closed before the instant `from`, in id order. */
  batchesInWindow(tx: Transaction, branchIds: readonly string[], speciesId: string | undefined, from: Date, toDay: string): Promise<BatchRecord[]>;

  insertMove(tx: Transaction, move: AnimalMoveRecord): Promise<void>;
  movesOf(tx: Transaction, stockUnitId: string): Promise<AnimalMoveRecord[]>;

  insertBreeding(tx: Transaction, record: NewBreedingRecord, actorId: string): Promise<void>;
  breeding(tx: Transaction, ids: readonly string[]): Promise<BreedingRecordRow[]>;
  lockBreeding(tx: Transaction, id: string): Promise<BreedingRecordRow | null>;
  updateBreeding(tx: Transaction, id: string, set: Readonly<Record<string, unknown>>, actorId: string): Promise<void>;
  listBreeding(tx: Transaction, filters: BreedingFilters, scope: ReadScope, after: string | null, limit: number): Promise<BreedingRecordRow[]>;
  breedingOfDam(tx: Transaction, damId: string): Promise<BreedingRecordRow[]>;
  offspringOf(tx: Transaction, breedingRecordIds: readonly string[]): Promise<OffspringRow[]>;
  /** Gestation days of a species by its code (FR-LIV-010, SA-19); null for a species that does not breed here. */
  gestationDays(tx: Transaction, speciesCode: string): Promise<number | null>;

  /** The animals of the branches alive now or closed at or after `since`: those a window from `since` can see. */
  livestockOf(tx: Transaction, branchIds: readonly string[], since: Date): Promise<AnimalRecord[]>;
  /** Every weighing of the units, oldest first, measured within the window when one is given. */
  weighingsOf(tx: Transaction, stockUnitIds: readonly string[], from?: Date, to?: Date): Promise<WeightRecord[]>;
  healthOfUnit(tx: Transaction, stockUnitId: string): Promise<UnitHealthRow[]>;
  feedOfUnit(tx: Transaction, stockUnitId: string): Promise<UnitFeedRow[]>;
  mortalityOfUnit(tx: Transaction, stockUnitId: string): Promise<UnitMortalityRow[]>;
  /** Posted feed consumptions of the branches consumed on the dates from `from` to `to`, both included. */
  feedInWindow(tx: Transaction, branchIds: readonly string[], from: string, to: string): Promise<WindowFeedRow[]>;
  /** Posted deaths (not culls) of the units found within the window, or ever when no window is given. */
  deathsOf(tx: Transaction, stockUnitIds: readonly string[], from?: Date, to?: Date): Promise<WindowDeathRow[]>;
}
