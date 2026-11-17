import type { Transaction } from '../../../platform/database/unit-of-work';
import type {
  CatalogueRecord,
  CatalogueStore,
  CategoryView,
  CategoryWrite,
  GradeView,
  GradeWrite,
  RowState,
  SpeciesTracking,
  SpeciesView,
  UomView,
  WeightBandView,
  WeightBandWrite,
} from '../application/catalogue-store';

/** The tables behind each record. Only these names ever reach a statement. */
const TABLE: Readonly<Record<CatalogueRecord | 'tax_category', string>> = {
  category: 'mdm.category',
  species: 'mdm.species',
  grade: 'mdm.grade',
  weight_band: 'mdm.weight_band',
  tax_category: 'mdm.tax_category',
};

/** The columns `update` may set, per record: what the contract's update schemas can change. */
const UPDATABLE: Readonly<Record<CatalogueRecord, ReadonlySet<string>>> = {
  category: new Set(['name', 'tax_category_id', 'sort_order', 'is_online_visible', 'sku_prefix']),
  species: new Set(['name']),
  grade: new Set(['name', 'description', 'sort_order']),
  weight_band: new Set(['min_kg', 'max_kg']),
};

const CATEGORY_SELECT = `
  SELECT c.id, c.parent_id, c.code, c.name, c.product_line, c.gl_group, c.sort_order, c.is_online_visible, c.sku_prefix, c.version, c.created_at, c.updated_at,
         t.id AS tax_id, t.code AS tax_code, t.name AS tax_name,
         (SELECT count(*)::int FROM mdm.product p WHERE p.category_id = c.id AND p.deleted_at IS NULL) AS product_count
    FROM mdm.category c JOIN mdm.tax_category t ON t.id = c.tax_category_id`;

const SPECIES_SELECT = `
  SELECT s.id, s.code, s.name, s.tracking_default, s.version, s.created_at, s.updated_at,
         (SELECT count(*)::int FROM mdm.grade g WHERE g.species_id = s.id AND g.deleted_at IS NULL) AS grade_count,
         (SELECT count(*)::int FROM mdm.weight_band b WHERE b.species_id = s.id AND b.deleted_at IS NULL) AS band_count
    FROM mdm.species s`;

const GRADE_SELECT = 'SELECT id, species_id, code, name, description, sort_order, version, created_at, updated_at FROM mdm.grade';
const BAND_SELECT = 'SELECT id, species_id, code, min_kg::text AS min_kg, max_kg::text AS max_kg, version, created_at, updated_at FROM mdm.weight_band';

interface Stamped {
  version: number;
  created_at: Date;
  updated_at: Date;
}

const stamps = (row: Stamped) => ({ version: row.version, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });

type CategoryRow = Stamped & {
  id: string;
  parent_id: string | null;
  code: string;
  name: string;
  product_line: CategoryView['productLine'];
  gl_group: CategoryView['glGroup'];
  sort_order: number;
  is_online_visible: boolean;
  sku_prefix: string;
  tax_id: string;
  tax_code: string;
  tax_name: string;
  product_count: number;
};

function toCategory(row: CategoryRow): CategoryView {
  return {
    id: row.id,
    parentId: row.parent_id,
    code: row.code,
    name: row.name,
    productLine: row.product_line,
    glGroup: row.gl_group,
    taxCategory: { id: row.tax_id, code: row.tax_code, name: row.tax_name },
    sortOrder: row.sort_order,
    isOnlineVisible: row.is_online_visible,
    skuPrefix: row.sku_prefix,
    productCount: row.product_count,
    ...stamps(row),
  };
}

type SpeciesRow = Stamped & { id: string; code: string; name: string; tracking_default: SpeciesTracking; grade_count: number; band_count: number };

function toSpecies(row: SpeciesRow): SpeciesView {
  return { id: row.id, code: row.code, name: row.name, trackingDefault: row.tracking_default, gradeCount: row.grade_count, weightBandCount: row.band_count, ...stamps(row) };
}

type GradeRow = Stamped & { id: string; species_id: string; code: string; name: string; description: string | null; sort_order: number };

function toGrade(row: GradeRow): GradeView {
  return { id: row.id, speciesId: row.species_id, code: row.code, name: row.name, description: row.description, sortOrder: row.sort_order, ...stamps(row) };
}

type BandRow = Stamped & { id: string; species_id: string; code: string; min_kg: string; max_kg: string };

function toBand(row: BandRow): WeightBandView {
  return { id: row.id, speciesId: row.species_id, code: row.code, minKg: row.min_kg, maxKg: row.max_kg, ...stamps(row) };
}

