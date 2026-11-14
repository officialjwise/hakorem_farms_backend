import { Quantity, Weight } from '@hakorem/kernel';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { PriceBasis, PriceListKind } from '../domain/pricing/pricing-engine';
import type { BandRow, GradeRow, ListInForce, PricingCustomer, PricingProduct, PricingStore, WalkSlots } from '../application/pricing-store';

interface ListRow {
  list_id: string;
  code: string;
  name: string;
  kind: PriceListKind;
  branch_id: string | null;
  entry_id: string | null;
  product_id: string | null;
  grade_id: string | null;
  weight_band_id: string | null;
  basis: PriceBasis | null;
  list_price: string | null;
  floor_price: string | null;
  ceiling_price: string | null;
  quote_only: boolean | null;
  min_qty: string | null;
}

/**
 * MDM's pricing reads in plain parameterised SQL over MDM's own tables (ADR-0030). The lists-in-force query is the
 * hot path of every sale: it uses ix_price_list_version_active and ix_price_list_entry_product.
 */
export class PgPricingStore implements PricingStore {
  async branchExists(tx: Transaction, branchId: string): Promise<boolean> {
    const { rows } = await tx.query('SELECT 1 FROM mdm.branch WHERE id = $1 AND deleted_at IS NULL', [branchId]);
    return rows.length > 0;
  }

  async products(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, PricingProduct>> {
    const { rows } = await tx.query<{ id: string; species_id: string | null }>('SELECT id, species_id FROM mdm.product WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [
      [...new Set(ids)],
    ]);
    return new Map(rows.map((row) => [row.id, { id: row.id, speciesId: row.species_id }]));
  }

  async grades(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, GradeRow>> {
    if (ids.length === 0) {
      return new Map();
    }
    const { rows } = await tx.query<{ id: string; code: string; name: string; species_id: string }>(
      'SELECT id, code, name, species_id FROM mdm.grade WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
      [[...new Set(ids)]],
    );
    return new Map(rows.map((row) => [row.id, { id: row.id, code: row.code, name: row.name, speciesId: row.species_id }]));
  }

  async bands(tx: Transaction, speciesIds: readonly string[]): Promise<readonly BandRow[]> {
    if (speciesIds.length === 0) {
      return [];
    }
    const { rows } = await tx.query<{ id: string; code: string; species_id: string; min_kg: string; max_kg: string }>(
      'SELECT id, code, species_id, min_kg::text, max_kg::text FROM mdm.weight_band WHERE species_id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY species_id, min_kg',
      [speciesIds],
    );
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      speciesId: row.species_id,
      min: Weight.parseKg(row.min_kg),
      max: Weight.parseKg(row.max_kg),
      minKg: row.min_kg,
      maxKg: row.max_kg,
    }));
  }

  async customer(tx: Transaction, id: string, at: Date): Promise<PricingCustomer | null> {
    const { rows } = await tx.query<{ id: string; tier_id: string; assigned_list_id: string | null }>(
      `SELECT c.id, c.tier_id,
              (SELECT a.price_list_id FROM mdm.customer_price_list a
                WHERE a.customer_id = c.id AND a.deleted_at IS NULL AND a.valid_from <= $2 AND (a.valid_to IS NULL OR a.valid_to > $2)) AS assigned_list_id
         FROM mdm.customer c
        WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [id, at],
    );
    const row = rows[0];
    return row === undefined ? null : { id: row.id, tierId: row.tier_id, assignedListId: row.assigned_list_id };
  }

  async listsInForce(tx: Transaction, slots: WalkSlots, at: Date, productIds: readonly string[]): Promise<readonly ListInForce[]> {
    const { rows } = await tx.query<ListRow>(
      `SELECT l.id AS list_id, l.code, l.name, l.kind, l.branch_id,
              e.id AS entry_id, e.product_id, e.grade_id, e.weight_band_id, e.basis, e.list_price_pesewas::text AS list_price,
              e.floor_price_pesewas::text AS floor_price, e.ceiling_price_pesewas::text AS ceiling_price, e.quote_only, e.min_qty::text
         FROM mdm.price_list l
         JOIN mdm.price_list_version v
           ON v.price_list_id = l.id AND v.status = 'ACTIVE' AND v.valid_from <= $5 AND (v.valid_to IS NULL OR v.valid_to > $5)
         LEFT JOIN mdm.price_list_entry e ON e.version_id = v.id AND e.product_id = ANY($6::uuid[])
        WHERE l.deleted_at IS NULL
          AND (l.branch_id IS NULL OR l.branch_id = $2)
          AND ((l.kind = 'CUSTOMER' AND l.id = $4)
               OR (l.kind = 'TIER' AND l.channel = $1 AND l.customer_tier_id = $3)
               OR (l.kind = 'CHANNEL' AND l.channel = $1)
               OR l.kind = 'BASE')
        ORDER BY l.id, e.id`,
      [slots.channel, slots.branchId, slots.tierId, slots.customerListId, at, [...new Set(productIds)]],
    );
    const lists = new Map<string, { list: ListInForce['list']; branchId: string | null; entries: Array<ListInForce['entries'][number]> }>();
    for (const row of rows) {
      let list = lists.get(row.list_id);
      if (list === undefined) {
        list = { list: { id: row.list_id, code: row.code, name: row.name, kind: row.kind }, branchId: row.branch_id, entries: [] };
        lists.set(row.list_id, list);
      }
      if (row.entry_id !== null) {
        list.entries.push({
          id: row.entry_id,
          productId: row.product_id!,
          gradeId: row.grade_id,
          weightBandId: row.weight_band_id,
          basis: row.basis!,
          listPricePesewas: BigInt(row.list_price!),
          floorPricePesewas: BigInt(row.floor_price!),
          ceilingPricePesewas: BigInt(row.ceiling_price!),
          quoteOnly: row.quote_only!,
          minQty: Quantity.parse(row.min_qty!),
        });
      }
    }
    return [...lists.values()];
  }
}
