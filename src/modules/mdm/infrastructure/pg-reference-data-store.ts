import type { Transaction } from '../../../platform/database/unit-of-work';
import type { RowState } from '../application/admin-kit';
import type {
  PaymentMethodView,
  ReasonCodeView,
  ReferenceDataStore,
  SupplierFilters,
  SupplierRecord,
  SupplierWrite,
  ZoneRecord,
  ZoneWrite,
} from '../application/reference-data-store';

const SUPPLIER_UPDATABLE: ReadonlySet<string> = new Set(['name', 'contact_name', 'phone_e164', 'phone_hash', 'email', 'address', 'tin_enc', 'status']);
const PAYMENT_METHOD_UPDATABLE: ReadonlySet<string> = new Set(['is_enabled', 'allowed_offline', 'requires_provider_verification', 'channels']);
const ZONE_UPDATABLE: ReadonlySet<string> = new Set(['name', 'areas', 'fee_pesewas', 'free_over_pesewas', 'cutoff_time', 'is_active']);

const SUPPLIER_SELECT = `
  SELECT s.id, s.supplier_no, s.name, s.contact_name, s.phone_e164, s.email, s.address, s.tin_enc, s.status, s.version, s.created_at, s.updated_at,
         coalesce((SELECT json_agg(json_build_object('id', c.id, 'code', c.code, 'name', c.name) ORDER BY c.code)
                     FROM mdm.supplier_category sc JOIN mdm.category c ON c.id = sc.category_id
                    WHERE sc.supplier_id = s.id AND sc.deleted_at IS NULL), '[]'::json) AS categories
    FROM mdm.supplier s`;

const PAYMENT_METHOD_SELECT = `
  SELECT id, code, name, kind, requires_provider_verification AS "requiresProviderVerification", allowed_offline AS "allowedOffline",
         channels, is_enabled AS "isEnabled", version
    FROM mdm.payment_method`;

/** Zones with their branch; `fee_pesewas` is read as text and parsed into a bigint, never through a float. */
export const ZONE_SELECT = `
  SELECT z.id, z.code, z.name, z.areas, z.fee_pesewas::text AS fee, z.free_over_pesewas::text AS free_over, to_char(z.cutoff_time, 'HH24:MI') AS cutoff,
         z.is_active, z.version, b.id AS branch_id, b.code AS branch_code, b.name AS branch_name
    FROM mdm.delivery_zone z
    JOIN mdm.branch b ON b.id = z.branch_id`;

interface SupplierRow {
  id: string;
  supplier_no: string;
  name: string;
  contact_name: string | null;
  phone_e164: string | null;
  email: string | null;
  address: string | null;
  tin_enc: Buffer | null;
  status: SupplierRecord['status'];
  version: number;
  created_at: Date;
  updated_at: Date;
  categories: SupplierRecord['categories'];
}

export interface ZoneRow {
  id: string;
  code: string;
  name: string;
  areas: string[];
  fee: string;
  free_over: string | null;
  cutoff: string;
  is_active: boolean;
  version: number;
  branch_id: string;
  branch_code: string;
  branch_name: string;
}

function toSupplier(row: SupplierRow): SupplierRecord {
  return {
    id: row.id,
    supplierNo: row.supplier_no,
    name: row.name,
    contactName: row.contact_name,
    phone: row.phone_e164,
    email: row.email,
    address: row.address,
    tinEnc: row.tin_enc,
    status: row.status,
    categories: row.categories,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toZone(row: ZoneRow): ZoneRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    areas: row.areas,
    feePesewas: BigInt(row.fee),
    freeOverPesewas: row.free_over === null ? null : BigInt(row.free_over),
    cutoffTime: row.cutoff,
    isActive: row.is_active,
    version: row.version,
    branch: { id: row.branch_id, code: row.branch_code, name: row.branch_name },
  };
}

