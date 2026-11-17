import type { Transaction } from '../../../platform/database/unit-of-work';
import type { CashMovementKind, OverShortDirection } from '../domain/till';

export interface RegisterRecord {
  readonly id: string;
  readonly branchId: string;
  readonly locationId: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'RETIRED';
  readonly version: number;
}

export type ShiftStatus = 'OPEN' | 'CLOSING' | 'CLOSED';

export interface ShiftRecord {
  readonly id: string;
  readonly shiftNo: string;
  readonly registerId: string;
  readonly cashierId: string;
  readonly shiftSeq: number;
  readonly openedAt: Date;
  readonly openingFloatPesewas: bigint;
  readonly declaredAt: Date | null;
  readonly declaredCashPesewas: bigint | null;
  readonly expectedCashPesewas: bigint | null;
  readonly overShortPesewas: bigint | null;
  readonly overShortDirection: OverShortDirection | null;
  readonly closeApprovedBy: string | null;
  readonly closedAt: Date | null;
  readonly lastDeviceCounter: number;
  readonly forceClosed: boolean;
  readonly status: ShiftStatus;
  readonly branchId: string;
  readonly version: number;
}

export interface NewShift {
  readonly id: string;
  readonly shiftNo: string;
  readonly registerId: string;
  readonly cashierId: string;
  readonly shiftSeq: number;
  readonly openedAt: Date;
  readonly openingFloatPesewas: bigint;
  readonly branchId: string;
  readonly actorId: string;
  readonly at: Date;
}

export interface CashMovementRecord {
  readonly id: string;
  readonly shiftId: string;
  readonly kind: CashMovementKind;
  readonly amountPesewas: bigint;
  readonly reasonCode: string | null;
  readonly note: string | null;
  readonly witnessId: string | null;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly actorId: string;
}

export interface TenderCountRecord {
  readonly shiftId: string;
  readonly paymentMethodId: string;
  readonly declaredPesewas: bigint;
  readonly expectedPesewas: bigint | null;
  readonly variancePesewas: bigint | null;
  readonly varianceDirection: OverShortDirection | null;
}

export interface ShiftFilter {
  readonly branchIds: readonly string[];
  readonly registerId: string | null;
  readonly cashierId: string | null;
  readonly status: ShiftStatus | null;
  readonly from: Date | null;
  readonly to: Date | null;
}

export const TILL_STORE = Symbol('TILL_STORE');

/** POS's tables (`pos.register`, `pos.shift`, `pos.cash_movement`, `pos.shift_tender_count`, `pos.shift_report`). */
export interface TillStore {
  registers(tx: Transaction, ids: readonly string[]): Promise<RegisterRecord[]>;
  lockRegister(tx: Transaction, id: string): Promise<RegisterRecord | null>;
  listRegisters(tx: Transaction, branchIds: readonly string[], beforeId: string | null, limit: number): Promise<RegisterRecord[]>;
  insertRegister(tx: Transaction, r: Omit<RegisterRecord, 'version' | 'status'>, actorId: string, at: Date): Promise<void>;
  updateRegister(tx: Transaction, id: string, patch: { readonly name: string; readonly locationId: string; readonly status: RegisterRecord['status'] }, actorId: string, at: Date): Promise<void>;
  /** The shift each register has OPEN or CLOSING, by register. */
  unclosedShifts(tx: Transaction, registerIds: readonly string[]): Promise<ReadonlyMap<string, ShiftRecord>>;
  unclosedShiftOfCashier(tx: Transaction, cashierId: string): Promise<ShiftRecord | null>;
  nextShiftSeq(tx: Transaction, registerId: string): Promise<number>;
  insertShift(tx: Transaction, shift: NewShift): Promise<void>;
  shifts(tx: Transaction, ids: readonly string[]): Promise<ShiftRecord[]>;
  lockShift(tx: Transaction, id: string): Promise<ShiftRecord | null>;
  listShifts(tx: Transaction, filter: ShiftFilter, beforeId: string | null, limit: number): Promise<ShiftRecord[]>;
  declare(tx: Transaction, id: string, d: { readonly declaredCashPesewas: bigint; readonly at: Date; readonly actorId: string }): Promise<void>;
  close(
    tx: Transaction,
    id: string,
    c: { readonly expectedCashPesewas: bigint; readonly overShortPesewas: bigint; readonly overShortDirection: OverShortDirection; readonly approvedBy: string; readonly at: Date },
  ): Promise<void>;
  insertCashMovement(tx: Transaction, m: CashMovementRecord): Promise<void>;
  cashMovements(tx: Transaction, ids: readonly string[]): Promise<CashMovementRecord[]>;
  cashMovementsOf(tx: Transaction, shiftId: string, beforeId: string | null, limit: number): Promise<CashMovementRecord[]>;
  /** Each kind's total over the shift's movements. */
  cashMovementTotals(tx: Transaction, shiftId: string): Promise<ReadonlyMap<CashMovementKind, bigint>>;
  insertTenderCounts(tx: Transaction, counts: readonly TenderCountRecord[], actorId: string, at: Date): Promise<void>;
  completeTenderCount(tx: Transaction, count: TenderCountRecord): Promise<void>;
  tenderCounts(tx: Transaction, shiftIds: readonly string[]): Promise<TenderCountRecord[]>;
  insertReport(tx: Transaction, r: { readonly id: string; readonly shiftId: string; readonly kind: 'Z'; readonly totals: object; readonly actorId: string; readonly at: Date }): Promise<void>;
  zReport(tx: Transaction, shiftId: string): Promise<{ readonly totals: Record<string, unknown>; readonly recordedAt: Date } | null>;
}
