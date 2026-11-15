import type { Transaction } from '../../../platform/database/unit-of-work';
import type {
  AnimalMoveRecord,
  BatchFilters,
  BatchRecord,
  BreedingFilters,
  BreedingRecordRow,
  HerdStore,
  NewBatch,
  NewBreedingRecord,
  OffspringRow,
  UnitFeedRow,
  UnitHealthRow,
  UnitMortalityRow,
  WindowDeathRow,
  WindowFeedRow,
} from '../application/herd-store';
import type { AnimalRecord, ReadScope, WeightRecord } from '../application/livestock-store';
import { ANIMAL_COLUMNS, animalOf } from './pg-livestock-store';

type Row = Record<string, unknown>;

class Params {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  scope(scope: ReadScope, columns: { readonly branch: string; readonly location?: string; readonly unit?: string }): string {
    const parts = [`${columns.branch} = ANY(${this.add(scope.branchIds)}::uuid[])`];
    if (columns.location !== undefined) parts.push(`${columns.location} = ANY(${this.add(scope.locationIds)}::uuid[])`);
    if (columns.unit !== undefined) parts.push(`${columns.unit} = ANY(${this.add(scope.unitIds)}::uuid[])`);
    return `(${parts.join(' OR ')})`;
  }
}

const ANIMAL_SETTABLE = new Set(['breed', 'sex', 'purpose']);
const BATCH_SETTABLE = new Set(['purpose', 'status', 'closed_at', 'closed_by', 'close_reason']);
const BREEDING_SETTABLE = new Set(['expected_birth_on', 'status', 'notes', 'actual_birth_on', 'litter_size', 'live_births', 'stillbirths', 'fail_reason', 'posted_at', 'posted_by']);

function assignments(set: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>, params: Params): string[] {
  return Object.entries(set).map(([column, value]) => {
    if (!allowed.has(column)) throw new Error(`column ${column} cannot be set here`);
    return `${column} = ${params.add(value)}`;
  });
}

const BATCH_COLUMNS = `id, stock_unit_id, batch_no, species_id, branch_id, location_id, to_char(started_on, 'YYYY-MM-DD') AS started_on, initial_head, purpose,
  status, closed_at, close_reason, version`;

function batch(r: Row): BatchRecord {
  return {
    id: r['id'] as string,
    stockUnitId: r['stock_unit_id'] as string | null,
    batchNo: r['batch_no'] as string,
    speciesId: r['species_id'] as string,
    branchId: r['branch_id'] as string,
    locationId: r['location_id'] as string | null,
    startedOn: r['started_on'] as string,
    initialHead: Number(r['initial_head']),
    purpose: r['purpose'] as BatchRecord['purpose'],
    status: r['status'] as BatchRecord['status'],
    closedAt: r['closed_at'] as Date | null,
    closeReason: r['close_reason'] as string | null,
    version: Number(r['version']),
  };
}

const BREEDING_COLUMNS = `id, dam_id, sire_id, to_char(mated_on, 'YYYY-MM-DD') AS mated_on, to_char(expected_birth_on, 'YYYY-MM-DD') AS expected_birth_on,
  to_char(actual_birth_on, 'YYYY-MM-DD') AS actual_birth_on, litter_size, live_births, stillbirths, notes, fail_reason, status, branch_id, version, created_at,
  created_by, posted_at, posted_by`;

const nullableInt = (value: unknown): number | null => (value === null ? null : Number(value));

function breeding(r: Row): BreedingRecordRow {
  return {
    id: r['id'] as string,
    damId: r['dam_id'] as string,
    sireId: r['sire_id'] as string | null,
    matedOn: r['mated_on'] as string,
    expectedBirthOn: r['expected_birth_on'] as string | null,
    actualBirthOn: r['actual_birth_on'] as string | null,
    litterSize: nullableInt(r['litter_size']),
    liveBirths: nullableInt(r['live_births']),
    stillbirths: nullableInt(r['stillbirths']),
    notes: r['notes'] as string | null,
    failReason: r['fail_reason'] as string | null,
    status: r['status'] as BreedingRecordRow['status'],
    branchId: r['branch_id'] as string,
    version: Number(r['version']),
    createdAt: r['created_at'] as Date,
    createdBy: r['created_by'] as string,
    postedAt: r['posted_at'] as Date | null,
    postedBy: r['posted_by'] as string | null,
  };
}

