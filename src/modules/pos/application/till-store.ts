import type { Transaction } from '../../../platform/database/unit-of-work';
import type { HeldSaleStatus } from '../domain/held-sale';
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
  /** Why a manager force-closed it (FR-POS-020); null on every other shift. */
  readonly forceCloseReason: string | null;
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
  /** A drop taken while no supervisor was signed in at the branch (A-273 (d)). */
  readonly unwitnessed: boolean;
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

/** The drawer of a force-closed shift, counted later by a supervisor who neither ran it nor force-closed it (A-275). */
export interface LateCountRecord {
  readonly shiftId: string;
  readonly declaredCashPesewas: bigint;
  readonly expectedCashPesewas: bigint;
  readonly overShortPesewas: bigint;
  readonly overShortDirection: OverShortDirection;
  readonly reason: string;
  readonly countedAt: Date;
  readonly actorId: string;
}

export interface ShiftFilter {
  readonly branchIds: readonly string[];
  readonly registerId: string | null;
  readonly cashierId: string | null;
  readonly status: ShiftStatus | null;
  readonly from: Date | null;
  readonly to: Date | null;
}

/** A device enrolled to run a till (ADR-0016); its credential is held only as its SHA-256 hash. */
export interface DeviceRecord {
  readonly id: string;
  readonly registerId: string;
  readonly deviceLabel: string;
  readonly enrolledBy: string;
  readonly enrolledAt: Date;
  readonly lastSyncAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
  readonly branchId: string;
  readonly version: number;
}

/** A sale parked on a till's open shift (`pos.held_sale`, WORK; FR-POS-007, A-276). */
export interface HeldSaleRecord {
  readonly id: string;
  readonly registerId: string;
  readonly shiftId: string;
  readonly branchId: string;
  readonly heldBy: string;
  readonly label: string | null;
  /** The lines as entered: `{ customerId?, lines: [...] }`; prices are re-resolved on recall. */
  readonly payload: HeldSalePayload;
  readonly heldGrossPesewas: bigint;
  readonly heldAt: Date;
  readonly expiresAt: Date;
  readonly status: HeldSaleStatus;
  readonly recalledAt: Date | null;
  readonly recalledBy: string | null;
  readonly lapsedAt: Date | null;
  readonly lapseReason: 'SHIFT_CLOSED' | 'SHIFT_FORCE_CLOSED' | null;
}

/** A held sale's lines, as a counter sale would carry them, without tenders. */
export interface HeldSalePayload {
  readonly customerId?: string | undefined;
  readonly lines: readonly {
    readonly productId: string;
    readonly stockUnitId?: string | undefined;
    readonly quantity: string;
    readonly weightKg?: string | undefined;
    readonly weightSource?: 'SCALE' | 'MANUAL' | 'ESTIMATE' | undefined;
    readonly gradeId?: string | undefined;
  }[];
}

/** One offline sale's submission (`pos.sale_sync`, migration 0256), as logged once and never changed. */
export interface SaleSyncRecord {
  readonly id: string;
  readonly deviceId: string;
  readonly shiftId: string;
  readonly branchId: string;
  readonly clientSaleId: string;
  readonly deviceCounter: number;
  readonly provisionalRef: string;
  readonly clientOccurredAt: Date;
  readonly payloadHash: Buffer;
  readonly outcome: 'APPLIED' | 'APPLIED_WITH_EXCEPTION' | 'DUPLICATE' | 'REJECTED_INTEGRITY';
  readonly orderDocumentId: string | null;
  readonly orderNo: string | null;
  readonly receiptNo: string | null;
  readonly grossPesewas: bigint | null;
  readonly exceptions: readonly { readonly kind: string; readonly summary: string }[];
  readonly rejectionRule: string | null;
  readonly postedLateReason: 'PERIOD_LOCKED' | 'SHIFT_CLOSED' | 'AFTER_FORCE_CLOSE' | null;
  readonly postingDate: string | null;
  readonly clockVerdict: 'AHEAD_OF_SERVER' | 'BEFORE_SHIFT_OPENED' | null;
  readonly tooOld: boolean;
  readonly receivedAt: Date;
  readonly actorId: string;
}

export const TILL_STORE = Symbol('TILL_STORE');

