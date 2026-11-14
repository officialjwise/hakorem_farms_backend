import { randomUUID } from 'node:crypto';
import type { TestDatabase } from './test-database';
import { SYSTEM_PRINCIPAL } from './iam';

/** The seven tax categories migration 0009 seeds, by code. */
export const TAX_CATEGORY = {
  LIVE_ANIMALS: '01900000-0000-7000-8000-000000000201',
  RAW_PRODUCE: '01900000-0000-7000-8000-000000000202',
  EGGS: '01900000-0000-7000-8000-000000000203',
  PROCESSED_MEAT: '01900000-0000-7000-8000-000000000204',
  DELIVERY_SERVICE: '01900000-0000-7000-8000-000000000206',
} as const;

export interface TestCatalogue {
  readonly liveCategoryId: string;
  readonly meatCategoryId: string;
  readonly eggsCategoryId: string;
  readonly goatSpeciesId: string;
}

/** Categories and a species, as the seeded farm has them, for tests that create products. */
export async function createCatalogue(database: TestDatabase): Promise<TestCatalogue> {
  const app = database.pool('app');
  const liveCategoryId = randomUUID();
  const meatCategoryId = randomUUID();
  const eggsCategoryId = randomUUID();
  const goatSpeciesId = randomUUID();
  await app.query(
    `INSERT INTO mdm.category (id, code, name, product_line, gl_group, tax_category_id, created_by, updated_by) VALUES
       ($1, 'LIVE', 'Live animals', 'LIVE', 'LIVE_ANIMALS', $4, $7, $7),
       ($2, 'MEAT', 'Meat', 'MEAT', 'MEAT', $5, $7, $7),
       ($3, 'EGGS', 'Eggs', 'PRODUCE', 'PRODUCE_EGGS', $6, $7, $7)`,
    [liveCategoryId, meatCategoryId, eggsCategoryId, TAX_CATEGORY.LIVE_ANIMALS, TAX_CATEGORY.PROCESSED_MEAT, TAX_CATEGORY.EGGS, SYSTEM_PRINCIPAL],
  );
  await app.query("INSERT INTO mdm.species (id, code, name, tracking_default, created_by, updated_by) VALUES ($1, 'GOAT', 'Goat', 'SERIAL', $2, $2)", [
    goatSpeciesId,
    SYSTEM_PRINCIPAL,
  ]);
  return { liveCategoryId, meatCategoryId, eggsCategoryId, goatSpeciesId };
}
