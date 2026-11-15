import type { Transaction } from '../../../platform/database/unit-of-work';
import type { RowState } from '../application/admin-kit';
import type { BranchView, BranchWrite, LocationFilters, LocationsStore, LocationView, LocationWrite } from '../application/locations-store';

/** The columns each update may set: what the contract's update schemas can change. */
const BRANCH_UPDATABLE: ReadonlySet<string> = new Set(['name', 'address', 'phone_e164', 'status']);
const LOCATION_UPDATABLE: ReadonlySet<string> = new Set(['name', 'parent_id', 'is_sellable', 'temp_min_c', 'temp_max_c', 'capacity_head']);

const BRANCH_SELECT = 'SELECT id, code, name, address, phone_e164, is_test, status, version, created_at, updated_at FROM mdm.branch';
const LOCATION_SELECT = `
  SELECT l.id, l.parent_id, l.code, l.name, l.kind, l.is_virtual, l.is_sellable, l.allows_negative, l.temp_class,
         to_char(l.temp_min_c, 'FM990.0') AS temp_min_c, to_char(l.temp_max_c, 'FM990.0') AS temp_max_c, l.capacity_head,
         l.version, l.created_at, l.updated_at, b.id AS branch_id, b.code AS branch_code, b.name AS branch_name
    FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id`;

interface Stamped {
  version: number;
  created_at: Date;
  updated_at: Date;
}

const stamps = (row: Stamped) => ({ version: row.version, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });

type BranchRow = Stamped & { id: string; code: string; name: string; address: string | null; phone_e164: string | null; is_test: boolean; status: BranchView['status'] };

function toBranch(row: BranchRow): BranchView {
  return { id: row.id, code: row.code, name: row.name, address: row.address, phone: row.phone_e164, isTest: row.is_test, status: row.status, ...stamps(row) };
}

type LocationRow = Stamped & {
  id: string;
  parent_id: string | null;
  code: string;
  name: string;
  kind: LocationView['kind'];
  is_virtual: boolean;
  is_sellable: boolean;
  allows_negative: boolean;
  temp_class: LocationView['tempClass'];
  temp_min_c: string | null;
  temp_max_c: string | null;
  capacity_head: number | null;
  branch_id: string;
  branch_code: string;
  branch_name: string;
};

function toLocation(row: LocationRow): LocationView {
  return {
    id: row.id,
    branch: { id: row.branch_id, code: row.branch_code, name: row.branch_name },
    parentId: row.parent_id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    isVirtual: row.is_virtual,
    isSellable: row.is_sellable,
    allowsNegative: row.allows_negative,
    tempClass: row.temp_class,
    tempMinC: row.temp_min_c,
    tempMaxC: row.temp_max_c,
    capacityHead: row.capacity_head,
    ...stamps(row),
  };
}

async function updateRow(
  tx: Transaction,
  table: string,
  allowed: ReadonlySet<string>,
  id: string,
  expectedVersion: number,
  columns: Readonly<Record<string, unknown>>,
  actorId: string,
): Promise<boolean> {
  const names = Object.keys(columns);
  for (const name of names) {
    if (!allowed.has(name)) {
      throw new Error(`${table}.${name} is not an updatable column`);
    }
  }
  const sets = names.map((name, index) => `${name} = $${index + 4}`);
  const result = await tx.query(
    `UPDATE ${table} SET ${[...sets, 'version = version + 1', 'updated_at = now()', 'updated_by = $3'].join(', ')} WHERE id = $1 AND version = $2 AND deleted_at IS NULL`,
    [id, expectedVersion, actorId, ...names.map((name) => columns[name])],
  );
  return result.rowCount === 1;
}

/** MDM's branch and location tables in plain SQL. */
export class PgLocationsStore implements LocationsStore {
  async branchCount(tx: Transaction): Promise<number> {
    const { rows } = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM mdm.branch');
    return rows[0]!.n;
  }

  async lockBranch(tx: Transaction, id: string): Promise<RowState | null> {
    const { rows } = await tx.query<RowState>('SELECT version, deleted_at IS NOT NULL AS archived FROM mdm.branch WHERE id = $1 FOR UPDATE', [id]);
    return rows[0] ?? null;
  }

  async branch(tx: Transaction, id: string): Promise<BranchView | null> {
    const { rows } = await tx.query<BranchRow>(`${BRANCH_SELECT} WHERE id = $1`, [id]);
    return rows[0] === undefined ? null : toBranch(rows[0]);
  }