/** Live rows after the cursor, optionally of one species, in creation order. */
function page(alias: string, speciesId: string | undefined, afterId: string | null, limit: number): { where: string; values: unknown[] } {
  const clauses = [`${alias}deleted_at IS NULL`];
  const values: unknown[] = [];
  if (speciesId !== undefined) {
    values.push(speciesId);
    clauses.push(`${alias}species_id = $${values.length}`);
  }
  if (afterId !== null) {
    values.push(afterId);
    clauses.push(`${alias}id > $${values.length}`);
  }
  values.push(limit);
  return { where: ` WHERE ${clauses.join(' AND ')} ORDER BY ${alias}id LIMIT $${values.length}`, values };
}

/** MDM's catalogue administration tables in plain SQL; reads join only MDM's own tables. */
export class PgCatalogueStore implements CatalogueStore {
  async lock(tx: Transaction, record: CatalogueRecord, id: string): Promise<RowState | null> {
    const { rows } = await tx.query<{ version: number; archived: boolean }>(`SELECT version, deleted_at IS NOT NULL AS archived FROM ${TABLE[record]} WHERE id = $1 FOR UPDATE`, [id]);
    return rows[0] ?? null;
  }

  async update(tx: Transaction, record: CatalogueRecord, id: string, expectedVersion: number, columns: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean> {
    const names = Object.keys(columns);
    for (const name of names) {
      if (!UPDATABLE[record].has(name)) {
        throw new Error(`${record}.${name} is not an updatable column`);
      }
    }
    const sets = names.map((name, index) => `${name} = $${index + 4}`);
    const result = await tx.query(
      `UPDATE ${TABLE[record]} SET ${[...sets, 'version = version + 1', 'updated_at = now()', 'updated_by = $3'].join(', ')}
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL`,
      [id, expectedVersion, actorId, ...names.map((name) => columns[name])],
    );
    return result.rowCount === 1;
  }

  async archive(tx: Transaction, record: CatalogueRecord, id: string, expectedVersion: number, reason: string, actorId: string, now: Date): Promise<boolean> {
    const result = await tx.query(
      `UPDATE ${TABLE[record]} SET deleted_at = $4, deleted_by = $3, delete_reason = $5, version = version + 1, updated_at = $4, updated_by = $3
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL`,
      [id, expectedVersion, actorId, now, reason],
    );
    return result.rowCount === 1;
  }

  async isLive(tx: Transaction, record: CatalogueRecord | 'tax_category', id: string): Promise<boolean> {
    const { rows } = await tx.query(`SELECT 1 FROM ${TABLE[record]} WHERE id = $1 AND deleted_at IS NULL`, [id]);
    return rows.length === 1;
  }

  async category(tx: Transaction, id: string): Promise<CategoryView | null> {
    const { rows } = await tx.query<CategoryRow>(`${CATEGORY_SELECT} WHERE c.id = $1`, [id]);
    return rows[0] === undefined ? null : toCategory(rows[0]);
  }

  async categories(tx: Transaction, afterId: string | null, limit: number): Promise<CategoryView[]> {
    const { where, values } = page('c.', undefined, afterId, limit);
    const { rows } = await tx.query<CategoryRow>(CATEGORY_SELECT + where, values);
    return rows.map(toCategory);
  }

  async insertCategory(tx: Transaction, id: string, w: CategoryWrite, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO mdm.category (id, parent_id, code, name, product_line, gl_group, tax_category_id, sort_order, is_online_visible, sku_prefix, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
      [id, w.parentId, w.code, w.name, w.productLine, w.glGroup, w.taxCategoryId, w.sortOrder, w.isOnlineVisible, w.skuPrefix, actorId],
    );
  }

  async categoryUsage(tx: Transaction, id: string): Promise<{ readonly liveProducts: number; readonly liveChildren: number }> {
    const { rows } = await tx.query<{ products: number; children: number }>(
      `SELECT (SELECT count(*)::int FROM mdm.product WHERE category_id = $1 AND deleted_at IS NULL) AS products,
              (SELECT count(*)::int FROM mdm.category WHERE parent_id = $1 AND deleted_at IS NULL) AS children`,
      [id],
    );
    return { liveProducts: rows[0]!.products, liveChildren: rows[0]!.children };
  }

  async siblingNameTaken(tx: Transaction, parentId: string | null, name: string, exceptId: string | null): Promise<boolean> {
    const { rows } = await tx.query(
      `SELECT 1 FROM mdm.category WHERE parent_id IS NOT DISTINCT FROM $1 AND lower(btrim(name)) = lower(btrim($2)) AND deleted_at IS NULL AND id IS DISTINCT FROM $3`,
      [parentId, name, exceptId],
    );
    return rows.length > 0;
  }

  async codeTaken(tx: Transaction, record: 'category' | 'species', code: string): Promise<boolean> {
    const { rows } = await tx.query(`SELECT 1 FROM ${TABLE[record]} WHERE code = $1 AND deleted_at IS NULL`, [code]);
    return rows.length > 0;
  }

  async units(tx: Transaction, afterCode: string | null, limit: number): Promise<UomView[]> {
    const { rows } = await tx.query<{ code: string; name: string; kind: UomView['kind']; display_decimals: number }>(
      'SELECT code, name, kind, display_decimals FROM mdm.uom WHERE $1::text IS NULL OR code > $1 ORDER BY code LIMIT $2',
      [afterCode, limit],
    );
    return rows.map((row) => ({ code: row.code, name: row.name, kind: row.kind, displayDecimals: row.display_decimals }));
  }

  async species(tx: Transaction, id: string): Promise<SpeciesView | null> {
    const { rows } = await tx.query<SpeciesRow>(`${SPECIES_SELECT} WHERE s.id = $1`, [id]);
    return rows[0] === undefined ? null : toSpecies(rows[0]);
  }

  async speciesList(tx: Transaction, afterId: string | null, limit: number): Promise<SpeciesView[]> {
    const { where, values } = page('s.', undefined, afterId, limit);
    const { rows } = await tx.query<SpeciesRow>(SPECIES_SELECT + where, values);
    return rows.map(toSpecies);
  }

  async insertSpecies(tx: Transaction, id: string, w: { readonly code: string; readonly name: string; readonly trackingDefault: SpeciesTracking }, actorId: string): Promise<void> {
    await tx.query('INSERT INTO mdm.species (id, code, name, tracking_default, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5)', [id, w.code, w.name, w.trackingDefault, actorId]);
  }

  async grade(tx: Transaction, id: string): Promise<GradeView | null> {
    const { rows } = await tx.query<GradeRow>(`${GRADE_SELECT} WHERE id = $1`, [id]);
    return rows[0] === undefined ? null : toGrade(rows[0]);
  }

  async grades(tx: Transaction, speciesId: string | undefined, afterId: string | null, limit: number): Promise<GradeView[]> {
    const { where, values } = page('', speciesId, afterId, limit);
    const { rows } = await tx.query<GradeRow>(GRADE_SELECT + where, values);
    return rows.map(toGrade);
  }

  async insertGrade(tx: Transaction, id: string, w: GradeWrite, actorId: string): Promise<void> {
    await tx.query(
      'INSERT INTO mdm.grade (id, species_id, code, name, description, sort_order, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)',
      [id, w.speciesId, w.code, w.name, w.description, w.sortOrder, actorId],
    );
  }

  async gradeCodeTaken(tx: Transaction, speciesId: string, code: string): Promise<boolean> {
    const { rows } = await tx.query('SELECT 1 FROM mdm.grade WHERE species_id = $1 AND code = $2 AND deleted_at IS NULL', [speciesId, code]);
    return rows.length > 0;
  }

  async weightBand(tx: Transaction, id: string): Promise<WeightBandView | null> {
    const { rows } = await tx.query<BandRow>(`${BAND_SELECT} WHERE id = $1`, [id]);
    return rows[0] === undefined ? null : toBand(rows[0]);
  }

  async weightBands(tx: Transaction, speciesId: string | undefined, afterId: string | null, limit: number): Promise<WeightBandView[]> {
    const { where, values } = page('', speciesId, afterId, limit);
    const { rows } = await tx.query<BandRow>(BAND_SELECT + where, values);
    return rows.map(toBand);
  }

  async insertWeightBand(tx: Transaction, id: string, w: WeightBandWrite, actorId: string): Promise<void> {
    await tx.query('INSERT INTO mdm.weight_band (id, species_id, code, min_kg, max_kg, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)', [
      id,
      w.speciesId,
      w.code,
      w.minKg,
      w.maxKg,
      actorId,
    ]);
  }

  async weightBandCodeTaken(tx: Transaction, speciesId: string, code: string): Promise<boolean> {
    const { rows } = await tx.query('SELECT 1 FROM mdm.weight_band WHERE species_id = $1 AND code = $2 AND deleted_at IS NULL', [speciesId, code]);
    return rows.length > 0;
  }

  async overlappingBands(tx: Transaction, speciesId: string, minKg: string, maxKg: string, exceptId: string | null): Promise<string[]> {
    const { rows } = await tx.query<{ code: string }>(
      `SELECT code FROM mdm.weight_band
        WHERE species_id = $1 AND deleted_at IS NULL AND id IS DISTINCT FROM $4
          AND numrange(min_kg, max_kg, '[)') && numrange($2::numeric, $3::numeric, '[)')
        ORDER BY min_kg`,
      [speciesId, minKg, maxKg, exceptId],
    );
    return rows.map((row) => row.code);
  }

  async livePriceUses(tx: Transaction, record: 'grade' | 'weight_band', id: string): Promise<number> {
    const column = record === 'grade' ? 'grade_id' : 'weight_band_id';
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM mdm.price_list_entry e JOIN mdm.price_list_version v ON v.id = e.version_id
        WHERE e.${column} = $1 AND v.status IN ('PENDING_APPROVAL', 'ACTIVE')`,
      [id],
    );
    return rows[0]!.n;
  }
}
