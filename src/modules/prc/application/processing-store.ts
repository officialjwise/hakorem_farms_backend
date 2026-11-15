import type { Transaction } from '../../../platform/database/unit-of-work';
import type { OutputKind } from '../domain/cost-allocation';

export type OrderStatus = 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type WeightSource = 'SCALE' | 'MANUAL' | 'ESTIMATE';
export type CostKind = 'LABOUR' | 'CONSUMABLE' | 'SERVICE' | 'UTILITY';

export interface InputRecord {
  readonly id: string;
  readonly lineNo: number;
  readonly stockUnitId: string;
  readonly productId: string;
  readonly qty: string;
  readonly weightKg: string;
  readonly weightSource: WeightSource;
  readonly costPesewas: bigint | null;
  readonly movementId: string | null;
}

export interface OutputRecord {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly outputKind: OutputKind;
  readonly stockUnitId: string | null;
  readonly weightKg: string;
  readonly weightSource: WeightSource;
  readonly packCount: number | null;
  readonly expiresOn: string | null;
  readonly referencePricePesewasPerKg: bigint;
  readonly allocationWeight: bigint;
  readonly allocatedCostPesewas: bigint;
  readonly movementId: string | null;
}

export interface CostRecord {
  readonly id: string;
  readonly costKind: CostKind;
  readonly amountPesewas: bigint;
  readonly description: string;
  readonly createdAt: Date;
  readonly createdBy: string;
}

export interface OrderRecord {
  readonly id: string;
  readonly orderNo: string | null;
  readonly status: OrderStatus;
  readonly locationId: string;
  readonly outputLocationId: string;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly inputWeightKg: string | null;
  readonly outputWeightKg: string | null;
  readonly wasteWeightKg: string | null;
  readonly expectedYieldPercent: string | null;
  readonly actualYieldPercent: string | null;
  readonly yieldVarianceFlag: boolean;
  readonly inputCostPesewas: bigint | null;
  readonly directCostPesewas: bigint;
  readonly totalCostPesewas: bigint | null;
  readonly cancelReason: string | null;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly postedAt: Date | null;
  readonly postedBy: string | null;
  /** The order's reversal (FR-PRC-011), when it was reversed. */
  readonly reversal: { readonly id: string; readonly reason: string; readonly at: Date; readonly by: string } | null;
  readonly inputs: readonly InputRecord[];
  readonly outputs: readonly OutputRecord[];
  readonly costs: readonly CostRecord[];
}

export interface OrderFilters {
  readonly status?: OrderStatus | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly yieldVarianceFlag?: boolean | undefined;
}

/** A grant an order list is narrowed to: a whole branch, or one location of it. */
export interface ReadScope {
  readonly branchId: string | null;
  readonly locationId: string | null;
}

export interface NewInput {
  readonly id: string;
  readonly lineNo: number;
  readonly stockUnitId: string;
  readonly productId: string;
  readonly qty: string;
  readonly weightKg: string;
  readonly weightSource: WeightSource;
}

export interface NewOutput {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly outputKind: OutputKind;
  readonly weightKg: string;
  readonly weightSource: WeightSource;
  readonly packCount: number | null;
  readonly expiresOn: string | null;
}

export interface Completion {
  readonly at: Date;
  readonly inputWeightKg: string;
  readonly outputWeightKg: string;
  readonly wasteWeightKg: string;
  readonly expectedYieldPercent: string | null;
  readonly actualYieldPercent: string | null;
  readonly yieldVarianceFlag: boolean;
  readonly inputCostPesewas: bigint;
  readonly totalCostPesewas: bigint;
}

export interface YieldStandardRecord {
  readonly id: string;
  readonly inputProductId: string;
  readonly outputProductId: string;
  readonly expectedPercent: string;
  readonly tolerancePercent: string;
  readonly version: number;
}

export type PackStatus = 'IN_STOCK' | 'PICKED' | 'SOLD' | 'WRITTEN_OFF' | 'REVERSED';

