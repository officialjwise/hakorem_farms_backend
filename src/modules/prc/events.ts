/**
 * Events PRC publishes (docs/DOMAIN_MODEL.md section 5.6). Types only: subscribers import them with `import type`.
 * ◆ marks an event the ledger posts from (ADR-0003); B8 builds the posting.
 */

/** `prc.ProcessingOrderStarted` v1: the inputs were checked and processing began. */
export interface ProcessingOrderStarted {
  readonly processingOrderId: string;
  readonly branchId: string;
  readonly locationId: string;
  readonly stockUnitIds: readonly string[];
  readonly startedAt: string;
}

/**
 * ◆ `prc.DirectCostIncurred` v1: a direct processing cost entered the order's work in progress, published when the
 * order completes so that a cancelled order leaves nothing behind (A-153). ADR-0003: 1340 debit, 2020 credit.
 */
export interface DirectCostIncurred {
  readonly processingOrderId: string;
  readonly processingCostId: string;
  readonly costKind: string;
  readonly valuePesewas: number;
  readonly branchId: string;
  readonly sourceDocumentId: string;
}

/** `prc.ProcessingOrderCompleted` v1: inputs consumed, output lots received at their allocated cost, lineage written. */
export interface ProcessingOrderCompleted {
  readonly processingOrderId: string;
  readonly branchId: string;
  readonly inputCostPesewas: number;
  readonly directCostPesewas: number;
  readonly totalCostPesewas: number;
  readonly inputStockUnitIds: readonly string[];
  readonly outputs: ReadonlyArray<{ readonly lineNo: number; readonly outputKind: string; readonly productId: string; readonly stockUnitId: string | null; readonly weightKg: string; readonly allocatedCostPesewas: number }>;
  readonly yieldVarianceFlag: boolean;
  readonly completedAt: string;
}

/**
 * `prc.YieldVarianceFlagged` v1 (FR-PRC-005, threat model abuse case 18): an output product's actual yield is outside
 * its standard's tolerance. The daily exception report (B12) lists it as `YIELD_VARIANCE` with the order, the actor
 * and the weights; the flag never blocks completion and posts no ledger figure (BL-007).
 */
export interface YieldVarianceFlagged {
  readonly processingOrderId: string;
  readonly branchId: string;
  readonly actorId: string;
  readonly inputWeightKg: string;
  readonly expectedYieldPercent: string;
  readonly actualYieldPercent: string;
  readonly lines: ReadonlyArray<{ readonly productId: string; readonly expectedKg: string; readonly actualKg: string; readonly varianceKg: string; readonly flagged: boolean }>;
  readonly abuseCases: readonly number[];
}
