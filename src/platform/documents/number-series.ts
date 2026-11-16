import type { Transaction } from '../database/unit-of-work';

export interface NumberRequest {
  /** A numbered code of `platform.document_type`. */
  readonly docType: string;
  /** The fiscal year of the document's posting date (ADR-0015): the calendar year (A-028). */
  readonly fiscalYear: number;
  readonly branchId: string;
  /** The branch's code as printed in the number, written on the series when the year's series opens. */
  readonly branchCode: string;
  /** A register code for receipts; empty otherwise. */
  readonly subScope?: string;
  /** The registered business document that takes the number. */
  readonly documentId: string;
}

/** A number the platform allocated, and the document it went to. */
export interface NumberAllocation {
  readonly docType: string;
  readonly documentId: string;
  readonly formatted: string;
}

/** A series whose allocations are not one contiguous run from 1 to `next_value - 1` (ADR-0015, the nightly check). */
export interface SeriesGap {
  readonly seriesId: string;
  readonly docType: string;
  readonly fiscalYear: number;
  readonly branchId: string;
  readonly subScope: string;
  readonly issued: number;
  readonly allocations: number;
  readonly maxValue: number;
}

/**
 * Gap-free document numbers (ADR-0015, migration 0122). The number is allocated by `platform.allocate_number` in the
 * caller's transaction: the series row is locked by the allocation, and a rollback gives the number back. Concurrent
 * allocators on one series queue on the row; under serializable isolation the later one fails with 40001 and the unit
 * of work re-runs it with a fresh snapshot (ADR-0005).
 */
export class NumberSeries {
  async allocateIn(tx: Transaction, request: NumberRequest): Promise<string> {
    const series = await tx.query<{ id: string }>('SELECT platform.open_number_series($1, $2, $3, $4, $5) AS id', [
      request.docType,
      request.fiscalYear,
      request.branchId,
      request.branchCode,
      request.subScope ?? '',
    ]);
    const allocated = await tx.query<{ number: string }>('SELECT platform.allocate_number($1, $2) AS number', [series.rows[0]!.id, request.documentId]);
    return allocated.rows[0]!.number;
  }

  /** Every series whose allocations are not exactly the values 1 to `next_value - 1`, each once. */
  async gapsIn(tx: Transaction): Promise<SeriesGap[]> {
    const { rows } = await tx.query<{
      id: string;
      doc_type: string;
      fiscal_year: number;
      branch_id: string;
      sub_scope: string;
      issued: string;
      allocations: string;
      max_value: string;
    }>(
      `SELECT s.id, s.doc_type, s.fiscal_year, s.branch_id, s.sub_scope, s.next_value - 1 AS issued,
              count(a.value) AS allocations, COALESCE(max(a.value), 0) AS max_value
         FROM platform.number_series s LEFT JOIN platform.number_allocation a ON a.series_id = s.id
        GROUP BY s.id
       HAVING count(a.value) <> s.next_value - 1 OR COALESCE(max(a.value), 0) <> s.next_value - 1
        ORDER BY s.doc_type, s.fiscal_year, s.branch_id, s.sub_scope`,
    );
    return rows.map((r) => ({
      seriesId: r.id,
      docType: r.doc_type,
      fiscalYear: r.fiscal_year,
      branchId: r.branch_id,
      subScope: r.sub_scope,
      issued: Number(r.issued),
      allocations: Number(r.allocations),
      maxValue: Number(r.max_value),
    }));
  }

  /** Every number allocated in series of these document types, with the document it was allocated to (FR-BIL-003). */
  async allocationsOf(tx: Transaction, docTypes: readonly string[]): Promise<NumberAllocation[]> {
    const { rows } = await tx.query<{ doc_type: string; document_id: string; formatted: string }>(
      `SELECT s.doc_type, a.document_id, a.formatted
         FROM platform.number_allocation a JOIN platform.number_series s ON s.id = a.series_id
        WHERE s.doc_type = ANY($1::text[])
        ORDER BY s.doc_type, a.formatted`,
      [docTypes],
    );
    return rows.map((r) => ({ docType: r.doc_type, documentId: r.document_id, formatted: r.formatted }));
  }
}
