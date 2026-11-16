import type { Transaction } from '../../../platform/database/unit-of-work';
import type { UomFactor } from '../domain/unit-conversion';
import type { BranchFacts, GradeFacts, ReasonCodeFacts, LocationFacts, MasterDataRefsStore, ProductFacts, SpeciesFacts, SupplierFacts, TaxCategoryFacts } from '../application/master-data-refs';

/** MDM's own tables, read by primary key for a higher module's transaction (MasterDataRefs). */
export class PgMasterDataRefsStore implements MasterDataRefsStore {
  async products(tx: Transaction, ids: readonly string[]): Promise<ProductFacts[]> {
    const { rows } = await tx.query<{
      id: string;
      sku: string;
      name: string;
      category_id: string;
      tax_category_id: string;
      stock_policy: ProductFacts['stockPolicy'];
      tracking: ProductFacts['tracking'];
      base_uom: string;
      display_decimals: number;
      shelf_life_days: number | null;
      storage_temp_class: ProductFacts['storageTempClass'];
      is_purchasable: boolean;
      is_live: boolean;
      species_id: string | null;
      withdrawal_days: number | null;
    }>(
      `SELECT p.id, p.sku, p.name, p.category_id, p.tax_category_id, p.stock_policy, p.tracking, p.base_uom, u.display_decimals, p.shelf_life_days,
              p.storage_temp_class, p.is_purchasable, (p.status = 'ACTIVE' AND p.deleted_at IS NULL) AS is_live, p.species_id, p.withdrawal_days
         FROM mdm.product p JOIN mdm.uom u ON u.code = p.base_uom
        WHERE p.id = ANY($1::uuid[])`,
      [ids],
    );
    return rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      name: r.name,
      categoryId: r.category_id,
      taxCategoryId: r.tax_category_id,
      stockPolicy: r.stock_policy,
      tracking: r.tracking,
      baseUom: r.base_uom,
      uomDisplayDecimals: Number(r.display_decimals),
      shelfLifeDays: r.shelf_life_days,
      storageTempClass: r.storage_temp_class,
      isPurchasable: r.is_purchasable,
      isLive: r.is_live,
      speciesId: r.species_id,
      withdrawalDays: r.withdrawal_days,
    }));
  }

  async locations(tx: Transaction, ids: readonly string[]): Promise<LocationFacts[]> {
    const { rows } = await tx.query<{
      id: string;
      branch_id: string;
      code: string;
      name: string;
      kind: string;
      is_virtual: boolean;
      is_live: boolean;
      temp_class: LocationFacts['tempClass'];
      temp_min_c: string | null;
      temp_max_c: string | null;
    }>(
      `SELECT id, branch_id, code, name, kind, is_virtual, deleted_at IS NULL AS is_live, temp_class, temp_min_c::text AS temp_min_c, temp_max_c::text AS temp_max_c
         FROM mdm.location WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return rows.map((r) => ({
      id: r.id,
      branchId: r.branch_id,
      code: r.code,
      name: r.name,
      kind: r.kind,
      isVirtual: r.is_virtual,
      isLive: r.is_live,
      tempClass: r.temp_class,
      tempRange: r.temp_min_c === null || r.temp_max_c === null ? null : { minC: r.temp_min_c, maxC: r.temp_max_c },
    }));
  }

  async virtualLocation(tx: Transaction, branchId: string, kind: string): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>(
      'SELECT id FROM mdm.location WHERE branch_id = $1 AND kind = $2 AND is_virtual AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1',
      [branchId, kind],
    );
    return rows[0]?.id ?? null;
  }

  async suppliers(tx: Transaction, ids: readonly string[]): Promise<SupplierFacts[]> {
    const { rows } = await tx.query<{ id: string; supplier_no: string; name: string; is_live: boolean }>(
      "SELECT id, supplier_no, name, (status = 'ACTIVE' AND deleted_at IS NULL) AS is_live FROM mdm.supplier WHERE id = ANY($1::uuid[])",
      [ids],
    );
    return rows.map((r) => ({ id: r.id, supplierNo: r.supplier_no, name: r.name, isLive: r.is_live }));
  }

  async species(tx: Transaction, ids: readonly string[]): Promise<SpeciesFacts[]> {
    const { rows } = await tx.query<SpeciesFacts>('SELECT id, code, name FROM mdm.species WHERE id = ANY($1::uuid[])', [ids]);
    return rows;
  }

  async grades(tx: Transaction, ids: readonly string[]): Promise<GradeFacts[]> {
    const { rows } = await tx.query<{ id: string; code: string; name: string }>('SELECT id, code, name FROM mdm.grade WHERE id = ANY($1::uuid[])', [ids]);
    return rows;
  }

  async branches(tx: Transaction, ids: readonly string[]): Promise<BranchFacts[]> {
    const { rows } = await tx.query<BranchFacts>('SELECT id, code, name FROM mdm.branch WHERE id = ANY($1::uuid[])', [ids]);
    return rows;
  }

  async taxCategories(tx: Transaction, ids: readonly string[]): Promise<TaxCategoryFacts[]> {
    const { rows } = await tx.query<TaxCategoryFacts>('SELECT id, code, name FROM mdm.tax_category WHERE id = ANY($1::uuid[])', [ids]);
    return rows;
  }

  async reasonCodes(tx: Transaction, codes: readonly string[]): Promise<ReasonCodeFacts[]> {
    const { rows } = await tx.query<ReasonCodeFacts>('SELECT code, domain, requires_note AS "requiresNote" FROM mdm.reason_code WHERE code = ANY($1::text[])', [codes]);
    return rows;
  }

  async physicalLocationOfKind(tx: Transaction, branchId: string, kind: string): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>(
      'SELECT id FROM mdm.location WHERE branch_id = $1 AND kind = $2 AND NOT is_virtual AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1',
      [branchId, kind],
    );
    return rows[0]?.id ?? null;
  }

  async headOfficeBranchId(tx: Transaction): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM mdm.branch WHERE deleted_at IS NULL AND status = 'ACTIVE' AND NOT is_test ORDER BY created_at, code LIMIT 1");
    return rows[0]?.id ?? null;
  }

  async branchIdByCode(tx: Transaction, code: string): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM mdm.branch WHERE code = upper($1) AND deleted_at IS NULL', [code]);
    return rows[0]?.id ?? null;
  }

  async locationIdByCode(tx: Transaction, branchId: string, code: string): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM mdm.location WHERE branch_id = $1 AND code = upper($2) AND deleted_at IS NULL', [branchId, code]);
    return rows[0]?.id ?? null;
  }

  async productIdBySku(tx: Transaction, sku: string): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM mdm.product WHERE sku = upper($1) AND deleted_at IS NULL', [sku]);
    return rows[0]?.id ?? null;
  }

  async productIdsOfSpecies(tx: Transaction, speciesId: string): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM mdm.product WHERE species_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL ORDER BY sku", [speciesId]);
    return rows.map((r) => r.id);
  }

  async uomFactor(tx: Transaction, productId: string, uom: string): Promise<{ readonly baseUom: string; readonly factor: UomFactor | null } | null> {
    const { rows } = await tx.query<{ base_uom: string; numerator: string | null; denominator: string | null }>(
      `SELECT p.base_uom, c.numerator::text AS numerator, c.denominator::text AS denominator
         FROM mdm.product p
         LEFT JOIN mdm.product_uom_conversion c ON c.product_id = p.id AND c.from_uom = $2 AND c.deleted_at IS NULL
        WHERE p.id = $1`,
      [productId, uom],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return { baseUom: row.base_uom, factor: row.numerator === null ? null : { numerator: BigInt(row.numerator), denominator: BigInt(row.denominator!) } };
  }
}
