import { type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { sqlStateOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { RegisterInvalidError, type TillRule } from './errors';
import type { Page } from './shifts';
import type { RegisterRecord, TillStore } from './till-store';

const READ = 'pos.register.read';
const MANAGE = 'pos.register.manage';
const UNIQUE_VIOLATION = '23505';

/** The contract's `Register`. */
export interface RegisterView {
  readonly id: string;
  readonly branch: { readonly id: string; readonly code: string; readonly name: string };
  readonly location: { readonly id: string; readonly code: string; readonly name: string; readonly kind: string };
  readonly code: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'RETIRED';
  readonly openShift: { readonly id: string; readonly cashier: PrincipalRef; readonly openedAt: string } | null;
  /** Devices enrolled on the till: none until device enrolment is built (A-273 (a)). */
  readonly deviceCount: number;
  readonly version: number;
}

export interface RegisterCreateRequest {
  readonly branchId: string;
  readonly locationId: string;
  readonly code: string;
  readonly name: string;
}

export interface RegisterUpdateRequest {
  readonly version: number;
  readonly name?: string | undefined;
  readonly locationId?: string | undefined;
  readonly status?: 'ACTIVE' | 'RETIRED' | undefined;
}

/**
 * The tills of a branch (FR-POS-015): each sells from one live, physical location of its branch, with a code that
 * prints in its receipts. A till with a shift not yet closed cannot be retired or moved.
 */
export class Registers {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: TillStore,
    private readonly refs: MasterDataRefs,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
    private readonly nextId: () => string,
  ) {}

  list(actor: Actor | undefined, branchId: string | null, cursor: string | undefined, limit: number): Promise<Page<RegisterView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const reachable = [...new Set((await this.authoriser.scopes(tx, actor!, READ)).map((s) => s.branchId))];
      const branchIds = branchId === null ? reachable : reachable.filter((b) => b === branchId);
      const binding = { operationId: 'listRegisters', principalId: actor!.principalId, filters: { branchId } };
      const before = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const rows = await this.store.listRegisters(tx, branchIds, before, limit + 1);
      const kept = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      return { data: await this.views(tx, kept), page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: kept.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  create(actor: Actor | undefined, body: RegisterCreateRequest, idempotencyKey: string): Promise<StoredResponse<RegisterView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE, { branchId: body.branchId });
      const claim = await this.idempotency.claim(tx, { operationId: 'createRegister', principalId: actor!.principalId, key: idempotencyKey, request: body });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<RegisterView>;
      await this.judgeLocation(tx, body.branchId, body.locationId);
      const id = this.nextId();
      const now = this.clock.now();
      try {
        await this.store.insertRegister(tx, { id, branchId: body.branchId, locationId: body.locationId, code: body.code, name: body.name }, actor!.principalId, now);
      } catch (error) {
        if (sqlStateOf(error) === UNIQUE_VIOLATION) throw new RegisterInvalidError([{ field: '/code', rule: 'REGISTER_CODE_TAKEN' }]);
        throw error;
      }
      const [view] = await this.views(tx, await this.store.registers(tx, [id]));
      await this.audit.record(tx, { module: 'pos', action: 'CREATE', entityType: 'Register', entityId: id, branchId: body.branchId, before: null, after: { ...view! } });
      const response: StoredResponse<RegisterView> = { status: 201, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  update(actor: Actor | undefined, id: string, body: RegisterUpdateRequest, idempotencyKey: string): Promise<StoredResponse<RegisterView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const current = await this.store.lockRegister(tx, id);
      await this.authoriser.authorise(tx, actor, MANAGE, current === null ? {} : { branchId: current.branchId });
      if (current === null) throw new NotFoundError(`no register ${id}`);
      const claim = await this.idempotency.claim(tx, { operationId: 'updateRegister', principalId: actor!.principalId, key: idempotencyKey, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<RegisterView>;
      if (current.version !== body.version) throw new VersionConflictError(`register ${id} is at version ${current.version}`);
      const next = { name: body.name ?? current.name, locationId: body.locationId ?? current.locationId, status: body.status ?? current.status };
      const broken: TillRule[] = [];
      const moving = next.locationId !== current.locationId || next.status !== current.status;
      if (moving && (await this.store.unclosedShifts(tx, [id])).has(id)) broken.push({ field: '/status', rule: 'SHIFT_OPEN' });
      if (broken.length > 0) throw new RegisterInvalidError(broken);
      if (next.locationId !== current.locationId) await this.judgeLocation(tx, current.branchId, next.locationId);
      const [before] = await this.views(tx, [current]);
      await this.store.updateRegister(tx, id, next, actor!.principalId, this.clock.now());
      const [view] = await this.views(tx, await this.store.registers(tx, [id]));
      await this.audit.record(tx, { module: 'pos', action: 'UPDATE', entityType: 'Register', entityId: id, branchId: current.branchId, before: { ...before! }, after: { ...view! } });
      const response: StoredResponse<RegisterView> = { status: 200, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** A till sells from a live, physical location of its own branch. */
  private async judgeLocation(tx: Transaction, branchId: string, locationId: string): Promise<void> {
    const location = (await this.refs.locationsIn(tx, [locationId])).get(locationId);
    if (location === undefined || location.branchId !== branchId) throw new RegisterInvalidError([{ field: '/locationId', rule: 'LOCATION_NOT_IN_BRANCH' }]);
    if (location.isVirtual || !location.isLive) throw new RegisterInvalidError([{ field: '/locationId', rule: 'LOCATION_NOT_SELLABLE' }]);
  }

  private async views(tx: Transaction, registers: readonly RegisterRecord[]): Promise<RegisterView[]> {
    if (registers.length === 0) return [];
    const branches = await this.refs.branchesIn(tx, [...new Set(registers.map((r) => r.branchId))]);
    const locations = await this.refs.locationsIn(tx, [...new Set(registers.map((r) => r.locationId))]);
    const open = await this.store.unclosedShifts(tx, registers.map((r) => r.id));
    const names = await this.principals.refs(tx, [...open.values()].map((s) => s.cashierId));
    return registers.map((r) => {
      const branch = branches.get(r.branchId)!;
      const location = locations.get(r.locationId)!;
      const shift = open.get(r.id);
      return {
        id: r.id,
        branch: { id: branch.id, code: branch.code, name: branch.name },
        location: { id: location.id, code: location.code, name: location.name, kind: location.kind },
        code: r.code,
        name: r.name,
        status: r.status,
        openShift: shift === undefined ? null : { id: shift.id, cashier: names.get(shift.cashierId) ?? { id: shift.cashierId, displayName: 'Unknown' }, openedAt: shift.openedAt.toISOString() },
        deviceCount: 0,
        version: r.version,
      };
    });
  }
}

