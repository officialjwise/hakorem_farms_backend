import type { Transaction } from '../../../platform/database/unit-of-work';
import type {
  AnimalFilters,
  AnimalRecord,
  CostAllocationRecord,
  FeedConsumptionRecord,
  FeedFilters,
  HealthEventRecord,
  HealthFilters,
  LivestockStore,
  MortalityFilters,
  MortalityRecord,
  NewAnimal,
  NewHealthEvent,
  NewMortality,
  RationRecord,
  ReadScope,
  WeightFilters,
  WeightRecord,
} from '../application/livestock-store';
import type { AnimalStatus } from '../domain/animal';

type Row = Record<string, unknown>;

/** Calendar dates come back as `YYYY-MM-DD` text (`to_char` in the SELECT), never through a time zone. */
const date = (value: unknown): string => value as string;
const nullableDate = (value: unknown): string | null => value as string | null;
const big = (value: unknown): bigint => BigInt(value as string);
const nullableBig = (value: unknown): bigint | null => (value === null ? null : BigInt(value as string));

/** SQL placeholders for a read scope: a record matches by branch, by location or by the stock unit it names. */
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

export const ANIMAL_COLUMNS = `stock_unit_id, tag_no, species_id, product_id, branch_id, breed, sex, to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
  to_char(acquired_on, 'YYYY-MM-DD') AS acquired_on, source, supplier_id, acquisition_cost_pesewas::text AS acquisition_cost_pesewas, dam_id, sire_id, batch_id, breeding_record_id, purpose, status, status_changed_at,
  exit_value_pesewas::text AS exit_value_pesewas, version, created_at`;

export function animalOf(r: Row): AnimalRecord {
  return {
    stockUnitId: r['stock_unit_id'] as string,
    tagNo: r['tag_no'] as string,
    speciesId: r['species_id'] as string,
    productId: r['product_id'] as string,
    branchId: r['branch_id'] as string,
    breed: r['breed'] as string | null,
    sex: r['sex'] as AnimalRecord['sex'],
    dateOfBirth: nullableDate(r['date_of_birth']),
    acquiredOn: date(r['acquired_on']),
    source: r['source'] as AnimalRecord['source'],
    supplierId: r['supplier_id'] as string | null,
    acquisitionCostPesewas: big(r['acquisition_cost_pesewas']),
    damId: r['dam_id'] as string | null,
    sireId: r['sire_id'] as string | null,
    batchId: r['batch_id'] as string | null,
    breedingRecordId: r['breeding_record_id'] as string | null,
    purpose: r['purpose'] as AnimalRecord['purpose'],
    status: r['status'] as AnimalStatus,
    statusChangedAt: r['status_changed_at'] as Date | null,
    exitValuePesewas: nullableBig(r['exit_value_pesewas']),
    version: Number(r['version']),
    createdAt: r['created_at'] as Date,
  };
}

const WEIGHT_COLUMNS = 'id, stock_unit_id, branch_id, weight_kg::text AS weight_kg, weight_source, head_weighed, measured_at, actor_id';

function weight(r: Row): WeightRecord {
  return {
    id: r['id'] as string,
    stockUnitId: r['stock_unit_id'] as string,
    branchId: r['branch_id'] as string,
    weightKg: r['weight_kg'] as string,
    weightSource: r['weight_source'] as WeightRecord['weightSource'],
    headWeighed: Number(r['head_weighed']),
    measuredAt: r['measured_at'] as Date,
    actorId: r['actor_id'] as string,
  };
}

const HEALTH_COLUMNS = `id, kind, branch_id, stock_unit_id, location_id, product_id, dose, qty_used::text AS qty_used, withdrawal_days, withdrawal_ends_at,
  stock_hold_id, holds_placed, cost_pesewas::text AS cost_pesewas, medication_value_pesewas::text AS medication_value_pesewas, issue_movement_id,
  administered_by, notes, occurred_at, recorded_at, actor_id`;

