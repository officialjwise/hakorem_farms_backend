import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { databaseErrorOf, sqlStateOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import { defineWeightBandRange, planCategoryArchive, planRangeChange, planReferencedArchive } from '../domain/catalogue';
import type { GlGroup } from '../domain/product';
import type {
  CatalogueRecord,
  CatalogueStore,
  CategoryView,
  GradeView,
  ProductLine,
  SpeciesTracking,
  SpeciesView,
  UomView,
  WeightBandView,
} from './catalogue-store';
import { DuplicateRecordError, RecordInUseError, referencesNotFound, WeightBandInvalidError } from './errors';
import type { Page } from './product-catalogue';

export interface CategoryCreateRequest {
  readonly parentId?: string | undefined;
  readonly code: string;
  readonly name: string;
  readonly productLine: ProductLine;
  readonly glGroup: GlGroup;
  readonly taxCategoryId: string;
  readonly sortOrder?: number | undefined;
  readonly isOnlineVisible?: boolean | undefined;
}

export interface CategoryUpdateRequest {
  readonly version: number;
  readonly name?: string | undefined;
  readonly taxCategoryId?: string | undefined;
  readonly sortOrder?: number | undefined;
  readonly isOnlineVisible?: boolean | undefined;
}

export interface ArchiveRequest {
  readonly version: number;
  readonly reason: string;
}

export interface GradeCreateRequest {
  readonly speciesId: string;
  readonly code: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly sortOrder?: number | undefined;
}

export interface WeightBandCreateRequest {
  readonly speciesId: string;
  readonly code: string;
  readonly minKg: string;
  readonly maxKg: string;
}

/** Unique indexes of migrations 0009, 0011 and 0019, for a race that reaches the database before a check sees it. */
const UNIQUE_POINTER: Readonly<Record<string, string>> = {
  uq_category_code: '/code',
  uq_category_sibling_name: '/name',
  uq_species_code: '/code',
  uq_grade_species_code: '/code',
  uq_weight_band_species_code: '/code',
};
const OVERLAP_CONSTRAINT = 'ex_weight_band_no_overlap';

const ENTITY: Readonly<Record<CatalogueRecord, string>> = { category: 'Category', species: 'Species', grade: 'Grade', weight_band: 'WeightBand' };

/** Turns a race the database caught into the same refusal the checks give. */
function translateConstraint(error: unknown): never {
  const constraint = databaseErrorOf(error)?.constraint ?? '';
  const state = sqlStateOf(error);
  if (state === '23505' && UNIQUE_POINTER[constraint] !== undefined) {
    throw new DuplicateRecordError([UNIQUE_POINTER[constraint]]);
  }
  if (state === '23P01' && constraint === OVERLAP_CONSTRAINT) {
    throw new WeightBandInvalidError([{ field: '/minKg', rule: 'OVERLAPS_BAND' }]);
  }
  throw error;
}

/**
 * The catalogue's reference data (FR-MDM-002, FR-MDM-003, FR-MDM-005): categories, units of measure (read only;
 * they change by migration), species, grades and weight bands. Every handler authorises first; every write is
 * serializable, claims its idempotency key as its first write, checks the version it was sent, and writes its
 * audit event with before and after in the same transaction. Archiving is a soft delete with a reason, refused while
 * something live still uses the record.
 */
export class CatalogueAdmin {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: CatalogueStore,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  // Reads.

  listCategories(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<CategoryView>> {
    return this.page(actor, 'mdm.category.read', 'listCategories', {}, cursor, limit, (tx, after) => this.store.categories(tx, after, limit + 1));
  }

  getCategory(actor: Actor | undefined, id: string): Promise<CategoryView> {
    return this.read(actor, 'mdm.category.read', (tx) => this.store.category(tx, id), 'no such category');
  }

  /** Units of measure are a fixed list changed by migration; each says how many decimals a quantity shows (CR-003). */
  listUnits(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<UomView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.product.read');
      const binding = { operationId: 'listUnitsOfMeasure', principalId: actor!.principalId, filters: {} };
      const after = cursor === undefined ? null : ((this.cursors.decode(cursor, binding)['code'] as string | undefined) ?? null);
      const rows = await this.store.units(tx, after, limit + 1);
      const hasMore = rows.length > limit;
      const data = rows.slice(0, limit);
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { code: last.code }) : null, limit, hasMore } };
    });
  }

  listSpecies(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<SpeciesView>> {
    return this.page(actor, 'mdm.species.read', 'listSpeciesList', {}, cursor, limit, (tx, after) => this.store.speciesList(tx, after, limit + 1));
  }

  listGrades(actor: Actor | undefined, speciesId: string | undefined, cursor: string | undefined, limit: number): Promise<Page<GradeView>> {
    return this.page(actor, 'mdm.grade.read', 'listGrades', { speciesId: speciesId ?? null }, cursor, limit, (tx, after) => this.store.grades(tx, speciesId, after, limit + 1));
  }

  listWeightBands(actor: Actor | undefined, speciesId: string | undefined, cursor: string | undefined, limit: number): Promise<Page<WeightBandView>> {
    return this.page(actor, 'mdm.weight_band.read', 'listWeightBands', { speciesId: speciesId ?? null }, cursor, limit, (tx, after) =>
      this.store.weightBands(tx, speciesId, after, limit + 1),
    );
  }

  // Categories.

  createCategory(actor: Actor | undefined, body: CategoryCreateRequest, idempotencyKey: string): Promise<StoredResponse<CategoryView>> {
    return this.write(actor, 'mdm.category.create', 'createCategory', body, idempotencyKey, async (tx) => {
      const missing: string[] = [];
      if (body.parentId !== undefined && !(await this.store.isLive(tx, 'category', body.parentId))) missing.push('/parentId');
      if (!(await this.store.isLive(tx, 'tax_category', body.taxCategoryId))) missing.push('/taxCategoryId');
      if (missing.length > 0) throw referencesNotFound(missing);
      const taken: string[] = [];
      if (await this.store.codeTaken(tx, 'category', body.code)) taken.push('/code');
      if (await this.store.siblingNameTaken(tx, body.parentId ?? null, body.name, null)) taken.push('/name');
      if (taken.length > 0) throw new DuplicateRecordError(taken);
      const id = this.nextId();
      await this.store.insertCategory(
        tx,
        id,
        {
          parentId: body.parentId ?? null,
          code: body.code,
          name: body.name,
          productLine: body.productLine,
          glGroup: body.glGroup,
          taxCategoryId: body.taxCategoryId,
          sortOrder: body.sortOrder ?? 0,
          isOnlineVisible: body.isOnlineVisible ?? true,
        },
        actor!.principalId,
      );
      const view = (await this.store.category(tx, id))!;
      await this.audit.record(tx, { module: 'mdm', action: 'CREATE', entityType: 'Category', entityId: id, before: null, after: { ...view } });
      return { status: 201, body: view };
    });
  }

  updateCategory(actor: Actor | undefined, id: string, body: CategoryUpdateRequest, idempotencyKey: string): Promise<StoredResponse<CategoryView>> {
    return this.write(actor, 'mdm.category.update', 'updateCategory', { id, ...body }, idempotencyKey, async (tx) => {
      const before = await this.lockedLive(tx, 'category', id, body.version, () => this.store.category(tx, id));
      if (body.taxCategoryId !== undefined && !(await this.store.isLive(tx, 'tax_category', body.taxCategoryId))) throw referencesNotFound(['/taxCategoryId']);
      if (body.name !== undefined && (await this.store.siblingNameTaken(tx, before.parentId, body.name, id))) throw new DuplicateRecordError(['/name']);
      const view = await this.change(tx, 'category', id, before.version, {
        name: body.name,
        tax_category_id: body.taxCategoryId,
        sort_order: body.sortOrder,
        is_online_visible: body.isOnlineVisible,
      }, actor!, () => this.store.category(tx, id));
      await this.audit.record(tx, { module: 'mdm', action: 'UPDATE', entityType: 'Category', entityId: id, before: { ...before }, after: { ...view } });
      return { status: 200, body: view };
    });
  }

  archiveCategory(actor: Actor | undefined, id: string, body: ArchiveRequest, idempotencyKey: string): Promise<StoredResponse<CategoryView>> {
    return this.write(actor, 'mdm.category.archive', 'archiveCategory', { id, ...body }, idempotencyKey, async (tx) => {
      const before = await this.lockedLive(tx, 'category', id, body.version, () => this.store.category(tx, id));
      const verdict = planCategoryArchive(await this.store.categoryUsage(tx, id));
      if (!verdict.ok) throw new RecordInUseError(verdict.error);
      const view = await this.archived(tx, 'category', id, before, body.reason, actor!, () => this.store.category(tx, id));
      return { status: 200, body: view };
    });
  }

  // Species.

  createSpecies(
    actor: Actor | undefined,
    body: { readonly code: string; readonly name: string; readonly trackingDefault: SpeciesTracking },
    idempotencyKey: string,
  ): Promise<StoredResponse<SpeciesView>> {
    return this.write(actor, 'mdm.species.create', 'createSpecies', body, idempotencyKey, async (tx) => {
      if (await this.store.codeTaken(tx, 'species', body.code)) throw new DuplicateRecordError(['/code']);
      const id = this.nextId();
      await this.store.insertSpecies(tx, id, body, actor!.principalId);
      const view = (await this.store.species(tx, id))!;
      await this.audit.record(tx, { module: 'mdm', action: 'CREATE', entityType: 'Species', entityId: id, before: null, after: { ...view } });
      return { status: 201, body: view };
    });
  }

  updateSpecies(actor: Actor | undefined, id: string, body: { readonly version: number; readonly name?: string | undefined }, idempotencyKey: string): Promise<StoredResponse<SpeciesView>> {
    return this.write(actor, 'mdm.species.update', 'updateSpecies', { id, ...body }, idempotencyKey, async (tx) => {
      const before = await this.lockedLive(tx, 'species', id, body.version, () => this.store.species(tx, id));
      const view = await this.change(tx, 'species', id, before.version, { name: body.name }, actor!, () => this.store.species(tx, id));
      await this.audit.record(tx, { module: 'mdm', action: 'UPDATE', entityType: 'Species', entityId: id, before: { ...before }, after: { ...view } });
      return { status: 200, body: view };
    });
  }

  // Grades.

  createGrade(actor: Actor | undefined, body: GradeCreateRequest, idempotencyKey: string): Promise<StoredResponse<GradeView>> {
    return this.write(actor, 'mdm.grade.create', 'createGrade', body, idempotencyKey, async (tx) => {
      if (!(await this.store.isLive(tx, 'species', body.speciesId))) throw referencesNotFound(['/speciesId']);
      if (await this.store.gradeCodeTaken(tx, body.speciesId, body.code)) throw new DuplicateRecordError(['/code']);
      const id = this.nextId();
      await this.store.insertGrade(tx, id, { speciesId: body.speciesId, code: body.code, name: body.name, description: body.description ?? null, sortOrder: body.sortOrder ?? 0 }, actor!.principalId);
      const view = (await this.store.grade(tx, id))!;
      await this.audit.record(tx, { module: 'mdm', action: 'CREATE', entityType: 'Grade', entityId: id, before: null, after: { ...view } });
      return { status: 201, body: view };
    });
  }

  updateGrade(
    actor: Actor | undefined,
    id: string,
    body: { readonly version: number; readonly name?: string | undefined; readonly description?: string | undefined; readonly sortOrder?: number | undefined },
    idempotencyKey: string,
  ): Promise<StoredResponse<GradeView>> {
    return this.write(actor, 'mdm.grade.update', 'updateGrade', { id, ...body }, idempotencyKey, async (tx) => {
      const before = await this.lockedLive(tx, 'grade', id, body.version, () => this.store.grade(tx, id));
      const view = await this.change(tx, 'grade', id, before.version, { name: body.name, description: body.description, sort_order: body.sortOrder }, actor!, () =>
        this.store.grade(tx, id),
      );
      await this.audit.record(tx, { module: 'mdm', action: 'UPDATE', entityType: 'Grade', entityId: id, before: { ...before }, after: { ...view } });
      return { status: 200, body: view };
    });
  }

  archiveGrade(actor: Actor | undefined, id: string, body: ArchiveRequest, idempotencyKey: string): Promise<StoredResponse<GradeView>> {
    return this.write(actor, 'mdm.grade.archive', 'archiveGrade', { id, ...body }, idempotencyKey, async (tx) => {
      const before = await this.lockedLive(tx, 'grade', id, body.version, () => this.store.grade(tx, id));
      const verdict = planReferencedArchive(await this.store.livePriceUses(tx, 'grade', id));
      if (!verdict.ok) throw new RecordInUseError(verdict.error);
      const view = await this.archived(tx, 'grade', id, before, body.reason, actor!, () => this.store.grade(tx, id));
      return { status: 200, body: view };
    });
  }

  // Weight bands.

  createWeightBand(actor: Actor | undefined, body: WeightBandCreateRequest, idempotencyKey: string): Promise<StoredResponse<WeightBandView>> {
    return this.write(actor, 'mdm.weight_band.create', 'createWeightBand', body, idempotencyKey, async (tx) => {
      if (!(await this.store.isLive(tx, 'species', body.speciesId))) throw referencesNotFound(['/speciesId']);
      const range = defineWeightBandRange(body.minKg, body.maxKg);
      if (!range.ok) throw new WeightBandInvalidError(range.error);
      if (await this.store.weightBandCodeTaken(tx, body.speciesId, body.code)) throw new DuplicateRecordError(['/code']);
      await this.refuseOverlap(tx, body.speciesId, range.value.minKg, range.value.maxKg, null);
      const id = this.nextId();
      await this.store.insertWeightBand(tx, id, { speciesId: body.speciesId, code: body.code, ...range.value }, actor!.principalId);
      const view = (await this.store.weightBand(tx, id))!;
      await this.audit.record(tx, { module: 'mdm', action: 'CREATE', entityType: 'WeightBand', entityId: id, before: null, after: { ...view } });
      return { status: 201, body: view };
    });
  }

  updateWeightBand(
    actor: Actor | undefined,
    id: string,
    body: { readonly version: number; readonly minKg?: string | undefined; readonly maxKg?: string | undefined },
    idempotencyKey: string,
  ): Promise<StoredResponse<WeightBandView>> {
    return this.write(actor, 'mdm.weight_band.update', 'updateWeightBand', { id, ...body }, idempotencyKey, async (tx) => {
      const before = await this.lockedLive(tx, 'weight_band', id, body.version, () => this.store.weightBand(tx, id));
      const range = defineWeightBandRange(body.minKg ?? before.minKg, body.maxKg ?? before.maxKg);
      if (!range.ok) throw new WeightBandInvalidError(range.error);
      const moved = planRangeChange(before, range.value, await this.store.livePriceUses(tx, 'weight_band', id));
      if (!moved.ok) throw new RecordInUseError(moved.error);
      await this.refuseOverlap(tx, before.speciesId, range.value.minKg, range.value.maxKg, id);
      const view = await this.change(tx, 'weight_band', id, before.version, { min_kg: range.value.minKg, max_kg: range.value.maxKg }, actor!, () => this.store.weightBand(tx, id));
      await this.audit.record(tx, { module: 'mdm', action: 'UPDATE', entityType: 'WeightBand', entityId: id, before: { ...before }, after: { ...view } });
      return { status: 200, body: view };
    });
  }

  archiveWeightBand(actor: Actor | undefined, id: string, body: ArchiveRequest, idempotencyKey: string): Promise<StoredResponse<WeightBandView>> {
    return this.write(actor, 'mdm.weight_band.archive', 'archiveWeightBand', { id, ...body }, idempotencyKey, async (tx) => {
      const before = await this.lockedLive(tx, 'weight_band', id, body.version, () => this.store.weightBand(tx, id));
      const verdict = planReferencedArchive(await this.store.livePriceUses(tx, 'weight_band', id));
      if (!verdict.ok) throw new RecordInUseError(verdict.error);
      const view = await this.archived(tx, 'weight_band', id, before, body.reason, actor!, () => this.store.weightBand(tx, id));
      return { status: 200, body: view };
    });
  }

  // The shape every handler shares.

  private async refuseOverlap(tx: Transaction, speciesId: string, minKg: string, maxKg: string, exceptId: string | null): Promise<void> {
    const overlapping = await this.store.overlappingBands(tx, speciesId, minKg, maxKg, exceptId);
    if (overlapping.length > 0) {
      throw new WeightBandInvalidError(overlapping.map((code) => ({ field: '/minKg', rule: `OVERLAPS_BAND:${code}` })));
    }
  }

  private async write<T>(
    actor: Actor | undefined,
    permission: string,
    operationId: string,
    request: object,
    idempotencyKey: string,
    work: (tx: Transaction) => Promise<StoredResponse<T>>,
  ): Promise<StoredResponse<T>> {
    try {
      return await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        await this.authoriser.authorise(tx, actor, permission);
        const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key: idempotencyKey, request });
        if (claim.kind === 'REPLAY') {
          return claim.response as StoredResponse<T>;
        }
        const response = await work(tx);
        await this.idempotency.complete(tx, claim.id, response);
        return response;
      });
    } catch (error) {
      return translateConstraint(error);
    }
  }

  /** Locks a live row, checks the version the client read, and returns its view. */
  private async lockedLive<V>(tx: Transaction, record: CatalogueRecord, id: string, version: number, view: () => Promise<V | null>): Promise<V> {
    const state = await this.store.lock(tx, record, id);
    if (state === null || state.archived) {
      throw new NotFoundError(`no live ${record.replace('_', ' ')} ${id}`);
    }
    if (state.version !== version) {
      throw new VersionConflictError(`${record} ${id} is at version ${state.version}, not ${version}`);
    }
    return (await view())!;
  }

  private async change<V>(
    tx: Transaction,
    record: CatalogueRecord,
    id: string,
    version: number,
    columns: Readonly<Record<string, unknown>>,
    actor: Actor,
    view: () => Promise<V | null>,
  ): Promise<V> {
    const set = Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
    if (Object.keys(set).length > 0 && !(await this.store.update(tx, record, id, version, set, actor.principalId))) {
      throw new VersionConflictError(`${record} ${id} changed while it was updated`);
    }
    return (await view())!;
  }

  private async archived<V extends object>(tx: Transaction, record: CatalogueRecord, id: string, before: V & { readonly version: number }, reason: string, actor: Actor, view: () => Promise<V | null>): Promise<V> {
    if (!(await this.store.archive(tx, record, id, before.version, reason, actor.principalId, this.clock.now()))) {
      throw new VersionConflictError(`${record} ${id} changed while it was archived`);
    }
    const after = (await view())!;
    await this.audit.record(tx, { module: 'mdm', action: 'ARCHIVE', entityType: ENTITY[record], entityId: id, before: { ...before }, after: { ...after, reason } });
    return after;
  }

  private read<V>(actor: Actor | undefined, permission: string, find: (tx: Transaction) => Promise<V | null>, missing: string): Promise<V> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, permission);
      const found = await find(tx);
      if (found === null) {
        throw new NotFoundError(missing);
      }
      return found;
    });
  }

  private page<V extends { readonly id: string }>(
    actor: Actor | undefined,
    permission: string,
    operationId: string,
    filters: Record<string, unknown>,
    cursor: string | undefined,
    limit: number,
    rows: (tx: Transaction, afterId: string | null) => Promise<V[]>,
  ): Promise<Page<V>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, permission);
      const binding = { operationId, principalId: actor!.principalId, filters };
      const after = cursor === undefined ? null : ((this.cursors.decode(cursor, binding)['id'] as string | undefined) ?? null);
      const found = await rows(tx, after);
      const hasMore = found.length > limit;
      const data = found.slice(0, limit);
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }
}
