import { boolean, integer, numeric, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle definitions of the MDM tables the code reads and writes. They mirror migrations/0003 and 0009, which are
 * the source of truth: the SQL creates, constrains and grants; these only describe. Relations across schemas are
 * never declared here (ADR-0011).
 */
export const mdm = pgSchema('mdm');

const auditColumns = {
  version: integer('version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdBy: uuid('created_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  updatedBy: uuid('updated_by').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: uuid('deleted_by'),
  deleteReason: text('delete_reason'),
};

export const branch = mdm.table('branch', {
  id: uuid('id').primaryKey(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  ...auditColumns,
});

export const location = mdm.table('location', {
  id: uuid('id').primaryKey(),
  branchId: uuid('branch_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  ...auditColumns,
});

export const uom = mdm.table('uom', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
});

export const taxCategory = mdm.table('tax_category', {
  id: uuid('id').primaryKey(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  ...auditColumns,
});

export const category = mdm.table('category', {
  id: uuid('id').primaryKey(),
  parentId: uuid('parent_id'),
  code: text('code').notNull(),
  name: text('name').notNull(),
  productLine: text('product_line').notNull(),
  glGroup: text('gl_group').notNull(),
  taxCategoryId: uuid('tax_category_id').notNull(),
  ...auditColumns,
});

export const species = mdm.table('species', {
  id: uuid('id').primaryKey(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  trackingDefault: text('tracking_default').notNull(),
  ...auditColumns,
});

export const product = mdm.table('product', {
  id: uuid('id').primaryKey(),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  categoryId: uuid('category_id').notNull(),
  stockPolicy: text('stock_policy').notNull(),
  tracking: text('tracking').notNull(),
  speciesId: uuid('species_id'),
  baseUom: text('base_uom').notNull(),
  saleUom: text('sale_uom').notNull(),
  /** platform.kg: NUMERIC(10,3), read and written as a decimal string, never a float. */
  nominalPackKg: numeric('nominal_pack_kg', { precision: 10, scale: 3 }),
  /** platform.percent: NUMERIC(7,4). */
  weightTolerancePercent: numeric('weight_tolerance_percent', { precision: 7, scale: 4 }).notNull(),
  taxCategoryId: uuid('tax_category_id').notNull(),
  glGroup: text('gl_group').notNull(),
  shelfLifeDays: integer('shelf_life_days'),
  storageTempClass: text('storage_temp_class'),
  withdrawalDays: integer('withdrawal_days'),
  barcode: text('barcode'),
  description: text('description'),
  onlineMode: text('online_mode').notNull(),
  seoSlug: text('seo_slug'),
  seoTitle: text('seo_title'),
  seoDescription: text('seo_description'),
  isPurchasable: boolean('is_purchasable').notNull(),
  isSellable: boolean('is_sellable').notNull(),
  status: text('status').notNull(),
  ...auditColumns,
});
