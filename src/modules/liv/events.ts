/**
 * Events LIV publishes (docs/DOMAIN_MODEL.md section 5.5). Types only: subscribers import them with `import type`.
 * None posts to the ledger itself: the stock and cost effects are INV's movements and their events (ADR-0003), and
 * these carry the livestock facts beside them for costing (B12), reporting (B12) and the daily exception report.
 */

/** `liv.AnimalRegistered` v1: a serialised stock unit became an animal in the register (FR-LIV-001). */
export interface AnimalRegistered {
  readonly stockUnitId: string;
  readonly tagNo: string;
  readonly speciesId: string;
  readonly productId: string;
  readonly branchId: string;
  readonly source: 'PURCHASE' | 'BIRTH' | 'OPENING';
  readonly supplierId: string | null;
  readonly acquisitionCostPesewas: number;
  readonly purpose: 'GROWING' | 'BREEDING';
}

/** `liv.AnimalWeighed` v1: a weighing was recorded (FR-LIV-004), with its source. */
export interface AnimalWeighed {
  readonly weightRecordId: string;
  readonly stockUnitId: string;
  readonly branchId: string;
  readonly weightKg: string;
  readonly weightSource: 'SCALE' | 'MANUAL' | 'ESTIMATE';
  readonly headWeighed: number;
  readonly measuredAt: string;
}

/** `liv.HealthEventRecorded` v1 (FR-LIV-007, FR-LIV-009): the treatment, the medication issued and the cost spread. */
export interface HealthEventRecorded {
  readonly healthEventId: string;
  readonly kind: 'VACCINATION' | 'TREATMENT' | 'CHECK' | 'DEWORMING';
  readonly branchId: string;
  readonly stockUnitIds: readonly string[];
  readonly productId: string | null;
  /** Medication issued from stock, valued by inventory; part of `costPesewas`. */
  readonly medicationValuePesewas: number;
  /** A veterinary service charged beside the medication; the rest of `costPesewas`. B8 posts its credit side. */
  readonly serviceCostPesewas: number;
  readonly costPesewas: number;
  readonly occurredAt: string;
}

/** `liv.WithdrawalStarted` v1 (FR-LIV-008): holds were placed that block sale and processing until `endsAt`. */
export interface WithdrawalStarted {
  readonly healthEventId: string;
  readonly branchId: string;
  readonly stockUnitIds: readonly string[];
  readonly withdrawalDays: number;
  readonly endsAt: string;
}

/**
 * `liv.MortalityReported` v1 (FR-LIV-012, threat model abuse case 2): a death or cull was submitted for write-off,
 * with who reported it and where, its value and the threshold it was judged against. The daily exception report
 * (B12) reads it for mortality rate by handler against the pen average; `abuseCases` names what it can reveal.
 */
export interface MortalityReported {
  readonly mortalityRecordId: string;
  readonly kind: 'DEATH' | 'CULL';
  readonly stockUnitId: string;
  readonly branchId: string;
  readonly locationId: string;
  readonly head: number;
  readonly reasonCode: string;
  readonly reportedBy: string;
  readonly valuePesewas: number;
  readonly thresholdPesewas: number;
  readonly needsApproval: boolean;
  readonly approvalRequestId: string | null;
  readonly abuseCases: readonly number[];
}

/** `liv.MortalityApproved` v1: a write-off at or above the threshold was approved by a different person and posted. */
export interface MortalityApproved {
  readonly mortalityRecordId: string;
  readonly branchId: string;
  readonly reportedBy: string;
  readonly approvedBy: string;
  readonly valuePesewas: number;
  readonly movementId: string;
}

/** `liv.FeedConsumed` v1 (FR-LIV-015, FR-LIV-016): feed issued to a pen and spread across it by head-days. */
export interface FeedConsumed {
  readonly feedConsumptionId: string;
  readonly branchId: string;
  readonly locationId: string;
  readonly feedProductId: string;
  readonly qty: string;
  readonly consumedOn: string;
  readonly valuePesewas: number;
  readonly allocations: ReadonlyArray<{ readonly stockUnitId: string; readonly headDays: number; readonly amountPesewas: number; readonly treatment: 'CAPITALISED' | 'EXPENSED' }>;
}

/** `liv.AnimalUpdated` v1 (FR-LIV-002): an animal's breed, sex, purpose or grade changed; purpose decides its cost treatment. */
export interface AnimalUpdated {
  readonly stockUnitId: string;
  readonly branchId: string;
  readonly changed: readonly string[];
  readonly purpose: 'GROWING' | 'BREEDING';
}

/** `liv.AnimalMoved` v1 (FR-LIV-003): an animal moved between pens of its branch, by a TRANSFER_INTERNAL movement. */
export interface AnimalMoved {
  readonly moveId: string;
  readonly stockUnitId: string;
  readonly branchId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly movementId: string;
  readonly occurredAt: string;
}

/** `liv.BatchStarted` v1 (FR-LIV-006): a batch opened, from a received flock or a hatch on the farm. */
export interface BatchStarted {
  readonly batchId: string;
  readonly batchNo: string;
  readonly stockUnitId: string | null;
  readonly speciesId: string;
  readonly branchId: string;
  readonly initialHead: number;
  readonly purpose: 'GROWING' | 'BREEDING' | 'LAYING';
  readonly startedOn: string;
}

/** `liv.BatchClosed` v1 (FR-LIV-006): a batch with no head left was closed, with its reason. */
export interface BatchClosed {
  readonly batchId: string;
  readonly branchId: string;
  readonly reason: string;
  readonly mortalityPercent: string;
}

/** `liv.BirthRecorded` v1 (FR-LIV-011): a dam gave birth; each live offspring was registered at nil cost. */
export interface BirthRecorded {
  readonly breedingRecordId: string;
  readonly damId: string;
  readonly branchId: string;
  readonly actualBirthOn: string;
  readonly litterSize: number;
  readonly liveBirths: number;
  readonly offspringIds: readonly string[];
}