/** POS's tables (`pos.register`, `pos.shift`, `pos.cash_movement`, `pos.shift_tender_count`, `pos.shift_report`, `pos.shift_late_count`). */
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
  /** OPEN to CLOSED by a manager (FR-POS-020): at its expected cash, flagged force-closed, nothing declared. */
  forceClose(tx: Transaction, id: string, c: { readonly expectedCashPesewas: bigint; readonly reason: string; readonly closedBy: string; readonly at: Date }): Promise<void>;
  insertLateCount(tx: Transaction, c: LateCountRecord): Promise<void>;
  lateCounts(tx: Transaction, shiftIds: readonly string[]): Promise<ReadonlyMap<string, LateCountRecord>>;
  insertCashMovement(tx: Transaction, m: CashMovementRecord): Promise<void>;
  cashMovements(tx: Transaction, ids: readonly string[]): Promise<CashMovementRecord[]>;
  cashMovementsOf(tx: Transaction, shiftId: string, beforeId: string | null, limit: number): Promise<CashMovementRecord[]>;
  /** Each kind's total over the shift's movements. */
  cashMovementTotals(tx: Transaction, shiftId: string): Promise<ReadonlyMap<CashMovementKind, bigint>>;
  /** The shift's drops taken unwitnessed (A-273 (d)): how many and how much. */
  unwitnessedDrops(tx: Transaction, shiftId: string): Promise<{ readonly count: number; readonly amountPesewas: bigint }>;
  insertTenderCounts(tx: Transaction, counts: readonly TenderCountRecord[], actorId: string, at: Date): Promise<void>;
  completeTenderCount(tx: Transaction, count: TenderCountRecord): Promise<void>;
  tenderCounts(tx: Transaction, shiftIds: readonly string[]): Promise<TenderCountRecord[]>;
  insertReport(tx: Transaction, r: { readonly id: string; readonly shiftId: string; readonly kind: 'Z'; readonly totals: object; readonly actorId: string; readonly at: Date }): Promise<void>;
  zReport(tx: Transaction, shiftId: string): Promise<{ readonly totals: Record<string, unknown>; readonly recordedAt: Date } | null>;
  insertDevice(tx: Transaction, d: { readonly id: string; readonly registerId: string; readonly deviceLabel: string; readonly credentialHash: Buffer; readonly branchId: string }, actorId: string, at: Date): Promise<void>;
  devices(tx: Transaction, ids: readonly string[]): Promise<DeviceRecord[]>;
  lockDevice(tx: Transaction, id: string): Promise<DeviceRecord | null>;
  /** The device whose credential hashes to this, revoked or not. */
  deviceByCredential(tx: Transaction, credentialHash: Buffer): Promise<DeviceRecord | null>;
  devicesOfRegister(tx: Transaction, registerId: string, beforeId: string | null, limit: number): Promise<DeviceRecord[]>;
  revokeDevice(tx: Transaction, id: string, reason: string, actorId: string, at: Date): Promise<void>;
  /** Live (not revoked) devices per register. */
  insertHeldSale(tx: Transaction, h: Omit<HeldSaleRecord, 'status' | 'recalledAt' | 'recalledBy' | 'lapsedAt' | 'lapseReason'>): Promise<void>;
  /** Held sales by id, locked when asked. */
  heldSales(tx: Transaction, ids: readonly string[], forUpdate?: boolean): Promise<HeldSaleRecord[]>;
  /** The sales still HELD on a register, newest first, below `beforeId`, none expired at `at`. */
  heldSalesOfRegister(tx: Transaction, registerId: string, at: Date, beforeId: string | null, limit: number): Promise<HeldSaleRecord[]>;
  recallHeldSale(tx: Transaction, id: string, r: { readonly by: string; readonly at: Date }): Promise<void>;
  /** Every sale still HELD on a shift becomes LAPSED; answers the ids lapsed. */
  lapseHeldSales(tx: Transaction, shiftId: string, l: { readonly reason: 'SHIFT_CLOSED' | 'SHIFT_FORCE_CLOSED'; readonly at: Date }): Promise<string[]>;
  liveDeviceCounts(tx: Transaction, registerIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
  insertSaleSync(tx: Transaction, row: SaleSyncRecord): Promise<void>;
  /** The applied submission (APPLIED or APPLIED_WITH_EXCEPTION) of each client sale id, if any. */
  appliedSales(tx: Transaction, clientSaleIds: readonly string[]): Promise<ReadonlyMap<string, SaleSyncRecord>>;
  /** The client sale id an applied submission of the shift holds this device counter for, if any. */
  appliedCounterOwner(tx: Transaction, shiftId: string, deviceCounter: number): Promise<string | null>;
  /** Every device counter the shift has received, whatever became of it (a refused sale was received, OFFLINE_SYNC 9.8). */
  receivedCounters(tx: Transaction, shiftId: string): Promise<number[]>;
  /** The highest counter synced on a shift not yet CLOSED, raised only (`pos.shift.last_device_counter`). */
  noteDeviceCounter(tx: Transaction, shiftId: string, deviceCounter: number, actorId: string, at: Date): Promise<void>;
  /** When a device last synced (`pos.device_enrolment.last_sync_at`). */
  noteDeviceSync(tx: Transaction, deviceId: string, at: Date, actorId: string): Promise<void>;
}
