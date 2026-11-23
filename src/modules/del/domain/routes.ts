import type { DeliveryStatus, VarianceReason } from './deliveries';

/** The route machine (docs/data-model/del.md); `del.route_guard` holds the same edges. */
export type RouteStatus = 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED';

export interface RouteRule {
  readonly field: string;
  readonly rule: string;
}

/** What a route is for: one driver, one vehicle, one branch, one day (FR-DEL-005). */
export interface RouteFacts {
  readonly driverId: string;
  readonly vehicleLocationId: string;
  readonly branchId: string;
  /** An Africa/Accra calendar date. */
  readonly routeDate: string;
}

/** A delivery a route is asked to take, as DEL holds it. */
export interface StopCandidate {
  readonly id: string;
  readonly status: DeliveryStatus;
  readonly driverId: string | null;
  readonly vehicleLocationId: string | null;
  readonly branchId: string;
  /** The live route it already sits on, if any. */
  readonly onRouteId: string | null;
  /** The Africa/Accra date it was dispatched on. */
  readonly dispatchedOn: string;
}

const EDGES: Readonly<Record<RouteStatus, readonly RouteStatus[]>> = { PLANNED: ['IN_PROGRESS'], IN_PROGRESS: ['COMPLETED'], COMPLETED: [] };

export function canMoveRoute(from: RouteStatus, to: RouteStatus): boolean {
  return EDGES[from].includes(to);
}

function repeated(ids: readonly string[]): boolean {
  return new Set(ids).size !== ids.length;
}

/**
 * The stops a route takes (FR-DEL-005, A-337): at least one; each delivery once; each a delivery assigned and still
 * waiting on the van (ASSIGNED: dispatch loaded it, ADR-0092), to the route's driver, on the route's vehicle, at its
 * branch, on no other route, dispatched on or before the route's date. The database holds the same (`ck_route_stop`).
 */
export function judgeRouteStops(route: RouteFacts, requested: readonly string[], found: readonly StopCandidate[]): RouteRule[] {
  if (requested.length === 0) return [{ field: '/deliveryIds', rule: 'NO_STOPS' }];
  if (repeated(requested)) return [{ field: '/deliveryIds', rule: 'STOP_REPEATED' }];
  const byId = new Map(found.map((c) => [c.id, c] as const));
  const broken: RouteRule[] = [];
  requested.forEach((id, i) => {
    const field = `/deliveryIds/${i}`;
    const c = byId.get(id);
    if (c === undefined) broken.push({ field, rule: 'DELIVERY_UNKNOWN' });
    else if (c.branchId !== route.branchId) broken.push({ field, rule: 'OTHER_BRANCH' });
    else if (c.status !== 'ASSIGNED') broken.push({ field, rule: 'NOT_ASSIGNED' });
    else if (c.driverId !== route.driverId) broken.push({ field, rule: 'NOT_THE_DRIVERS' });
    else if (c.vehicleLocationId !== route.vehicleLocationId) broken.push({ field, rule: 'NOT_ON_THE_VEHICLE' });
    else if (c.onRouteId !== null) broken.push({ field, rule: 'ON_ANOTHER_ROUTE' });
    else if (c.dispatchedOn > route.routeDate) broken.push({ field, rule: 'DISPATCHED_AFTER_ROUTE_DATE' });
  });
  return broken;
}

/** A new order of a route's stops names exactly the stops it has, each once (a stop is moved, never added or dropped here). */
export function judgeReorder(current: readonly string[], requested: readonly string[]): RouteRule[] {
  const broken: RouteRule[] = [];
  if (repeated(requested)) broken.push({ field: '/deliveryIds', rule: 'STOP_REPEATED' });
  const have = new Set(current);
  if (requested.length !== current.length || new Set(requested).size !== have.size || requested.some((id) => !have.has(id))) {
    broken.push({ field: '/deliveryIds', rule: 'NOT_THE_SAME_STOPS' });
  }
  return broken;
}

/**
 * A stop's goods have left the van: delivered to the customer, or returned to stock (the owner, 2026-11-23: "every item
 * is delivered, returned to stock or written off with a reason"; the write-off is B11 continued 4's and joins this list).
 */
export function leftTheVan(status: DeliveryStatus): boolean {
  return status === 'DELIVERED' || status === 'RETURNED';
}

/**
 * Closing a run (the owner, 2026-11-23): refused while any stop's goods are still on the van (each named), or while any
 * cash collected on the run is still held by the driver, not handed in at a till shift (A-345). The database holds the
 * same at commit (`ck_route_closed`).
 */
export function judgeClose(stops: readonly { readonly deliveryId: string; readonly status: DeliveryStatus }[], heldPesewas: bigint): RouteRule[] {
  const broken: RouteRule[] = stops.filter((s) => !leftTheVan(s.status)).map((s) => ({ field: `/stops/${s.deliveryId}`, rule: 'GOODS_ON_VAN' }));
  if (heldPesewas > 0n) broken.push({ field: '', rule: 'CASH_NOT_HANDED_IN' });
  return broken;
}

/**
 * On the way (FR-DEL-007): an assigned delivery is recorded on its way once; one already on its way answers as it stands
 * and records nothing more; any other is refused (a delivered stop 422).
 */
export function judgeOnTheWay(status: DeliveryStatus): 'RECORD' | 'ALREADY' | 'REFUSE' {
  if (status === 'ASSIGNED') return 'RECORD';
  if (status === 'OUT_FOR_DELIVERY') return 'ALREADY';
  return 'REFUSE';
}

/** A failed attempt is taken on a delivery waiting on the van or on its way, never one finished or already failed. */
export function takesFailure(status: DeliveryStatus): boolean {
  return status === 'ASSIGNED' || status === 'OUT_FOR_DELIVERY';
}

export interface FailureFacts {
  readonly reason: VarianceReason;
  readonly occurredAt: Date;
  readonly dispatchedAt: Date;
  readonly latitude: string | undefined;
  readonly longitude: string | undefined;
}

const DELIVERY_FAILURE = 'DELIVERY_FAILURE';

/** FR-DEL-011: a failed attempt names a reason from the fixed DELIVERY_FAILURE list, at or after dispatch, a whole position or none. */
export function judgeFailure(f: FailureFacts): RouteRule[] {
  const broken: RouteRule[] = [];
  if (f.reason === null || f.reason === 'UNKNOWN') broken.push({ field: '/failureReasonCode', rule: 'REASON_UNKNOWN' });
  else if (f.reason.domain !== DELIVERY_FAILURE) broken.push({ field: '/failureReasonCode', rule: 'REASON_NOT_ALLOWED' });
  if (f.occurredAt.getTime() < f.dispatchedAt.getTime()) broken.push({ field: '/occurredAt', rule: 'OCCURRED_BEFORE_DISPATCH' });
  if ((f.latitude === undefined) !== (f.longitude === undefined)) broken.push({ field: f.latitude === undefined ? '/latitude' : '/longitude', rule: 'POSITION_INCOMPLETE' });
  return broken;
}
