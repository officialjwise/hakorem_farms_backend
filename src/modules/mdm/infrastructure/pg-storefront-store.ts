import type { Transaction } from '../../../platform/database/unit-of-work';
import type { FileStore } from '../../../platform/storage/file-store';
import { galleryVariants } from '../domain/product-images';
import type { DeliveryZoneFacts, OnlineCategoryFacts, OnlineProductFacts, StorefrontStore } from '../application/storefront';
import { deliverableZones } from './pg-reference-data-store';

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  online_mode: 'LISTED' | 'REQUEST_TO_BUY';
  seo_slug: string | null;
  seo_title: string | null;
  seo_description: string | null;
  stock_policy: OnlineProductFacts['stockPolicy'];
  base_uom: string;
  sale_uom: string;
  nominal_pack_kg: string | null;
  weight_tolerance_percent: string;
  tax_category_id: string;
  species_id: string | null;
  chain_codes: string[];
  chain_names: string[];
  root_sort: number;
  product_line: string;
}

/** The storefront's reads over MDM's own tables (B07 continued 2). Only online-visible facts are selected. */
export class PgStorefrontStore implements StorefrontStore {
  constructor(private readonly files: FileStore) {}

  async onlineProducts(tx: Transaction, ids: readonly string[] | null): Promise<OnlineProductFacts[]> {
    const { rows } = await tx.query<ProductRow>(
      `WITH RECURSIVE chain AS (
         SELECT c.id AS leaf_id, c.id, c.parent_id, c.code, c.name, c.sort_order, c.product_line, 0 AS depth, c.is_online_visible AND c.deleted_at IS NULL AS visible
           FROM mdm.category c
         UNION ALL
         SELECT chain.leaf_id, p.id, p.parent_id, p.code, p.name, p.sort_order, chain.product_line, chain.depth + 1, p.is_online_visible AND p.deleted_at IS NULL
           FROM chain JOIN mdm.category p ON p.id = chain.parent_id
       ), paths AS (
         SELECT leaf_id, array_agg(code ORDER BY depth) AS chain_codes, array_agg(name ORDER BY depth) AS chain_names,
                (array_agg(sort_order ORDER BY depth DESC))[1] AS root_sort, min(product_line) AS product_line, bool_and(visible) AS visible
           FROM chain GROUP BY leaf_id
       )
       SELECT p.id, p.sku, p.name, p.description, p.online_mode, p.seo_slug, p.seo_title, p.seo_description, p.stock_policy, p.base_uom, p.sale_uom,
              p.nominal_pack_kg::text AS nominal_pack_kg, p.weight_tolerance_percent::text AS weight_tolerance_percent, p.tax_category_id, p.species_id,
              paths.chain_codes, paths.chain_names, paths.root_sort, paths.product_line
         FROM mdm.product p
         JOIN paths ON paths.leaf_id = p.category_id
        WHERE p.deleted_at IS NULL AND p.status = 'ACTIVE' AND p.is_sellable AND p.online_mode IN ('LISTED', 'REQUEST_TO_BUY') AND paths.visible
          AND ($1::uuid[] IS NULL OR p.id = ANY($1::uuid[]))
        ORDER BY p.id`,
      [ids],
    );
    const images = await this.images(tx, rows.map((row) => row.id));
    return rows.map((row) => ({
      id: row.id,
      sku: row.sku,
      name: row.name,
      description: row.description,
      onlineMode: row.online_mode,
      seoSlug: row.seo_slug,
      seoTitle: row.seo_title,
      seoDescription: row.seo_description,
      stockPolicy: row.stock_policy,
      baseUom: row.base_uom,
      saleUom: row.sale_uom,
      nominalPackKg: row.nominal_pack_kg,
      weightTolerancePercent: row.weight_tolerance_percent,
      taxCategoryId: row.tax_category_id,
      speciesId: row.species_id,
      categoryChain: row.chain_codes.map((code, index) => ({ code, name: row.chain_names[index]! })),
      categorySort: row.root_sort,
      productLine: row.product_line,
      images: images.get(row.id) ?? [],
    }));
  }

  private async images(tx: Transaction, productIds: readonly string[]): Promise<Map<string, OnlineProductFacts['images'][number][]>> {
    const result = new Map<string, OnlineProductFacts['images'][number][]>();
    if (productIds.length === 0) return result;
    const { rows } = await tx.query<{ product_id: string; file_id: string; alt_text: string }>(
      `SELECT product_id, file_id, alt_text FROM mdm.product_image
        WHERE product_id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY product_id, sort_order, id`,
      [productIds],
    );
    const variants = await this.files.publicVariants(tx, [...new Set(rows.map((row) => row.file_id))]);
    for (const row of rows) {
      const gallery = galleryVariants(variants.get(row.file_id) ?? []);
      if (gallery.length === 0) continue;
      const list = result.get(row.product_id) ?? [];
      list.push({ fileId: row.file_id, alt: row.alt_text, variants: gallery });
      result.set(row.product_id, list);
    }
    return result;
  }

  async onlineCategories(tx: Transaction): Promise<OnlineCategoryFacts[]> {
    const { rows } = await tx.query<{ id: string; code: string; name: string; parent_code: string | null; sort_order: number }>(
      `SELECT c.id, c.code, c.name, p.code AS parent_code, c.sort_order
         FROM mdm.category c LEFT JOIN mdm.category p ON p.id = c.parent_id
        WHERE c.deleted_at IS NULL AND c.is_online_visible
        ORDER BY c.sort_order, c.code`,
    );
    return rows.map((row) => ({ id: row.id, code: row.code, name: row.name, parentCode: row.parent_code, sortOrder: row.sort_order }));
  }

  async deliverableZones(tx: Transaction): Promise<DeliveryZoneFacts[]> {
    return (await deliverableZones(tx)).map((zone) => ({
      id: zone.id,
      code: zone.code,
      name: zone.name,
      branchId: zone.branch.id,
      feePesewas: zone.feePesewas,
      freeOverPesewas: zone.freeOverPesewas,
      cutoffTime: zone.cutoffTime,
      areas: zone.areas,
    }));
  }

  async zoneRefs(tx: Transaction, ids: readonly string[]) {
    const { rows } = await tx.query<{ id: string; code: string; name: string; branch_id: string }>('SELECT id, code, name, branch_id FROM mdm.delivery_zone WHERE id = ANY($1::uuid[])', [ids]);
    return new Map(rows.map((row) => [row.id, { id: row.id, code: row.code, name: row.name, branchId: row.branch_id }] as const));
  }

  async taxCategoryIdByCode(tx: Transaction, code: string): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM mdm.tax_category WHERE code = $1', [code]);
    return rows[0]?.id ?? null;
  }

  async priceListsTaxInclusive(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, boolean>> {
    const { rows } = await tx.query<{ id: string; tax_inclusive: boolean }>('SELECT id, tax_inclusive FROM mdm.price_list WHERE id = ANY($1::uuid[])', [ids]);
    return new Map(rows.map((row) => [row.id, row.tax_inclusive] as const));
  }

  async bandFloors(tx: Transaction, speciesIds: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>> {
    const { rows } = await tx.query<{ species_id: string; min_kg: string }>(
      'SELECT species_id, min_kg::text AS min_kg FROM mdm.weight_band WHERE species_id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY species_id, min_kg',
      [speciesIds],
    );
    const floors = new Map<string, string[]>();
    for (const row of rows) floors.set(row.species_id, [...(floors.get(row.species_id) ?? []), row.min_kg]);
    return floors;
  }
}
