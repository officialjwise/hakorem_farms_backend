import { createUuidV7Generator, Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { InvalidStateTransitionError, NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import { translate } from '../../../platform/i18n/messages';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { pageProbe, stopNo } from '../domain/numbering';
import { canMoveRoute, judgeClose, judgeReorder, judgeRouteStops, leftTheVan, type RouteStatus } from '../domain/routes';
import type { RouteCompleted } from '../events';
import type { Deliveries, Page } from './deliveries';
import type { DeliveryRecord, DeliveryStore } from './delivery-store';
import { RouteInvalidError } from './errors';
import type { RouteCash, RouteRecord, RouteStore } from './route-store';

const READ = 'del.route.read';
const MANAGE = 'del.route.manage';
const READ_MINE = 'del.delivery.read.assigned';
/** Who may drive: a holder of the driver's proof permission at the branch (CR-056 item 1, A-337 (d)). */
const DRIVES = 'del.proof.create';
export const ROUTE_COMPLETED = 'del.RouteCompleted';

/** The contract's `RouteStopDelivery`; the slot is null until slot booking (B11 continued 4). */
export interface RouteStopDeliveryView {
  readonly id: string;
  readonly deliveryNo: string | null;
  readonly recipientName: string;
  readonly area: string;
  readonly status: string;
  readonly codDuePesewas: number;
  readonly slotStartsAt: null;
  readonly slotEndsAt: null;
}

/** The contract's `Route`, with what is still on the van, the cash collected and still held, and the hand-ins that took it. */
export interface RouteView {
  readonly id: string;
  readonly driver: { readonly id: string; readonly displayName: string };
  readonly routeDate: string;
  readonly vehicle: { readonly id: string; readonly code: string; readonly name: string; readonly kind: string };
  readonly status: RouteStatus;
  readonly stops: readonly { readonly stopNo: number; readonly delivery: RouteStopDeliveryView }[];
  readonly stopsOnVan: number;
  readonly codDueTotalPesewas: number;
  readonly codCollectedPesewas: number;
  readonly codHeldPesewas: number;
  readonly handIns: readonly { readonly id: string }[];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly currency: 'GHS';
  readonly branchId: string;
  readonly version: number;
}

export interface RouteCreateRequest {
  readonly driverId: string;
  readonly routeDate: string;
  readonly vehicleLocationId: string;
  readonly deliveryIds: readonly string[];
}

export interface RouteQuery {
  readonly date: string | null;
  readonly driverId: string | null;
}

const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();
const invalidState = (what: string, status: string) =>
  new InvalidStateTransitionError(`${what} is ${status}`, [{ field: null, code: status, message: translate('error.invalid_state_transition') }]);
const NO_CASH: RouteCash = { collectedPesewas: 0n, heldPesewas: 0n, reconciliationIds: [] };

/**
 * A driver's run for a day (FR-DEL-005, FR-DEL-004, CR-056 items 3 and 4, CR-057 point 2, A-337 and the owner's close
 * rule, 2026-11-23). The Manager plans a run of the driver's loaded deliveries (dispatch put the goods on the van,
 * ADR-0092), orders its stops by hand (no optimisation, BL-033), starts it on its day and closes it only when every
 * stop's goods have left the van and every collection made on it has been handed in at a till shift (the hand-ins are
 * then recorded against the run). A driver reads only their own run (`getMyRoute`; none that day is 404). Each handler
 * authorises in the application layer at the run's branch, deny by default (ADR-0035); every write is audited.
 */
export class Routes {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: RouteStore,
    private readonly deliveryStore: DeliveryStore,
    private readonly deliveries: Deliveries,
    private readonly refs: MasterDataRefs,
    private readonly events: DomainEvents,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly authoriser: Authoriser,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /**
   * createRoute: at the vehicle's branch, a driver who drives for it on a live vehicle of it, a date not past, the driver's
   * only run that day, and stops that `judgeRouteStops` takes, in the order given.
   */
  create(actor: Actor | undefined, body: RouteCreateRequest, key: string): Promise<StoredResponse<RouteView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId: 'createRoute', principalId: actor!.principalId, key, request: { ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<RouteView>;
      const vehicle = (await this.refs.locationsIn(tx, [body.vehicleLocationId])).get(body.vehicleLocationId);
      if (vehicle === undefined) throw new RouteInvalidError([{ field: '/vehicleLocationId', rule: 'NOT_A_VEHICLE' }]);
      await this.authoriser.authorise(tx, actor, MANAGE, { branchId: vehicle.branchId });
      await this.deliveries.assertAssignableIn(tx, vehicle.branchId, body.driverId, body.vehicleLocationId);
      const facts = { driverId: body.driverId, vehicleLocationId: body.vehicleLocationId, branchId: vehicle.branchId, routeDate: body.routeDate };
      const broken = judgeRouteStops(facts, body.deliveryIds, await this.store.candidates(tx, body.deliveryIds));
      if (body.routeDate < toBusinessDate(this.clock.now())) broken.unshift({ field: '/routeDate', rule: 'ROUTE_DATE_PAST' });
      if ((await this.store.ofDriverOn(tx, body.driverId, body.routeDate)) !== null) broken.unshift({ field: '/routeDate', rule: 'DRIVER_HAS_A_ROUTE' });
      if (broken.length > 0) throw new RouteInvalidError(broken);

      const id = this.nextId();
      await this.store.insert(tx, { id, ...facts, stops: body.deliveryIds, at: this.clock.now(), actorId: actor!.principalId });
      const view = await this.viewIn(tx, id);
      await this.audit.record(tx, { module: 'del', action: 'CREATE', entityType: 'Route', entityId: id, branchId: vehicle.branchId, before: null, after: { ...view } });
      const response = { status: 201, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** getRoute: at the run's branch; another branch's is refused as any other. */
  get(actor: Actor | undefined, id: string): Promise<RouteView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const [found] = await this.store.routes(tx, [id]);
      if (found === undefined) throw new NotFoundError('no such route');
      await this.authoriser.authorise(tx, actor, READ, { branchId: found.branchId });
      return this.viewIn(tx, id);
    });
  }

  /** listRoutes: the runs at the branches the caller reads whole, newest first, by date or driver. */
  list(actor: Actor | undefined, query: RouteQuery, cursor: string | undefined, limit: number): Promise<Page<RouteView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = [...new Set((await this.authoriser.scopes(tx, actor!, READ)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
      const binding = { operationId: 'listRoutes', principalId: actor!.principalId, filters: { ...query } };
      const beforeId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.list(tx, { branchIds, ...query }, beforeId, pageProbe(limit));
      const data = await this.viewsIn(tx, await this.store.routes(tx, found.slice(0, limit)));
      const hasMore = found.length > limit;
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  /** reorderRouteStops: a planned run's same stops in a new order, at the version read (409 otherwise). */
  reorder(actor: Actor | undefined, id: string, body: { readonly version: number; readonly deliveryIds: readonly string[] }, key: string): Promise<StoredResponse<RouteView>> {
    return this.write(actor, 'reorderRouteStops', id, body, key, async (tx, route, at, actorId) => {
      if (route.status !== 'PLANNED') throw invalidState(`route ${id}`, route.status);
      if (route.version !== body.version) throw new VersionConflictError(`route ${id} is at version ${route.version}, not ${body.version}`);
      const broken = judgeReorder(route.stops, body.deliveryIds);
      if (broken.length > 0) throw new RouteInvalidError(broken);
      await this.store.reorder(tx, id, body.deliveryIds, at, actorId);
      return 'REORDER';
    });
  }

  /** startRoute: a planned run, on or after its day (a run is never started before it). */
  start(actor: Actor | undefined, id: string, key: string): Promise<StoredResponse<RouteView>> {
    return this.write(actor, 'startRoute', id, {}, key, async (tx, route, at, actorId) => {
      if (!canMoveRoute(route.status, 'IN_PROGRESS')) throw invalidState(`route ${id}`, route.status);
      if (route.routeDate > toBusinessDate(at)) throw new RouteInvalidError([{ field: '', rule: 'NOT_ITS_DAY' }]);
      await this.store.start(tx, id, at, actorId);
      return 'START';
    });
  }

  /**
   * completeRoute (the owner, 2026-11-23): a started run closes only when every stop's goods have left the van and no
   * collection made on it is still held by the driver; the hand-ins that took its cash are recorded against it.
   */
  complete(actor: Actor | undefined, id: string, key: string): Promise<StoredResponse<RouteView>> {
    return this.write(actor, 'completeRoute', id, {}, key, async (tx, route, at, actorId) => {
      if (!canMoveRoute(route.status, 'COMPLETED')) throw invalidState(`route ${id}`, route.status);
      const stops = await this.deliveryStore.deliveries(tx, route.stops);
      const cash = (await this.store.cashOf(tx, [id])).get(id) ?? NO_CASH;
      const broken = judgeClose(
        stops.map((d) => ({ deliveryId: d.id, status: d.status })),
        cash.heldPesewas,
      );
      if (broken.length > 0) throw new RouteInvalidError(broken);
      await this.store.complete(tx, id, at, actorId);
      const completed: RouteCompleted = {
        routeId: id,
        driverId: route.driverId,
        routeDate: route.routeDate,
        branchId: route.branchId,
        deliveryIds: route.stops,
        codCollectedPesewas: json(cash.collectedPesewas),
        reconciliationIds: cash.reconciliationIds,
        completedAt: at.toISOString(),
      };
      await this.events.publish<RouteCompleted>(tx, { type: ROUTE_COMPLETED, subjectType: 'Route', subjectId: id, branchId: route.branchId, payload: completed, occurredAt: at });
      return 'COMPLETE';
    });
  }

  /** getMyRoute (CR-057 point 2): the caller's own run that day (today in Africa/Accra by default); none is 404, nobody else's ever. */
  getMine(actor: Actor | undefined, date: string | undefined): Promise<RouteView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ_MINE);
      const id = await this.store.ofDriverOn(tx, actor!.principalId, date ?? toBusinessDate(this.clock.now()));
      if (id === null) throw new NotFoundError('no route for the caller that day');
      return this.viewIn(tx, id);
    });
  }

  /**
   * listDrivers (CR-056 item 4): who a delivery or a run at the branch may be given, as dispatch and `createRoute` judge
   * it (a holder of the driver's proof permission there, A-337 (d)), by name, without `iam.user.read`.
   */
  drivers(actor: Actor | undefined, branchId: string | undefined, cursor: string | undefined, limit: number): Promise<Page<{ readonly id: string; readonly displayName: string }>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      if (branchId !== undefined) await this.authoriser.authorise(tx, actor, MANAGE, { branchId });
      // With no branch named, every branch the caller manages whole.
      const branchIds = branchId !== undefined ? [branchId] : [...new Set((await this.authoriser.scopes(tx, actor!, MANAGE)).filter((s) => s.locationId === null).map((s) => s.branchId))];
      const binding = { operationId: 'listDrivers', principalId: actor!.principalId, filters: { branchId: branchId ?? null } };
      const afterId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const held = new Set<string>();
      for (const b of branchIds) for (const id of await this.authoriser.holdersIn(tx, DRIVES, b)) held.add(id);
      const ids = [...held].sort().filter((id) => afterId === null || id > afterId);
      const names = await this.principals.refs(tx, ids.slice(0, limit));
      const data = ids.slice(0, limit).map((id) => names.get(id) ?? { id, displayName: id });
      const hasMore = ids.length > limit;
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  /** A write on a run: the permission, the key as the first write, the run locked and authorised at its branch, audited. */
  private write(
    actor: Actor | undefined,
    operationId: string,
    id: string,
    body: object,
    key: string,
    apply: (tx: Transaction, route: RouteRecord, at: Date, actorId: string) => Promise<string>,
  ): Promise<StoredResponse<RouteView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<RouteView>;
      const route = await this.store.lock(tx, id);
      if (route === null) throw new NotFoundError('no such route');
      await this.authoriser.authorise(tx, actor, MANAGE, { branchId: route.branchId });
      const before = await this.viewIn(tx, id);
      const action = await apply(tx, route, this.clock.now(), actor!.principalId);
      const after = await this.viewIn(tx, id);
      await this.audit.record(tx, { module: 'del', action, entityType: 'Route', entityId: id, branchId: route.branchId, before: { ...before }, after: { ...after } });
      const response = { status: 200, body: after };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  private async viewIn(tx: Transaction, id: string): Promise<RouteView> {
    return (await this.viewsIn(tx, await this.store.routes(tx, [id])))[0]!;
  }

  private async viewsIn(tx: Transaction, routes: readonly RouteRecord[]): Promise<RouteView[]> {
    if (routes.length === 0) return [];
    const deliveries = new Map((await this.deliveryStore.deliveries(tx, routes.flatMap((r) => r.stops))).map((d) => [d.id, d] as const));
    const vehicles = await this.refs.locationsIn(tx, [...new Set(routes.map((r) => r.vehicleLocationId))]);
    const drivers = await this.principals.refs(tx, [...new Set(routes.map((r) => r.driverId))]);
    const cash = await this.store.cashOf(
      tx,
      routes.map((r) => r.id),
    );
    return routes.map((r) => {
      const stops = r.stops.map((deliveryId) => deliveries.get(deliveryId)!);
      const vehicle = vehicles.get(r.vehicleLocationId);
      const money = cash.get(r.id) ?? NO_CASH;
      return {
        id: r.id,
        driver: drivers.get(r.driverId) ?? { id: r.driverId, displayName: r.driverId },
        routeDate: r.routeDate,
        vehicle: { id: r.vehicleLocationId, code: vehicle?.code ?? '', name: vehicle?.name ?? '', kind: vehicle?.kind ?? 'VEHICLE' },
        status: r.status,
        stops: stops.map((d, i) => ({ stopNo: stopNo(i), delivery: stopOf(d) })),
        stopsOnVan: stops.filter((d) => !leftTheVan(d.status)).length,
        codDueTotalPesewas: Money.sum(stops.map((d) => Money.ofPesewas(d.codDuePesewas))).toJsonInteger(),
        codCollectedPesewas: json(money.collectedPesewas),
        codHeldPesewas: json(money.heldPesewas),
        handIns: money.reconciliationIds.map((reconciliationId) => ({ id: reconciliationId })),
        startedAt: r.startedAt?.toISOString() ?? null,
        completedAt: r.postedAt?.toISOString() ?? null,
        currency: 'GHS' as const,
        branchId: r.branchId,
        version: r.version,
      };
    });
  }
}

function stopOf(d: DeliveryRecord): RouteStopDeliveryView {
  const area = d.addressSnapshot['area'];
  return {
    id: d.id,
    deliveryNo: d.deliveryNo,
    recipientName: d.recipientName,
    area: typeof area === 'string' ? area : '',
    status: d.status,
    codDuePesewas: json(d.codDuePesewas),
    slotStartsAt: null,
    slotEndsAt: null,
  };
}
