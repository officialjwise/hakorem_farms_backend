import { and, desc, eq, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { keysetComparisons, orderByOf, type SortOrder } from '../../../platform/http/keyset-sort';
import { alias } from 'drizzle-orm/pg-core';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { GlGroup, ProductDefinition, ProductDraft, ProductReferences, UomKind } from '../domain/product';
import type { FileStore } from '../../../platform/storage/file-store';
import { galleryVariants } from '../domain/product-images';
import type { ProductImageRow, ProductImageView, ProductListFilter, ProductStore, ProductView, UniqueProductField } from '../application/product-store';
import { category, product, species, taxCategory, uom } from './tables';

const speciesRef = alias(species, 'species_ref');

/** The columns a `ProductView` is built from, joined within MDM's own schema. */
const VIEW_COLUMNS = {
  product,
  categoryCode: category.code,
  categoryName: category.name,
  speciesCode: speciesRef.code,
  speciesName: speciesRef.name,
  taxCategoryCode: taxCategory.code,
  taxCategoryName: taxCategory.name,
};

type ViewRow = {
  product: typeof product.$inferSelect;
  categoryCode: string;
  categoryName: string;
  speciesCode: string | null;
  speciesName: string | null;
  taxCategoryCode: string;
  taxCategoryName: string;
};

/** "10.0000" -> "10.00", "7.5000" -> "7.50", "2.1250" -> "2.125": at least two places, no trailing zeros beyond. */
function percent(text: string): string {
  const [whole, fraction = ''] = text.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return `${whole}.${trimmed.padEnd(2, '0')}`;
}

function toView(row: ViewRow, images: readonly ProductImageView[]): ProductView {
  const p = row.product;
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    category: { id: p.categoryId, code: row.categoryCode, name: row.categoryName },
    stockPolicy: p.stockPolicy as ProductView['stockPolicy'],
    tracking: p.tracking as ProductView['tracking'],
    species: p.speciesId === null || row.speciesCode === null ? null : { id: p.speciesId, code: row.speciesCode, name: row.speciesName ?? '' },
    baseUom: p.baseUom,
    saleUom: p.saleUom,
    nominalPackKg: p.nominalPackKg,
    weightTolerancePercent: percent(p.weightTolerancePercent),
    taxCategory: { id: p.taxCategoryId, code: row.taxCategoryCode, name: row.taxCategoryName },
    glGroup: p.glGroup,
    shelfLifeDays: p.shelfLifeDays,
    storageTempClass: p.storageTempClass as ProductView['storageTempClass'],
    withdrawalDays: p.withdrawalDays,
    barcode: p.barcode,
    description: p.description,
    onlineMode: p.onlineMode as ProductView['onlineMode'],
    seo: { slug: p.seoSlug, title: p.seoTitle, description: p.seoDescription },
    isPurchasable: p.isPurchasable,
    isSellable: p.isSellable,
    status: p.status as ProductView['status'],
    images,
    version: p.version,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** Escapes LIKE wildcards so a search for "50%" matches the text, not everything. */
function likePrefix(text: string): string {
  return `${text.toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * MDM's product store in Drizzle (ADR-0030: SQL stays visible; the migration is the schema). Reads join only MDM's
 * own tables. Every statement runs on the caller's transaction connection.
 */
export class DrizzleProductStore implements ProductStore {
  /** The file store, for the public variants of each photograph: read through platform, never by a join (ADR-0045). */
  constructor(private readonly files: FileStore) {}

  async liveImages(tx: Transaction, productId: string): Promise<ProductImageRow[]> {
    const { rows } = await tx.query<{ id: string; file_id: string; alt_text: string; sort_order: number }>(
      'SELECT id, file_id, alt_text, sort_order FROM mdm.product_image WHERE product_id = $1 AND deleted_at IS NULL ORDER BY sort_order, id',
      [productId],
    );
    return rows.map((row) => ({ id: row.id, fileId: row.file_id, altText: row.alt_text, sortOrder: row.sort_order }));
  }

  async insertImage(tx: Transaction, productId: string, image: ProductImageRow, actorId: string, now: Date): Promise<void> {
    await tx.query(
      `INSERT INTO mdm.product_image (id, product_id, file_id, alt_text, sort_order, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $7)`,
      [image.id, productId, image.fileId, image.altText, image.sortOrder, now, actorId],
    );
  }

  async removeImage(tx: Transaction, productId: string, imageId: string, reason: string, actorId: string, now: Date): Promise<boolean> {
    const result = await tx.query(
      `UPDATE mdm.product_image SET deleted_at = $5, deleted_by = $4, delete_reason = $3, updated_at = $5, updated_by = $4, version = version + 1
        WHERE id = $2 AND product_id = $1 AND deleted_at IS NULL`,
      [productId, imageId, reason, actorId, now],
    );
    return result.rowCount === 1;
  }

  /** Each product's gallery, with the variants the file store has published. */
  private async galleries(tx: Transaction, productIds: readonly string[]): Promise<Map<string, ProductImageView[]>> {
    const galleries = new Map<string, ProductImageView[]>(productIds.map((id) => [id, []]));
    if (productIds.length === 0) return galleries;
    const { rows } = await tx.query<{ id: string; product_id: string; file_id: string; alt_text: string; sort_order: number }>(
      `SELECT id, product_id, file_id, alt_text, sort_order FROM mdm.product_image
        WHERE product_id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY product_id, sort_order, id`,
      [productIds],
    );
    const variants = await this.files.publicVariants(tx, [...new Set(rows.map((row) => row.file_id))]);
    for (const row of rows) {
      galleries.get(row.product_id)!.push({
        id: row.id,
        fileId: row.file_id,
        altText: row.alt_text,
        sortOrder: row.sort_order,
        variants: galleryVariants(variants.get(row.file_id) ?? []),
      });
    }
    return galleries;
  }

  async references(tx: Transaction, draft: ProductDraft): Promise<ProductReferences> {
    const [categoryRow] = await tx.db
      .select({ id: category.id, glGroup: category.glGroup, taxCategoryId: category.taxCategoryId })
      .from(category)
      .where(and(eq(category.id, draft.categoryId), isNull(category.deletedAt)));
    const speciesRows =
      draft.speciesId === undefined
        ? []
        : await tx.db.select({ id: species.id, trackingDefault: species.trackingDefault }).from(species).where(and(eq(species.id, draft.speciesId), isNull(species.deletedAt)));
    const taxRows =
      draft.taxCategoryId === undefined
        ? []
        : await tx.db.select({ id: taxCategory.id }).from(taxCategory).where(and(eq(taxCategory.id, draft.taxCategoryId), isNull(taxCategory.deletedAt)));
    const units = await tx.db.select({ code: uom.code, kind: uom.kind }).from(uom).where(inArray(uom.code, [draft.baseUom, draft.saleUom]));
    return {
      category: categoryRow === undefined ? null : { id: categoryRow.id, glGroup: categoryRow.glGroup as GlGroup, taxCategoryId: categoryRow.taxCategoryId },
      speciesFound: speciesRows.length === 1,
      speciesTrackingDefault: speciesRows[0]?.trackingDefault as 'SERIAL' | 'LOT' | undefined,
      taxCategoryFound: taxRows.length === 1,
      units: new Map(units.map((unit) => [unit.code, unit.kind as UomKind])),
    };
  }

  async takenValues(tx: Transaction, definition: ProductDefinition, exceptId?: string): Promise<UniqueProductField[]> {
    const clauses: SQL[] = [eq(product.sku, definition.sku)];
    if (definition.barcode !== null) clauses.push(eq(product.barcode, definition.barcode));
    if (definition.seoSlug !== null) clauses.push(eq(product.seoSlug, definition.seoSlug));
    const rows = await tx.db
      .select({ sku: product.sku, barcode: product.barcode, seoSlug: product.seoSlug })
      .from(product)
      .where(and(isNull(product.deletedAt), or(...clauses), exceptId === undefined ? undefined : ne(product.id, exceptId)));
    const taken = new Set<UniqueProductField>();
    for (const row of rows) {
      if (row.sku === definition.sku) taken.add('sku');
      if (definition.barcode !== null && row.barcode === definition.barcode) taken.add('barcode');
      if (definition.seoSlug !== null && row.seoSlug === definition.seoSlug) taken.add('seoSlug');
    }
    return (['sku', 'barcode', 'seoSlug'] as const).filter((field) => taken.has(field));
  }

  async insert(tx: Transaction, id: string, d: ProductDefinition, actorId: string, now: Date): Promise<void> {
    await tx.db.insert(product).values({
      id,
      sku: d.sku,
      name: d.name,
      categoryId: d.categoryId,
      stockPolicy: d.stockPolicy,
      tracking: d.tracking,
      speciesId: d.speciesId,
      baseUom: d.baseUom,
      saleUom: d.saleUom,
      nominalPackKg: d.nominalPackKg,
      weightTolerancePercent: d.weightTolerancePercent,
      taxCategoryId: d.taxCategoryId,
      glGroup: d.glGroup,
      shelfLifeDays: d.shelfLifeDays,
      storageTempClass: d.storageTempClass,
      withdrawalDays: d.withdrawalDays,
      barcode: d.barcode,
      description: d.description,
      onlineMode: d.onlineMode,
      seoSlug: d.seoSlug,
      seoTitle: d.seoTitle,
      seoDescription: d.seoDescription,
      isPurchasable: d.isPurchasable,
      isSellable: d.isSellable,
      status: d.status,
      version: 1,
      createdAt: now,
      createdBy: actorId,
      updatedAt: now,
      updatedBy: actorId,
    });
  }

  async lock(tx: Transaction, id: string): Promise<boolean> {
    const { rows } = await tx.query('SELECT 1 FROM mdm.product WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
    return rows.length === 1;
  }

  async update(tx: Transaction, id: string, expectedVersion: number, d: ProductDefinition, actorId: string, now: Date): Promise<boolean> {
    const updated = await tx.db
      .update(product)
      .set({
        name: d.name,
        categoryId: d.categoryId,
        nominalPackKg: d.nominalPackKg,
        weightTolerancePercent: d.weightTolerancePercent,
        taxCategoryId: d.taxCategoryId,
        glGroup: d.glGroup,
        shelfLifeDays: d.shelfLifeDays,
        barcode: d.barcode,
        description: d.description,
        onlineMode: d.onlineMode,
        seoSlug: d.seoSlug,
        seoTitle: d.seoTitle,
        seoDescription: d.seoDescription,
        isPurchasable: d.isPurchasable,
        isSellable: d.isSellable,
        status: d.status,
        version: expectedVersion + 1,
        updatedAt: now,
        updatedBy: actorId,
      })
      .where(and(eq(product.id, id), eq(product.version, expectedVersion), isNull(product.deletedAt)))
      .returning({ id: product.id });
    return updated.length === 1;
  }

  async view(tx: Transaction, id: string): Promise<ProductView | null> {
    const rows = await this.select(tx, and(eq(product.id, id), isNull(product.deletedAt))!, 1);
    return rows[0] ?? null;
  }

  async viewAny(tx: Transaction, id: string): Promise<ProductView | null> {
    const rows = await this.select(tx, eq(product.id, id), 1);
    return rows[0] ?? null;
  }

  async lockedVersion(tx: Transaction, id: string): Promise<number | null> {
    const { rows } = await tx.query<{ version: number }>('SELECT version FROM mdm.product WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
    return rows[0]?.version ?? null;
  }

  async archive(tx: Transaction, id: string, expectedVersion: number, reason: string, actorId: string, now: Date): Promise<boolean> {
    const result = await tx.query(
      `UPDATE mdm.product SET deleted_at = $4, deleted_by = $3, delete_reason = $5, version = version + 1, updated_at = $4, updated_by = $3
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL`,
      [id, expectedVersion, actorId, now, reason],
    );
    return result.rowCount === 1;
  }

  async livePriceUses(tx: Transaction, id: string): Promise<number> {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM mdm.price_list_entry e JOIN mdm.price_list_version v ON v.id = e.version_id
        WHERE e.product_id = $1 AND v.status IN ('PENDING_APPROVAL', 'ACTIVE')`,
      [id],
    );
    return rows[0]!.n;
  }

  async list(tx: Transaction, filter: ProductListFilter, beforeId: string | null, limit: number): Promise<ProductView[]> {
    const clauses = filterClauses(filter);
    if (beforeId !== null) clauses.push(lt(product.id, beforeId));
    return this.select(tx, and(...clauses)!, limit);
  }

  async listSorted(tx: Transaction, filter: ProductListFilter, order: SortOrder, position: readonly string[] | null, limit: number) {
    const clauses = filterClauses(filter);
    if (position !== null) clauses.push(keysetAfter(order, position));
    const keys = Object.fromEntries(order.keys.map((key, index) => [`sortKey${index}`, sql<string>`(${sql.raw(key.expression)})::text`]));
    const rows = (await tx.db
      .select({ ...VIEW_COLUMNS, ...keys })
      .from(product)
      .innerJoin(category, eq(category.id, product.categoryId))
      .innerJoin(taxCategory, eq(taxCategory.id, product.taxCategoryId))
      .leftJoin(speciesRef, eq(speciesRef.id, product.speciesId))
      .where(and(...clauses))
      .orderBy(sql.raw(orderByOf(order)))
      .limit(limit)) as unknown as Array<ViewRow & Record<string, unknown>>;
    const galleries = await this.galleries(tx, rows.map((row) => row.product.id));
    return rows.map((row) => ({ view: toView(row, galleries.get(row.product.id)!), position: order.keys.map((_key, index) => String(row[`sortKey${index}`])) }));
  }

  private async select(tx: Transaction, where: SQL, limit: number): Promise<ProductView[]> {
    const rows = await tx.db
      .select(VIEW_COLUMNS)
      .from(product)
      .innerJoin(category, eq(category.id, product.categoryId))
      .innerJoin(taxCategory, eq(taxCategory.id, product.taxCategoryId))
      .leftJoin(speciesRef, eq(speciesRef.id, product.speciesId))
      .where(where)
      .orderBy(desc(product.id))
      .limit(limit);
    const galleries = await this.galleries(tx, rows.map((row) => row.product.id));
    return rows.map((row) => toView(row, galleries.get(row.product.id)!));
  }
}

