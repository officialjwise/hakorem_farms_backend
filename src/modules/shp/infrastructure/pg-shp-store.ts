import type { Transaction } from '../../../platform/database/unit-of-work';
import { keysetClause, sortKeySelect, type SortOrder } from '../../../platform/http/keyset-sort';
import type {
  AddressSnapshot,
  CartLineRecord,
  CartRecord,
  CatalogueFilters,
  CheckoutLineRecord,
  CheckoutRecord,
  CheckoutWrite,
  ImageSetView,
  ListingRow,
  ShpStore,
} from '../application/shp-store';
import type { Availability } from '../domain/listing';
import type { PriceBasis } from '../domain/pricing-lines';

interface ListingDbRow {
  product_id: string;
  slug: string;
  name: string;
  description: string | null;
  category_code: string;
  category_codes: string[];
  category_path: string[];
  category_sort: number;
  product_line: string;
  online_mode: 'LISTED' | 'REQUEST_TO_BUY';
  price_from_pesewas: string | null;
  price_to_pesewas: string | null;
  price_basis: PriceBasis | null;
  tax_inclusive: boolean | null;
  sale_uom: string;
  nominal_pack_kg: string | null;
  catch_weight: boolean;
  weight_tolerance_percent: string | null;
  availability: Availability;
  images: ImageSetView[];
  main_image_file_id: string | null;
  seo_title: string | null;
  seo_description: string | null;
  [key: string]: unknown;
}

const LISTING_COLUMNS = `l.product_id, l.slug, l.name, l.description, l.category_code, l.category_codes, l.category_path, l.category_sort, l.product_line,
  l.online_mode, l.price_from_pesewas::text AS price_from_pesewas, l.price_to_pesewas::text AS price_to_pesewas, l.price_basis, l.tax_inclusive,
  l.sale_uom, l.nominal_pack_kg::text AS nominal_pack_kg, l.catch_weight, l.weight_tolerance_percent::text AS weight_tolerance_percent,
  l.availability, l.images, l.main_image_file_id, l.seo_title, l.seo_description`;

/** The catalogue filters as SQL over `l`, numbered from `$2` ($1 is the branch). */
const FILTERS = `l.branch_id = $1
  AND ($2::text IS NULL OR l.search_text @@ websearch_to_tsquery('english', $2::text))
  AND ($3::text IS NULL OR $3::text = ANY(l.category_codes))
  AND ($4::text IS NULL OR l.product_line = $4::text)
  AND ($5::text IS NULL OR l.availability = $5::text)`;

function filterValues(branchId: string, f: CatalogueFilters): unknown[] {
  return [branchId, f.q, f.category, f.productLine, f.availability];
}

function toListing(row: ListingDbRow): ListingRow {
  return {
    productId: row.product_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    categoryCode: row.category_code,
    categoryCodes: row.category_codes,
    categoryPath: row.category_path,
    categorySort: row.category_sort,
    productLine: row.product_line,
    onlineMode: row.online_mode,
    priceFromPesewas: row.price_from_pesewas === null ? null : BigInt(row.price_from_pesewas),
    priceToPesewas: row.price_to_pesewas === null ? null : BigInt(row.price_to_pesewas),
    priceBasis: row.price_basis,
    taxInclusive: row.tax_inclusive,
    saleUom: row.sale_uom,
    nominalPackKg: row.nominal_pack_kg,
    catchWeight: row.catch_weight,
    weightTolerancePercent: row.weight_tolerance_percent,
    availability: row.availability,
    images: row.images,
    mainImageFileId: row.main_image_file_id,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
  };
}

interface CartDbRow {
  id: string;
  guest_token_hash: Buffer | null;
  branch_id: string;
  coupon_code: string | null;
  status: CartRecord['status'];
  updated_at: Date;
}