  async branches(tx: Transaction, afterId: string | null, limit: number): Promise<BranchView[]> {
    const { rows } = await tx.query<BranchRow>(`${BRANCH_SELECT} WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR id > $1) ORDER BY id LIMIT $2`, [afterId, limit]);
    return rows.map(toBranch);
  }

  async branchCodeTaken(tx: Transaction, code: string): Promise<boolean> {
    const { rows } = await tx.query('SELECT 1 FROM mdm.branch WHERE code = $1', [code]);
    return rows.length > 0;
  }

  async insertBranch(tx: Transaction, id: string, w: BranchWrite, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO mdm.branch (id, code, name, address, phone_e164, is_test, status, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $7)`,
      [id, w.code, w.name, w.address, w.phone, w.isTest, actorId],
    );
  }

  updateBranch(tx: Transaction, id: string, expectedVersion: number, columns: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean> {
    return updateRow(tx, 'mdm.branch', BRANCH_UPDATABLE, id, expectedVersion, columns, actorId);
  }

  async lockLocation(tx: Transaction, id: string): Promise<RowState | null> {
    const { rows } = await tx.query<RowState>('SELECT version, deleted_at IS NOT NULL AS archived FROM mdm.location WHERE id = $1 FOR UPDATE', [id]);
    return rows[0] ?? null;
  }

  async location(tx: Transaction, id: string): Promise<LocationView | null> {
    const { rows } = await tx.query<LocationRow>(`${LOCATION_SELECT} WHERE l.id = $1`, [id]);
    return rows[0] === undefined ? null : toLocation(rows[0]);
  }

  async locations(tx: Transaction, filters: LocationFilters, afterId: string | null, limit: number): Promise<LocationView[]> {
    const { rows } = await tx.query<LocationRow>(
      `${LOCATION_SELECT}
        WHERE l.deleted_at IS NULL
          AND ($1::uuid IS NULL OR l.branch_id = $1) AND ($2::text IS NULL OR l.kind = $2) AND ($3::uuid IS NULL OR l.parent_id = $3)
          AND ($4 OR NOT l.is_virtual) AND ($5::uuid IS NULL OR l.id > $5)
        ORDER BY l.id LIMIT $6`,
      [filters.branchId ?? null, filters.kind ?? null, filters.parentId ?? null, filters.includeVirtual, afterId, limit],
    );
    return rows.map(toLocation);
  }

  async locationCodeTaken(tx: Transaction, branchId: string, code: string): Promise<boolean> {
    const { rows } = await tx.query('SELECT 1 FROM mdm.location WHERE branch_id = $1 AND code = $2 AND deleted_at IS NULL', [branchId, code]);
    return rows.length > 0;
  }

  async insertLocation(tx: Transaction, id: string, w: LocationWrite, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO mdm.location (id, branch_id, parent_id, code, name, kind, is_virtual, is_sellable, allows_negative, temp_class, temp_min_c, temp_max_c, capacity_head, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
      [id, w.branchId, w.parentId, w.code, w.name, w.kind, w.isVirtual, w.isSellable, w.allowsNegative, w.tempClass, w.tempMinC, w.tempMaxC, w.capacityHead, actorId],
    );
  }

  updateLocation(tx: Transaction, id: string, expectedVersion: number, columns: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean> {
    return updateRow(tx, 'mdm.location', LOCATION_UPDATABLE, id, expectedVersion, columns, actorId);
  }

  async archiveLocation(tx: Transaction, id: string, expectedVersion: number, reason: string, actorId: string, now: Date): Promise<boolean> {
    const result = await tx.query(
      `UPDATE mdm.location SET deleted_at = $4, deleted_by = $3, delete_reason = $5, version = version + 1, updated_at = $4, updated_by = $3
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL`,
      [id, expectedVersion, actorId, now, reason],
    );
    return result.rowCount === 1;
  }

  async liveChildren(tx: Transaction, id: string): Promise<number> {
    const { rows } = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM mdm.location WHERE parent_id = $1 AND deleted_at IS NULL', [id]);
    return rows[0]!.n;
  }

  async isSelfOrBelow(tx: Transaction, id: string, candidateId: string): Promise<boolean> {
    const { rows } = await tx.query(
      `WITH RECURSIVE below AS (SELECT id FROM mdm.location WHERE id = $1 UNION SELECT l.id FROM mdm.location l JOIN below ON l.parent_id = below.id)
       SELECT 1 FROM below WHERE id = $2`,
      [id, candidateId],
    );
    return rows.length > 0;
  }
}
