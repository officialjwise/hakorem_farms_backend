import { describe, expect, it } from 'vitest';
import { canMoveRoute, judgeClose, judgeFailure, judgeOnTheWay, judgeReorder, judgeRouteStops, leftTheVan, type StopCandidate } from './routes';

const route = { driverId: 'd1', vehicleLocationId: 'v1', branchId: 'b1', routeDate: '2026-11-23' };
const candidate = (over: Partial<StopCandidate> = {}): StopCandidate => ({
  id: 'x1',
  status: 'ASSIGNED',
  driverId: 'd1',
  vehicleLocationId: 'v1',
  branchId: 'b1',
  onRouteId: null,
  dispatchedOn: '2026-11-23',
  ...over,
});
const rules = (r: readonly { readonly rule: string }[]) => r.map((x) => x.rule);

describe("a route's stops (FR-DEL-005): the driver's own loaded deliveries, each on one route", () => {
  it('takes assigned deliveries of the route driver on the route vehicle at its branch, dispatched by its date', () => {
    expect(judgeRouteStops(route, ['x1', 'x2'], [candidate(), candidate({ id: 'x2', dispatchedOn: '2026-11-22' })])).toEqual([]);
  });

  it('refuses a route with no stops and a delivery named twice', () => {
    expect(rules(judgeRouteStops(route, [], []))).toEqual(['NO_STOPS']);
    expect(rules(judgeRouteStops(route, ['x1', 'x1'], [candidate()]))).toEqual(['STOP_REPEATED']);
  });

  it('refuses an unknown delivery and one that is not waiting on the van', () => {
    expect(rules(judgeRouteStops(route, ['x9'], []))).toEqual(['DELIVERY_UNKNOWN']);
    for (const status of ['SCHEDULED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED'] as const) {
      expect(rules(judgeRouteStops(route, ['x1'], [candidate({ status })])), status).toEqual(['NOT_ASSIGNED']);
    }
  });

  it("refuses another driver's delivery, another vehicle's, another branch's, one on another route and one dispatched after the route's date", () => {
    expect(rules(judgeRouteStops(route, ['x1'], [candidate({ driverId: 'd2' })]))).toEqual(['NOT_THE_DRIVERS']);
    expect(rules(judgeRouteStops(route, ['x1'], [candidate({ vehicleLocationId: 'v2' })]))).toEqual(['NOT_ON_THE_VEHICLE']);
    expect(rules(judgeRouteStops(route, ['x1'], [candidate({ branchId: 'b2' })]))).toEqual(['OTHER_BRANCH']);
    expect(rules(judgeRouteStops(route, ['x1'], [candidate({ onRouteId: 'r9' })]))).toEqual(['ON_ANOTHER_ROUTE']);
    expect(rules(judgeRouteStops(route, ['x1'], [candidate({ dispatchedOn: '2026-11-24' })]))).toEqual(['DISPATCHED_AFTER_ROUTE_DATE']);
  });
});

describe("a route's new order (FR-DEL-005): the same stops, each once", () => {
  it('takes the same deliveries in any order', () => {
    expect(judgeReorder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual([]);
  });

  it('refuses a stop left out, one added and one named twice', () => {
    expect(rules(judgeReorder(['a', 'b', 'c'], ['a', 'b']))).toEqual(['NOT_THE_SAME_STOPS']);
    expect(rules(judgeReorder(['a', 'b'], ['a', 'b', 'c']))).toEqual(['NOT_THE_SAME_STOPS']);
    expect(rules(judgeReorder(['a', 'b'], ['a', 'a']))).toEqual(['STOP_REPEATED', 'NOT_THE_SAME_STOPS']);
  });
});

describe('the route machine', () => {
  it('moves PLANNED to IN_PROGRESS to COMPLETED and nowhere else', () => {
    expect([canMoveRoute('PLANNED', 'IN_PROGRESS'), canMoveRoute('IN_PROGRESS', 'COMPLETED')]).toEqual([true, true]);
    expect([canMoveRoute('PLANNED', 'COMPLETED'), canMoveRoute('COMPLETED', 'IN_PROGRESS'), canMoveRoute('IN_PROGRESS', 'PLANNED')]).toEqual([false, false, false]);
  });
});

describe('closing a run (the owner, 2026-11-23): nothing left on the van and no cash still held', () => {
  it('counts only a delivered or returned stop as off the van', () => {
    expect(['ASSIGNED', 'OUT_FOR_DELIVERY', 'FAILED', 'DELIVERED', 'RETURNED', 'WRITTEN_OFF'].map((s) => leftTheVan(s as never))).toEqual([false, false, false, true, true, true]);
  });

  it('closes when every stop is delivered, returned or written off and every collection was handed in', () => {
    expect(judgeClose([{ deliveryId: 'a', status: 'DELIVERED' }, { deliveryId: 'b', status: 'RETURNED' }, { deliveryId: 'c', status: 'WRITTEN_OFF' }], 0n)).toEqual([]);
  });

  it('refuses each stop still on the van, by its delivery', () => {
    expect(judgeClose([{ deliveryId: 'a', status: 'DELIVERED' }, { deliveryId: 'b', status: 'FAILED' }, { deliveryId: 'c', status: 'OUT_FOR_DELIVERY' }], 0n)).toEqual([
      { field: '/stops/b', rule: 'GOODS_ON_VAN' },
      { field: '/stops/c', rule: 'GOODS_ON_VAN' },
    ]);
  });

  it('refuses while one pesewa collected on the run is still held by the driver', () => {
    expect(judgeClose([{ deliveryId: 'a', status: 'DELIVERED' }], 1n)).toEqual([{ field: '', rule: 'CASH_NOT_HANDED_IN' }]);
  });
});

describe('on the way (FR-DEL-007)', () => {
  it('takes an assigned delivery, answers one already on its way unchanged, and refuses a finished one', () => {
    expect(judgeOnTheWay('ASSIGNED')).toBe('RECORD');
    expect(judgeOnTheWay('OUT_FOR_DELIVERY')).toBe('ALREADY');
    for (const status of ['SCHEDULED', 'DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED'] as const) expect(judgeOnTheWay(status), status).toBe('REFUSE');
  });
});

describe('a failed attempt (FR-DEL-011)', () => {
  const at = new Date('2026-11-23T12:00:00Z');
  const ok = { reason: { domain: 'DELIVERY_FAILURE', requiresNote: false }, occurredAt: at, dispatchedAt: new Date('2026-11-23T09:00:00Z'), latitude: undefined, longitude: undefined } as const;

  it('takes a DELIVERY_FAILURE reason at or after dispatch', () => {
    expect(judgeFailure(ok)).toEqual([]);
    expect(judgeFailure({ ...ok, occurredAt: ok.dispatchedAt })).toEqual([]);
  });

  it('refuses an unknown reason, a reason of another kind, a time before dispatch and half a position', () => {
    expect(rules(judgeFailure({ ...ok, reason: 'UNKNOWN' }))).toEqual(['REASON_UNKNOWN']);
    expect(rules(judgeFailure({ ...ok, reason: { domain: 'COD_VARIANCE', requiresNote: false } }))).toEqual(['REASON_NOT_ALLOWED']);
    expect(rules(judgeFailure({ ...ok, occurredAt: new Date(ok.dispatchedAt.getTime() - 1) }))).toEqual(['OCCURRED_BEFORE_DISPATCH']);
    expect(rules(judgeFailure({ ...ok, latitude: '5.600000' }))).toEqual(['POSITION_INCOMPLETE']);
  });
});
