import type { Transaction } from '../../../platform/database/unit-of-work';
import type { UomConversionFilter, UomConversionRow, UomConversionStore } from '../application/uom-conversions';
import type { UomKind } from '../domain/product';
import type { UomFactor } from '../domain/unit-conversion';

interface Row {
  id: string;
  product_id: string;
  sku: string;
  name: string;
  from_uom: string;
  to_uom: string;
  numerator: string;
  denominator: string;
  version: number;
  created_at: Date;
  deleted_at: Date | null;
  delete_reason: string | null;
}

const SELECT = `SELECT c.id, c.product_id, p.sku, p.name, c.from_uom, c.to_uom, c.numerator::text AS numerator, c.denominator::text AS denominator,
                       c.version, c.created_at, c.deleted_at, c.delete_reason
                  FROM mdm.product_uom_conversion c JOIN mdm.product p ON p.id = c.product_id`;

function toRow(r: Row): UomConversionRow {
  return {
    id: r.id,
    product: { id: r.product_id, sku: r.sku, name: r.name },
    fromUom: r.from_uom,
    toUom: r.to_uom,
    numerator: BigInt(r.numerator),
    denominator: BigInt(r.denominator),
    version: r.version,
    createdAt: r.created_at,
    archivedAt: r.deleted_at,
    archiveReason: r.delete_reason,
  };
}

/** `mdm.product_uom_conversion` (migration 0090), MDM's own table, in the caller's transaction. */
export class PgUomConversionStore implements UomConversionStore {
  async unitKind(tx: Transaction, code: string): Promise<UomKind | null> {
    const { rows } = await tx.query<{ kind: UomKind }>('SELECT kind FROM mdm.uom WHERE code = $1', [code]);
    return rows[0]?.kind ?? null;
  }

  async find(tx: Transaction, id: string): Promise<UomConversionRow | null> {
    const { rows } = await tx.query<Row>(`${SELECT} WHERE c.id = $1`, [id]);
    return rows[0] === undefined ? null : toRow(rows[0]);
  }

  async lockLive(tx: Transaction, id: string): Promise<UomConversionRow | null> {
    const { rows } = await tx.query<Row>(`${SELECT} WHERE c.id = $1 AND c.deleted_at IS NULL FOR UPDATE OF c`, [id]);
    return rows[0] === undefined ? null : toRow(rows[0]);
  }

  async list(tx: Transaction, filter: UomConversionFilter, afterId: string | null, limit: number): Promise<UomConversionRow[]> {
    const { rows } = await tx.query<Row>(
      `${SELECT}
        WHERE ($1::uuid IS NULL OR c.product_id = $1) AND ($2 OR c.deleted_at IS NULL) AND ($3::uuid IS NULL OR c.id > $3)
        ORDER BY c.id
        LIMIT $4`,
      [filter.productId ?? null, filter.includeArchived, afterId, limit],
    );
    return rows.map(toRow);
  }

  async liveFromUnitTaken(tx: Transaction, productId: string, fromUom: string): Promise<boolean> {
    const { rows } = await tx.query('SELECT 1 FROM mdm.product_uom_conversion WHERE product_id = $1 AND from_uom = $2 AND deleted_at IS NULL', [productId, fromUom]);
    return rows.length > 0;
  }

  async insert(tx: Transaction, row: { readonly id: string; readonly productId: string; readonly fromUom: string; readonly toUom: string } & UomFactor, actorId: string, now: Date): Promise<void> {
    await tx.query(
      `INSERT INTO mdm.product_uom_conversion (id, product_id, from_uom, to_uom, numerator, denominator, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7, $8)`,
      [row.id, row.productId, row.fromUom, row.toUom, row.numerator.toString(), row.denominator.toString(), now, actorId],
    );
  }

  async archive(tx: Transaction, id: string, expectedVersion: number, reason: string, actorId: string, now: Date): Promise<boolean> {
    const result = await tx.query(
      `UPDATE mdm.product_uom_conversion SET deleted_at = $4, deleted_by = $3, delete_reason = $5, version = version + 1, updated_at = $4, updated_by = $3
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL`,
      [id, expectedVersion, actorId, now, reason],
    );
    return result.rowCount === 1;
  }
}
