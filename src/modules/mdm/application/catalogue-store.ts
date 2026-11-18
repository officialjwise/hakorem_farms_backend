import type { Transaction } from '../../../platform/database/unit-of-work';
import type { GlGroup, UomKind } from '../domain/product';

export type ProductLine = 'LIVE' | 'MEAT' | 'PRODUCE' | 'BY_PRODUCT' | 'FEED' | 'SUPPLY' | 'SERVICE';
export type SpeciesTracking = 'SERIAL' | 'LOT';

/** The contract's `Category`. `productCount` counts the live products directly in it. */
export interface CategoryView {
  readonly id: string;
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly productLine: ProductLine;
  readonly glGroup: GlGroup;
  readonly taxCategory: { readonly id: string; readonly code: string; readonly name: string };
  readonly sortOrder: number;
  readonly isOnlineVisible: boolean;
  /** The prefix of the SKUs the server gives its products (B09q, ADR-0072). */
  readonly skuPrefix: string;
  readonly productCount: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The contract's `Uom`, with CR-003's `displayDecimals`. */
export interface UomView {
  readonly code: string;
  readonly name: string;
  /** B09u: the unit's name for one ("egg", "crate") and for many ("eggs", "crates"), lowercase, for a sentence. */
  readonly singularName: string;
  readonly pluralName: string;
  readonly kind: UomKind;
  readonly displayDecimals: number;
}

/** The contract's `Species`; the counts are of live grades and bands. */
export interface SpeciesView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly trackingDefault: SpeciesTracking;
  readonly gradeCount: number;
  readonly weightBandCount: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The contract's `Grade`. */
export interface GradeView {
  readonly id: string;
  readonly speciesId: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly sortOrder: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The contract's `WeightBand`: `[minKg, maxKg)`. */
export interface WeightBandView {
  readonly id: string;
  readonly speciesId: string;
  readonly code: string;
  readonly minKg: string;
  readonly maxKg: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A record the catalogue administration keeps, with its row state. */
export type CatalogueRecord = 'category' | 'species' | 'grade' | 'weight_band';

export interface RowState {
  readonly version: number;
  readonly archived: boolean;
}

export interface CategoryWrite {
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly productLine: ProductLine;
  readonly glGroup: GlGroup;
  readonly taxCategoryId: string;
  readonly sortOrder: number;
  readonly isOnlineVisible: boolean;
  /** Null takes the database's default: the first three letters of the code (migration 0210). */
  readonly skuPrefix: string | null;
}

export interface GradeWrite {
  readonly speciesId: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly sortOrder: number;
}

export interface WeightBandWrite {
  readonly speciesId: string;
  readonly code: string;
  readonly minKg: string;
  readonly maxKg: string;
}

/**
 * MDM's category, unit, species, grade and weight band tables, each call in the caller's transaction. Lists return
 * live rows in creation order (UUIDv7), `afterId` exclusive; a get also returns an archived row, whose history stays
 * readable.
 */
export interface CatalogueStore {
  /** Locks the row for the rest of the transaction and returns its state; null when there is no such row. */
  lock(tx: Transaction, record: CatalogueRecord, id: string): Promise<RowState | null>;
  /** Sets the columns given (snake_case names of the record's own table) if the row is at `expectedVersion`. */
  update(tx: Transaction, record: CatalogueRecord, id: string, expectedVersion: number, columns: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean>;
  archive(tx: Transaction, record: CatalogueRecord, id: string, expectedVersion: number, reason: string, actorId: string, now: Date): Promise<boolean>;
  /** Whether a live row of `record` has this id. */
  isLive(tx: Transaction, record: CatalogueRecord | 'tax_category', id: string): Promise<boolean>;

  category(tx: Transaction, id: string): Promise<CategoryView | null>;
  categories(tx: Transaction, afterId: string | null, limit: number): Promise<CategoryView[]>;
  insertCategory(tx: Transaction, id: string, write: CategoryWrite, actorId: string): Promise<void>;
  categoryUsage(tx: Transaction, id: string): Promise<{ readonly liveProducts: number; readonly liveChildren: number }>;
  /** Whether a live sibling (same parent) other than `exceptId` has this name, ignoring case and outer spaces. */
  siblingNameTaken(tx: Transaction, parentId: string | null, name: string, exceptId: string | null): Promise<boolean>;
  codeTaken(tx: Transaction, record: 'category' | 'species', code: string): Promise<boolean>;

  units(tx: Transaction, afterCode: string | null, limit: number): Promise<UomView[]>;

  species(tx: Transaction, id: string): Promise<SpeciesView | null>;
  speciesList(tx: Transaction, afterId: string | null, limit: number): Promise<SpeciesView[]>;
  insertSpecies(tx: Transaction, id: string, write: { readonly code: string; readonly name: string; readonly trackingDefault: SpeciesTracking }, actorId: string): Promise<void>;

  grade(tx: Transaction, id: string): Promise<GradeView | null>;
  grades(tx: Transaction, speciesId: string | undefined, afterId: string | null, limit: number): Promise<GradeView[]>;
  insertGrade(tx: Transaction, id: string, write: GradeWrite, actorId: string): Promise<void>;
  gradeCodeTaken(tx: Transaction, speciesId: string, code: string): Promise<boolean>;

  weightBand(tx: Transaction, id: string): Promise<WeightBandView | null>;
  weightBands(tx: Transaction, speciesId: string | undefined, afterId: string | null, limit: number): Promise<WeightBandView[]>;
  insertWeightBand(tx: Transaction, id: string, write: WeightBandWrite, actorId: string): Promise<void>;
  weightBandCodeTaken(tx: Transaction, speciesId: string, code: string): Promise<boolean>;
  /** Live bands of the species, other than `exceptId`, whose `[min, max)` meets `[minKg, maxKg)`. */
  overlappingBands(tx: Transaction, speciesId: string, minKg: string, maxKg: string, exceptId: string | null): Promise<string[]>;

  /** Entries of PENDING_APPROVAL or ACTIVE price list versions that price with this grade or band. */
  livePriceUses(tx: Transaction, record: 'grade' | 'weight_band', id: string): Promise<number>;
}

export const CATALOGUE_STORE = Symbol('CATALOGUE_STORE');
