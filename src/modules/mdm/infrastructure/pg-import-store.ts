import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ImportJobFilters, ImportJobRecord, ImportStore, NamedRecord, NewImportJob, SheetLookups, StoredRowError } from '../application/import-store';
import type { RowError } from '../domain/imports';

interface JobRow {
  id: string;
  entity: ImportJobRecord['entity'];
  direction: ImportJobRecord['direction'];
  file_id: string;
  status: ImportJobRecord['status'];
  rows_total: number | null;
  rows_valid: number | null;
  rows_applied: number | null;
  rows_to_create: number | null;
  rows_to_update: number | null;
  version: number;
  created_at: Date;
  created_by: string;
}

const COLUMNS = 'id, entity, direction, file_id, status, rows_total, rows_valid, rows_applied, rows_to_create, rows_to_update, version, created_at, created_by';

function toJob(row: JobRow): ImportJobRecord {
  return {
    id: row.id,
    entity: row.entity,
    direction: row.direction,
    fileId: row.file_id,
    status: row.status,
    rowsTotal: row.rows_total,
    rowsValid: row.rows_valid,
    rowsApplied: row.rows_applied,
    rowsToCreate: row.rows_to_create,
    rowsToUpdate: row.rows_to_update,
    version: row.version,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

/** `mdm.import_job` and `mdm.import_job_error` in SQL (migration 0039). No query leaves the `mdm` schema. */
export class PgImportStore implements ImportStore {
  async headOfficeBranchId(tx: Transaction): Promise<string> {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM mdm.branch WHERE deleted_at IS NULL AND status = 'ACTIVE' AND NOT is_test ORDER BY created_at, code LIMIT 1");
    if (rows[0] === undefined) throw new Error('no active branch exists to register an import job under');
    return rows[0].id;
  }

  async insertJob(tx: Transaction, job: NewImportJob, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO mdm.import_job (id, entity, direction, file_id, status, rows_total, rows_valid, rows_applied, rows_to_create, rows_to_update, branch_id, created_by, updated_by, posted_at, posted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13, CASE WHEN $13::timestamptz IS NULL THEN NULL ELSE $12::uuid END)`,
      [job.id, job.entity, job.direction, job.fileId, job.status, job.rowsTotal, job.rowsValid, job.rowsApplied, job.rowsToCreate, job.rowsToUpdate, job.branchId, actorId, job.postedAt],
    );
  }

  async job(tx: Transaction, id: string): Promise<ImportJobRecord | null> {
    const { rows } = await tx.query<JobRow>(`SELECT ${COLUMNS} FROM mdm.import_job WHERE id = $1`, [id]);
    return rows[0] === undefined ? null : toJob(rows[0]);
  }

  async lockJob(tx: Transaction, id: string): Promise<ImportJobRecord | null> {
    const { rows } = await tx.query<JobRow>(`SELECT ${COLUMNS} FROM mdm.import_job WHERE id = $1 FOR UPDATE`, [id]);
    return rows[0] === undefined ? null : toJob(rows[0]);
  }

  async jobs(tx: Transaction, filters: ImportJobFilters, beforeId: string | null, limit: number): Promise<ImportJobRecord[]> {
    const { rows } = await tx.query<JobRow>(
      `SELECT ${COLUMNS} FROM mdm.import_job
        WHERE ($1::text IS NULL OR entity = $1) AND ($2::text IS NULL OR direction = $2) AND ($3::uuid IS NULL OR id < $3)
        ORDER BY id DESC LIMIT $4`,
      [filters.entity ?? null, filters.direction ?? null, beforeId, limit],
    );
    return rows.map(toJob);
  }

  async updateJob(tx: Transaction, id: string, expectedVersion: number, set: { status: ImportJobRecord['status']; rowsValid?: number; rowsApplied?: number; posted: boolean }, actorId: string, now: Date): Promise<boolean> {
    const result = await tx.query(
      `UPDATE mdm.import_job
          SET status = $3, rows_valid = COALESCE($4, rows_valid), rows_applied = COALESCE($5, rows_applied), version = version + 1, updated_by = $6,
              posted_at = CASE WHEN $7 THEN $8::timestamptz ELSE posted_at END, posted_by = CASE WHEN $7 THEN $6::uuid ELSE posted_by END
        WHERE id = $1 AND version = $2`,
      [id, expectedVersion, set.status, set.rowsValid ?? null, set.rowsApplied ?? null, actorId, set.posted, now],
    );
    return result.rowCount === 1;
  }

  async insertErrors(tx: Transaction, jobId: string, errors: readonly (RowError & { readonly id: string })[]): Promise<void> {
    if (errors.length === 0) return;
    await tx.query(
      `INSERT INTO mdm.import_job_error (id, import_job_id, row_no, column_name, message)
       SELECT e.id, $1, e.row_no, e.column_name, e.message
         FROM unnest($2::uuid[], $3::int[], $4::text[], $5::text[]) AS e (id, row_no, column_name, message)`,
      [jobId, errors.map((e) => e.id), errors.map((e) => e.rowNo), errors.map((e) => e.column), errors.map((e) => e.message)],
    );
  }

  async errorCount(tx: Transaction, jobId: string): Promise<number> {
    const { rows } = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM mdm.import_job_error WHERE import_job_id = $1', [jobId]);
    return rows[0]!.n;
  }

  async errors(tx: Transaction, jobId: string, after: { rowNo: number; id: string } | null, limit: number): Promise<StoredRowError[]> {
    const { rows } = await tx.query<{ id: string; row_no: number; column_name: string | null; message: string }>(
      `SELECT id, row_no, column_name, message FROM mdm.import_job_error
        WHERE import_job_id = $1 AND ($2::int IS NULL OR (row_no, id) > ($2, $3::uuid))
        ORDER BY row_no, id LIMIT $4`,
      [jobId, after?.rowNo ?? null, after?.id ?? null, limit],
    );
    return rows.map((row) => ({ id: row.id, rowNo: row.row_no, column: row.column_name, message: row.message }));
  }
}

/** The id of the one row a lookup query finds, or null. */
async function idOf(tx: Transaction, sql: string, values: unknown[]): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(sql, values);
  return rows[0]?.id ?? null;
}

/** A sheet's codes as live MDM records (A-130). Every query reads only the `mdm` schema, and only live rows. */
export class PgSheetLookups implements SheetLookups {
  async productBySku(tx: Transaction, sku: string): Promise<(NamedRecord & { readonly speciesId: string | null }) | null> {
    const { rows } = await tx.query<{ id: string; version: number; species_id: string | null }>('SELECT id, version, species_id FROM mdm.product WHERE sku = $1 AND deleted_at IS NULL', [sku]);
    return rows[0] === undefined ? null : { id: rows[0].id, version: rows[0].version, speciesId: rows[0].species_id };
  }

  categoryIdByCode(tx: Transaction, code: string): Promise<string | null> {
    return idOf(tx, 'SELECT id FROM mdm.category WHERE code = $1 AND deleted_at IS NULL', [code]);
  }

  speciesIdByCode(tx: Transaction, code: string): Promise<string | null> {
    return idOf(tx, 'SELECT id FROM mdm.species WHERE code = $1 AND deleted_at IS NULL', [code]);
  }

  taxCategoryIdByCode(tx: Transaction, code: string): Promise<string | null> {
    return idOf(tx, 'SELECT id FROM mdm.tax_category WHERE code = $1 AND deleted_at IS NULL', [code]);
  }

  async supplierByPublicId(tx: Transaction, publicId: string): Promise<NamedRecord | null> {
    const { rows } = await tx.query<{ id: string; version: number }>('SELECT id, version FROM mdm.supplier WHERE public_id = $1 AND deleted_at IS NULL', [publicId]);
    return rows[0] ?? null;
  }

  branchIdByCode(tx: Transaction, code: string): Promise<string | null> {
    return idOf(tx, 'SELECT id FROM mdm.branch WHERE code = $1 AND deleted_at IS NULL', [code]);
  }

  async locationByCode(tx: Transaction, branchId: string, code: string): Promise<(NamedRecord & { readonly isVirtual: boolean }) | null> {
    const { rows } = await tx.query<{ id: string; version: number; is_virtual: boolean }>(
      'SELECT id, version, is_virtual FROM mdm.location WHERE branch_id = $1 AND code = $2 AND deleted_at IS NULL',
      [branchId, code],
    );
    return rows[0] === undefined ? null : { id: rows[0].id, version: rows[0].version, isVirtual: rows[0].is_virtual };
  }

  async priceListByCode(tx: Transaction, code: string): Promise<{ readonly id: string } | null> {
    const id = await idOf(tx, 'SELECT id FROM mdm.price_list WHERE code = $1 AND deleted_at IS NULL', [code]);
    return id === null ? null : { id };
  }

  async openVersion(tx: Transaction, priceListId: string): Promise<{ readonly id: string; readonly status: string; readonly version: number; readonly branchId: string } | null> {
    const { rows } = await tx.query<{ id: string; status: string; version: number; branch_id: string }>(
      "SELECT id, status, version, branch_id FROM mdm.price_list_version WHERE price_list_id = $1 AND status IN ('DRAFT', 'PENDING_APPROVAL')",
      [priceListId],
    );
    return rows[0] === undefined ? null : { id: rows[0].id, status: rows[0].status, version: rows[0].version, branchId: rows[0].branch_id };
  }

  gradeIdByCode(tx: Transaction, speciesId: string, code: string): Promise<string | null> {
    return idOf(tx, 'SELECT id FROM mdm.grade WHERE species_id = $1 AND code = $2 AND deleted_at IS NULL', [speciesId, code]);
  }

  weightBandIdByCode(tx: Transaction, speciesId: string, code: string): Promise<string | null> {
    return idOf(tx, 'SELECT id FROM mdm.weight_band WHERE species_id = $1 AND code = $2 AND deleted_at IS NULL', [speciesId, code]);
  }
}