async function updateRow(tx: Transaction, table: string, allowed: ReadonlySet<string>, id: string, expectedVersion: number, columns: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean> {
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

async function lockRow(tx: Transaction, table: string, id: string): Promise<RowState | null> {
  const { rows } = await tx.query<RowState>(`SELECT version, deleted_at IS NOT NULL AS archived FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  return rows[0] ?? null;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** MDM's supplier and reference data tables in plain SQL; reads join only MDM's own tables. */
export class PgReferenceDataStore implements ReferenceDataStore {
  async nextSupplierNo(tx: Transaction): Promise<string> {
    const { rows } = await tx.query<{ no: string }>("SELECT 'S-' || lpad(nextval('mdm.supplier_no_seq')::text, 4, '0') AS no");
    return rows[0]!.no;
  }

  lockSupplier(tx: Transaction, id: string): Promise<RowState | null> {
    return lockRow(tx, 'mdm.supplier', id);
  }

  async supplier(tx: Transaction, id: string): Promise<SupplierRecord | null> {
    const { rows } = await tx.query<SupplierRow>(`${SUPPLIER_SELECT} WHERE s.id = $1`, [id]);
    return rows[0] === undefined ? null : toSupplier(rows[0]);
  }

  async suppliers(tx: Transaction, f: SupplierFilters, afterId: string | null, limit: number): Promise<SupplierRecord[]> {
    const { rows } = await tx.query<SupplierRow>(
      `${SUPPLIER_SELECT}
        WHERE s.deleted_at IS NULL
          AND ($1::text IS NULL OR s.name ILIKE '%' || $1 || '%') AND ($2::bytea IS NULL OR s.phone_hash = $2)
          AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM mdm.supplier_category sc WHERE sc.supplier_id = s.id AND sc.category_id = $3 AND sc.deleted_at IS NULL))
          AND ($4::text IS NULL OR s.status = $4) AND ($5::uuid IS NULL OR s.id > $5)
        ORDER BY s.id LIMIT $6`,
      [f.name === undefined ? null : escapeLike(f.name), f.phoneHash ?? null, f.categoryId ?? null, f.status ?? null, afterId, limit],
    );
    return rows.map(toSupplier);
  }

  async supplierPhoneTaken(tx: Transaction, phoneHash: Buffer, exceptId: string | null): Promise<boolean> {
    const { rows } = await tx.query('SELECT 1 FROM mdm.supplier WHERE phone_hash = $1 AND deleted_at IS NULL AND id IS DISTINCT FROM $2', [phoneHash, exceptId]);
    return rows.length > 0;
  }

  async unknownCategories(tx: Transaction, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM mdm.category WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [ids]);
    const live = new Set(rows.map((row) => row.id));
    return ids.filter((id) => !live.has(id));
  }

  async insertSupplier(tx: Transaction, id: string, w: SupplierWrite, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO mdm.supplier (id, supplier_no, name, contact_name, phone_e164, phone_hash, email, address, tin_enc, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE', $10, $10)`,
      [id, w.supplierNo, w.name, w.contactName, w.phone, w.phoneHash, w.email, w.address, w.tinEnc, actorId],
    );
  }

  updateSupplier(tx: Transaction, id: string, expectedVersion: number, columns: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean> {
    return updateRow(tx, 'mdm.supplier', SUPPLIER_UPDATABLE, id, expectedVersion, columns, actorId);
  }

  async archiveSupplier(tx: Transaction, id: string, expectedVersion: number, reason: string, actorId: string, now: Date): Promise<boolean> {
    const result = await tx.query(
      `UPDATE mdm.supplier SET deleted_at = $4, deleted_by = $3, delete_reason = $5, version = version + 1, updated_at = $4, updated_by = $3
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL`,
      [id, expectedVersion, actorId, now, reason],
    );
    return result.rowCount === 1;
  }

  async setSupplierCategories(tx: Transaction, supplierId: string, categoryIds: readonly string[], actorId: string, now: Date, newId: () => string): Promise<void> {
    await tx.query(
      `UPDATE mdm.supplier_category SET deleted_at = $3, deleted_by = $4, delete_reason = 'Removed from the categories supplied', version = version + 1, updated_at = $3, updated_by = $4
        WHERE supplier_id = $1 AND deleted_at IS NULL AND NOT (category_id = ANY($2::uuid[]))`,
      [supplierId, categoryIds, now, actorId],
    );
    const { rows } = await tx.query<{ category_id: string }>('SELECT category_id FROM mdm.supplier_category WHERE supplier_id = $1 AND deleted_at IS NULL', [supplierId]);
    const kept = new Set(rows.map((row) => row.category_id));
    for (const categoryId of categoryIds.filter((id) => !kept.has(id))) {
      await tx.query('INSERT INTO mdm.supplier_category (id, supplier_id, category_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)', [newId(), supplierId, categoryId, actorId]);
    }
  }

  async paymentMethods(tx: Transaction, includeDisabled: boolean, afterId: string | null, limit: number): Promise<PaymentMethodView[]> {
    const { rows } = await tx.query<PaymentMethodView>(
      `${PAYMENT_METHOD_SELECT} WHERE deleted_at IS NULL AND ($1 OR is_enabled) AND ($2::uuid IS NULL OR id > $2) ORDER BY id LIMIT $3`,
      [includeDisabled, afterId, limit],
    );
    return rows;
  }

  lockPaymentMethod(tx: Transaction, id: string): Promise<RowState | null> {
    return lockRow(tx, 'mdm.payment_method', id);
  }

  async paymentMethod(tx: Transaction, id: string): Promise<PaymentMethodView | null> {
    const { rows } = await tx.query<PaymentMethodView>(`${PAYMENT_METHOD_SELECT} WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  updatePaymentMethod(tx: Transaction, id: string, expectedVersion: number, columns: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean> {
    return updateRow(tx, 'mdm.payment_method', PAYMENT_METHOD_UPDATABLE, id, expectedVersion, columns, actorId);
  }

  async branchExists(tx: Transaction, id: string): Promise<boolean> {
    const { rows } = await tx.query('SELECT 1 FROM mdm.branch WHERE id = $1 AND deleted_at IS NULL', [id]);
    return rows.length > 0;
  }

  lockZone(tx: Transaction, id: string): Promise<RowState | null> {
    return lockRow(tx, 'mdm.delivery_zone', id);
  }

  async zone(tx: Transaction, id: string): Promise<ZoneRecord | null> {
    const { rows } = await tx.query<ZoneRow>(`${ZONE_SELECT} WHERE z.id = $1`, [id]);
    return rows[0] === undefined ? null : toZone(rows[0]);
  }

  async zones(tx: Transaction, branchId: string | null, afterId: string | null, limit: number): Promise<ZoneRecord[]> {
    const { rows } = await tx.query<ZoneRow>(
      `${ZONE_SELECT} WHERE z.deleted_at IS NULL AND ($1::uuid IS NULL OR z.branch_id = $1) AND ($2::uuid IS NULL OR z.id > $2) ORDER BY z.id LIMIT $3`,
      [branchId, afterId, limit],
    );
    return rows.map(toZone);
  }

  async zoneCodeTaken(tx: Transaction, branchId: string, code: string): Promise<boolean> {
    const { rows } = await tx.query('SELECT 1 FROM mdm.delivery_zone WHERE branch_id = $1 AND code = $2 AND deleted_at IS NULL', [branchId, code]);
    return rows.length > 0;
  }

  deliverableZones(tx: Transaction): Promise<ZoneRecord[]> {
    return deliverableZones(tx);
  }

  async otherActiveZones(tx: Transaction, exceptId: string | null): Promise<ZoneRecord[]> {
    const { rows } = await tx.query<ZoneRow>(`${ZONE_SELECT} WHERE z.deleted_at IS NULL AND z.is_active AND z.id IS DISTINCT FROM $1 ORDER BY z.id`, [exceptId]);
    return rows.map(toZone);
  }

  async insertZone(tx: Transaction, id: string, w: ZoneWrite, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO mdm.delivery_zone (id, branch_id, code, name, areas, fee_pesewas, free_over_pesewas, cutoff_time, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [id, w.branchId, w.code, w.name, w.areas, w.feePesewas.toString(), w.freeOverPesewas?.toString() ?? null, w.cutoffTime, actorId],
    );
  }

  updateZone(tx: Transaction, id: string, expectedVersion: number, columns: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean> {
    const values = Object.fromEntries(Object.entries(columns).map(([name, value]) => [name, typeof value === 'bigint' ? value.toString() : value]));
    return updateRow(tx, 'mdm.delivery_zone', ZONE_UPDATABLE, id, expectedVersion, values, actorId);
  }

  async reasonCodes(tx: Transaction, domain: string | null, afterCode: string | null, limit: number): Promise<ReasonCodeView[]> {
    const { rows } = await tx.query<ReasonCodeView>(
      `SELECT code, domain, description, requires_note AS "requiresNote", loss_account_group AS "lossAccountGroup"
         FROM mdm.reason_code WHERE ($1::text IS NULL OR domain = $1) AND ($2::text IS NULL OR code > $2) ORDER BY code LIMIT $3`,
      [domain, afterCode, limit],
    );
    return rows;
  }
}

/** Live, active zones of open, non-test branches: what a storefront address and a saved address are matched against. */
export async function deliverableZones(tx: Transaction): Promise<ZoneRecord[]> {
  const { rows } = await tx.query<ZoneRow>(`${ZONE_SELECT} WHERE z.deleted_at IS NULL AND z.is_active AND b.deleted_at IS NULL AND b.status = 'ACTIVE' AND NOT b.is_test ORDER BY z.id`);
  return rows.map(toZone);
}
