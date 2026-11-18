import type { Transaction } from '../../../platform/database/unit-of-work';
import type {
  StandingOrderChange,
  StandingOrderFilter,
  StandingOrderLineRecord,
  StandingOrderRecord,
  StandingOrderRunRecord,
  StandingOrderStore,
} from '../application/standing-order-store';

const ORDER = `id, customer_id, branch_id, frequency, weekdays, day_of_month, interval_days, starts_on::text, ends_on::text, next_run_on::text, salesperson_id, status, version`;
type RawOrder = {
  id: string;
  customer_id: string;
  branch_id: string;
  frequency: StandingOrderRecord['frequency'];
  weekdays: number[];
  day_of_month: number | null;
  interval_days: number | null;
  starts_on: string;
  ends_on: string | null;
  next_run_on: string | null;
  salesperson_id: string;
  status: StandingOrderRecord['status'];
  version: number;
};

const RUN = `standing_order_id, run_date::text, outcome, order_id, reason, recorded_at`;
type RawRun = { standing_order_id: string; run_date: string; outcome: StandingOrderRunRecord['outcome']; order_id: string | null; reason: string | null; recorded_at: Date };
const runOf = (r: RawRun): StandingOrderRunRecord => ({ standingOrderId: r.standing_order_id, runDate: r.run_date, outcome: r.outcome, orderId: r.order_id, reason: r.reason, recordedAt: r.recorded_at });

/** WHL's standing orders and their runs (migration 0272). Parameterised SQL only. */
export class PgStandingOrderStore implements StandingOrderStore {
  async insert(tx: Transaction, o: Omit<StandingOrderRecord, 'version' | 'lines'>, actorId: string, at: Date): Promise<void> {
    await tx.query(
      `INSERT INTO whl.standing_order (id, customer_id, frequency, weekdays, day_of_month, interval_days, starts_on, ends_on, next_run_on, salesperson_id, status, branch_id,
                                       created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4::integer[], $5, $6, $7::date, $8::date, $9::date, $10, $11, $12, $13, $14, $13, $14)`,
      [o.id, o.customerId, o.frequency, o.weekdays, o.dayOfMonth, o.intervalDays, o.startsOn, o.endsOn, o.nextRunOn, o.salespersonId, o.status, o.branchId, at, actorId],
    );
  }

  async insertLines(tx: Transaction, standingOrderId: string, lines: readonly StandingOrderLineRecord[], actorId: string, at: Date): Promise<void> {
    for (const l of lines) {
      await tx.query(
        'INSERT INTO whl.standing_order_line (id, standing_order_id, line_no, product_id, qty, uom, created_at, created_by) VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8)',
        [l.id, standingOrderId, l.lineNo, l.productId, l.qty, l.uom, at, actorId],
      );
    }
  }

  async retireLines(tx: Transaction, standingOrderId: string, actorId: string, at: Date): Promise<void> {
    await tx.query('UPDATE whl.standing_order_line SET retired_at = $2, retired_by = $3 WHERE standing_order_id = $1 AND retired_at IS NULL', [standingOrderId, at, actorId]);
  }

