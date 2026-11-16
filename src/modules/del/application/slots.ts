import { createUuidV7Generator, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import { decodePosition, encodePosition, resolveSort, type SortSpec } from '../../../platform/http/keyset-sort';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs, Storefront } from '../../mdm';
import { judgeCapacity, planSlots, remaining, type SlotGeneration } from '../domain/slots';
import { CapacityBelowBookedError, DelReferenceNotFoundError, SlotRequestInvalidError } from './errors';
import type { SlotFilters, SlotRecord, SlotStore } from './slot-store';

export const GENERATE_DELIVERY_SLOTS = 'generateDeliverySlots';
export const UPDATE_DELIVERY_SLOT = 'updateDeliverySlot';
const READ = 'del.slot.read';
const MANAGE = 'del.slot.manage';

interface Ref {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** The contract's `DeliverySlot`. */
export interface DeliverySlotView {
  readonly id: string;
  readonly branch: Ref;
  readonly deliveryZone: Ref;
  readonly slotDate: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly capacity: number;
  readonly booked: number;
  readonly remaining: number;
  readonly version: number;
}

/** The contract's `SlotOption`: what a shopper sees of a slot. */
export interface SlotOptionView {
  readonly id: string;
  readonly date: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly available: boolean;
  readonly remaining: number;
}

/** A slot as SHP's checkout names it (`Slots.slotIn`). */
export interface SlotFacts {
  readonly id: string;
  readonly branchId: string;
  readonly deliveryZoneId: string;
  readonly option: SlotOptionView;
  /** The slot has started: it is no longer offered. */
  readonly started: boolean;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

/** Every slot list runs in the order the slots start, then by id (CR-019's keyset; index ix_delivery_slot_start). */
const SLOT_ORDER: SortSpec<'start'> = {
  fields: { start: { expression: '(s.slot_date + s.starts_at)', type: 'timestamp' } },
  tieBreaker: { expression: 's.id', type: 'uuid' },
  defaultOrder: { field: 'start', direction: 'asc' },
};

function option(slot: SlotRecord): SlotOptionView {
  const left = remaining(slot);
  return { id: slot.id, date: slot.slotDate, startsAt: slot.startsAt, endsAt: slot.endsAt, available: left > 0, remaining: left };
}

/**
 * Delivery slots (FR-DEL-001 without its capacity rule; ADR-0026's delivery split, SA-13): a manager generates a zone's
 * slots over a date range and changes a slot's capacity, never below its bookings; the storefront lists a zone's
 * coming slots and its checkout names one. Each command authorises first through IAM's policy engine at the zone's
 * branch, deny by default, and is audited. Booking against capacity, cut-offs and scheduling are B11's.
 */
export class Slots {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: SlotStore,
    private readonly refs: MasterDataRefs,
    private readonly storefront: Storefront,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  generate(actor: Actor | undefined, body: SlotGeneration & { readonly zoneId: string }, idempotencyKey: string): Promise<StoredResponse<{ readonly created: number; readonly skippedExisting: number }>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const zone = (await this.storefront.deliveryZonesIn(tx, [body.zoneId])).get(body.zoneId);
      if (zone === undefined) throw new DelReferenceNotFoundError(['/zoneId']);
      await this.authoriser.authorise(tx, actor, MANAGE, { branchId: zone.branchId });
      const claim = await this.idempotency.claim(tx, { operationId: GENERATE_DELIVERY_SLOTS, principalId: actor!.principalId, key: idempotencyKey, request: body });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<{ readonly created: number; readonly skippedExisting: number }>;
      const planned = planSlots(body, toBusinessDate(this.clock.now()));
      if (!planned.ok) throw new SlotRequestInvalidError(planned.error);
      const created = await this.store.insertMissing(tx, zone.branchId, zone.id, planned.value, actor!.principalId, this.nextId);
      const result = { created, skippedExisting: planned.value.length - created };
      await this.audit.record(tx, {
        module: 'del',
        action: 'GENERATE',
        entityType: 'DeliverySlot',
        entityId: zone.id,
        branchId: zone.branchId,
        before: null,
        after: { zoneId: zone.id, from: body.from, to: body.to, weekdays: [...body.weekdays], times: body.times.map((t) => ({ ...t })), ...result },
      });
      const response = { status: 201, body: result };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  list(actor: Actor | undefined, query: { readonly zoneId?: string | undefined; readonly from?: string | undefined; readonly to?: string | undefined }, cursor: string | undefined, limit: number): Promise<Page<DeliverySlotView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = [...new Set((await this.authoriser.scopes(tx, actor!, READ)).map((scope) => scope.branchId))];
      const filters: SlotFilters = { zoneIds: query.zoneId === undefined ? null : [query.zoneId], branchIds, from: query.from ?? null, to: query.to ?? null, startingAfter: null };
      return this.page(tx, 'listDeliverySlots', actor!.principalId, filters, cursor, limit, async (rows) => this.views(tx, rows));
    });
  }

  update(actor: Actor | undefined, id: string, body: { readonly version: number; readonly capacity: number }, idempotencyKey: string): Promise<StoredResponse<DeliverySlotView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const before = await this.store.lock(tx, id);
      if (before === null) throw new NotFoundError(`no delivery slot ${id}`);
      await this.authoriser.authorise(tx, actor, MANAGE, { branchId: before.branchId });
      const claim = await this.idempotency.claim(tx, { operationId: UPDATE_DELIVERY_SLOT, principalId: actor!.principalId, key: idempotencyKey, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<DeliverySlotView>;
      if (before.version !== body.version) throw new VersionConflictError(`delivery slot ${id} is at version ${before.version}`);
      const verdict = judgeCapacity(body.capacity, before.booked);
      if (verdict === 'BELOW_BOOKED') throw new CapacityBelowBookedError(before.booked);
      if (verdict === 'OUT_OF_RANGE') throw new SlotRequestInvalidError([{ field: '/capacity', rule: 'OUT_OF_RANGE' }]);
      await this.store.setCapacity(tx, id, body.capacity, actor!.principalId);
      const after = (await this.store.lock(tx, id))!;
      await this.audit.record(tx, { module: 'del', action: 'UPDATE', entityType: 'DeliverySlot', entityId: id, branchId: before.branchId, before: { capacity: before.capacity, version: before.version }, after: { capacity: after.capacity, version: after.version } });
      const [view] = await this.views(tx, [after]);
      const response = { status: 200, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** listDeliverySlotOptions (FR-SHP-009, public): a zone's slots that have not started, from a date on. */
  listOptions(zoneId: string, from: string | undefined, cursor: string | undefined, limit: number): Promise<Page<SlotOptionView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const filters: SlotFilters = { zoneIds: [zoneId], branchIds: null, from: from ?? null, to: null, startingAfter: this.clock.now() };
      return this.page(tx, 'listDeliverySlotOptions', 'public', filters, cursor, limit, async (rows) => rows.map(option));
    });
  }

  /** A slot as a checkout names it, in the caller's transaction; null if there is no such live slot. */
  async slotIn(tx: Transaction, id: string): Promise<SlotFacts | null> {
    const slot = (await this.store.slots(tx, [id])).get(id);
    if (slot === undefined) return null;
    const startsAt = Date.parse(`${slot.slotDate}T${slot.startsAt}:00Z`);
    return { id: slot.id, branchId: slot.branchId, deliveryZoneId: slot.deliveryZoneId, option: option(slot), started: startsAt <= this.clock.now().getTime() };
  }

  private async page<T>(
    tx: Transaction,
    operationId: string,
    principalId: string,
    filters: SlotFilters,
    cursor: string | undefined,
    limit: number,
    view: (rows: readonly SlotRecord[]) => Promise<readonly T[]>,
  ): Promise<Page<T>> {
    const order = resolveSort(SLOT_ORDER, undefined, undefined);
    const binding = { operationId, principalId, filters: { zoneIds: filters.zoneIds, from: filters.from, to: filters.to } };
    const position = cursor === undefined ? null : decodePosition(order, this.cursors.decode(cursor, binding));
    const found = await this.store.page(tx, filters, order, position, limit + 1);
    const rows = found.slice(0, limit);
    const last = rows.at(-1);
    const hasMore = found.length > limit;
    return { data: await view(rows), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, encodePosition(last.position)) : null, limit, hasMore } };
  }

  private async views(tx: Transaction, rows: readonly SlotRecord[]): Promise<DeliverySlotView[]> {
    const [branches, zones] = await Promise.all([this.refs.branchesIn(tx, rows.map((r) => r.branchId)), this.storefront.zoneRefsIn(tx, rows.map((r) => r.deliveryZoneId))]);
    return rows.map((r) => {
      const branch = branches.get(r.branchId)!;
      const zone = zones.get(r.deliveryZoneId)!;
      return {
        id: r.id,
        branch: { id: branch.id, code: branch.code, name: branch.name },
        deliveryZone: { id: zone.id, code: zone.code, name: zone.name },
        slotDate: r.slotDate,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        capacity: r.capacity,
        booked: r.booked,
        remaining: remaining(r),
        version: r.version,
      };
    });
  }
}
