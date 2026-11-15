import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { sqlStateOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import { VersionConflictError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import { planLocation, planLocationArchive, planLocationChange, VIRTUAL_KINDS, type LocationKind, type TempClass } from '../domain/locations';
import { normaliseGhanaPhone } from '../domain/parties';
import { AdminKit, requireLiveVersion, sentColumns } from './admin-kit';
import { DuplicateRecordError, invalidFormat, LocationInvalidError, RecordInUseError, referencesNotFound } from './errors';
import type { BranchStatus, BranchView, LocationFilters, LocationsStore, LocationView } from './locations-store';
import type { Page } from './product-catalogue';

export interface BranchCreateRequest {
  readonly code: string;
  readonly name: string;
  readonly address?: string | undefined;
  readonly phone?: string | undefined;
}

export interface BranchUpdateRequest {
  readonly version: number;
  readonly name?: string | undefined;
  readonly address?: string | undefined;
  readonly phone?: string | undefined;
  readonly status?: BranchStatus | undefined;
}

export interface LocationCreateRequest {
  readonly branchId: string;
  readonly parentId?: string | undefined;
  readonly code: string;
  readonly name: string;
  readonly kind: LocationKind;
  readonly isSellable?: boolean | undefined;
  readonly allowsNegative?: boolean | undefined;
  readonly tempClass?: TempClass | undefined;
  readonly tempMinC?: string | undefined;
  readonly tempMaxC?: string | undefined;
  readonly capacityHead?: number | undefined;
}

export interface LocationUpdateRequest {
  readonly version: number;
  readonly name?: string | undefined;
  readonly parentId?: string | undefined;
  readonly isSellable?: boolean | undefined;
  readonly tempMinC?: string | undefined;
  readonly tempMaxC?: string | undefined;
  readonly capacityHead?: number | undefined;
}

/** Only an in-process caller (the seed) may mark the smoke-suite branch; the contract's `BranchCreate` has no such field (A-110). */
export interface InProcessBranchOptions {
  readonly isTest?: boolean;
}

const UNIQUE_POINTER: Readonly<Record<string, string>> = { uq_branch_code: '/code', uq_location_branch_code: '/code' };

function translateConstraint(error: unknown): never {
  const constraint = (error as { constraint?: string }).constraint ?? '';
  if (sqlStateOf(error) === '23505' && UNIQUE_POINTER[constraint] !== undefined) {
    throw new DuplicateRecordError([UNIQUE_POINTER[constraint]]);
  }
  throw error;
}

function phoneOf(input: string | undefined, field: string): string | null | undefined {
  if (input === undefined) return undefined;
  const phone = normaliseGhanaPhone(input);
  if (!phone.ok) throw invalidFormat([{ field, rule: phone.error }]);
  return phone.value;
}

/** A virtual location's code and name, the same in every branch. */
function virtualLocation(kind: (typeof VIRTUAL_KINDS)[number]) {
  return { code: `V-${kind}`, name: `Virtual: ${kind.toLowerCase()}`, kind, allowsNegative: kind !== 'CUSTOMER' };
}

/**
 * Branches and locations (FR-MDM-006). A branch is created with one virtual location of each of the eight virtual
 * kinds, in the same transaction, and those never change. A physical location belongs to one branch and its parent
 * is a physical location of the same branch, which the database's trigger enforces too. Writes on a location are
 * scoped to its branch: a grant at another branch does not reach it (ADR-0017). Every write is serializable,
 * idempotent, version-checked and audited with before and after.
 */
export class LocationsAdmin {
  private readonly nextId: () => string;
  private readonly kit: AdminKit;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: LocationsStore,
    authoriser: Authoriser,
    idempotency: Idempotency,
    private readonly audit: AuditTrail,
    cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
    this.kit = new AdminKit(uow, authoriser, idempotency, cursors, translateConstraint);
  }

  // Branches.

  listBranches(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<BranchView>> {
    return this.kit.page(actor, 'mdm.branch.read', 'listBranches', {}, cursor, limit, (tx, after) => this.store.branches(tx, after, limit + 1));
  }

  getBranch(actor: Actor | undefined, id: string): Promise<BranchView> {
    return this.kit.read(actor, 'mdm.branch.read', (tx) => this.store.branch(tx, id), 'no such branch');
  }

  createBranch(actor: Actor | undefined, body: BranchCreateRequest, idempotencyKey: string, options: InProcessBranchOptions = {}): Promise<StoredResponse<BranchView>> {
    return this.kit.write(actor, 'mdm.branch.create', 'createBranch', { ...body, ...options }, idempotencyKey, async (tx) => {
      const view = await this.insertBranch(tx, body, options.isTest === true, actor!.principalId);
      return { status: 201, body: view };
    });
  }

  /**
   * The farm's first branch, written before any grant can exist (a role grant names a branch, so nobody can be
   * authorised to create the first one; ADR-0042). It runs as the SYSTEM principal and only while no branch exists
   * at all; once one does, it refuses. Not reachable over HTTP.
   */
  bootstrapFirstBranch(system: Actor, body: BranchCreateRequest): Promise<BranchView> {
    if (system.kind !== 'SYSTEM') {
      throw new Error('only the SYSTEM principal bootstraps the first branch');
    }
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      if ((await this.store.branchCount(tx)) > 0) {
        throw new Error('a branch exists already; further branches are created through createBranch by someone granted mdm.branch.create');
      }
      return this.insertBranch(tx, body, false, system.principalId);
    });
  }

  updateBranch(actor: Actor | undefined, id: string, body: BranchUpdateRequest, idempotencyKey: string): Promise<StoredResponse<BranchView>> {
    return this.kit.write(
      actor,
      'mdm.branch.update',
      'updateBranch',
      { id, ...body },
      idempotencyKey,
      async (tx) => {
        requireLiveVersion(await this.store.lockBranch(tx, id), 'branch', id, body.version);
        const before = (await this.store.branch(tx, id))!;
        const set = sentColumns({ name: body.name, address: body.address, phone_e164: phoneOf(body.phone, '/phone'), status: body.status });
        if (Object.keys(set).length > 0 && !(await this.store.updateBranch(tx, id, body.version, set, actor!.principalId))) {
          throw new VersionConflictError(`branch ${id} changed while it was updated`);
        }
        const view = (await this.store.branch(tx, id))!;
        await this.audit.record(tx, { module: 'mdm', action: 'UPDATE', entityType: 'Branch', entityId: id, branchId: id, before: { ...before }, after: { ...view } });
        return { status: 200, body: view };
      },
      (tx) => this.branchScope(tx, id),
    );
  }

  // Locations.

  listLocations(actor: Actor | undefined, filters: LocationFilters, cursor: string | undefined, limit: number): Promise<Page<LocationView>> {
    return this.kit.page(
      actor,
      'mdm.location.read',
      'listLocations',
      { branchId: filters.branchId ?? null, kind: filters.kind ?? null, parentId: filters.parentId ?? null, includeVirtual: filters.includeVirtual },
      cursor,
      limit,
      (tx, after) => this.store.locations(tx, filters, after, limit + 1),
    );
  }

  getLocation(actor: Actor | undefined, id: string): Promise<LocationView> {
    return this.kit.read(actor, 'mdm.location.read', (tx) => this.store.location(tx, id), 'no such location');
  }

  createLocation(actor: Actor | undefined, body: LocationCreateRequest, idempotencyKey: string): Promise<StoredResponse<LocationView>> {
    return this.kit.write(
      actor,
      'mdm.location.create',
      'createLocation',
      body,
      idempotencyKey,
      async (tx) => ({ status: 201, body: await this.createLocationIn(tx, actor!, body) }),
      (tx) => this.branchScope(tx, body.branchId),
    );
  }

  /**
   * Creates a physical location in the caller's transaction, every rule of createLocation applied and audited. The
   * caller has authorised `mdm.location.create` for the location's branch: createLocation, or an import being
   * applied (FR-MDM-019).
   */
  async createLocationIn(tx: Transaction, actor: Actor, body: LocationCreateRequest): Promise<LocationView> {
    const branch = await this.store.branch(tx, body.branchId);
    if (branch === null) throw referencesNotFound(['/branchId']);
    let parent: { sameBranch: boolean; isVirtual: boolean } | null = null;
    if (body.parentId !== undefined) {
      const found = await this.store.location(tx, body.parentId);
      if (found === null || (await this.store.lockLocation(tx, body.parentId))?.archived === true) throw referencesNotFound(['/parentId']);
      parent = { sameBranch: found.branch.id === body.branchId, isVirtual: found.isVirtual };
    }
    const plan = planLocation({ kind: body.kind, parent, tempClass: body.tempClass, tempMinC: body.tempMinC, tempMaxC: body.tempMaxC });
    if (!plan.ok) throw new LocationInvalidError(plan.error);
    if (await this.store.locationCodeTaken(tx, body.branchId, body.code)) throw new DuplicateRecordError(['/code']);
    const id = this.nextId();
    await this.store.insertLocation(
      tx,
      id,
      {
        branchId: body.branchId,
        parentId: body.parentId ?? null,
        code: body.code,
        name: body.name,
        kind: body.kind,
        isVirtual: false,
        isSellable: body.isSellable ?? false,
        allowsNegative: body.allowsNegative ?? false,
        tempClass: plan.value.tempClass,
        tempMinC: body.tempMinC ?? null,
        tempMaxC: body.tempMaxC ?? null,
        capacityHead: body.capacityHead ?? null,
      },
      actor.principalId,
    );
    const view = (await this.store.location(tx, id))!;
    await this.audit.record(tx, { module: 'mdm', action: 'CREATE', entityType: 'Location', entityId: id, branchId: body.branchId, before: null, after: { ...view } });
    return view;
  }

  updateLocation(actor: Actor | undefined, id: string, body: LocationUpdateRequest, idempotencyKey: string): Promise<StoredResponse<LocationView>> {
    return this.kit.write(
      actor,
      'mdm.location.update',
      'updateLocation',
      { id, ...body },
      idempotencyKey,
      async (tx) => ({ status: 200, body: await this.updateLocationIn(tx, actor!, id, body) }),
      (tx) => this.scopeOf(tx, id),
    );
  }

  /**
   * Changes a physical location in the caller's transaction, every rule of updateLocation applied and audited. The
   * caller has authorised `mdm.location.update` for the location's branch: updateLocation, or an import being
   * applied (FR-MDM-019).
   */
  async updateLocationIn(tx: Transaction, actor: Actor, id: string, body: LocationUpdateRequest): Promise<LocationView> {
    const before = await this.lockedLive(tx, id, body.version);
    let parent: { sameBranch: boolean; isVirtual: boolean; isSelfOrBelow: boolean } | undefined;
    if (body.parentId !== undefined) {
      const found = await this.store.location(tx, body.parentId);
      if (found === null || (await this.store.lockLocation(tx, body.parentId))?.archived === true) throw referencesNotFound(['/parentId']);
      parent = { sameBranch: found.branch.id === before.branch.id, isVirtual: found.isVirtual, isSelfOrBelow: await this.store.isSelfOrBelow(tx, id, body.parentId) };
    }
    const plan = planLocationChange(before, { parent, tempMinC: body.tempMinC, tempMaxC: body.tempMaxC });
    if (!plan.ok) throw new LocationInvalidError(plan.error);
    const set = sentColumns({
      name: body.name,
      parent_id: body.parentId,
      is_sellable: body.isSellable,
      temp_min_c: body.tempMinC,
      temp_max_c: body.tempMaxC,
      capacity_head: body.capacityHead,
    });
    if (Object.keys(set).length > 0 && !(await this.store.updateLocation(tx, id, body.version, set, actor.principalId))) {
      throw new VersionConflictError(`location ${id} changed while it was updated`);
    }
    const view = (await this.store.location(tx, id))!;
    await this.audit.record(tx, { module: 'mdm', action: 'UPDATE', entityType: 'Location', entityId: id, branchId: view.branch.id, before: { ...before }, after: { ...view } });
    return view;
  }

  archiveLocation(actor: Actor | undefined, id: string, body: { readonly version: number; readonly reason: string }, idempotencyKey: string): Promise<StoredResponse<LocationView>> {
    return this.kit.write(
      actor,
      'mdm.location.archive',
      'archiveLocation',
      { id, ...body },
      idempotencyKey,
      async (tx) => {
        const before = await this.lockedLive(tx, id, body.version);
        const verdict = planLocationArchive({ isVirtual: before.isVirtual, liveChildren: await this.store.liveChildren(tx, id) });
        if (!verdict.ok) {
          throw verdict.error[0]!.rule === 'HAS_LIVE_CHILDREN' ? new RecordInUseError(verdict.error) : new LocationInvalidError(verdict.error);
        }
        if (!(await this.store.archiveLocation(tx, id, body.version, body.reason, actor!.principalId, this.clock.now()))) {
          throw new VersionConflictError(`location ${id} changed while it was archived`);
        }
        const view = (await this.store.location(tx, id))!;
        await this.audit.record(tx, { module: 'mdm', action: 'ARCHIVE', entityType: 'Location', entityId: id, branchId: view.branch.id, before: { ...before }, after: { ...view, reason: body.reason } });
        return { status: 200, body: view };
      },
      (tx) => this.scopeOf(tx, id),
    );
  }

  // Shared steps.

  private async insertBranch(tx: Transaction, body: BranchCreateRequest, isTest: boolean, actorId: string): Promise<BranchView> {
    const phone = phoneOf(body.phone, '/phone') ?? null;
    if (await this.store.branchCodeTaken(tx, body.code)) throw new DuplicateRecordError(['/code']);
    const id = this.nextId();
    await this.store.insertBranch(tx, id, { code: body.code, name: body.name, address: body.address ?? null, phone, isTest }, actorId);
    for (const kind of VIRTUAL_KINDS) {
      const virtual = virtualLocation(kind);
      await this.store.insertLocation(
        tx,
        this.nextId(),
        { branchId: id, parentId: null, ...virtual, isVirtual: true, isSellable: false, tempClass: null, tempMinC: null, tempMaxC: null, capacityHead: null },
        actorId,
      );
    }
    const view = (await this.store.branch(tx, id))!;
    await this.audit.record(tx, { module: 'mdm', action: 'CREATE', entityType: 'Branch', entityId: id, branchId: id, before: null, after: { ...view, virtualLocations: VIRTUAL_KINDS.length } });
    return view;
  }

  private async lockedLive(tx: Transaction, id: string, version: number): Promise<LocationView> {
    requireLiveVersion(await this.store.lockLocation(tx, id), 'location', id, version);
    return (await this.store.location(tx, id))!;
  }

  /** A write scoped to a branch; an unknown branch is refused or 404 after the permission is checked unscoped. */
  private async branchScope(tx: Transaction, branchId: string): Promise<{ branchId?: string }> {
    return (await this.store.branch(tx, branchId)) === null ? {} : { branchId };
  }

  /** The branch a location write is scoped to; an unknown location is 404 only after the permission is checked unscoped. */
  private async scopeOf(tx: Transaction, id: string): Promise<{ branchId?: string }> {
    const found = await this.store.location(tx, id);
    if (found === null) {
      return {};
    }
    return { branchId: found.branch.id };
  }
}