const MOVE_COLUMNS = 'id, stock_unit_id, branch_id, from_location_id, to_location_id, movement_id, note, occurred_at, actor_id';

function move(r: Row): AnimalMoveRecord {
  return {
    id: r['id'] as string,
    stockUnitId: r['stock_unit_id'] as string,
    branchId: r['branch_id'] as string,
    fromLocationId: r['from_location_id'] as string,
    toLocationId: r['to_location_id'] as string,
    movementId: r['movement_id'] as string,
    note: r['note'] as string | null,
    occurredAt: r['occurred_at'] as Date,
    actorId: r['actor_id'] as string,
  };
}

/** LIV's herd tables over PostgreSQL: point reads by key and lists by an index in id order; nothing outside schema `liv`. */
export class PgHerdStore implements HerdStore {
  async updateAnimal(tx: Transaction, id: string, version: number, set: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean> {
    const p = new Params();
    const columns = assignments(set, ANIMAL_SETTABLE, p);
    const { rowCount } = await tx.query(
      `UPDATE liv.animal SET ${[...columns, 'version = version + 1', 'updated_at = now()', `updated_by = ${p.add(actorId)}`].join(', ')} WHERE stock_unit_id = ${p.add(id)} AND version = ${p.add(version)}`,
      p.values,
    );
    return rowCount === 1;
  }

  async isDam(tx: Transaction, id: string): Promise<boolean> {
    const { rows } = await tx.query<{ found: boolean }>('SELECT EXISTS (SELECT 1 FROM liv.breeding_record WHERE dam_id = $1) AS found', [id]);
    return rows[0]!.found;
  }

  async insertBatch(tx: Transaction, b: NewBatch, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO liv.batch (id, stock_unit_id, batch_no, species_id, branch_id, location_id, started_on, initial_head, purpose, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [b.id, b.stockUnitId, b.batchNo, b.speciesId, b.branchId, b.locationId, b.startedOn, b.initialHead, b.purpose, actorId],
    );
  }

  async batches(tx: Transaction, ids: readonly string[]): Promise<BatchRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<Row>(`SELECT ${BATCH_COLUMNS} FROM liv.batch WHERE id = ANY($1::uuid[])`, [[...new Set(ids)]]);
    return rows.map(batch);
  }

  async lockBatch(tx: Transaction, id: string): Promise<BatchRecord | null> {
    const { rows } = await tx.query<Row>(`SELECT ${BATCH_COLUMNS} FROM liv.batch WHERE id = $1 FOR UPDATE`, [id]);
    return rows[0] === undefined ? null : batch(rows[0]);
  }

  async batchesOfUnits(tx: Transaction, stockUnitIds: readonly string[]): Promise<ReadonlyMap<string, BatchRecord>> {
    if (stockUnitIds.length === 0) return new Map();
    const { rows } = await tx.query<Row>(`SELECT ${BATCH_COLUMNS} FROM liv.batch WHERE stock_unit_id = ANY($1::uuid[])`, [[...new Set(stockUnitIds)]]);
    return new Map(rows.map((r) => [r['stock_unit_id'] as string, batch(r)] as const));
  }

  async batchNoTaken(tx: Transaction, batchNo: string): Promise<boolean> {
    const { rows } = await tx.query<{ found: boolean }>('SELECT EXISTS (SELECT 1 FROM liv.batch WHERE batch_no = $1) AS found', [batchNo]);
    return rows[0]!.found;
  }

