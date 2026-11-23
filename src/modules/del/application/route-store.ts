import type { Transaction } from '../../../platform/database/unit-of-work';
import type { RouteStatus, StopCandidate } from '../domain/routes';

export const ROUTE_STORE = Symbol('ROUTE_STORE');

export interface RouteRecord {
  readonly id: string;
  readonly driverId: string;
  /** An Africa/Accra calendar date. */
  readonly routeDate: string;
  readonly vehicleLocationId: string;
  readonly status: RouteStatus;
  readonly startedAt: Date | null;
  readonly postedAt: Date | null;
  readonly branchId: string;
  readonly version: number;
  /** The delivery ids in the order of visit. */
  readonly stops: readonly string[];
}

export interface NewRoute {
  readonly id: string;
  readonly driverId: string;
  readonly routeDate: string;
  readonly vehicleLocationId: string;
  readonly branchId: string;
  readonly stops: readonly string[];
  readonly at: Date;
  readonly actorId: string;
}

/** The cash a run's deliveries collected, what of it the driver still holds, and the hand-ins that took the rest. */
export interface RouteCash {
  readonly collectedPesewas: bigint;
  readonly heldPesewas: bigint;
  readonly reconciliationIds: readonly string[];
}

export interface RouteFilter {
  readonly branchIds: readonly string[];
  readonly date: string | null;
  readonly driverId: string | null;
}

export interface RouteStore {
  insert(tx: Transaction, r: NewRoute): Promise<void>;
  routes(tx: Transaction, ids: readonly string[]): Promise<RouteRecord[]>;
  lock(tx: Transaction, id: string): Promise<RouteRecord | null>;
  ofDriverOn(tx: Transaction, driverId: string, routeDate: string): Promise<string | null>;
  list(tx: Transaction, f: RouteFilter, beforeId: string | null, limit: number): Promise<string[]>;
  /** The deliveries a route is asked to take, as `judgeRouteStops` reads them; dispatch dates in Africa/Accra. */
  candidates(tx: Transaction, deliveryIds: readonly string[]): Promise<StopCandidate[]>;
  reorder(tx: Transaction, id: string, stops: readonly string[], at: Date, actorId: string): Promise<void>;
  start(tx: Transaction, id: string, at: Date, actorId: string): Promise<void>;
  complete(tx: Transaction, id: string, at: Date, actorId: string): Promise<void>;
  cashOf(tx: Transaction, ids: readonly string[]): Promise<Map<string, RouteCash>>;
  /** The route a delivery sits on, and its status; null when it is on none. */
  routeOfDelivery(tx: Transaction, deliveryId: string): Promise<{ readonly id: string; readonly status: RouteStatus } | null>;
}
