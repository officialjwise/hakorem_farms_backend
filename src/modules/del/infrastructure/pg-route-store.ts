import type { Transaction } from '../../../platform/database/unit-of-work';
import type { NewRoute, RouteCash, RouteFilter, RouteRecord, RouteStore } from '../application/route-store';
import type { DeliveryStatus } from '../domain/deliveries';
import type { RouteStatus, StopCandidate } from '../domain/routes';

interface RouteRow {
  id: string;
  driver_id: string;
  route_date: string;
  vehicle_location_id: string;
  status: RouteStatus;
  started_at: Date | null;
  posted_at: Date | null;
  branch_id: string;
  version: number;
  stops: string[] | null;
}

const COLUMNS = `r.id, r.driver_id, to_char(r.route_date, 'YYYY-MM-DD') AS route_date, r.vehicle_location_id, r.status, r.started_at, r.posted_at, r.branch_id, r.version,
  (SELECT array_agg(s.delivery_id ORDER BY s.stop_no) FROM del.route_stop s WHERE s.route_id = r.id) AS stops`;

const toRecord = (r: RouteRow): RouteRecord => ({
  id: r.id,
  driverId: r.driver_id,
  routeDate: r.route_date,
  vehicleLocationId: r.vehicle_location_id,
  status: r.status,
  startedAt: r.started_at,
  postedAt: r.posted_at,
  branchId: r.branch_id,
  version: r.version,
  stops: r.stops ?? [],
});

/** DEL's routes in PostgreSQL (migration 0318). Plain parameterised SQL; every time is the caller's clock (ADR-0067). */
export class PgRouteStore implements RouteStore {
  async insert(tx: Transaction, r: NewRoute): Promise<void> {
    await tx.query(
      `INSERT INTO del.route (id, driver_id, route_date, vehicle_location_id, status, branch_id, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3::date, $4, 'PLANNED', $5, $6, $7, $6, $7)`,
      [r.id, r.driverId, r.routeDate, r.vehicleLocationId, r.branchId, r.at, r.actorId],
    );
    await tx.query(
      `INSERT INTO del.route_stop (route_id, stop_no, delivery_id, created_at, created_by, updated_at, updated_by)
       SELECT $1, s.n, s.delivery_id, $3, $4, $3, $4 FROM unnest($2::uuid[]) WITH ORDINALITY AS s (delivery_id, n)`,
      [r.id, [...r.stops], r.at, r.actorId],
    );
  }

  async routes(tx: Transaction, ids: readonly string[]): Promise<RouteRecord[]> {
    if (ids.length === 0) return [];
    const rows = (await tx.query<RouteRow>(`SELECT ${COLUMNS} FROM del.route r WHERE r.id = ANY($1::uuid[])`, [[...ids]])).rows.map(toRecord);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  }

