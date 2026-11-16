import type { Transaction } from '../../../platform/database/unit-of-work';
import type { SortOrder } from '../../../platform/http/keyset-sort';
import type { PlannedSlot } from '../domain/slots';

/** A live row of `del.delivery_slot`, with each key of the list's order as text for its cursor. */
export interface SlotRecord {
  readonly id: string;
  readonly branchId: string;
  readonly deliveryZoneId: string;
  readonly slotDate: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly capacity: number;
  readonly booked: number;
  readonly version: number;
  readonly position: readonly string[];
}

export interface SlotFilters {
  readonly zoneIds: readonly string[] | null;
  readonly branchIds: readonly string[] | null;
  readonly from: string | null;
  readonly to: string | null;
  /** Leave out a slot whose start has passed at this instant (UTC, which is Africa/Accra time). */
  readonly startingAfter: Date | null;
}

export interface SlotStore {
  /** Inserts the planned slots that do not exist yet; answers how many were written. */
  insertMissing(tx: Transaction, branchId: string, zoneId: string, slots: readonly PlannedSlot[], actorId: string, newId: () => string): Promise<number>;
  page(tx: Transaction, filters: SlotFilters, order: SortOrder, position: readonly string[] | null, limit: number): Promise<SlotRecord[]>;
  lock(tx: Transaction, id: string): Promise<SlotRecord | null>;
  setCapacity(tx: Transaction, id: string, capacity: number, actorId: string): Promise<void>;
  slots(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, SlotRecord>>;
}

export const SLOT_STORE = Symbol('SLOT_STORE');
