import { databaseErrorOf, type Transaction } from '../../../platform/database/unit-of-work';
import type {
  Completion,
  CostRecord,
  InputRecord,
  NewInput,
  NewOutput,
  OrderFilters,
  OrderRecord,
  OrderStatus,
  NewPack,
  OutputRecord,
  PackRecord,
  PackStatus,
  ProcessingStore,
  ReadScope,
  YieldStandardRecord,
} from '../application/processing-store';

const ORDER = `SELECT o.id, o.order_no AS "orderNo", o.status, o.location_id AS "locationId", o.output_location_id AS "outputLocationId",
                      o.started_at AS "startedAt", o.completed_at AS "completedAt", o.input_weight_kg::text AS "inputWeightKg",
                      o.output_weight_kg::text AS "outputWeightKg", o.waste_weight_kg::text AS "wasteWeightKg",
                      o.expected_yield_percent::text AS "expectedYieldPercent", o.actual_yield_percent::text AS "actualYieldPercent",
                      o.yield_variance_flag AS "yieldVarianceFlag", o.input_cost_pesewas::text AS "inputCostPesewas",
                      o.direct_cost_pesewas::text AS "directCostPesewas", o.total_cost_pesewas::text AS "totalCostPesewas",
                      o.cancel_reason AS "cancelReason", o.branch_id AS "branchId", o.version, o.created_at AS "createdAt",
                      o.created_by AS "createdBy", o.posted_at AS "postedAt", o.posted_by AS "postedBy",
                      rv.id AS "reversalId", rv.reason AS "reversalReason", rv.posted_at AS "reversedAt", rv.posted_by AS "reversedBy"
                 FROM prc.processing_order o LEFT JOIN prc.processing_reversal rv ON rv.processing_order_id = o.id`;

type OrderRow = Omit<OrderRecord, 'inputs' | 'outputs' | 'costs' | 'inputCostPesewas' | 'directCostPesewas' | 'totalCostPesewas' | 'reversal'> & {
  reversalId: string | null;
  reversalReason: string | null;
  reversedAt: Date | null;
  reversedBy: string | null;
  inputCostPesewas: string | null;
  directCostPesewas: string;
  totalCostPesewas: string | null;
};

const PACK = `SELECT k.id, k.stock_unit_id AS "stockUnitId", k.processing_output_id AS "processingOutputId", p.line_no AS "outputLineNo",
                     k.pack_no AS "packNo", k.weight_kg::text AS "weightKg", k.weight_source AS "weightSource", k.barcode,
                     k.label_printed_at AS "labelPrintedAt", k.status
                FROM prc.pack k JOIN prc.processing_output p ON p.id = k.processing_output_id`;

const big = (text: string | null): bigint | null => (text === null ? null : BigInt(text));

/** Fixed three places for a percent column (`numeric(7,4)`), which the domain wrote with three. */
const percent3 = (text: string | null): string | null => (text === null ? null : text.replace(/^(\d+\.\d{3})\d*$/, '$1'));