/** A weighed, labelled pack of an output's lot (migration 0085). */
export interface PackRecord {
  readonly id: string;
  readonly stockUnitId: string;
  readonly processingOutputId: string;
  readonly outputLineNo: number;
  readonly packNo: number;
  readonly weightKg: string;
  readonly weightSource: WeightSource;
  readonly barcode: string;
  readonly labelPrintedAt: Date | null;
  readonly status: PackStatus;
}

export interface NewPack {
  readonly id: string;
  readonly stockUnitId: string;
  readonly processingOutputId: string;
  readonly packNo: number;
  readonly weightKg: string;
  readonly weightSource: WeightSource;
  readonly barcode: string;
}

export const PROCESSING_STORE = Symbol('ProcessingStore');

/** The `prc` schema of migrations 0072, 0085 and 0087. */
export interface ProcessingStore {
  insertOrder(tx: Transaction, order: { id: string; locationId: string; outputLocationId: string; branchId: string }, actorId: string): Promise<void>;
  order(tx: Transaction, id: string): Promise<OrderRecord | null>;
  /** Locks the order row for the command and answers its status and version. */
  lock(tx: Transaction, id: string): Promise<{ status: OrderStatus; version: number } | null>;
  orders(tx: Transaction, filters: OrderFilters, scopes: readonly ReadScope[], afterId: string | null, limit: number): Promise<OrderRecord[]>;
  /** Moves the version on by one when it is `version`; false when it is not. */
  touch(tx: Transaction, id: string, version: number, set: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean>;
  insertInput(tx: Transaction, orderId: string, input: NewInput): Promise<void>;
  clearInputs(tx: Transaction, orderId: string): Promise<void>;
  insertOutput(tx: Transaction, orderId: string, output: NewOutput): Promise<void>;
  clearOutputs(tx: Transaction, orderId: string): Promise<void>;
  insertCost(tx: Transaction, orderId: string, cost: { id: string; costKind: CostKind; amountPesewas: bigint; description: string }, actorId: string): Promise<void>;
  markStarted(tx: Transaction, id: string, at: Date, actorId: string): Promise<void>;
  markCancelled(tx: Transaction, id: string, reason: string, actorId: string): Promise<void>;
  setInputConsumed(tx: Transaction, inputId: string, costPesewas: bigint, movementId: string): Promise<void>;
  setOutputCosted(
    tx: Transaction,
    outputId: string,
    costed: { referencePricePesewasPerKg: bigint; allocationWeight: bigint; allocatedCostPesewas: bigint; expiresOn: string | null; stockUnitId: string | null; movementId: string | null },
  ): Promise<void>;
  markCompleted(tx: Transaction, id: string, completion: Completion, actorId: string): Promise<void>;
  standards(tx: Transaction, afterId: string | null, limit: number): Promise<YieldStandardRecord[]>;
  standard(tx: Transaction, id: string): Promise<YieldStandardRecord | null>;
  standardsOf(tx: Transaction, inputProductId: string): Promise<YieldStandardRecord[]>;
  insertStandard(tx: Transaction, standard: Omit<YieldStandardRecord, 'version'>, actorId: string): Promise<boolean>;
  updateStandard(tx: Transaction, id: string, version: number, set: { expectedPercent?: string; tolerancePercent?: string }, actorId: string): Promise<boolean>;
  /** An order's packs in output line and pack order, after `after` (output line, pack number) when given. */
  packsOf(tx: Transaction, orderId: string, after: { lineNo: number; packNo: number } | null, limit: number): Promise<PackRecord[]>;
  /** The packs with these ids, locked for the command, in output line and pack order. */
  lockPacks(tx: Transaction, ids: readonly string[]): Promise<PackRecord[]>;
  insertPack(tx: Transaction, pack: NewPack, actorId: string): Promise<void>;
  /** Sets the first print time of each pack that has none. */
  markPrinted(tx: Transaction, ids: readonly string[], at: Date, actorId: string): Promise<void>;
  setPackStatus(tx: Transaction, ids: readonly string[], status: PackStatus, actorId: string): Promise<void>;
  insertReversal(tx: Transaction, reversal: { id: string; orderId: string; branchId: string; reason: string; at: Date }, actorId: string): Promise<void>;
}