interface CheckoutDbRow {
  id: string;
  cart_id: string;
  contact_name: string;
  contact_phone_e164: string;
  address_snapshot: AddressSnapshot | null;
  fulfilment_mode: CheckoutRecord['fulfilmentMode'];
  delivery_zone_id: string | null;
  delivery_slot_id: string | null;
  delivery_fee_pesewas: string;
  payment_terms: CheckoutRecord['paymentTerms'];
  tax_inclusive: boolean;
  coupon_code: string | null;
  discount_pesewas: string;
  promotions: CheckoutRecord['promotions'];
  tax_pesewas: string;
  estimated_total_pesewas: string;
  maximum_total_pesewas: string;
  difference_preference: CheckoutRecord['differencePreference'];
  price_changed: boolean;
  reserved_until: Date;
  order_id: string | null;
  status: CheckoutRecord['status'];
  branch_id: string;
  version: number;
}

/** SHP's persistence over its own schema (migration 0119). */
export class PgShpStore implements ShpStore {
  async replaceListing(tx: Transaction, branchId: string, rows: readonly ListingRow[]): Promise<number> {
    const payload = rows.map((row) => ({
      ...row,
      priceFromPesewas: row.priceFromPesewas === null ? null : row.priceFromPesewas.toString(),
      priceToPesewas: row.priceToPesewas === null ? null : row.priceToPesewas.toString(),
    }));
    const { rows: result } = await tx.query<{ written: number }>('SELECT shp.replace_product_listing($1, $2::jsonb) AS written', [branchId, JSON.stringify(payload)]);
    return result[0]!.written;
  }

  async listingPage(tx: Transaction, branchId: string, filters: CatalogueFilters, order: SortOrder, position: readonly string[] | null, limit: number) {
    const clause = keysetClause(order, position, 7);
    const { rows } = await tx.query<ListingDbRow>(
      `SELECT ${LISTING_COLUMNS}, ${sortKeySelect(order)} FROM shp.product_listing l
        WHERE ${FILTERS} AND ${clause.after}
        ORDER BY ${clause.orderBy} LIMIT $6`,
      [...filterValues(branchId, filters), limit, ...clause.values],
    );
    return rows.map((row) => ({ ...toListing(row), position: order.keys.map((_key, index) => String(row[`sort_key_${index}`])) }));
  }

  async facets(tx: Transaction, branchId: string, filters: CatalogueFilters) {
    const [categories, lines] = await Promise.all([
      tx.query<{ code: string; name: string; count: string }>(
        `SELECT c.code, c.name, count(*)::text AS count FROM shp.product_listing l, unnest(l.category_codes, l.category_path) AS c(code, name)
          WHERE ${FILTERS} GROUP BY c.code, c.name ORDER BY min(l.category_sort), c.code`,
        filterValues(branchId, filters),
      ),
      tx.query<{ value: string; count: string }>(
        `SELECT l.product_line AS value, count(*)::text AS count FROM shp.product_listing l WHERE ${FILTERS} GROUP BY l.product_line ORDER BY l.product_line`,
        filterValues(branchId, filters),
      ),
    ]);
    return {
      categories: categories.rows.map((row) => ({ code: row.code, name: row.name, count: Number(row.count) })),
      productLines: lines.rows.map((row) => ({ value: row.value, count: Number(row.count) })),
    };
  }

  async listingBySlug(tx: Transaction, branchId: string, slug: string): Promise<ListingRow | null> {
    const { rows } = await tx.query<ListingDbRow>(`SELECT ${LISTING_COLUMNS} FROM shp.product_listing l WHERE l.branch_id = $1 AND l.slug = $2`, [branchId, slug]);
    return rows[0] === undefined ? null : toListing(rows[0]);
  }

  async listings(tx: Transaction, branchId: string, productIds: readonly string[]): Promise<ReadonlyMap<string, ListingRow>> {
    if (productIds.length === 0) return new Map();
    const { rows } = await tx.query<ListingDbRow>(`SELECT ${LISTING_COLUMNS} FROM shp.product_listing l WHERE l.branch_id = $1 AND l.product_id = ANY($2::uuid[])`, [branchId, productIds]);
    return new Map(rows.map((row) => [row.product_id, toListing(row)] as const));
  }

  async relatedSlugs(tx: Transaction, branchId: string, categoryCode: string, exceptProductId: string, limit: number): Promise<string[]> {
    const { rows } = await tx.query<{ slug: string }>(
      'SELECT slug FROM shp.product_listing WHERE branch_id = $1 AND category_code = $2 AND product_id <> $3 ORDER BY lower(name), product_id LIMIT $4',
      [branchId, categoryCode, exceptProductId, limit],
    );
    return rows.map((row) => row.slug);
  }