  async get(tx: Transaction, id: string, lock: boolean): Promise<StandingOrderRecord | null> {
    const { rows } = await tx.query<RawOrder>(`SELECT ${ORDER} FROM whl.standing_order WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    const [order] = await this.withLines(tx, rows);
    return order ?? null;
  }

  async list(tx: Transaction, f: StandingOrderFilter, beforeId: string | null, limit: number): Promise<StandingOrderRecord[]> {
    if (f.branchIds.length === 0) return [];
    const { rows } = await tx.query<RawOrder>(
      `SELECT ${ORDER} FROM whl.standing_order
        WHERE branch_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR customer_id = $2) AND ($3::text IS NULL OR status = $3) AND ($4::uuid IS NULL OR id < $4)
        ORDER BY id DESC LIMIT $5`,
      [f.branchIds, f.customerId, f.status, beforeId, limit],
    );
    return this.withLines(tx, rows);
  }

  async change(tx: Transaction, id: string, version: number, c: StandingOrderChange, actorId: string, at: Date): Promise<boolean> {
    const final = c.status === 'ENDED' || c.status === 'CANCELLED';
    const { rowCount } = await tx.query(
      `UPDATE whl.standing_order
          SET weekdays = $3::integer[], day_of_month = $4, interval_days = $5, ends_on = $6::date, next_run_on = $7::date, status = $8,
              posted_at = CASE WHEN $9 THEN $10::timestamptz END, posted_by = CASE WHEN $9 THEN $11::uuid END,
              version = version + 1, updated_by = $11
        WHERE id = $1 AND version = $2`,
      [id, version, c.weekdays, c.dayOfMonth, c.intervalDays, c.endsOn, c.nextRunOn, c.status, final, at, actorId],
    );
    return rowCount === 1;
  }

  async due(tx: Transaction, onOrBefore: string, afterId: string | null, limit: number): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>(
      "SELECT id FROM whl.standing_order WHERE status = 'ACTIVE' AND next_run_on <= $1::date AND ($2::uuid IS NULL OR id > $2) ORDER BY id LIMIT $3",
      [onOrBefore, afterId, limit],
    );
    return rows.map((r) => r.id);
  }

  async insertRun(tx: Transaction, run: StandingOrderRunRecord, actorId: string): Promise<boolean> {
    const { rowCount } = await tx.query(
      `INSERT INTO whl.standing_order_run (standing_order_id, run_date, outcome, order_id, reason, recorded_at, actor_id) VALUES ($1, $2::date, $3, $4, $5, $6, $7)
       ON CONFLICT (standing_order_id, run_date) DO NOTHING`,
      [run.standingOrderId, run.runDate, run.outcome, run.orderId, run.reason, run.recordedAt, actorId],
    );
    return rowCount === 1;
  }

  async hasRun(tx: Transaction, standingOrderId: string, runDate: string): Promise<boolean> {
    const { rows } = await tx.query('SELECT 1 FROM whl.standing_order_run WHERE standing_order_id = $1 AND run_date = $2::date', [standingOrderId, runDate]);
    return rows.length > 0;
  }

  async runs(tx: Transaction, standingOrderId: string, beforeDate: string | null, limit: number): Promise<StandingOrderRunRecord[]> {
    const { rows } = await tx.query<RawRun>(`SELECT ${RUN} FROM whl.standing_order_run WHERE standing_order_id = $1 AND ($2::date IS NULL OR run_date < $2::date) ORDER BY run_date DESC LIMIT $3`, [
      standingOrderId,
      beforeDate,
      limit,
    ]);
    return rows.map(runOf);
  }

  private async withLines(tx: Transaction, rows: readonly RawOrder[]): Promise<StandingOrderRecord[]> {
    if (rows.length === 0) return [];
    const { rows: lines } = await tx.query<{ id: string; standing_order_id: string; line_no: number; product_id: string; qty: string; uom: string }>(
      'SELECT id, standing_order_id, line_no, product_id, qty::text, uom FROM whl.standing_order_line WHERE standing_order_id = ANY($1::uuid[]) AND retired_at IS NULL ORDER BY line_no',
      [rows.map((r) => r.id)],
    );
    return rows.map((r) => ({
      id: r.id,
      customerId: r.customer_id,
      branchId: r.branch_id,
      frequency: r.frequency,
      weekdays: r.weekdays,
      dayOfMonth: r.day_of_month,
      intervalDays: r.interval_days,
      startsOn: r.starts_on,
      endsOn: r.ends_on,
      nextRunOn: r.next_run_on,
      salespersonId: r.salesperson_id,
      status: r.status,
      version: r.version,
      lines: lines.filter((l) => l.standing_order_id === r.id).map((l) => ({ id: l.id, lineNo: l.line_no, productId: l.product_id, qty: l.qty, uom: l.uom })),
    }));
  }
}
