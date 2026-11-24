import type { Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import { translate } from '../../../platform/i18n/messages';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import type { Storefront } from '../../mdm';
import { judgeBooking, judgeReassignment, type SchedulingRule } from '../domain/scheduling';
import type { DeliveryReassigned, DeliveryRescheduled } from '../events';
import type { Deliveries, DeliveryView } from './deliveries';
import type { DeliveryRecord, DeliveryStore } from './delivery-store';
import { DeliveryInvalidError } from './errors';
import type { SlotStore } from './slot-store';

const ASSIGN = 'del.delivery.assign';
export const DELIVERY_REASSIGNED = 'del.DeliveryReassigned';
export const DELIVERY_RESCHEDULED = 'del.DeliveryRescheduled';
const LIVE_RUN: ReadonlySet<string> = new Set(['PLANNED', 'IN_PROGRESS']);

/** The contract's `DeliveryAssign`. */
export interface AssignRequest {
  readonly driverId: string;
  readonly vehicleLocationId: string;
}

/** The contract's `DeliveryReschedule`. */
export interface RescheduleRequest {
  readonly slotId: string;
  readonly reason: string;
}

const invalidState = (what: string, status: string) =>
  new InvalidStateTransitionError(`${what} is ${status}`, [{ field: null, code: status, message: translate('error.invalid_state_transition') }]);

/** The advisory lock bookings of one delivery slot queue on (`seriesLocks`, ADR-0005). */
export const slotLockKey = (slotId: string): string => `del.delivery_slot:${slotId}`;

/**
 * A delivery's driver, vehicle and slot after dispatch (FR-DEL-001 to FR-DEL-004, FR-DEL-011; A-362), each in one
 * serializable transaction, authorised in the application layer at the delivery's branch (ADR-0035,
 * `del.delivery.assign`, the Manager's and the Owner's):
 *
 * - `assignDelivery`: another driver who drives for the branch, or another live vehicle of it, for a delivery waiting on
 *   the van or failed at the door and on no live run (a run keeps its stops' drivers and vans, `ck_delivery_route`).
 *   The old driver can no longer open it (the ownership rule follows the delivery). When the vehicle changes ORD moves
 *   the goods from the one van to the other in the same transaction (`del.DeliveryReassigned`), never below zero.
 *   Audited with the before and after.
 * - `rescheduleDelivery`: a slot of the delivery's zone, under the slot's row lock: never more bookings than its
 *   capacity, never a slot that has started, today's only up to the zone's cut-off (FR-DEL-002), on its run's day when
 *   it is a stop of one; the old slot is freed and the new one taken in the same statement (the database counts them).
 *   For a FAILED delivery this is the reattempt: back to ASSIGNED, and ORD moves the order DELIVERY_FAILED to
 *   DISPATCHED (`del.DeliveryRescheduled`, which NTF reads to tell the customer).
 */
export class Scheduling {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: DeliveryStore,
    private readonly slots: SlotStore,
    private readonly deliveries: Deliveries,
    private readonly storefront: Storefront,
    private readonly events: DomainEvents,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly authoriser: Authoriser,
    private readonly clock: Clock,
  ) {}

  /** assignDelivery (FR-DEL-004): another driver or vehicle for a delivery off any live run. */
  assign(actor: Actor | undefined, id: string, body: AssignRequest, key: string): Promise<StoredResponse<DeliveryView>> {
    return this.command(actor, 'assignDelivery', id, body, key, [], async (tx, d) => {
      const route = await this.store.routeOf(tx, id);
      const broken = judgeReassignment({ status: d.status, onLiveRun: route !== null && LIVE_RUN.has(route.status), sameDriver: d.driverId === body.driverId, sameVehicle: d.vehicleLocationId === body.vehicleLocationId });
      this.refuse(id, d, broken);
      await this.deliveries.assertAssignableIn(tx, d.branchId, body.driverId, body.vehicleLocationId);
      const before = await this.deliveries.viewIn(tx, id);
      const at = this.clock.now();
      await this.store.reassign(tx, id, { driverId: body.driverId, vehicleLocationId: body.vehicleLocationId, at, actorId: actor!.principalId });
      const event: DeliveryReassigned = {
        deliveryId: id,
        deliveryNo: d.deliveryNo,
        orderDocumentId: d.orderDocumentId,
        branchId: d.branchId,
        fromDriverId: d.driverId,
        toDriverId: body.driverId,
        fromVehicleLocationId: d.vehicleLocationId,
        toVehicleLocationId: body.vehicleLocationId,
        reassignedAt: at.toISOString(),
      };
      await this.events.publish<DeliveryReassigned>(tx, { type: DELIVERY_REASSIGNED, subjectType: 'Delivery', subjectId: id, branchId: d.branchId, payload: event, occurredAt: at });
      const after = await this.deliveries.viewIn(tx, id);
      await this.audit.record(tx, { module: 'del', action: 'REASSIGN', entityType: 'Delivery', entityId: id, branchId: d.branchId, before: { ...before }, after: { ...after } });
      return { status: 200, body: after };
    });
  }

  /**
   * rescheduleDelivery (FR-DEL-003, FR-DEL-011): another slot, booked under its row lock; for a failed delivery, the
   * reattempt. Bookings of one slot queue on the slot's advisory lock, taken before the transaction begins (ADR-0005),
   * so eight at once book in turn rather than fail each other's serializable snapshot until one runs out of retries.
   */
  reschedule(actor: Actor | undefined, id: string, body: RescheduleRequest, key: string): Promise<StoredResponse<DeliveryView>> {
    return this.command(actor, 'rescheduleDelivery', id, body, key, [slotLockKey(body.slotId)], async (tx, d) => {
      const slot = await this.slots.lock(tx, body.slotId);
      const zone = (await this.storefront.deliveryZonesIn(tx, [d.deliveryZoneId])).get(d.deliveryZoneId);
      const route = await this.store.routeOf(tx, id);
      const now = this.clock.now();
      const broken = judgeBooking({
        status: d.status,
        deliveryZoneId: d.deliveryZoneId,
        currentSlotId: d.slotId,
        slotId: body.slotId,
        slot: slot === null ? 'MISSING' : slot,
        cutoffTime: zone?.cutoffTime ?? '00:00',
        runDate: route !== null && LIVE_RUN.has(route.status) ? route.routeDate : null,
        now,
      });
      if (zone === undefined && broken.every((b) => b.rule !== 'INVALID_STATE_TRANSITION')) broken.push({ field: '/slotId', rule: 'ZONE_NOT_DELIVERING' });
      this.refuse(id, d, broken);
      const reattempt = d.status === 'FAILED';
      const before = await this.deliveries.viewIn(tx, id);
      await this.store.book(tx, id, { slotId: body.slotId, reattempt, at: now, actorId: actor!.principalId });
      const event: DeliveryRescheduled = {
        deliveryId: id,
        deliveryNo: d.deliveryNo,
        orderDocumentId: d.orderDocumentId,
        branchId: d.branchId,
        fromSlotId: d.slotId,
        toSlotId: body.slotId,
        slotDate: slot!.slotDate,
        slotStartsAt: slot!.startsAt,
        slotEndsAt: slot!.endsAt,
        reattempt,
        reason: body.reason,
        rescheduledAt: now.toISOString(),
      };
      await this.events.publish<DeliveryRescheduled>(tx, { type: DELIVERY_RESCHEDULED, subjectType: 'Delivery', subjectId: id, branchId: d.branchId, payload: event, occurredAt: now });
      const after = await this.deliveries.viewIn(tx, id);
      await this.audit.record(tx, { module: 'del', action: reattempt ? 'REATTEMPT' : 'RESCHEDULE', entityType: 'Delivery', entityId: id, branchId: d.branchId, before: { ...before }, after: { ...after, reason: body.reason } });
      return { status: 200, body: after };
    });
  }

  /** The frame: the permission, the key as the first write, the delivery under its row lock (404), the permission at its branch. */
  private command(
    actor: Actor | undefined,
    operationId: string,
    id: string,
    body: object,
    key: string,
    seriesLocks: readonly string[],
    work: (tx: Transaction, d: DeliveryRecord) => Promise<StoredResponse<DeliveryView>>,
  ): Promise<StoredResponse<DeliveryView>> {
    return this.uow.run({ isolation: 'serializable', seriesLocks }, async (tx) => {
      await this.authoriser.authorise(tx, actor, ASSIGN);
      const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key, request: { deliveryId: id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<DeliveryView>;
      const d = await this.store.lock(tx, id);
      if (d === null) throw new NotFoundError('no such delivery');
      await this.authoriser.authorise(tx, actor, ASSIGN, { branchId: d.branchId });
      const response = await work(tx, d);
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  private refuse(id: string, d: DeliveryRecord, broken: readonly SchedulingRule[]): void {
    if (broken.some((b) => b.rule === 'INVALID_STATE_TRANSITION')) throw invalidState(`delivery ${id}`, d.status);
    if (broken.length > 0) throw new DeliveryInvalidError(broken);
  }
}