function healthEvent(r: Row): HealthEventRecord {
  return {
    id: r['id'] as string,
    kind: r['kind'] as HealthEventRecord['kind'],
    branchId: r['branch_id'] as string,
    stockUnitId: r['stock_unit_id'] as string | null,
    locationId: r['location_id'] as string | null,
    productId: r['product_id'] as string | null,
    dose: r['dose'] as string | null,
    qtyUsed: r['qty_used'] as string | null,
    withdrawalDays: Number(r['withdrawal_days']),
    withdrawalEndsAt: r['withdrawal_ends_at'] as Date | null,
    stockHoldId: r['stock_hold_id'] as string | null,
    holdsPlaced: Number(r['holds_placed']),
    costPesewas: big(r['cost_pesewas']),
    medicationValuePesewas: big(r['medication_value_pesewas']),
    issueMovementId: r['issue_movement_id'] as string | null,
    administeredBy: r['administered_by'] as string | null,
    notes: r['notes'] as string | null,
    occurredAt: r['occurred_at'] as Date,
    recordedAt: r['recorded_at'] as Date,
    actorId: r['actor_id'] as string,
  };
}

const MORTALITY_COLUMNS = `id, kind, stock_unit_id, location_id, head, reason_code, found_at, reported_by, photo_file_id, value_pesewas::text AS value_pesewas,
  threshold_pesewas::text AS threshold_pesewas, approval_request_id, movement_id, disposal_note, status, branch_id, version`;

function mortality(r: Row): MortalityRecord {
  return {
    id: r['id'] as string,
    kind: r['kind'] as MortalityRecord['kind'],
    stockUnitId: r['stock_unit_id'] as string,
    locationId: r['location_id'] as string,
    head: Number(r['head']),
    reasonCode: r['reason_code'] as string,
    foundAt: r['found_at'] as Date,
    reportedBy: r['reported_by'] as string,
    photoFileId: r['photo_file_id'] as string | null,
    valuePesewas: big(r['value_pesewas']),
    thresholdPesewas: nullableBig(r['threshold_pesewas']),
    approvalRequestId: r['approval_request_id'] as string | null,
    movementId: r['movement_id'] as string | null,
    disposalNote: r['disposal_note'] as string | null,
    status: r['status'] as MortalityRecord['status'],
    branchId: r['branch_id'] as string,
    version: Number(r['version']),
  };
}

const RATION_COLUMNS = 'id, name, species_id, feed_product_id, qty_per_head_per_day::text AS qty_per_head_per_day, stage, version';

function ration(r: Row): RationRecord {
  return {
    id: r['id'] as string,
    name: r['name'] as string,
    speciesId: r['species_id'] as string,
    feedProductId: r['feed_product_id'] as string,
    qtyPerHeadPerDay: r['qty_per_head_per_day'] as string,
    stage: r['stage'] as string | null,
    version: Number(r['version']),
  };
}

const FEED_COLUMNS = `c.id, c.location_id, c.from_location_id, c.feed_product_id, c.qty::text AS qty, to_char(c.consumed_on, 'YYYY-MM-DD') AS consumed_on, c.ration_id, c.value_pesewas::text AS value_pesewas,
  c.issue_movement_id, c.status, c.branch_id, c.posted_at, c.created_by,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('stockUnitId', a.stock_unit_id, 'headDays', a.head_days, 'amountPesewas', a.amount_pesewas::text,
                                                'treatment', a.treatment, 'movementId', a.movement_id) ORDER BY a.stock_unit_id)
              FROM liv.feed_cost_allocation a WHERE a.feed_consumption_id = c.id), '[]'::jsonb) AS allocations`;

function feed(r: Row): FeedConsumptionRecord {
  const allocations = r['allocations'] as Array<{ stockUnitId: string; headDays: number; amountPesewas: string; treatment: CostAllocationRecord['treatment']; movementId: string | null }>;
  return {
    id: r['id'] as string,
    locationId: r['location_id'] as string,
    fromLocationId: r['from_location_id'] as string,
    feedProductId: r['feed_product_id'] as string,
    qty: r['qty'] as string,
    consumedOn: date(r['consumed_on']),
    rationId: r['ration_id'] as string | null,
    valuePesewas: nullableBig(r['value_pesewas']),
    issueMovementId: r['issue_movement_id'] as string | null,
    status: r['status'] as FeedConsumptionRecord['status'],
    branchId: r['branch_id'] as string,
    postedAt: r['posted_at'] as Date | null,
    createdBy: r['created_by'] as string,
    allocations: allocations.map((a) => ({ stockUnitId: a.stockUnitId, headDays: BigInt(a.headDays), amountPesewas: BigInt(a.amountPesewas), treatment: a.treatment, movementId: a.movementId })),
  };
}