  async updateBatch(tx: Transaction, id: string, version: number, set: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean> {
    const p = new Params();
    const columns = assignments(set, BATCH_SETTABLE, p);
    const { rowCount } = await tx.query(
      `UPDATE liv.batch SET ${[...columns, 'version = version + 1', 'updated_at = now()', `updated_by = ${p.add(actorId)}`].join(', ')} WHERE id = ${p.add(id)} AND version = ${p.add(version)}`,
      p.values,
    );
    return rowCount === 1;
  }

  async listBatches(tx: Transaction, filters: BatchFilters, scope: ReadScope, after: string | null, limit: number): Promise<BatchRecord[]> {
    const p = new Params();
    const where = [p.scope(scope, { branch: 'branch_id', location: 'location_id', unit: 'stock_unit_id' })];
    if (filters.status !== undefined) where.push(`status = ${p.add(filters.status)}`);
    if (filters.speciesId !== undefined) where.push(`species_id = ${p.add(filters.speciesId)}`);
    if (after !== null) where.push(`id < ${p.add(after)}`);
    const { rows } = await tx.query<Row>(`SELECT ${BATCH_COLUMNS} FROM liv.batch WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${p.add(limit)}`, p.values);
    return rows.map(batch);
  }

  async batchesInWindow(tx: Transaction, branchIds: readonly string[], speciesId: string | undefined, from: Date, toDay: string): Promise<BatchRecord[]> {
    const p = new Params();
    const where = [`branch_id = ANY(${p.add(branchIds)}::uuid[])`, `started_on <= ${p.add(toDay)}`, `(closed_at IS NULL OR closed_at >= ${p.add(from)})`, 'stock_unit_id IS NOT NULL'];
    if (speciesId !== undefined) where.push(`species_id = ${p.add(speciesId)}`);
    const { rows } = await tx.query<Row>(`SELECT ${BATCH_COLUMNS} FROM liv.batch WHERE ${where.join(' AND ')} ORDER BY id`, p.values);
    return rows.map(batch);
  }

  async insertMove(tx: Transaction, m: AnimalMoveRecord): Promise<void> {
    await tx.query(
      `INSERT INTO liv.animal_move (id, stock_unit_id, branch_id, from_location_id, to_location_id, movement_id, note, occurred_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [m.id, m.stockUnitId, m.branchId, m.fromLocationId, m.toLocationId, m.movementId, m.note, m.occurredAt, m.actorId],
    );
  }

  async movesOf(tx: Transaction, stockUnitId: string): Promise<AnimalMoveRecord[]> {
    const { rows } = await tx.query<Row>(`SELECT ${MOVE_COLUMNS} FROM liv.animal_move WHERE stock_unit_id = $1 ORDER BY occurred_at, id`, [stockUnitId]);
    return rows.map(move);
  }

  async insertBreeding(tx: Transaction, r: NewBreedingRecord, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO liv.breeding_record (id, dam_id, sire_id, mated_on, expected_birth_on, notes, status, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [r.id, r.damId, r.sireId, r.matedOn, r.expectedBirthOn, r.notes, r.status, r.branchId, actorId],
    );
  }

  async breeding(tx: Transaction, ids: readonly string[]): Promise<BreedingRecordRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<Row>(`SELECT ${BREEDING_COLUMNS} FROM liv.breeding_record WHERE id = ANY($1::uuid[])`, [[...new Set(ids)]]);
    return rows.map(breeding);
  }

  async lockBreeding(tx: Transaction, id: string): Promise<BreedingRecordRow | null> {
    const { rows } = await tx.query<Row>(`SELECT ${BREEDING_COLUMNS} FROM liv.breeding_record WHERE id = $1 FOR UPDATE`, [id]);
    return rows[0] === undefined ? null : breeding(rows[0]);
  }

  async updateBreeding(tx: Transaction, id: string, set: Readonly<Record<string, unknown>>, actorId: string): Promise<void> {
    const p = new Params();
    const columns = assignments(set, BREEDING_SETTABLE, p);
    await tx.query(`UPDATE liv.breeding_record SET ${[...columns, 'version = version + 1', 'updated_at = now()', `updated_by = ${p.add(actorId)}`].join(', ')} WHERE id = ${p.add(id)}`, p.values);
  }

  async listBreeding(tx: Transaction, filters: BreedingFilters, scope: ReadScope, after: string | null, limit: number): Promise<BreedingRecordRow[]> {
    const p = new Params();
    const where = [p.scope(scope, { branch: 'branch_id', unit: 'dam_id' })];
    if (filters.status !== undefined) where.push(`status = ${p.add(filters.status)}`);
    if (filters.damId !== undefined) where.push(`dam_id = ${p.add(filters.damId)}`);
    if (filters.dueBefore !== undefined) where.push(`expected_birth_on < ${p.add(filters.dueBefore)}`);
    if (after !== null) where.push(`id < ${p.add(after)}`);
    const { rows } = await tx.query<Row>(`SELECT ${BREEDING_COLUMNS} FROM liv.breeding_record WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${p.add(limit)}`, p.values);
    return rows.map(breeding);
  }

  async breedingOfDam(tx: Transaction, damId: string): Promise<BreedingRecordRow[]> {
    const { rows } = await tx.query<Row>(`SELECT ${BREEDING_COLUMNS} FROM liv.breeding_record WHERE dam_id = $1 ORDER BY id`, [damId]);
    return rows.map(breeding);
  }

  async offspringOf(tx: Transaction, breedingRecordIds: readonly string[]): Promise<OffspringRow[]> {
    if (breedingRecordIds.length === 0) return [];
    const { rows } = await tx.query<{ stock_unit_id: string; tag_no: string; sex: OffspringRow['sex']; breeding_record_id: string }>(
      'SELECT stock_unit_id, tag_no, sex, breeding_record_id FROM liv.animal WHERE breeding_record_id = ANY($1::uuid[]) ORDER BY tag_no, stock_unit_id',
      [[...new Set(breedingRecordIds)]],
    );
    return rows.map((r) => ({ id: r.stock_unit_id, tagNo: r.tag_no, sex: r.sex, breedingRecordId: r.breeding_record_id }));
  }

  async gestationDays(tx: Transaction, speciesCode: string): Promise<number | null> {
    const { rows } = await tx.query<{ gestation_days: number }>('SELECT gestation_days FROM liv.gestation_period WHERE species_code = $1', [speciesCode]);
    return rows[0] === undefined ? null : Number(rows[0].gestation_days);
  }

  async livestockOf(tx: Transaction, branchIds: readonly string[], since: Date): Promise<AnimalRecord[]> {
    const { rows } = await tx.query<Row>(
      `SELECT ${ANIMAL_COLUMNS} FROM liv.animal WHERE branch_id = ANY($1::uuid[]) AND (status = 'ALIVE' OR status_changed_at >= $2) ORDER BY stock_unit_id`,
      [branchIds, since],
    );
    return rows.map(animalOf);
  }

  async weighingsOf(tx: Transaction, stockUnitIds: readonly string[], from?: Date, to?: Date): Promise<WeightRecord[]> {
    if (stockUnitIds.length === 0) return [];
    const p = new Params();
    const where = [`stock_unit_id = ANY(${p.add([...new Set(stockUnitIds)])}::uuid[])`];
    if (from !== undefined) where.push(`measured_at >= ${p.add(from)}`);
    if (to !== undefined) where.push(`measured_at <= ${p.add(to)}`);
    const { rows } = await tx.query<Row>(
      `SELECT id, stock_unit_id, branch_id, weight_kg::text AS weight_kg, weight_source, head_weighed, measured_at, actor_id
         FROM liv.weight_record WHERE ${where.join(' AND ')} ORDER BY measured_at, id`,
      p.values,
    );
    return rows.map((r) => ({
      id: r['id'] as string,
      stockUnitId: r['stock_unit_id'] as string,
      branchId: r['branch_id'] as string,
      weightKg: r['weight_kg'] as string,
      weightSource: r['weight_source'] as WeightRecord['weightSource'],
      headWeighed: Number(r['head_weighed']),
      measuredAt: r['measured_at'] as Date,
      actorId: r['actor_id'] as string,
    }));
  }

  async healthOfUnit(tx: Transaction, stockUnitId: string): Promise<UnitHealthRow[]> {
    const { rows } = await tx.query<Row>(
      `SELECT e.id, e.kind, e.product_id, e.withdrawal_days, e.occurred_at, e.actor_id, a.amount_pesewas::text AS amount_pesewas
         FROM liv.health_event e
         LEFT JOIN liv.health_cost_allocation a ON a.health_event_id = e.id AND a.stock_unit_id = $1
        WHERE e.stock_unit_id = $1 OR a.stock_unit_id IS NOT NULL
        ORDER BY e.occurred_at, e.id`,
      [stockUnitId],
    );
    return rows.map((r) => ({
      id: r['id'] as string,
      kind: r['kind'] as UnitHealthRow['kind'],
      productId: r['product_id'] as string | null,
      withdrawalDays: Number(r['withdrawal_days']),
      occurredAt: r['occurred_at'] as Date,
      actorId: r['actor_id'] as string,
      amountPesewas: r['amount_pesewas'] === null ? null : BigInt(r['amount_pesewas'] as string),
    }));
  }

  async feedOfUnit(tx: Transaction, stockUnitId: string): Promise<UnitFeedRow[]> {
    const { rows } = await tx.query<Row>(
      `SELECT c.id, c.location_id, to_char(c.consumed_on, 'YYYY-MM-DD') AS consumed_on, c.posted_at, c.created_by, a.amount_pesewas::text AS amount_pesewas, a.treatment
         FROM liv.feed_cost_allocation a JOIN liv.feed_consumption c ON c.id = a.feed_consumption_id
        WHERE a.stock_unit_id = $1 AND c.status = 'POSTED'
        ORDER BY c.posted_at, c.id`,
      [stockUnitId],
    );
    return rows.map((r) => ({
      consumptionId: r['id'] as string,
      locationId: r['location_id'] as string,
      consumedOn: r['consumed_on'] as string,
      postedAt: r['posted_at'] as Date,
      actorId: r['created_by'] as string,
      amountPesewas: BigInt(r['amount_pesewas'] as string),
      treatment: r['treatment'] as UnitFeedRow['treatment'],
    }));
  }

  async mortalityOfUnit(tx: Transaction, stockUnitId: string): Promise<UnitMortalityRow[]> {
    const { rows } = await tx.query<{ id: string; kind: UnitMortalityRow['kind']; status: string }>(
      "SELECT id, kind, status FROM liv.mortality_record WHERE stock_unit_id = $1 AND status = 'POSTED' ORDER BY id",
      [stockUnitId],
    );
    return rows;
  }

  async feedInWindow(tx: Transaction, branchIds: readonly string[], from: string, to: string): Promise<WindowFeedRow[]> {
    const { rows } = await tx.query<{ location_id: string; qty: string; shares: Array<{ stockUnitId: string; headDays: number }> }>(
      `SELECT c.location_id, c.qty::text AS qty,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('stockUnitId', a.stock_unit_id, 'headDays', a.head_days) ORDER BY a.stock_unit_id)
                          FROM liv.feed_cost_allocation a WHERE a.feed_consumption_id = c.id), '[]'::jsonb) AS shares
         FROM liv.feed_consumption c
        WHERE c.branch_id = ANY($1::uuid[]) AND c.status = 'POSTED' AND c.consumed_on BETWEEN $2 AND $3
        ORDER BY c.id`,
      [branchIds, from, to],
    );
    return rows.map((r) => ({ locationId: r.location_id, qty: r.qty, shares: r.shares.map((s) => ({ stockUnitId: s.stockUnitId, headDays: BigInt(s.headDays) })) }));
  }

  async deathsOf(tx: Transaction, stockUnitIds: readonly string[], from?: Date, to?: Date): Promise<WindowDeathRow[]> {
    if (stockUnitIds.length === 0) return [];
    const p = new Params();
    const where = [`stock_unit_id = ANY(${p.add([...new Set(stockUnitIds)])}::uuid[])`, "status = 'POSTED'", "kind = 'DEATH'"];
    if (from !== undefined) where.push(`found_at >= ${p.add(from)}`);
    if (to !== undefined) where.push(`found_at <= ${p.add(to)}`);
    const { rows } = await tx.query<{ stock_unit_id: string; location_id: string; head: number }>(
      `SELECT stock_unit_id, location_id, head FROM liv.mortality_record WHERE ${where.join(' AND ')} ORDER BY id`,
      p.values,
    );
    return rows.map((r) => ({ stockUnitId: r.stock_unit_id, locationId: r.location_id, head: Number(r.head) }));
  }
}
