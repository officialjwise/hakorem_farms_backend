import type { Transaction } from '../../../platform/database/unit-of-work';
import type { NewTaxCell, TaxCategoryRow, TaxCellRow, TaxLevyRow, TaxStore, TaxVersionRow, TaxVersionStatus } from '../application/tax-store';
import type { TaxBaseKind, TaxTreatment } from '../domain/tax/tax-calculator';
import type { ActiveTaxWindow, TaxWindow } from '../domain/tax/tax-scheme';

interface VersionRecord {
  id: string;
  version_no: number;
  status: TaxVersionStatus;
  valid_from: string;
  valid_to: string | null;
  source_note: string;
  approval_request_id: string | null;
  branch_id: string;
  version: number;
  created_at: Date;
  created_by: string;
}

// Dates leave the database as text: node-postgres would otherwise turn a `date` into local midnight.
const VERSION_SELECT = `
  SELECT v.id, v.version_no, v.status, to_char(v.valid_from, 'YYYY-MM-DD') AS valid_from, to_char(v.valid_to, 'YYYY-MM-DD') AS valid_to,
         v.source_note, v.approval_request_id, v.branch_id, v.version, v.created_at, v.created_by
    FROM mdm.tax_scheme_version v`;

function toVersion(row: VersionRecord): TaxVersionRow {
  return {
    id: row.id,
    versionNo: row.version_no,
    status: row.status,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    sourceNote: row.source_note,
    approvalRequestId: row.approval_request_id,
    branchId: row.branch_id,
    version: row.version,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

interface CellRecord {
  category_id: string;
  category_code: string;
  category_name: string;
  levy_id: string;
  levy_code: string;
  levy_name: string;
  treatment: TaxTreatment;
  rate_percent: string;
  base_kind: TaxBaseKind;
  base_levies: { id: string; code: string }[];
  is_reclaimable: boolean;
  calc_order: number;
}

/** PostgreSQL implementation of `TaxStore`. Parameterised SQL only; no SQL is built from values (SC-03). */
export class PgTaxStore implements TaxStore {
  async levies(tx: Transaction): Promise<TaxLevyRow[]> {
    const { rows } = await tx.query<{ id: string; code: string; name: string; sort_order: number; version: number }>(
      'SELECT id, code, name, sort_order, version FROM mdm.tax_levy WHERE deleted_at IS NULL ORDER BY sort_order, code',
    );
    return rows.map((row) => ({ id: row.id, code: row.code, name: row.name, sortOrder: row.sort_order, version: row.version }));
  }

  async insertLevy(tx: Transaction, id: string, levy: { code: string; name: string; sortOrder: number }, actorId: string): Promise<void> {
    await tx.query('INSERT INTO mdm.tax_levy (id, code, name, sort_order, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5)', [id, levy.code, levy.name, levy.sortOrder, actorId]);
  }

  async categories(tx: Transaction): Promise<TaxCategoryRow[]> {
    const { rows } = await tx.query<{ id: string; code: string; name: string; product_count: number; version: number }>(
      `SELECT c.id, c.code, c.name, c.version,
              (SELECT count(*)::int FROM mdm.product p WHERE p.tax_category_id = c.id AND p.deleted_at IS NULL) AS product_count
         FROM mdm.tax_category c
        WHERE c.deleted_at IS NULL
        ORDER BY c.code`,
    );
    return rows.map((row) => ({ id: row.id, code: row.code, name: row.name, productCount: row.product_count, version: row.version }));
  }

  async insertCategory(tx: Transaction, id: string, category: { code: string; name: string }, actorId: string): Promise<void> {
    await tx.query('INSERT INTO mdm.tax_category (id, code, name, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)', [id, category.code, category.name, actorId]);
  }

  async versionPage(tx: Transaction, beforeVersionNo: number | null, limit: number): Promise<TaxVersionRow[]> {
    const { rows } = await tx.query<VersionRecord>(`${VERSION_SELECT} WHERE ($1::int IS NULL OR v.version_no < $1) ORDER BY v.version_no DESC LIMIT $2`, [beforeVersionNo, limit + 1]);
    return rows.map(toVersion);
  }

  async version(tx: Transaction, id: string, forUpdate: boolean): Promise<TaxVersionRow | null> {
    const { rows } = await tx.query<VersionRecord>(`${VERSION_SELECT} WHERE v.id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] === undefined ? null : toVersion(rows[0]);
  }

  async cells(tx: Transaction, versionId: string): Promise<TaxCellRow[]> {
    const { rows } = await tx.query<CellRecord>(
      `SELECT c.tax_category_id AS category_id, tc.code AS category_code, tc.name AS category_name,
              c.levy_id, l.code AS levy_code, l.name AS levy_name, c.treatment, c.rate_percent::text AS rate_percent,
              c.base_kind, c.is_reclaimable, c.calc_order,
              COALESCE((SELECT json_agg(json_build_object('id', il.id, 'code', il.code) ORDER BY ic.calc_order)
                          FROM mdm.tax_levy_base_component b
                          JOIN mdm.tax_category_levy ic ON ic.id = b.included_category_levy_id
                          JOIN mdm.tax_levy il ON il.id = ic.levy_id
                         WHERE b.tax_category_levy_id = c.id), '[]'::json) AS base_levies
         FROM mdm.tax_category_levy c
         JOIN mdm.tax_category tc ON tc.id = c.tax_category_id
         JOIN mdm.tax_levy l ON l.id = c.levy_id
        WHERE c.version_id = $1
        ORDER BY tc.code, c.calc_order`,
      [versionId],
    );
    return rows.map((row) => ({
      category: { id: row.category_id, code: row.category_code, name: row.category_name },
      levy: { id: row.levy_id, code: row.levy_code, name: row.levy_name },
      treatment: row.treatment,
      ratePercent: row.rate_percent,
      baseKind: row.base_kind,
      baseLevies: row.base_levies,
      isReclaimable: row.is_reclaimable,
      calcOrder: row.calc_order,
    }));
  }

  async openVersionId(tx: Transaction): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM mdm.tax_scheme_version WHERE status IN ('DRAFT', 'PENDING_APPROVAL')");
    return rows[0]?.id ?? null;
  }

  async nextVersionNo(tx: Transaction): Promise<number> {
    const { rows } = await tx.query<{ next: number }>('SELECT COALESCE(max(version_no), 0)::int + 1 AS next FROM mdm.tax_scheme_version');
    return rows[0]!.next;
  }

  async firstBranchId(tx: Transaction): Promise<string> {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM mdm.branch WHERE deleted_at IS NULL AND status = 'ACTIVE' AND NOT is_test ORDER BY created_at, code LIMIT 1");
    if (rows[0] === undefined) {
      throw new Error('no active branch exists to register a tax scheme version under');
    }
    return rows[0].id;
  }

  async insertVersion(tx: Transaction, version: { id: string; versionNo: number; window: TaxWindow; sourceNote: string; branchId: string }, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO mdm.tax_scheme_version (id, version_no, status, valid_from, valid_to, source_note, branch_id, created_by, updated_by)
       VALUES ($1, $2, 'DRAFT', $3, $4, $5, $6, $7, $7)`,
      [version.id, version.versionNo, version.window.validFrom, version.window.validTo, version.sourceNote, version.branchId, actorId],
    );
  }

  async replaceCells(tx: Transaction, versionId: string, cells: readonly NewTaxCell[], actorId: string, nextId: () => string): Promise<void> {
    await tx.query('SELECT mdm.clear_draft_tax_cells($1)', [versionId]);
    const ids = cells.map(() => nextId());
    await tx.query(
      `INSERT INTO mdm.tax_category_levy (id, version_id, tax_category_id, levy_id, treatment, rate_percent, base_kind, is_reclaimable, calc_order, created_by, updated_by)
       SELECT c.id, $2, c.category_id, c.levy_id, c.treatment, c.rate_percent, c.base_kind, c.is_reclaimable, c.calc_order, $3, $3
         FROM unnest($1::uuid[], $4::uuid[], $5::uuid[], $6::text[], $7::numeric[], $8::text[], $9::boolean[], $10::int[])
              AS c (id, category_id, levy_id, treatment, rate_percent, base_kind, is_reclaimable, calc_order)`,
      [
        ids,
        versionId,
        actorId,
        cells.map((cell) => cell.categoryId),
        cells.map((cell) => cell.levyId),
        cells.map((cell) => cell.treatment),
        cells.map((cell) => cell.ratePercent),
        cells.map((cell) => cell.baseKind),
        cells.map((cell) => cell.isReclaimable),
        cells.map((cell) => cell.calcOrder),
      ],
    );
    const idOf = new Map(cells.map((cell, index) => [`${cell.categoryId}|${cell.levyId}`, ids[index]!]));
    const owners: string[] = [];
    const included: string[] = [];
    for (const cell of cells) {
      for (const levyId of cell.baseLevyIds) {
        owners.push(idOf.get(`${cell.categoryId}|${cell.levyId}`)!);
        included.push(idOf.get(`${cell.categoryId}|${levyId}`)!);
      }
    }
    if (owners.length > 0) {
      await tx.query(
        `INSERT INTO mdm.tax_levy_base_component (tax_category_levy_id, included_category_levy_id, created_by)
         SELECT o, i, $3 FROM unnest($1::uuid[], $2::uuid[]) AS b (o, i)`,
        [owners, included, actorId],
      );
    }
  }

  async touchVersion(tx: Transaction, id: string, expected: number, actorId: string): Promise<boolean> {
    const { rowCount } = await tx.query('UPDATE mdm.tax_scheme_version SET version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1 AND version = $2', [id, expected, actorId]);
    return rowCount === 1;
  }

  async markPending(tx: Transaction, id: string, approvalRequestId: string, actorId: string): Promise<void> {
    await tx.query(
      "UPDATE mdm.tax_scheme_version SET status = 'PENDING_APPROVAL', approval_request_id = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1",
      [id, approvalRequestId, actorId],
    );
  }

  async activeWindows(tx: Transaction, lock: boolean): Promise<ActiveTaxWindow[]> {
    const { rows } = await tx.query<{ id: string; valid_from: string; valid_to: string | null }>(
      `SELECT id, to_char(valid_from, 'YYYY-MM-DD') AS valid_from, to_char(valid_to, 'YYYY-MM-DD') AS valid_to FROM mdm.tax_scheme_version WHERE status = 'ACTIVE' ORDER BY valid_from${lock ? ' FOR UPDATE' : ''}`,
    );
    return rows.map((row) => ({ id: row.id, validFrom: row.valid_from, validTo: row.valid_to }));
  }

  async endVersion(tx: Transaction, id: string, validTo: string, actorId: string): Promise<void> {
    await tx.query('UPDATE mdm.tax_scheme_version SET valid_to = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1', [id, validTo, actorId]);
  }

  async supersede(tx: Transaction, id: string, actorId: string): Promise<void> {
    await tx.query("UPDATE mdm.tax_scheme_version SET status = 'SUPERSEDED', version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1", [id, actorId]);
  }

  async activate(tx: Transaction, id: string, validFrom: string, actorId: string, at: Date): Promise<void> {
    await tx.query(
      `UPDATE mdm.tax_scheme_version
          SET status = 'ACTIVE', valid_from = $2, activated_at = $4, activated_by = $3, version = version + 1, updated_at = now(), updated_by = $3
        WHERE id = $1`,
      [id, validFrom, actorId, at],
    );
  }

  async reject(tx: Transaction, id: string, actorId: string): Promise<void> {
    await tx.query("UPDATE mdm.tax_scheme_version SET status = 'REJECTED', version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1", [id, actorId]);
  }

  async existingCategoryIds(tx: Transaction, ids: readonly string[]): Promise<Set<string>> {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM mdm.tax_category WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [ids]);
    return new Set(rows.map((row) => row.id));
  }
}