/** Columns a caller may set on a mortality record; anything else is a programming error, refused before any SQL. */
const MORTALITY_SETTABLE = new Set(['status', 'value_pesewas', 'threshold_pesewas', 'approval_request_id', 'movement_id', 'photo_file_id', 'posted_at', 'posted_by']);
const RATION_SETTABLE = new Set(['name', 'qty_per_head_per_day', 'stage']);

function assignments(set: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>, params: Params): string[] {
  return Object.entries(set).map(([column, value]) => {
    if (!allowed.has(column)) throw new Error(`column ${column} cannot be set here`);
    return `${column} = ${params.add(value)}`;
  });
}

/** LIV's tables over PostgreSQL. Point reads by key, lists by an index in id order; no table outside schema `liv`. */
export class PgLivestockStore implements LivestockStore {
  async insertAnimal(tx: Transaction, a: NewAnimal, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO liv.animal (stock_unit_id, tag_no, species_id, product_id, branch_id, breed, sex, date_of_birth, acquired_on, source, supplier_id,
                               acquisition_cost_pesewas, dam_id, sire_id, purpose, status, created_by, updated_by, breeding_record_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'ALIVE', $16, $16, $17)`,
      [a.stockUnitId, a.tagNo, a.speciesId, a.productId, a.branchId, a.breed, a.sex, a.dateOfBirth, a.acquiredOn, a.source, a.supplierId,
        a.acquisitionCostPesewas.toString(), a.damId, a.sireId, a.purpose, actorId, a.breedingRecordId ?? null],
    );
  }

  async animals(tx: Transaction, ids: readonly string[]): Promise<AnimalRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<Row>(`SELECT ${ANIMAL_COLUMNS} FROM liv.animal WHERE stock_unit_id = ANY($1::uuid[])`, [[...new Set(ids)]]);
    return rows.map(animalOf);
  }

  async lockAnimal(tx: Transaction, id: string): Promise<AnimalRecord | null> {
    const { rows } = await tx.query<Row>(`SELECT ${ANIMAL_COLUMNS} FROM liv.animal WHERE stock_unit_id = $1 FOR UPDATE`, [id]);
    return rows[0] === undefined ? null : animalOf(rows[0]);
  }

  async liveAnimalByTag(tx: Transaction, tagNo: string): Promise<string | null> {
    const { rows } = await tx.query<{ stock_unit_id: string }>("SELECT stock_unit_id FROM liv.animal WHERE tag_no = $1 AND status = 'ALIVE'", [tagNo]);
    return rows[0]?.stock_unit_id ?? null;
  }

  async setAnimalStatus(tx: Transaction, id: string, status: AnimalStatus, exitValuePesewas: bigint | null, at: Date, actorId: string): Promise<void> {
    await tx.query('UPDATE liv.animal SET status = $2, exit_value_pesewas = $3, status_changed_at = $4, version = version + 1, updated_at = now(), updated_by = $5 WHERE stock_unit_id = $1', [
      id,
      status,
      exitValuePesewas?.toString() ?? null,
      at,
      actorId,
    ]);
  }

  async listAnimals(tx: Transaction, filters: AnimalFilters, scope: ReadScope, after: string | null, limit: number): Promise<AnimalRecord[]> {
    const p = new Params();
    const where = [p.scope(scope, { branch: 'branch_id', unit: 'stock_unit_id' })];
    if (filters.q !== undefined) where.push(`tag_no ILIKE ${p.add(`%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)}`);
    if (filters.speciesId !== undefined) where.push(`species_id = ${p.add(filters.speciesId)}`);
    if (filters.status !== undefined) where.push(`status = ${p.add(filters.status)}`);
    if (filters.purpose !== undefined) where.push(`purpose = ${p.add(filters.purpose)}`);
    if (filters.unitIds !== undefined) where.push(`stock_unit_id = ANY(${p.add(filters.unitIds)}::uuid[])`);
    if (after !== null) where.push(`stock_unit_id > ${p.add(after)}`);
    const { rows } = await tx.query<Row>(`SELECT ${ANIMAL_COLUMNS} FROM liv.animal WHERE ${where.join(' AND ')} ORDER BY stock_unit_id LIMIT ${p.add(limit)}`, p.values);
    return rows.map(animalOf);
  }

  async insertWeight(tx: Transaction, w: WeightRecord): Promise<void> {
    await tx.query(
      `INSERT INTO liv.weight_record (id, stock_unit_id, branch_id, weight_kg, weight_source, head_weighed, measured_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [w.id, w.stockUnitId, w.branchId, w.weightKg, w.weightSource, w.headWeighed, w.measuredAt, w.actorId],
    );
  }

  async weights(tx: Transaction, ids: readonly string[]): Promise<WeightRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<Row>(`SELECT ${WEIGHT_COLUMNS} FROM liv.weight_record WHERE id = ANY($1::uuid[])`, [[...ids]]);
    return rows.map(weight);
  }

  async latestWeights(tx: Transaction, stockUnitIds: readonly string[]): Promise<ReadonlyMap<string, WeightRecord>> {
    if (stockUnitIds.length === 0) return new Map();
    const { rows } = await tx.query<Row>(
      `SELECT DISTINCT ON (stock_unit_id) ${WEIGHT_COLUMNS} FROM liv.weight_record WHERE stock_unit_id = ANY($1::uuid[]) ORDER BY stock_unit_id, measured_at DESC, id DESC`,
      [[...new Set(stockUnitIds)]],
    );
    return new Map(rows.map((r) => [r['stock_unit_id'] as string, weight(r)] as const));
  }

  async listWeights(tx: Transaction, filters: WeightFilters, scope: ReadScope, after: string | null, limit: number): Promise<WeightRecord[]> {
    const p = new Params();
    const where = [p.scope(scope, { branch: 'branch_id', unit: 'stock_unit_id' })];
    if (filters.stockUnitId !== undefined) where.push(`stock_unit_id = ${p.add(filters.stockUnitId)}`);
    if (filters.unitIds !== undefined) where.push(`stock_unit_id = ANY(${p.add(filters.unitIds)}::uuid[])`);
    if (filters.from !== undefined) where.push(`measured_at >= ${p.add(filters.from)}`);
    if (filters.to !== undefined) where.push(`measured_at < ${p.add(filters.to)}`);
    if (after !== null) where.push(`id < ${p.add(after)}`);
    const { rows } = await tx.query<Row>(`SELECT ${WEIGHT_COLUMNS} FROM liv.weight_record WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${p.add(limit)}`, p.values);
    return rows.map(weight);
  }

  async insertHealthEvent(tx: Transaction, e: NewHealthEvent): Promise<void> {
    await tx.query(
      `INSERT INTO liv.health_event (id, kind, branch_id, stock_unit_id, location_id, product_id, dose, qty_used, withdrawal_days, withdrawal_ends_at,
                                     stock_hold_id, holds_placed, cost_pesewas, medication_value_pesewas, issue_movement_id, administered_by, notes,
                                     occurred_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [e.id, e.kind, e.branchId, e.stockUnitId, e.locationId, e.productId, e.dose, e.qtyUsed, e.withdrawalDays, e.withdrawalEndsAt, e.stockHoldId,
        e.holdsPlaced, e.costPesewas.toString(), e.medicationValuePesewas.toString(), e.issueMovementId, e.administeredBy, e.notes, e.occurredAt, e.actorId],
    );
  }

  async insertHealthAllocation(tx: Transaction, eventId: string, a: CostAllocationRecord, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO liv.health_cost_allocation (health_event_id, stock_unit_id, head_days, amount_pesewas, treatment, movement_id, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [eventId, a.stockUnitId, a.headDays.toString(), a.amountPesewas.toString(), a.treatment, a.movementId, actorId],
    );
  }

  async healthEvents(tx: Transaction, ids: readonly string[]): Promise<HealthEventRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<Row>(`SELECT ${HEALTH_COLUMNS} FROM liv.health_event WHERE id = ANY($1::uuid[])`, [[...ids]]);
    return rows.map(healthEvent);
  }

  async listHealthEvents(tx: Transaction, filters: HealthFilters, scope: ReadScope, after: string | null, limit: number): Promise<HealthEventRecord[]> {
    const p = new Params();
    const where = [p.scope(scope, { branch: 'branch_id', location: 'location_id', unit: 'stock_unit_id' })];
    if (filters.stockUnitId !== undefined) where.push(`stock_unit_id = ${p.add(filters.stockUnitId)}`);
    if (filters.locationId !== undefined) where.push(`location_id = ${p.add(filters.locationId)}`);
    if (filters.kind !== undefined) where.push(`kind = ${p.add(filters.kind)}`);
    if (filters.from !== undefined) where.push(`occurred_at >= ${p.add(filters.from)}`);
    if (filters.to !== undefined) where.push(`occurred_at < ${p.add(filters.to)}`);
    if (after !== null) where.push(`id < ${p.add(after)}`);
    const { rows } = await tx.query<Row>(`SELECT ${HEALTH_COLUMNS} FROM liv.health_event WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${p.add(limit)}`, p.values);
    return rows.map(healthEvent);
  }

  async insertMortality(tx: Transaction, m: NewMortality, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO liv.mortality_record (id, kind, stock_unit_id, location_id, head, reason_code, found_at, reported_by, photo_file_id, value_pesewas,
                                         disposal_note, status, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'REPORTED', $12, $13, $13)`,
      [m.id, m.kind, m.stockUnitId, m.locationId, m.head, m.reasonCode, m.foundAt, m.reportedBy, m.photoFileId, m.valuePesewas.toString(), m.disposalNote, m.branchId, actorId],
    );
  }

  async mortality(tx: Transaction, id: string): Promise<MortalityRecord | null> {
    const { rows } = await tx.query<Row>(`SELECT ${MORTALITY_COLUMNS} FROM liv.mortality_record WHERE id = $1`, [id]);
    return rows[0] === undefined ? null : mortality(rows[0]);
  }

  async lockMortality(tx: Transaction, id: string): Promise<MortalityRecord | null> {
    const { rows } = await tx.query<Row>(`SELECT ${MORTALITY_COLUMNS} FROM liv.mortality_record WHERE id = $1 FOR UPDATE`, [id]);
    return rows[0] === undefined ? null : mortality(rows[0]);
  }

  async updateMortality(tx: Transaction, id: string, set: Readonly<Record<string, unknown>>, actorId: string): Promise<void> {
    const p = new Params();
    const columns = assignments(set, MORTALITY_SETTABLE, p);
    await tx.query(`UPDATE liv.mortality_record SET ${[...columns, 'version = version + 1', `updated_at = now()`, `updated_by = ${p.add(actorId)}`].join(', ')} WHERE id = ${p.add(id)}`, p.values);
  }

  async openMortalityOf(tx: Transaction, stockUnitId: string, exceptId: string | null): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>(
      "SELECT id FROM liv.mortality_record WHERE stock_unit_id = $1 AND status = 'PENDING_APPROVAL' AND id IS DISTINCT FROM $2 ORDER BY id LIMIT 1",
      [stockUnitId, exceptId],
    );
    return rows[0]?.id ?? null;
  }

  async listMortality(tx: Transaction, filters: MortalityFilters, scope: ReadScope, after: string | null, limit: number): Promise<MortalityRecord[]> {
    const p = new Params();
    const where = [p.scope(scope, { branch: 'branch_id', location: 'location_id' })];
    if (filters.status !== undefined) where.push(`status = ${p.add(filters.status)}`);
    if (filters.kind !== undefined) where.push(`kind = ${p.add(filters.kind)}`);
    if (filters.reportedBy !== undefined) where.push(`reported_by = ${p.add(filters.reportedBy)}`);
    if (filters.locationId !== undefined) where.push(`location_id = ${p.add(filters.locationId)}`);
    if (filters.from !== undefined) where.push(`found_at >= ${p.add(filters.from)}`);
    if (filters.to !== undefined) where.push(`found_at < ${p.add(filters.to)}`);
    if (after !== null) where.push(`id < ${p.add(after)}`);
    const { rows } = await tx.query<Row>(`SELECT ${MORTALITY_COLUMNS} FROM liv.mortality_record WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${p.add(limit)}`, p.values);
    return rows.map(mortality);
  }

  async insertRation(tx: Transaction, r: Omit<RationRecord, 'version'>, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO liv.ration (id, name, species_id, feed_product_id, qty_per_head_per_day, stage, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [r.id, r.name, r.speciesId, r.feedProductId, r.qtyPerHeadPerDay, r.stage, actorId],
    );
  }

  async ration(tx: Transaction, id: string): Promise<RationRecord | null> {
    const { rows } = await tx.query<Row>(`SELECT ${RATION_COLUMNS} FROM liv.ration WHERE id = $1 AND deleted_at IS NULL`, [id]);
    return rows[0] === undefined ? null : ration(rows[0]);
  }

  async updateRation(tx: Transaction, id: string, version: number, set: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean> {
    const p = new Params();
    const columns = assignments(set, RATION_SETTABLE, p);
    const { rowCount } = await tx.query(
      `UPDATE liv.ration SET ${[...columns, 'version = version + 1', 'updated_at = now()', `updated_by = ${p.add(actorId)}`].join(', ')} WHERE id = ${p.add(id)} AND version = ${p.add(version)} AND deleted_at IS NULL`,
      p.values,
    );
    return rowCount === 1;
  }

  async listRations(tx: Transaction, speciesId: string | undefined, after: string | null, limit: number): Promise<RationRecord[]> {
    const p = new Params();
    const where = ['deleted_at IS NULL'];
    if (speciesId !== undefined) where.push(`species_id = ${p.add(speciesId)}`);
    if (after !== null) where.push(`id > ${p.add(after)}`);
    const { rows } = await tx.query<Row>(`SELECT ${RATION_COLUMNS} FROM liv.ration WHERE ${where.join(' AND ')} ORDER BY id LIMIT ${p.add(limit)}`, p.values);
    return rows.map(ration);
  }

  async insertFeedConsumption(tx: Transaction, c: Omit<FeedConsumptionRecord, 'allocations' | 'createdBy'>, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO liv.feed_consumption (id, location_id, from_location_id, feed_product_id, qty, consumed_on, ration_id, value_pesewas, issue_movement_id,
                                         status, branch_id, posted_at, posted_by, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $12::timestamptz IS NULL THEN NULL ELSE $13::uuid END, $13, $13)`,
      [c.id, c.locationId, c.fromLocationId, c.feedProductId, c.qty, c.consumedOn, c.rationId, c.valuePesewas?.toString() ?? null, c.issueMovementId, c.status,
        c.branchId, c.postedAt, actorId],
    );
  }

