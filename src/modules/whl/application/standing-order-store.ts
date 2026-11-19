import type { Transaction } from '../../../platform/database/unit-of-work';
import type { Frequency } from '../domain/schedule';

export const STANDING_ORDER_STORE = Symbol('STANDING_ORDER_STORE');

export type StandingOrderStatus = 'ACTIVE' | 'PAUSED' | 'ENDED' | 'CANCELLED';
export type RunOutcome = 'CREATED' | 'HELD_FOR_CREDIT' | 'SKIPPED_ON_HOLD' | 'SKIPPED_NO_PRICE' | 'MISSED' | 'FAILED';

/** A line in force of a `whl.standing_order`. */
export interface StandingOrderLineRecord {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  /** In `uom`, as a decimal string with three places. */
  readonly qty: string;
  readonly uom: string;
}

/** A `whl.standing_order` row with its lines in force. */
export interface StandingOrderRecord {
  readonly id: string;
  readonly customerId: string;
  readonly branchId: string;
  readonly frequency: Frequency;
  readonly weekdays: readonly number[];
  readonly dayOfMonth: number | null;
  readonly intervalDays: number | null;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly nextRunOn: string | null;
  readonly salespersonId: string;
  readonly status: StandingOrderStatus;
  readonly version: number;
  readonly lines: readonly StandingOrderLineRecord[];
}

/** The schedule and state a change writes. */
export interface StandingOrderChange {
  readonly weekdays: readonly number[];
  readonly dayOfMonth: number | null;
  readonly intervalDays: number | null;
  readonly endsOn: string | null;
  readonly nextRunOn: string | null;
  readonly status: StandingOrderStatus;
}

/** A `whl.standing_order_run` row. */
export interface StandingOrderRunRecord {
  readonly standingOrderId: string;
  readonly runDate: string;
  readonly outcome: RunOutcome;
  readonly orderId: string | null;
  readonly reason: string | null;
  readonly recordedAt: Date;
}

export interface StandingOrderFilter {
  readonly branchIds: readonly string[];
  readonly customerId: string | null;
  readonly status: StandingOrderStatus | null;
}

/** WHL's standing orders and their runs (FR-WHL-004, migration 0274). */
export interface StandingOrderStore {
  insert(tx: Transaction, order: Omit<StandingOrderRecord, 'version' | 'lines'>, actorId: string, at: Date): Promise<void>;
  insertLines(tx: Transaction, standingOrderId: string, lines: readonly StandingOrderLineRecord[], actorId: string, at: Date): Promise<void>;
  /** Retires every line in force, so a new set can take their numbers. */
  retireLines(tx: Transaction, standingOrderId: string, actorId: string, at: Date): Promise<void>;
  /** One order with its lines in force; `lock` takes its row lock, so two runs of one order queue. */
  get(tx: Transaction, id: string, lock: boolean): Promise<StandingOrderRecord | null>;
  /** The orders at the branches given, newest first. */
  list(tx: Transaction, filter: StandingOrderFilter, beforeId: string | null, limit: number): Promise<StandingOrderRecord[]>;
  /** Writes a change at the version read; false when someone changed it since (the version moved). */
  change(tx: Transaction, id: string, version: number, change: StandingOrderChange, actorId: string, at: Date): Promise<boolean>;
  /** Active orders due on or before a date, by id. */
  due(tx: Transaction, onOrBefore: string, afterId: string | null, limit: number): Promise<string[]>;
  /**
   * Writes a run, in the transaction of the order it made: a date that has already run is refused by the key
   * (`pk_standing_order_run`, 23505) and rolls that order back with it, whatever the caller checked.
   */
  insertRun(tx: Transaction, run: StandingOrderRunRecord, actorId: string): Promise<boolean>;
  /** Whether a date has run. */
  hasRun(tx: Transaction, standingOrderId: string, runDate: string): Promise<boolean>;
  /** The runs of one order, newest date first. */
  runs(tx: Transaction, standingOrderId: string, beforeDate: string | null, limit: number): Promise<StandingOrderRunRecord[]>;
}
