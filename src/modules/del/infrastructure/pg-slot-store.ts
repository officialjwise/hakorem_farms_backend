import type { Transaction } from '../../../platform/database/unit-of-work';
import { keysetClause, sortKeySelect, type SortOrder } from '../../../platform/http/keyset-sort';
import type { PlannedSlot } from '../domain/slots';
import type { SlotFilters, SlotRecord, SlotStore } from '../application/slot-store';

interface SlotRow {
  id: string;
  branch_id: string;
  delivery_zone_id: string;
  slot_date: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  booked: number;
  version: number;
  [key: string]: unknown;
}

const COLUMNS = `s.id, s.branch_id, s.delivery_zone_id, to_char(s.slot_date, 'YYYY-MM-DD') AS slot_date,
                 to_char(s.starts_at, 'HH24:MI') AS starts_at, to_char(s.ends_at, 'HH24:MI') AS ends_at, s.capacity, s.booked, s.version`;

function toRecord(row: SlotRow, order: SortOrder | null): SlotRecord {
  return {
    id: row.id,
    branchId: row.branch_id,
    deliveryZoneId: row.delivery_zone_id,
    slotDate: row.slot_date,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    capacity: row.capacity,
    booked: row.booked,
    version: row.version,
    position: order === null ? [] : order.keys.map((_key, index) => String(row[`sort_key_${index}`])),
  };
}

/** Delivery slots over DEL's own table (migration 0118). */
export class PgSlotStore implements SlotStore {
  async insertMissing(tx: Transaction, branchId: string, zoneId: string, slots: readonly PlannedSlot[], actorId: string, newId: () => string): Promise<number> {
    if (slots.length === 0) return 0;
    const result = await tx.query(
      `INSERT INTO del.delivery_slot (id, branch_id, delivery_zone_id, slot_date, starts_at, ends_at, capacity, created_by, updated_by)
       SELECT s.id, $1, $2, s.slot_date, s.starts_at, s.ends_at, s.capacity, $3, $3
         FROM unnest($4::uuid[], $5::date[], $6::time[], $7::time[], $8::integer[]) AS s(id, slot_date, starts_at, ends_at, capacity)
       ON CONFLICT (delivery_zone_id, slot_date, starts_at) WHERE deleted_at IS NULL DO NOTHING`,
      [
        branchId,
        zoneId,
        actorId,
        slots.map(() => newId()),
        slots.map((s) => s.slotDate),
        slots.map((s) => s.startsAt),
        slots.map((s) => s.endsAt),
        slots.map((s) => s.capacity),
      ],
    );
    return result.rowCount ?? 0;
  }

  async page(tx: Transaction, filters: SlotFilters, order: SortOrder, position: readonly string[] | null, limit: number): Promise<SlotRecord[]> {
    const clause = keysetClause(order, position, 7);
    const { rows } = await tx.query<SlotRow>(
      `SELECT ${COLUMNS}, ${sortKeySelect(order)}
         FROM del.delivery_slot s
        WHERE s.deleted_at IS NULL
          AND ($1::uuid[] IS NULL OR s.delivery_zone_id = ANY($1::uuid[]))
          AND ($2::uuid[] IS NULL OR s.branch_id = ANY($2::uuid[]))
          AND ($3::date IS NULL OR s.slot_date >= $3::date)
          AND ($4::date IS NULL OR s.slot_date <= $4::date)
          AND ($5::timestamptz IS NULL OR (s.slot_date + s.starts_at) > ($5::timestamptz AT TIME ZONE 'Africa/Accra'))
          AND ${clause.after}
        ORDER BY ${clause.orderBy}
        LIMIT $6`,
      [filters.zoneIds, filters.branchIds, filters.from, filters.to, filters.startingAfter, limit, ...clause.values],
    );
    return rows.map((row) => toRecord(row, order));
  }

  async lock(tx: Transaction, id: string): Promise<SlotRecord | null> {
    const { rows } = await tx.query<SlotRow>(`SELECT ${COLUMNS} FROM del.delivery_slot s WHERE s.id = $1 AND s.deleted_at IS NULL FOR UPDATE`, [id]);
    return rows[0] === undefined ? null : toRecord(rows[0], null);
  }

  async setCapacity(tx: Transaction, id: string, capacity: number, actorId: string): Promise<void> {
    await tx.query('UPDATE del.delivery_slot SET capacity = $2, updated_at = now(), updated_by = $3, version = version + 1 WHERE id = $1', [id, capacity, actorId]);
  }

  async slots(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, SlotRecord>> {
    if (ids.length === 0) return new Map();
    const { rows } = await tx.query<SlotRow>(`SELECT ${COLUMNS} FROM del.delivery_slot s WHERE s.id = ANY($1::uuid[]) AND s.deleted_at IS NULL`, [ids]);
    return new Map(rows.map((row) => [row.id, toRecord(row, null)] as const));
  }
}