  async insertFeedAllocation(tx: Transaction, consumptionId: string, a: CostAllocationRecord, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO liv.feed_cost_allocation (feed_consumption_id, stock_unit_id, head_days, amount_pesewas, treatment, movement_id, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [consumptionId, a.stockUnitId, a.headDays.toString(), a.amountPesewas.toString(), a.treatment, a.movementId, actorId],
    );
  }

  async feedConsumptions(tx: Transaction, ids: readonly string[]): Promise<FeedConsumptionRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<Row>(`SELECT ${FEED_COLUMNS} FROM liv.feed_consumption c WHERE c.id = ANY($1::uuid[])`, [[...ids]]);
    return rows.map(feed);
  }

  async listFeedConsumptions(tx: Transaction, filters: FeedFilters, scope: ReadScope, after: string | null, limit: number): Promise<FeedConsumptionRecord[]> {
    const p = new Params();
    const where = [p.scope(scope, { branch: 'c.branch_id', location: 'c.location_id' })];
    if (filters.locationId !== undefined) where.push(`c.location_id = ${p.add(filters.locationId)}`);
    if (filters.from !== undefined) where.push(`c.consumed_on >= ${p.add(filters.from)}`);
    if (filters.to !== undefined) where.push(`c.consumed_on <= ${p.add(filters.to)}`);
    if (after !== null) where.push(`c.id < ${p.add(after)}`);
    const { rows } = await tx.query<Row>(`SELECT ${FEED_COLUMNS} FROM liv.feed_consumption c WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT ${p.add(limit)}`, p.values);
    return rows.map(feed);
  }
}
