import type { Transaction } from '../../../platform/database/unit-of-work';
import type { UomFactor } from '../domain/unit-conversion';
import type { BranchFacts, GradeFacts, ReasonCodeFacts, UomFacts, ReasonCodeView, LocationFacts, MasterDataRefsStore, ProductFacts, SpeciesFacts, SupplierFacts, TaxCategoryFacts, CustomerAddressFacts,
  CustomerContactFacts, CustomerFacts, PaymentMethodFacts, WeightBandFacts } from '../application/master-data-refs';

/** MDM's own tables, read by primary key for a higher module's transaction (MasterDataRefs). */
const PAYMENT_METHOD_FACTS = `SELECT id, code, name, kind, requires_provider_verification AS "requiresProviderVerification", allowed_offline AS "allowedOffline", channels,
       (is_enabled AND deleted_at IS NULL) AS "isLive"
  FROM mdm.payment_method`;

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
      gl_group: ProductFacts['glGroup'];
    }>(
      `SELECT p.id, p.sku, p.name, p.category_id, p.tax_category_id, p.stock_policy, p.tracking, p.base_uom, u.display_decimals, p.shelf_life_days,
              p.storage_temp_class, p.is_purchasable, (p.status = 'ACTIVE' AND p.deleted_at IS NULL) AS is_live, p.species_id, p.withdrawal_days,
              p.gl_group
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
      glGroup: r.gl_group,
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
    const { rows } = await tx.query<{ id: string; public_id: string; name: string; is_live: boolean }>(
      "SELECT id, public_id, name, (status = 'ACTIVE' AND deleted_at IS NULL) AS is_live FROM mdm.supplier WHERE id = ANY($1::uuid[])",
      [ids],
    );
    return rows.map((r) => ({ id: r.id, publicId: r.public_id, name: r.name, isLive: r.is_live }));
  }

  async species(tx: Transaction, ids: readonly string[]): Promise<SpeciesFacts[]> {
    const { rows } = await tx.query<SpeciesFacts>('SELECT id, code, name FROM mdm.species WHERE id = ANY($1::uuid[])', [ids]);
    return rows;
  }

  async grades(tx: Transaction, ids: readonly string[]): Promise<GradeFacts[]> {
    const { rows } = await tx.query<{ id: string; code: string; name: string }>('SELECT id, code, name FROM mdm.grade WHERE id = ANY($1::uuid[])', [ids]);
    return rows;
  }

  async weightBands(tx: Transaction, ids: readonly string[]): Promise<WeightBandFacts[]> {
    const { rows } = await tx.query<WeightBandFacts>('SELECT id, code, min_kg::text AS "minKg", max_kg::text AS "maxKg" FROM mdm.weight_band WHERE id = ANY($1::uuid[])', [ids]);
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

  async customers(tx: Transaction, ids: readonly string[]): Promise<CustomerFacts[]> {
    const { rows } = await tx.query<CustomerFacts>(
      'SELECT id, public_id AS "publicId", name, kind, (deleted_at IS NULL AND status = $2) AS "isLive", (phone_e164 IS NOT NULL) AS "hasPhone" FROM mdm.customer WHERE id = ANY($1::uuid[])',
      [ids, 'ACTIVE'],
    );
    return rows;
  }

  async customerContacts(tx: Transaction, ids: readonly string[]): Promise<CustomerContactFacts[]> {
    const { rows } = await tx.query<CustomerContactFacts>(
      'SELECT id, name, (deleted_at IS NULL AND status = $2) AS "isLive", phone_e164 AS "phoneE164" FROM mdm.customer WHERE id = ANY($1::uuid[])',
      [ids, 'ACTIVE'],
    );
    return rows;
  }

  async consentingCustomers(tx: Transaction, ids: readonly string[]): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>(
      'SELECT id FROM mdm.customer WHERE id = ANY($1::uuid[]) AND marketing_consent_at IS NOT NULL AND deleted_at IS NULL AND status = $2',
      [ids, 'ACTIVE'],
    );
    return rows.map((r) => r.id);
  }

  async customerAddress(tx: Transaction, id: string): Promise<CustomerAddressFacts | null> {
    const { rows } = await tx.query<CustomerAddressFacts>(
      `SELECT id, customer_id AS "customerId", recipient_name AS "recipientName", recipient_phone_e164 AS "recipientPhone", line1, area, city, region,
              digital_address AS "digitalAddress", directions, delivery_zone_id AS "deliveryZoneId", deleted_at IS NULL AS "isLive"
         FROM mdm.customer_address WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async customerOfPrincipal(tx: Transaction, principalId: string): Promise<CustomerFacts | null> {
    const { rows } = await tx.query<CustomerFacts>(
      'SELECT id, public_id AS "publicId", name, kind, (deleted_at IS NULL AND status = $2) AS "isLive", (phone_e164 IS NOT NULL) AS "hasPhone" FROM mdm.customer WHERE principal_id = $1',
      [principalId, 'ACTIVE'],
    );
    return rows[0] ?? null;
  }

  async reasonCodes(tx: Transaction, codes: readonly string[]): Promise<ReasonCodeFacts[]> {
    const { rows } = await tx.query<ReasonCodeFacts>('SELECT code, domain, requires_note AS "requiresNote", loss_account_group AS "lossAccountGroup" FROM mdm.reason_code WHERE code = ANY($1::text[])', [codes]);
    return rows;
  }

  async units(tx: Transaction, codes: readonly string[]): Promise<UomFacts[]> {
    const { rows } = await tx.query<UomFacts>(
      'SELECT code, name, singular_name AS "singularName", plural_name AS "pluralName", display_decimals AS "displayDecimals" FROM mdm.uom WHERE code = ANY($1::text[]) ORDER BY code',
      [codes],
    );
    return rows;
  }

  async paymentMethodsByCode(tx: Transaction, codes: readonly string[]): Promise<PaymentMethodFacts[]> {
    const { rows } = await tx.query<PaymentMethodFacts>(`${PAYMENT_METHOD_FACTS} WHERE code = ANY($1::text[])`, [codes]);
    return rows;
  }

  async paymentMethods(tx: Transaction, ids: readonly string[]): Promise<PaymentMethodFacts[]> {
    const { rows } = await tx.query<PaymentMethodFacts>(`${PAYMENT_METHOD_FACTS} WHERE id = ANY($1::uuid[])`, [ids]);
    return rows;
  }

  async reasonCodesOfDomains(tx: Transaction, domains: readonly string[]): Promise<ReasonCodeView[]> {
    const { rows } = await tx.query<ReasonCodeView>(
      'SELECT code, domain, description, requires_note AS "requiresNote", loss_account_group AS "lossAccountGroup" FROM mdm.reason_code WHERE domain = ANY($1::text[]) ORDER BY domain, code',
      [domains],
    );
    return rows;
  }

  async allPaymentMethods(tx: Transaction): Promise<PaymentMethodFacts[]> {
    const { rows } = await tx.query<PaymentMethodFacts>(`${PAYMENT_METHOD_FACTS} ORDER BY code`);
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

  async productIdsInCategory(tx: Transaction, categoryId: string): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM mdm.product WHERE category_id = $1 ORDER BY id', [categoryId]);
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