  async lock(tx: Transaction, id: string): Promise<RouteRecord | null> {
    const row = (await tx.query<RouteRow>(`SELECT ${COLUMNS} FROM del.route r WHERE r.id = $1 FOR UPDATE`, [id])).rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async ofDriverOn(tx: Transaction, driverId: string, routeDate: string): Promise<string | null> {
    return (await tx.query<{ id: string }>(`SELECT id FROM del.route WHERE driver_id = $1 AND route_date = $2::date`, [driverId, routeDate])).rows[0]?.id ?? null;
  }

  async list(tx: Transaction, f: RouteFilter, beforeId: string | null, limit: number): Promise<string[]> {
    if (f.branchIds.length === 0) return [];
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM del.route
        WHERE branch_id = ANY($1::uuid[]) AND ($2::date IS NULL OR route_date = $2::date) AND ($3::uuid IS NULL OR driver_id = $3)
          AND ($4::uuid IS NULL OR id < $4)
        ORDER BY id DESC LIMIT $5`,
      [[...f.branchIds], f.date, f.driverId, beforeId, limit],
    );
    return rows.map((r) => r.id);
  }

  async candidates(tx: Transaction, deliveryIds: readonly string[]): Promise<StopCandidate[]> {
    if (deliveryIds.length === 0) return [];
    const { rows } = await tx.query<{ id: string; status: DeliveryStatus; driver_id: string | null; vehicle_location_id: string | null; branch_id: string; route_id: string | null; dispatched_on: string }>(
      `SELECT d.id, d.status, d.driver_id, d.vehicle_location_id, d.branch_id, s.route_id,
              to_char(d.dispatched_at AT TIME ZONE 'Africa/Accra', 'YYYY-MM-DD') AS dispatched_on
         FROM del.delivery d LEFT JOIN del.route_stop s ON s.delivery_id = d.id
        WHERE d.id = ANY($1::uuid[])`,
      [[...deliveryIds]],
    );
    return rows.map((r) => ({ id: r.id, status: r.status, driverId: r.driver_id, vehicleLocationId: r.vehicle_location_id, branchId: r.branch_id, onRouteId: r.route_id, dispatchedOn: r.dispatched_on }));
  }

  async reorder(tx: Transaction, id: string, stops: readonly string[], at: Date, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE del.route_stop s SET stop_no = x.n, updated_at = $3, updated_by = $4
         FROM unnest($2::uuid[]) WITH ORDINALITY AS x (delivery_id, n)
        WHERE s.route_id = $1 AND s.delivery_id = x.delivery_id AND s.stop_no IS DISTINCT FROM x.n`,
      [id, [...stops], at, actorId],
    );
    await this.touch(tx, id, at, actorId);
  }

  async start(tx: Transaction, id: string, at: Date, actorId: string): Promise<void> {
    await tx.query(`UPDATE del.route SET status = 'IN_PROGRESS', started_at = $2, started_by = $3, updated_by = $3, version = version + 1 WHERE id = $1`, [id, at, actorId]);
  }

  async complete(tx: Transaction, id: string, at: Date, actorId: string): Promise<void> {
    await tx.query(`UPDATE del.route SET status = 'COMPLETED', posted_at = $2, posted_by = $3, updated_by = $3, version = version + 1 WHERE id = $1`, [id, at, actorId]);
  }

  async cashOf(tx: Transaction, ids: readonly string[]): Promise<Map<string, RouteCash>> {
    const found = new Map<string, RouteCash>(ids.map((id) => [id, { collectedPesewas: 0n, heldPesewas: 0n, reconciliationIds: [] }]));
    if (ids.length === 0) return found;
    const { rows } = await tx.query<{ route_id: string; collected: string; held: string; reconciliations: string[] | null }>(
      `SELECT s.route_id,
              COALESCE(sum(p.cod_collected_pesewas), 0)::text AS collected,
              COALESCE(sum(p.cod_collected_pesewas) FILTER (WHERE h.proof_id IS NULL), 0)::text AS held,
              array_agg(DISTINCT h.reconciliation_id ORDER BY h.reconciliation_id) FILTER (WHERE h.reconciliation_id IS NOT NULL) AS reconciliations
         FROM del.route_stop s
         JOIN del.proof_of_delivery p ON p.delivery_id = s.delivery_id AND p.payment_id IS NOT NULL
         LEFT JOIN del.driver_cash_handed_in h ON h.proof_id = p.id
        WHERE s.route_id = ANY($1::uuid[])
        GROUP BY s.route_id`,
      [[...ids]],
    );
    for (const r of rows) found.set(r.route_id, { collectedPesewas: BigInt(r.collected), heldPesewas: BigInt(r.held), reconciliationIds: r.reconciliations ?? [] });
    return found;
  }

  async routeOfDelivery(tx: Transaction, deliveryId: string): Promise<{ readonly id: string; readonly status: RouteStatus } | null> {
    const row = (await tx.query<{ id: string; status: RouteStatus }>(`SELECT r.id, r.status FROM del.route_stop s JOIN del.route r ON r.id = s.route_id WHERE s.delivery_id = $1`, [deliveryId])).rows[0];
    return row ?? null;
  }

  private async touch(tx: Transaction, id: string, at: Date, actorId: string): Promise<void> {
    await tx.query(`UPDATE del.route SET updated_at = $2, updated_by = $3, version = version + 1 WHERE id = $1`, [id, at, actorId]);
  }
}
