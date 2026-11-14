import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { GlGroup, ProductDefinition, ProductDraft, ProductReferences, UomKind } from '../domain/product';
import type { ProductListFilter, ProductStore, ProductView, UniqueProductField } from '../application/product-store';
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

function toView(row: ViewRow): ProductView {
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
    images: [],
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
  async references(tx: Transaction, draft: ProductDraft): Promise<ProductReferences> {
    const [categoryRow] = await tx.db
      .select({ id: category.id, glGroup: category.glGroup, taxCategoryId: category.taxCategoryId })
      .from(category)
      .where(and(eq(category.id, draft.categoryId), isNull(category.deletedAt)));
    const speciesRows =
      draft.speciesId === undefined
        ? []
        : await tx.db.select({ id: species.id }).from(species).where(and(eq(species.id, draft.speciesId), isNull(species.deletedAt)));
    const taxRows =
      draft.taxCategoryId === undefined
        ? []
        : await tx.db.select({ id: taxCategory.id }).from(taxCategory).where(and(eq(taxCategory.id, draft.taxCategoryId), isNull(taxCategory.deletedAt)));
    const units = await tx.db.select({ code: uom.code, kind: uom.kind }).from(uom).where(inArray(uom.code, [draft.baseUom, draft.saleUom]));
    return {
      category: categoryRow === undefined ? null : { id: categoryRow.id, glGroup: categoryRow.glGroup as GlGroup, taxCategoryId: categoryRow.taxCategoryId },
      speciesFound: speciesRows.length === 1,
      taxCategoryFound: taxRows.length === 1,
      units: new Map(units.map((unit) => [unit.code, unit.kind as UomKind])),
    };
  }

  async takenValues(tx: Transaction, definition: ProductDefinition): Promise<UniqueProductField[]> {
    const clauses: SQL[] = [eq(product.sku, definition.sku)];
    if (definition.barcode !== null) clauses.push(eq(product.barcode, definition.barcode));
    if (definition.seoSlug !== null) clauses.push(eq(product.seoSlug, definition.seoSlug));
    const rows = await tx.db
      .select({ sku: product.sku, barcode: product.barcode, seoSlug: product.seoSlug })
      .from(product)
      .where(and(isNull(product.deletedAt), or(...clauses)));
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

  async view(tx: Transaction, id: string): Promise<ProductView | null> {
    const rows = await this.select(tx, and(eq(product.id, id), isNull(product.deletedAt))!, 1);
    return rows[0] ?? null;
  }

  async list(tx: Transaction, filter: ProductListFilter, beforeId: string | null, limit: number): Promise<ProductView[]> {
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
    if (beforeId !== null) clauses.push(lt(product.id, beforeId));
    return this.select(tx, and(...clauses)!, limit);
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
    return rows.map(toView);
  }
}