/** The `prc` schema of migration 0072. Point reads by key; lists by branch and creation time. */
export class PgProcessingStore implements ProcessingStore {
  async insertOrder(tx: Transaction, order: { id: string; locationId: string; outputLocationId: string; branchId: string }, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO prc.processing_order (id, location_id, output_location_id, status, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, 'PLANNED', $4, $5, $5)`,
      [order.id, order.locationId, order.outputLocationId, order.branchId, actorId],
    );
  }

  async order(tx: Transaction, id: string): Promise<OrderRecord | null> {
    const { rows } = await tx.query<OrderRow>(`${ORDER} WHERE o.id = $1`, [id]);
    return (await this.withParts(tx, rows))[0] ?? null;
  }

  async lock(tx: Transaction, id: string): Promise<{ status: OrderStatus; version: number } | null> {
    const { rows } = await tx.query<{ status: OrderStatus; version: number }>('SELECT status, version FROM prc.processing_order WHERE id = $1 FOR UPDATE', [id]);
    return rows[0] ?? null;
  }

  async orders(tx: Transaction, filters: OrderFilters, scopes: readonly ReadScope[], afterId: string | null, limit: number): Promise<OrderRecord[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (!scopes.some((s) => s.branchId === null && s.locationId === null)) {
      const branches = scopes.filter((s) => s.branchId !== null && s.locationId === null).map((s) => s.branchId);
      const locations = scopes.filter((s) => s.locationId !== null).map((s) => s.locationId);
      where.push(`(o.branch_id = ANY(${add(branches)}::uuid[]) OR o.location_id = ANY(${add(locations)}::uuid[]))`);
    }
    if (filters.status !== undefined) where.push(`o.status = ${add(filters.status)}`);
    if (filters.yieldVarianceFlag !== undefined) where.push(`o.yield_variance_flag = ${add(filters.yieldVarianceFlag)}`);
    if (filters.from !== undefined) where.push(`(o.created_at AT TIME ZONE 'Africa/Accra')::date >= ${add(filters.from)}::date`);
    if (filters.to !== undefined) where.push(`(o.created_at AT TIME ZONE 'Africa/Accra')::date <= ${add(filters.to)}::date`);
    if (afterId !== null) where.push(`o.id < ${add(afterId)}`);
    const { rows } = await tx.query<OrderRow>(`${ORDER} ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`} ORDER BY o.id DESC LIMIT ${add(limit)}`, params);
    return this.withParts(tx, rows);
  }

  async touch(tx: Transaction, id: string, version: number, set: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean> {
    const columns = Object.keys(set);
    const assignments = columns.map((column, index) => `${column} = $${index + 4}`);
    const result = await tx.query(
      `UPDATE prc.processing_order SET ${[...assignments, 'version = version + 1', 'updated_by = $3', 'updated_at = now()'].join(', ')} WHERE id = $1 AND version = $2`,
      [id, version, actorId, ...columns.map((column) => set[column])],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async insertInput(tx: Transaction, orderId: string, input: NewInput): Promise<void> {
    await tx.query(
      `INSERT INTO prc.processing_input (id, processing_order_id, line_no, stock_unit_id, product_id, qty, weight_kg, weight_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [input.id, orderId, input.lineNo, input.stockUnitId, input.productId, input.qty, input.weightKg, input.weightSource],
    );
  }

  async clearInputs(tx: Transaction, orderId: string): Promise<void> {
    await tx.query('SELECT prc.clear_processing_inputs($1)', [orderId]);
  }

  async insertOutput(tx: Transaction, orderId: string, output: NewOutput): Promise<void> {
    await tx.query(
      `INSERT INTO prc.processing_output (id, processing_order_id, line_no, product_id, output_kind, weight_kg, weight_source, pack_count, expires_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [output.id, orderId, output.lineNo, output.productId, output.outputKind, output.weightKg, output.weightSource, output.packCount, output.expiresOn],
    );
  }

  async clearOutputs(tx: Transaction, orderId: string): Promise<void> {
    await tx.query('SELECT prc.clear_processing_outputs($1)', [orderId]);
  }

  async insertCost(tx: Transaction, orderId: string, cost: { id: string; costKind: string; amountPesewas: bigint; description: string }, actorId: string): Promise<void> {
    await tx.query(
      'INSERT INTO prc.processing_cost (id, processing_order_id, cost_kind, amount_pesewas, description, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
      [cost.id, orderId, cost.costKind, cost.amountPesewas.toString(), cost.description, actorId],
    );
  }

  async markStarted(tx: Transaction, id: string, at: Date, actorId: string): Promise<void> {
    await tx.query("UPDATE prc.processing_order SET status = 'IN_PROGRESS', started_at = $2, version = version + 1, updated_by = $3, updated_at = now() WHERE id = $1", [id, at, actorId]);
  }

  async markCancelled(tx: Transaction, id: string, reason: string, actorId: string): Promise<void> {
    await tx.query("UPDATE prc.processing_order SET status = 'CANCELLED', cancel_reason = $2, version = version + 1, updated_by = $3, updated_at = now() WHERE id = $1", [id, reason, actorId]);
  }

  async setInputConsumed(tx: Transaction, inputId: string, costPesewas: bigint, movementId: string): Promise<void> {
    await tx.query('UPDATE prc.processing_input SET cost_pesewas = $2, movement_id = $3 WHERE id = $1', [inputId, costPesewas.toString(), movementId]);
  }

  async setOutputCosted(
    tx: Transaction,
    outputId: string,
    c: { referencePricePesewasPerKg: bigint; allocationWeight: bigint; allocatedCostPesewas: bigint; expiresOn: string | null; stockUnitId: string | null; movementId: string | null },
  ): Promise<void> {
    await tx.query(
      `UPDATE prc.processing_output SET reference_price_pesewas_per_kg = $2, allocation_weight = $3, allocated_cost_pesewas = $4, expires_on = $5, stock_unit_id = $6, movement_id = $7
        WHERE id = $1`,
      [outputId, c.referencePricePesewasPerKg.toString(), c.allocationWeight.toString(), c.allocatedCostPesewas.toString(), c.expiresOn, c.stockUnitId, c.movementId],
    );
  }

  async markCompleted(tx: Transaction, id: string, c: Completion, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE prc.processing_order
          SET status = 'COMPLETED', completed_at = $2, posted_at = $2, posted_by = $3, input_weight_kg = $4, output_weight_kg = $5, waste_weight_kg = $6,
              expected_yield_percent = $7, actual_yield_percent = $8, yield_variance_flag = $9, input_cost_pesewas = $10, total_cost_pesewas = $11,
              version = version + 1, updated_by = $3, updated_at = now()
        WHERE id = $1`,
      [id, c.at, actorId, c.inputWeightKg, c.outputWeightKg, c.wasteWeightKg, c.expectedYieldPercent, c.actualYieldPercent, c.yieldVarianceFlag, c.inputCostPesewas.toString(), c.totalCostPesewas.toString()],
    );
  }

  async standards(tx: Transaction, afterId: string | null, limit: number): Promise<YieldStandardRecord[]> {
    const { rows } = await tx.query<YieldStandardRecord>(`${STANDARD} WHERE s.deleted_at IS NULL AND ($1::uuid IS NULL OR s.id > $1) ORDER BY s.id LIMIT $2`, [afterId, limit]);
    return rows;
  }

  async standard(tx: Transaction, id: string): Promise<YieldStandardRecord | null> {
    const { rows } = await tx.query<YieldStandardRecord>(`${STANDARD} WHERE s.id = $1 AND s.deleted_at IS NULL`, [id]);
    return rows[0] ?? null;
  }

  async standardsOf(tx: Transaction, inputProductId: string): Promise<YieldStandardRecord[]> {
    const { rows } = await tx.query<YieldStandardRecord>(`${STANDARD} WHERE s.input_product_id = $1 AND s.deleted_at IS NULL ORDER BY s.id`, [inputProductId]);
    return rows;
  }

  async insertStandard(tx: Transaction, s: Omit<YieldStandardRecord, 'version'>, actorId: string): Promise<boolean> {
    try {
      await tx.query('SAVEPOINT yield_standard_insert');
      await tx.query(
        `INSERT INTO prc.yield_standard (id, input_product_id, output_product_id, expected_percent, tolerance_percent, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [s.id, s.inputProductId, s.outputProductId, s.expectedPercent, s.tolerancePercent, actorId],
      );
      await tx.query('RELEASE SAVEPOINT yield_standard_insert');
      return true;
    } catch (error) {
      const failure = databaseErrorOf(error);
      if (failure?.code === '23505' && failure.constraint === 'uq_yield_standard_products') {
        await tx.query('ROLLBACK TO SAVEPOINT yield_standard_insert');
        return false;
      }
      throw error;
    }
  }

  async updateStandard(tx: Transaction, id: string, version: number, set: { expectedPercent?: string; tolerancePercent?: string }, actorId: string): Promise<boolean> {
    const result = await tx.query(
      `UPDATE prc.yield_standard SET expected_percent = COALESCE($3, expected_percent), tolerance_percent = COALESCE($4, tolerance_percent),
              version = version + 1, updated_by = $5, updated_at = now()
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL`,
      [id, version, set.expectedPercent ?? null, set.tolerancePercent ?? null, actorId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  private async withParts(tx: Transaction, rows: readonly OrderRow[]): Promise<OrderRecord[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const inputs = await tx.query<InputRecord & { orderId: string; costPesewas: string | null }>(
      `SELECT processing_order_id AS "orderId", id, line_no AS "lineNo", stock_unit_id AS "stockUnitId", product_id AS "productId", qty::text AS qty,
              weight_kg::text AS "weightKg", weight_source AS "weightSource", cost_pesewas::text AS "costPesewas", movement_id AS "movementId"
         FROM prc.processing_input WHERE processing_order_id = ANY($1::uuid[]) ORDER BY line_no`,
      [ids],
    );
    const outputs = await tx.query<
      Omit<OutputRecord, 'referencePricePesewasPerKg' | 'allocationWeight' | 'allocatedCostPesewas' | 'expiresOn'> & {
        orderId: string;
        referencePricePesewasPerKg: string;
        allocationWeight: string;
        allocatedCostPesewas: string;
        expiresOn: string | null;
      }
    >(
      `SELECT processing_order_id AS "orderId", id, line_no AS "lineNo", product_id AS "productId", output_kind AS "outputKind", stock_unit_id AS "stockUnitId",
              weight_kg::text AS "weightKg", weight_source AS "weightSource", pack_count AS "packCount", to_char(expires_on, 'YYYY-MM-DD') AS "expiresOn",
              reference_price_pesewas_per_kg::text AS "referencePricePesewasPerKg", allocation_weight::text AS "allocationWeight",
              allocated_cost_pesewas::text AS "allocatedCostPesewas", movement_id AS "movementId"
         FROM prc.processing_output WHERE processing_order_id = ANY($1::uuid[]) ORDER BY line_no`,
      [ids],
    );
    const costs = await tx.query<Omit<CostRecord, 'amountPesewas'> & { orderId: string; amountPesewas: string }>(
      `SELECT processing_order_id AS "orderId", id, cost_kind AS "costKind", amount_pesewas::text AS "amountPesewas", description, created_at AS "createdAt", created_by AS "createdBy"
         FROM prc.processing_cost WHERE processing_order_id = ANY($1::uuid[]) ORDER BY created_at, id`,
      [ids],
    );
    return rows.map(({ reversalId, reversalReason, reversedAt, reversedBy, ...r }) => ({
      ...r,
      reversal: reversalId === null ? null : { id: reversalId, reason: reversalReason!, at: reversedAt!, by: reversedBy! },
      expectedYieldPercent: percent3(r.expectedYieldPercent),
      actualYieldPercent: percent3(r.actualYieldPercent),
      inputCostPesewas: big(r.inputCostPesewas),
      directCostPesewas: BigInt(r.directCostPesewas),
      totalCostPesewas: big(r.totalCostPesewas),
      inputs: inputs.rows.filter((i) => i.orderId === r.id).map(({ orderId: _o, ...i }) => ({ ...i, costPesewas: big(i.costPesewas) })),
      outputs: outputs.rows
        .filter((o) => o.orderId === r.id)
        .map(({ orderId: _o, ...o }) => ({ ...o, referencePricePesewasPerKg: BigInt(o.referencePricePesewasPerKg), allocationWeight: BigInt(o.allocationWeight), allocatedCostPesewas: BigInt(o.allocatedCostPesewas) })),
      costs: costs.rows.filter((c) => c.orderId === r.id).map(({ orderId: _o, ...c }) => ({ ...c, amountPesewas: BigInt(c.amountPesewas) })),
    }));
  }

  async packsOf(tx: Transaction, orderId: string, after: { lineNo: number; packNo: number } | null, limit: number): Promise<PackRecord[]> {
    const { rows } = await tx.query<PackRecord>(
      `${PACK} WHERE p.processing_order_id = $1 AND ($2::integer IS NULL OR (p.line_no, k.pack_no) > ($2, $3))
        ORDER BY p.line_no, k.pack_no LIMIT $4`,
      [orderId, after?.lineNo ?? null, after?.packNo ?? null, limit],
    );
    return rows;
  }

  async lockPacks(tx: Transaction, ids: readonly string[]): Promise<PackRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<PackRecord>(`${PACK} WHERE k.id = ANY($1::uuid[]) ORDER BY p.line_no, k.pack_no FOR UPDATE OF k`, [ids]);
    return rows;
  }

  async insertPack(tx: Transaction, pack: NewPack, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO prc.pack (id, stock_unit_id, processing_output_id, pack_no, weight_kg, weight_source, barcode, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [pack.id, pack.stockUnitId, pack.processingOutputId, pack.packNo, pack.weightKg, pack.weightSource, pack.barcode, actorId],
    );
  }

  async markPrinted(tx: Transaction, ids: readonly string[], at: Date, actorId: string): Promise<void> {
    await tx.query('UPDATE prc.pack SET label_printed_at = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = ANY($1::uuid[]) AND label_printed_at IS NULL', [ids, at, actorId]);
  }

  async setPackStatus(tx: Transaction, ids: readonly string[], status: PackStatus, actorId: string): Promise<void> {
    if (ids.length === 0) return;
    await tx.query('UPDATE prc.pack SET status = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = ANY($1::uuid[]) AND status <> $2', [ids, status, actorId]);
  }

  async insertReversal(tx: Transaction, reversal: { id: string; orderId: string; branchId: string; reason: string; at: Date }, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO prc.processing_reversal (id, processing_order_id, branch_id, reason, status, posted_at, posted_by, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 'POSTED', $5, $6, $6, $6)`,
      [reversal.id, reversal.orderId, reversal.branchId, reversal.reason, reversal.at, actorId],
    );
  }
}

const STANDARD = `SELECT s.id, s.input_product_id AS "inputProductId", s.output_product_id AS "outputProductId", s.expected_percent::text AS "expectedPercent",
                         s.tolerance_percent::text AS "tolerancePercent", s.version
                    FROM prc.yield_standard s`;