  async categoryCounts(tx: Transaction, branchId: string): Promise<ReadonlyMap<string, number>> {
    const { rows } = await tx.query<{ code: string; count: string }>(
      'SELECT c.code, count(*)::text AS count FROM shp.product_listing l, unnest(l.category_codes) AS c(code) WHERE l.branch_id = $1 GROUP BY c.code',
      [branchId],
    );
    return new Map(rows.map((row) => [row.code, Number(row.count)] as const));
  }

  async insertCart(tx: Transaction, cart: { readonly id: string; readonly guestTokenHash: Buffer; readonly branchId: string }): Promise<void> {
    await tx.query(`INSERT INTO shp.cart (id, guest_token_hash, branch_id, status) VALUES ($1, $2, $3, 'ACTIVE')`, [cart.id, cart.guestTokenHash, cart.branchId]);
  }

  async openCheckoutOf(tx: Transaction, cartId: string): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM shp.checkout_session WHERE cart_id = $1 AND status IN ('STARTED', 'AWAITING_PAYMENT')", [cartId]);
    return rows[0]?.id ?? null;
  }

  async cart(tx: Transaction, id: string, lock: boolean): Promise<CartRecord | null> {
    const { rows } = await tx.query<CartDbRow>(`SELECT id, guest_token_hash, branch_id, coupon_code, status, updated_at FROM shp.cart WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    const row = rows[0];
    return row === undefined ? null : { id: row.id, guestTokenHash: row.guest_token_hash, branchId: row.branch_id, couponCode: row.coupon_code, status: row.status, updatedAt: row.updated_at };
  }

  async cartLines(tx: Transaction, cartId: string): Promise<CartLineRecord[]> {
    const { rows } = await tx.query<{ id: string; product_id: string; qty: string; uom: string; displayed_unit_price_pesewas: string; added_at: Date }>(
      'SELECT id, product_id, qty::text AS qty, uom, displayed_unit_price_pesewas::text AS displayed_unit_price_pesewas, added_at FROM shp.cart_line WHERE cart_id = $1 ORDER BY added_at, id',
      [cartId],
    );
    return rows.map((row) => ({ id: row.id, productId: row.product_id, qty: row.qty, uom: row.uom, displayedUnitPricePesewas: BigInt(row.displayed_unit_price_pesewas), addedAt: row.added_at }));
  }

  async upsertCartLine(tx: Transaction, cartId: string, line: { readonly id: string; readonly productId: string; readonly qty: string; readonly uom: string; readonly displayedUnitPricePesewas: bigint }): Promise<void> {
    await tx.query(
      `INSERT INTO shp.cart_line (id, cart_id, product_id, qty, uom, displayed_unit_price_pesewas) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (cart_id, product_id) DO UPDATE SET qty = EXCLUDED.qty, displayed_unit_price_pesewas = EXCLUDED.displayed_unit_price_pesewas, updated_at = now()`,
      [line.id, cartId, line.productId, line.qty, line.uom, line.displayedUnitPricePesewas.toString()],
    );
    await this.touch(tx, cartId);
  }

  async setCartLineQty(tx: Transaction, cartId: string, lineId: string, qty: string, displayedUnitPricePesewas: bigint): Promise<boolean> {
    const result = await tx.query('UPDATE shp.cart_line SET qty = $3, displayed_unit_price_pesewas = $4, updated_at = now() WHERE cart_id = $1 AND id = $2', [cartId, lineId, qty, displayedUnitPricePesewas.toString()]);
    await this.touch(tx, cartId);
    return result.rowCount === 1;
  }

  async deleteCartLine(tx: Transaction, cartId: string, lineId: string): Promise<boolean> {
    const result = await tx.query('DELETE FROM shp.cart_line WHERE cart_id = $1 AND id = $2', [cartId, lineId]);
    await this.touch(tx, cartId);
    return result.rowCount === 1;
  }

  async setCart(tx: Transaction, cartId: string, change: { readonly couponCode?: string | null; readonly status?: CartRecord['status'] }): Promise<void> {
    await tx.query(
      `UPDATE shp.cart SET coupon_code = CASE WHEN $2::boolean THEN $3::text ELSE coupon_code END, status = COALESCE($4::text, status), updated_at = now(), version = version + 1 WHERE id = $1`,
      [cartId, change.couponCode !== undefined, change.couponCode ?? null, change.status ?? null],
    );
  }

  private async touch(tx: Transaction, cartId: string): Promise<void> {
    await tx.query('UPDATE shp.cart SET updated_at = now(), version = version + 1 WHERE id = $1', [cartId]);
  }

  async insertCheckout(tx: Transaction, c: CheckoutWrite, lines: readonly CheckoutLineRecord[], actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO shp.checkout_session (id, cart_id, contact_name, contact_phone_e164, address_snapshot, fulfilment_mode, delivery_zone_id, delivery_slot_id,
              delivery_fee_pesewas, payment_terms, tax_inclusive, coupon_code, discount_pesewas, tax_pesewas, estimated_total_pesewas, maximum_total_pesewas,
              difference_preference, price_changed, reserved_until, status, branch_id, created_by, updated_by, promotions)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'STARTED', $20, $21, $21, $22::jsonb)`,
      [
        c.id,
        c.cartId,
        c.contactName,
        c.contactPhone,
        c.addressSnapshot === null ? null : JSON.stringify(c.addressSnapshot),
        c.fulfilmentMode,
        c.deliveryZoneId,
        c.deliverySlotId,
        c.deliveryFeePesewas.toString(),
        c.paymentTerms,
        c.taxInclusive,
        c.couponCode,
        c.discountPesewas.toString(),
        c.taxPesewas.toString(),
        c.estimatedTotalPesewas.toString(),
        c.maximumTotalPesewas.toString(),
        c.differencePreference,
        c.priceChanged,
        c.reservedUntil,
        c.branchId,
        actorId,
        JSON.stringify(c.promotions),
      ],
    );
    for (const line of lines) {
      await tx.query(
        `INSERT INTO shp.checkout_line (checkout_id, line_no, cart_line_id, product_id, qty, uom, base_qty, price_list_entry_id, unit_price_pesewas, price_basis,
                catch_weight, estimated_weight_kg, estimated_line_total_pesewas, maximum_line_total_pesewas, discount_pesewas, tax_category_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          c.id,
          line.lineNo,
          line.cartLineId,
          line.productId,
          line.qty,
          line.uom,
          line.baseQty,
          line.priceListEntryId,
          line.unitPricePesewas.toString(),
          line.priceBasis,
          line.catchWeight,
          line.estimatedWeightKg,
          line.estimatedLineTotalPesewas.toString(),
          line.maximumLineTotalPesewas.toString(),
          line.discountPesewas.toString(),
          line.taxCategoryId,
        ],
      );
    }
  }

  async checkout(tx: Transaction, id: string, lock: boolean): Promise<CheckoutRecord | null> {
    const { rows } = await tx.query<CheckoutDbRow>(
      `SELECT id, cart_id, contact_name, contact_phone_e164, address_snapshot, fulfilment_mode, delivery_zone_id, delivery_slot_id, delivery_fee_pesewas::text AS delivery_fee_pesewas,
              payment_terms, tax_inclusive, coupon_code, discount_pesewas::text AS discount_pesewas, promotions, tax_pesewas::text AS tax_pesewas,
              estimated_total_pesewas::text AS estimated_total_pesewas, maximum_total_pesewas::text AS maximum_total_pesewas, difference_preference, price_changed,
              reserved_until, order_id, status, branch_id, version
         FROM shp.checkout_session WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      cartId: row.cart_id,
      contactName: row.contact_name,
      contactPhone: row.contact_phone_e164,
      addressSnapshot: row.address_snapshot,
      fulfilmentMode: row.fulfilment_mode,
      deliveryZoneId: row.delivery_zone_id,
      deliverySlotId: row.delivery_slot_id,
      deliveryFeePesewas: BigInt(row.delivery_fee_pesewas),
      paymentTerms: row.payment_terms,
      taxInclusive: row.tax_inclusive,
      couponCode: row.coupon_code,
      discountPesewas: BigInt(row.discount_pesewas),
      promotions: row.promotions,
      taxPesewas: BigInt(row.tax_pesewas),
      estimatedTotalPesewas: BigInt(row.estimated_total_pesewas),
      maximumTotalPesewas: BigInt(row.maximum_total_pesewas),
      differencePreference: row.difference_preference,
      priceChanged: row.price_changed,
      reservedUntil: row.reserved_until,
      orderId: row.order_id,
      status: row.status,
      branchId: row.branch_id,
      version: row.version,
    };
  }

  async checkoutLines(tx: Transaction, id: string): Promise<CheckoutLineRecord[]> {
    const { rows } = await tx.query<Record<string, string | number | boolean | null>>(
      `SELECT line_no, cart_line_id, product_id, qty::text AS qty, uom, base_qty::text AS base_qty, price_list_entry_id, unit_price_pesewas::text AS unit_price_pesewas,
              price_basis, catch_weight, estimated_weight_kg::text AS estimated_weight_kg, estimated_line_total_pesewas::text AS estimated_line_total_pesewas,
              maximum_line_total_pesewas::text AS maximum_line_total_pesewas, discount_pesewas::text AS discount_pesewas, tax_category_id
         FROM shp.checkout_line WHERE checkout_id = $1 ORDER BY line_no`,
      [id],
    );
    return rows.map((row) => ({
      lineNo: row['line_no'] as number,
      cartLineId: row['cart_line_id'] as string,
      productId: row['product_id'] as string,
      qty: row['qty'] as string,
      uom: row['uom'] as string,
      baseQty: row['base_qty'] as string,
      priceListEntryId: row['price_list_entry_id'] as string,
      unitPricePesewas: BigInt(row['unit_price_pesewas'] as string),
      priceBasis: row['price_basis'] as PriceBasis,
      catchWeight: row['catch_weight'] as boolean,
      estimatedWeightKg: row['estimated_weight_kg'] as string | null,
      estimatedLineTotalPesewas: BigInt(row['estimated_line_total_pesewas'] as string),
      maximumLineTotalPesewas: BigInt(row['maximum_line_total_pesewas'] as string),
      discountPesewas: BigInt(row['discount_pesewas'] as string),
      taxCategoryId: row['tax_category_id'] as string,
    }));
  }

  async updateCheckout(tx: Transaction, id: string, c: CheckoutWrite, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE shp.checkout_session SET address_snapshot = $2::jsonb, fulfilment_mode = $3, delivery_zone_id = $4, delivery_slot_id = $5, delivery_fee_pesewas = $6,
              payment_terms = $7, tax_pesewas = $8, estimated_total_pesewas = $9, maximum_total_pesewas = $10, difference_preference = $11,
              updated_at = now(), updated_by = $12, version = version + 1
        WHERE id = $1`,
      [
        id,
        c.addressSnapshot === null ? null : JSON.stringify(c.addressSnapshot),
        c.fulfilmentMode,
        c.deliveryZoneId,
        c.deliverySlotId,
        c.deliveryFeePesewas.toString(),
        c.paymentTerms,
        c.taxPesewas.toString(),
        c.estimatedTotalPesewas.toString(),
        c.maximumTotalPesewas.toString(),
        c.differencePreference,
        actorId,
      ],
    );
  }

  async awaitPayment(tx: Transaction, id: string, orderId: string, actorId: string): Promise<void> {
    await tx.query("UPDATE shp.checkout_session SET status = 'AWAITING_PAYMENT', order_id = $2, updated_at = now(), updated_by = $3, version = version + 1 WHERE id = $1", [id, orderId, actorId]);
  }

  async endCheckout(tx: Transaction, id: string, status: 'EXPIRED' | 'CANCELLED' | 'COMPLETED', actorId: string): Promise<void> {
    await tx.query('UPDATE shp.checkout_session SET status = $2, posted_at = now(), posted_by = $3, updated_at = now(), updated_by = $3, version = version + 1 WHERE id = $1', [id, status, actorId]);
  }
}