/** The list's filters, combined with AND (docs/API.md section 6), live products only. */
function filterClauses(filter: ProductListFilter): SQL[] {
  const clauses: SQL[] = [isNull(product.deletedAt)];
  if (filter.categoryId !== undefined) clauses.push(eq(product.categoryId, filter.categoryId));
  if (filter.stockPolicy !== undefined) clauses.push(eq(product.stockPolicy, filter.stockPolicy));
  if (filter.onlineMode !== undefined) clauses.push(eq(product.onlineMode, filter.onlineMode));
  if (filter.status !== undefined) clauses.push(eq(product.status, filter.status));
  if (filter.barcode !== undefined) clauses.push(eq(product.barcode, filter.barcode));
  if (filter.q !== undefined) {
    // "Matches the start of words, case-insensitive" (docs/API.md section 6), on name and SKU.
    const prefix = likePrefix(filter.q);
    clauses.push(
      or(
        sql`lower(${product.name}) LIKE ${prefix} ESCAPE '\\'`,
        sql`lower(${product.name}) LIKE ${`% ${prefix}`} ESCAPE '\\'`,
        sql`lower(${product.sku}) LIKE ${prefix} ESCAPE '\\'`,
      )!,
    );
  }
  return clauses;
}

/** The rows strictly after the cursor's position in `order`: the shared keyset condition, in Drizzle's parameters. */
function keysetAfter(order: SortOrder, position: readonly string[]): SQL {
  return or(
    ...keysetComparisons(order).map((all) => and(...all.map((c) => sql`${sql.raw(c.key.expression)} ${sql.raw(c.operator)} ${position[c.index]}::${sql.raw(c.key.type)}`))),
  )!;
}
