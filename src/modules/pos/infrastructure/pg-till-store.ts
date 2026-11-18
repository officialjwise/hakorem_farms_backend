import type { Transaction } from '../../../platform/database/unit-of-work';
import type { CashMovementRecord, DeviceRecord, HeldSaleRecord, LateCountRecord, NewShift, RegisterRecord, ShiftFilter, ShiftRecord, TenderCountRecord, TillStore } from '../application/till-store';
import type { CashMovementKind, OverShortDirection } from '../domain/till';

interface HeldSaleRow {
  id: string;
  register_id: string;
  shift_id: string;
  branch_id: string;
  held_by: string;
  label: string | null;
  payload: HeldSaleRecord['payload'];
  held_gross_pesewas: string;
  held_at: Date;
  expires_at: Date;
  status: HeldSaleRecord['status'];
  recalled_at: Date | null;
  recalled_by: string | null;
  lapsed_at: Date | null;
  lapse_reason: HeldSaleRecord['lapseReason'];
}

const HELD_SALE_COLUMNS =
  'h.id, h.register_id, h.shift_id, h.branch_id, h.held_by, h.label, h.payload, h.held_gross_pesewas::text, h.held_at, h.expires_at, h.status, h.recalled_at, h.recalled_by, h.lapsed_at, h.lapse_reason';

function heldSale(r: HeldSaleRow): HeldSaleRecord {
  return {
    id: r.id,
    registerId: r.register_id,
    shiftId: r.shift_id,
    branchId: r.branch_id,
    heldBy: r.held_by,
    label: r.label,
    payload: r.payload,
    heldGrossPesewas: BigInt(r.held_gross_pesewas),
    heldAt: r.held_at,
    expiresAt: r.expires_at,
    status: r.status,
    recalledAt: r.recalled_at,
    recalledBy: r.recalled_by,
    lapsedAt: r.lapsed_at,
    lapseReason: r.lapse_reason,
  };
}

interface RegisterRow {
  id: string;
  branch_id: string;
  location_id: string;
  code: string;
  name: string;
  status: RegisterRecord['status'];
  version: number;
}

interface ShiftRow {
  id: string;
  shift_no: string;
  register_id: string;
  cashier_id: string;
  shift_seq: number;
  opened_at: Date;
  opening_float_pesewas: string;
  declared_at: Date | null;
  declared_cash_pesewas: string | null;
  expected_cash_pesewas: string | null;
  over_short_pesewas: string | null;
  over_short_direction: OverShortDirection | null;
  close_approved_by: string | null;
  closed_at: Date | null;
  last_device_counter: number;
  force_closed: boolean;
  force_close_reason: string | null;
  status: ShiftRecord['status'];
  branch_id: string;
  version: number;
}

interface MovementRow {
  id: string;
  shift_id: string;
  kind: CashMovementKind;
  amount_pesewas: string;
  reason_code: string | null;
  note: string | null;
  witness_id: string | null;
  unwitnessed: boolean;
  occurred_at: Date;
  recorded_at: Date;
  actor_id: string;
}

interface DeviceRow {
  id: string;
  register_id: string;
  device_label: string;
  enrolled_by: string;
  enrolled_at: Date;
  last_sync_at: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  branch_id: string;
  version: number;
}

function device(r: DeviceRow): DeviceRecord {
  return {
    id: r.id,
    registerId: r.register_id,
    deviceLabel: r.device_label,
    enrolledBy: r.enrolled_by,
    enrolledAt: r.enrolled_at,
    lastSyncAt: r.last_sync_at,
    revokedAt: r.revoked_at,
    revokedBy: r.revoked_by,
    revokeReason: r.revoke_reason,
    branchId: r.branch_id,
    version: r.version,
  };
}

interface CountRow {
  shift_id: string;
  payment_method_id: string;
  declared_pesewas: string;
  expected_pesewas: string | null;
  variance_pesewas: string | null;
  variance_direction: OverShortDirection | null;
}

const REGISTER_COLUMNS = 'id, branch_id, location_id, code, name, status, version';
const SHIFT_COLUMNS = `id, shift_no, register_id, cashier_id, shift_seq, opened_at, opening_float_pesewas::text, declared_at, declared_cash_pesewas::text,
  expected_cash_pesewas::text, over_short_pesewas::text, over_short_direction, close_approved_by, closed_at, last_device_counter, force_closed, force_close_reason,
  status, branch_id, version`;
const MOVEMENT_COLUMNS = 'id, shift_id, kind, amount_pesewas::text, reason_code, note, witness_id, unwitnessed, occurred_at, recorded_at, actor_id';
const DEVICE_COLUMNS = 'id, register_id, device_label, enrolled_by, enrolled_at, last_sync_at, revoked_at, revoked_by, revoke_reason, branch_id, version';
const COUNT_COLUMNS = 'shift_id, payment_method_id, declared_pesewas::text, expected_pesewas::text, variance_pesewas::text, variance_direction';

const big = (value: string | null): bigint | null => (value === null ? null : BigInt(value));

function register(r: RegisterRow): RegisterRecord {
  return { id: r.id, branchId: r.branch_id, locationId: r.location_id, code: r.code, name: r.name, status: r.status, version: r.version };
}

function shift(r: ShiftRow): ShiftRecord {
  return {
    id: r.id,
    shiftNo: r.shift_no,
    registerId: r.register_id,
    cashierId: r.cashier_id,
    shiftSeq: r.shift_seq,
    openedAt: r.opened_at,
    openingFloatPesewas: BigInt(r.opening_float_pesewas),
    declaredAt: r.declared_at,
    declaredCashPesewas: big(r.declared_cash_pesewas),
    expectedCashPesewas: big(r.expected_cash_pesewas),
    overShortPesewas: big(r.over_short_pesewas),
    overShortDirection: r.over_short_direction,
    closeApprovedBy: r.close_approved_by,
    closedAt: r.closed_at,
    lastDeviceCounter: r.last_device_counter,
    forceClosed: r.force_closed,
    forceCloseReason: r.force_close_reason,
    status: r.status,
    branchId: r.branch_id,
    version: r.version,
  };
}

function movement(r: MovementRow): CashMovementRecord {
  return {
    id: r.id,
    shiftId: r.shift_id,
    kind: r.kind,
    amountPesewas: BigInt(r.amount_pesewas),
    reasonCode: r.reason_code,
    note: r.note,
    witnessId: r.witness_id,
    unwitnessed: r.unwitnessed,
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
    actorId: r.actor_id,
  };
}

function count(r: CountRow): TenderCountRecord {
  return {
    shiftId: r.shift_id,
    paymentMethodId: r.payment_method_id,
    declaredPesewas: BigInt(r.declared_pesewas),
    expectedPesewas: big(r.expected_pesewas),
    variancePesewas: big(r.variance_pesewas),
    varianceDirection: r.variance_direction,
  };
}

/** POS's tables, parameterised SQL only, never joined with another schema (MODULE_BOUNDARIES 7). */
export class PgTillStore implements TillStore {
  async registers(tx: Transaction, ids: readonly string[]): Promise<RegisterRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<RegisterRow>(`SELECT ${REGISTER_COLUMNS} FROM pos.register WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [ids]);
    return rows.map(register);
  }

  async lockRegister(tx: Transaction, id: string): Promise<RegisterRecord | null> {
    const { rows } = await tx.query<RegisterRow>(`SELECT ${REGISTER_COLUMNS} FROM pos.register WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id]);
    return rows[0] === undefined ? null : register(rows[0]);
  }

  async listRegisters(tx: Transaction, branchIds: readonly string[], beforeId: string | null, limit: number): Promise<RegisterRecord[]> {
    const { rows } = await tx.query<RegisterRow>(
      `SELECT ${REGISTER_COLUMNS} FROM pos.register
        WHERE deleted_at IS NULL AND branch_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR id < $2)
        ORDER BY id DESC LIMIT $3`,
      [branchIds, beforeId, limit],
    );
    return rows.map(register);
  }

  async insertRegister(tx: Transaction, r: Omit<RegisterRecord, 'version' | 'status'>, actorId: string, at: Date): Promise<void> {
    await tx.query(
      `INSERT INTO pos.register (id, branch_id, location_id, code, name, status, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7, $6, $7)`,
      [r.id, r.branchId, r.locationId, r.code, r.name, at, actorId],
    );
  }

  async updateRegister(tx: Transaction, id: string, patch: { readonly name: string; readonly locationId: string; readonly status: RegisterRecord['status'] }, actorId: string, at: Date): Promise<void> {
    await tx.query('UPDATE pos.register SET version = version + 1, name = $2, location_id = $3, status = $4, updated_at = $5, updated_by = $6 WHERE id = $1', [id, patch.name, patch.locationId, patch.status, at, actorId]);
  }

  async unclosedShifts(tx: Transaction, registerIds: readonly string[]): Promise<ReadonlyMap<string, ShiftRecord>> {
    if (registerIds.length === 0) return new Map();
    const { rows } = await tx.query<ShiftRow>(`SELECT ${SHIFT_COLUMNS} FROM pos.shift WHERE register_id = ANY($1::uuid[]) AND status <> 'CLOSED'`, [registerIds]);
    return new Map(rows.map((r) => [r.register_id, shift(r)]));
  }

  async unclosedShiftOfCashier(tx: Transaction, cashierId: string): Promise<ShiftRecord | null> {
    const { rows } = await tx.query<ShiftRow>(`SELECT ${SHIFT_COLUMNS} FROM pos.shift WHERE cashier_id = $1 AND status <> 'CLOSED'`, [cashierId]);
    return rows[0] === undefined ? null : shift(rows[0]);
  }

  async nextShiftSeq(tx: Transaction, registerId: string): Promise<number> {
    const { rows } = await tx.query<{ next: number }>('SELECT COALESCE(max(shift_seq), 0)::int + 1 AS next FROM pos.shift WHERE register_id = $1', [registerId]);
    return rows[0]!.next;
  }

  async insertShift(tx: Transaction, s: NewShift): Promise<void> {
    await tx.query(
      `INSERT INTO pos.shift (id, shift_no, register_id, cashier_id, shift_seq, opened_at, opening_float_pesewas, status, branch_id,
                              created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', $8, $9, $10, $9, $10)`,
      [s.id, s.shiftNo, s.registerId, s.cashierId, s.shiftSeq, s.openedAt, s.openingFloatPesewas.toString(), s.branchId, s.at, s.actorId],
    );
  }

  async shifts(tx: Transaction, ids: readonly string[]): Promise<ShiftRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<ShiftRow>(`SELECT ${SHIFT_COLUMNS} FROM pos.shift WHERE id = ANY($1::uuid[])`, [ids]);
    const byId = new Map(rows.map((r) => [r.id, shift(r)]));
    return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  }

  async lockShift(tx: Transaction, id: string): Promise<ShiftRecord | null> {
    const { rows } = await tx.query<ShiftRow>(`SELECT ${SHIFT_COLUMNS} FROM pos.shift WHERE id = $1 FOR UPDATE`, [id]);
    return rows[0] === undefined ? null : shift(rows[0]);
  }

  async listShifts(tx: Transaction, f: ShiftFilter, beforeId: string | null, limit: number): Promise<ShiftRecord[]> {
    const { rows } = await tx.query<ShiftRow>(
      `SELECT ${SHIFT_COLUMNS} FROM pos.shift
        WHERE branch_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR register_id = $2) AND ($3::uuid IS NULL OR cashier_id = $3)
          AND ($4::text IS NULL OR status = $4) AND ($5::timestamptz IS NULL OR opened_at >= $5) AND ($6::timestamptz IS NULL OR opened_at < $6)
          AND ($7::uuid IS NULL OR id < $7)
        ORDER BY id DESC LIMIT $8`,
      [f.branchIds, f.registerId, f.cashierId, f.status, f.from, f.to, beforeId, limit],
    );
    return rows.map(shift);
  }

  async declare(tx: Transaction, id: string, d: { readonly declaredCashPesewas: bigint; readonly at: Date; readonly actorId: string }): Promise<void> {
    await tx.query(
      `UPDATE pos.shift SET version = version + 1, status = 'CLOSING', declared_at = $2, declared_cash_pesewas = $3, updated_at = $2, updated_by = $4 WHERE id = $1`,
      [id, d.at, d.declaredCashPesewas.toString(), d.actorId],
    );
  }

  async close(
    tx: Transaction,
    id: string,
    c: { readonly expectedCashPesewas: bigint; readonly overShortPesewas: bigint; readonly overShortDirection: OverShortDirection; readonly approvedBy: string; readonly at: Date },
  ): Promise<void> {
    await tx.query(
      `UPDATE pos.shift SET version = version + 1, status = 'CLOSED', expected_cash_pesewas = $2, over_short_pesewas = $3, over_short_direction = $4, close_approved_by = $5,
              closed_at = $6, posted_at = $6, posted_by = $5, updated_at = $6, updated_by = $5
        WHERE id = $1`,
      [id, c.expectedCashPesewas.toString(), c.overShortPesewas.toString(), c.overShortDirection, c.approvedBy, c.at],
    );
  }

  async forceClose(tx: Transaction, id: string, c: { readonly expectedCashPesewas: bigint; readonly reason: string; readonly closedBy: string; readonly at: Date }): Promise<void> {
    await tx.query(
      `UPDATE pos.shift SET version = version + 1, status = 'CLOSED', force_closed = true, force_close_reason = $2, expected_cash_pesewas = $3, close_approved_by = $4,
              closed_at = $5, posted_at = $5, posted_by = $4, updated_at = $5, updated_by = $4
        WHERE id = $1`,
      [id, c.reason, c.expectedCashPesewas.toString(), c.closedBy, c.at],
    );
  }

  async insertLateCount(tx: Transaction, c: LateCountRecord): Promise<void> {
    await tx.query(
      `INSERT INTO pos.shift_late_count (shift_id, declared_cash_pesewas, expected_cash_pesewas, over_short_pesewas, over_short_direction, reason, counted_at, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)`,
      [c.shiftId, c.declaredCashPesewas.toString(), c.expectedCashPesewas.toString(), c.overShortPesewas.toString(), c.overShortDirection, c.reason, c.countedAt, c.actorId],
    );
  }

  async lateCounts(tx: Transaction, shiftIds: readonly string[]): Promise<ReadonlyMap<string, LateCountRecord>> {
    if (shiftIds.length === 0) return new Map();
    const { rows } = await tx.query<{ shift_id: string; declared: string; expected: string; over_short: string; direction: OverShortDirection; reason: string; counted_at: Date; actor_id: string }>(
      `SELECT shift_id, declared_cash_pesewas::text AS declared, expected_cash_pesewas::text AS expected, over_short_pesewas::text AS over_short,
              over_short_direction AS direction, reason, counted_at, actor_id
         FROM pos.shift_late_count WHERE shift_id = ANY($1::uuid[])`,
      [shiftIds],
    );
    return new Map(
      rows.map((r) => [
        r.shift_id,
        { shiftId: r.shift_id, declaredCashPesewas: BigInt(r.declared), expectedCashPesewas: BigInt(r.expected), overShortPesewas: BigInt(r.over_short), overShortDirection: r.direction, reason: r.reason, countedAt: r.counted_at, actorId: r.actor_id },
      ]),
    );
  }

  async insertCashMovement(tx: Transaction, m: CashMovementRecord): Promise<void> {
    await tx.query(
      `INSERT INTO pos.cash_movement (id, shift_id, kind, amount_pesewas, reason_code, note, witness_id, unwitnessed, occurred_at, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [m.id, m.shiftId, m.kind, m.amountPesewas.toString(), m.reasonCode, m.note, m.witnessId, m.unwitnessed, m.occurredAt, m.recordedAt, m.actorId],
    );
  }

  async cashMovements(tx: Transaction, ids: readonly string[]): Promise<CashMovementRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<MovementRow>(`SELECT ${MOVEMENT_COLUMNS} FROM pos.cash_movement WHERE id = ANY($1::uuid[])`, [ids]);
    return rows.map(movement);
  }

  async cashMovementsOf(tx: Transaction, shiftId: string, beforeId: string | null, limit: number): Promise<CashMovementRecord[]> {
    const { rows } = await tx.query<MovementRow>(
      `SELECT ${MOVEMENT_COLUMNS} FROM pos.cash_movement WHERE shift_id = $1 AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
      [shiftId, beforeId, limit],
    );
    return rows.map(movement);
  }

  async cashMovementTotals(tx: Transaction, shiftId: string): Promise<ReadonlyMap<CashMovementKind, bigint>> {
    const { rows } = await tx.query<{ kind: CashMovementKind; total: string }>(
      'SELECT kind, sum(amount_pesewas)::text AS total FROM pos.cash_movement WHERE shift_id = $1 GROUP BY kind',
      [shiftId],
    );
    return new Map(rows.map((r) => [r.kind, BigInt(r.total)]));
  }

  async unwitnessedDrops(tx: Transaction, shiftId: string): Promise<{ readonly count: number; readonly amountPesewas: bigint }> {
    const { rows } = await tx.query<{ n: number; total: string }>(
      "SELECT count(*)::int AS n, COALESCE(sum(amount_pesewas), 0)::text AS total FROM pos.cash_movement WHERE shift_id = $1 AND kind = 'CASH_DROP' AND unwitnessed",
      [shiftId],
    );
    return { count: rows[0]!.n, amountPesewas: BigInt(rows[0]!.total) };
  }

  async insertTenderCounts(tx: Transaction, counts: readonly TenderCountRecord[], actorId: string, at: Date): Promise<void> {
    for (const c of counts) {
      await tx.query(
        `INSERT INTO pos.shift_tender_count (shift_id, payment_method_id, declared_pesewas, created_at, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [c.shiftId, c.paymentMethodId, c.declaredPesewas.toString(), at, actorId],
      );
    }
  }

  async completeTenderCount(tx: Transaction, c: TenderCountRecord): Promise<void> {
    await tx.query(
      `UPDATE pos.shift_tender_count SET expected_pesewas = $3, variance_pesewas = $4, variance_direction = $5 WHERE shift_id = $1 AND payment_method_id = $2`,
      [c.shiftId, c.paymentMethodId, c.expectedPesewas?.toString() ?? null, c.variancePesewas?.toString() ?? null, c.varianceDirection],
    );
  }

  async tenderCounts(tx: Transaction, shiftIds: readonly string[]): Promise<TenderCountRecord[]> {
    if (shiftIds.length === 0) return [];
    const { rows } = await tx.query<CountRow>(`SELECT ${COUNT_COLUMNS} FROM pos.shift_tender_count WHERE shift_id = ANY($1::uuid[]) ORDER BY shift_id, payment_method_id`, [shiftIds]);
    return rows.map(count);
  }

  async insertReport(tx: Transaction, r: { readonly id: string; readonly shiftId: string; readonly kind: 'Z'; readonly totals: object; readonly actorId: string; readonly at: Date }): Promise<void> {
    await tx.query('INSERT INTO pos.shift_report (id, shift_id, kind, totals, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, $6)', [r.id, r.shiftId, r.kind, JSON.stringify(r.totals), r.at, r.actorId]);
  }

  async zReport(tx: Transaction, shiftId: string): Promise<{ readonly totals: Record<string, unknown>; readonly recordedAt: Date } | null> {
    const { rows } = await tx.query<{ totals: Record<string, unknown>; recorded_at: Date }>("SELECT totals, recorded_at FROM pos.shift_report WHERE shift_id = $1 AND kind = 'Z'", [shiftId]);
    return rows[0] === undefined ? null : { totals: rows[0].totals, recordedAt: rows[0].recorded_at };
  }

  async insertDevice(tx: Transaction, d: { readonly id: string; readonly registerId: string; readonly deviceLabel: string; readonly credentialHash: Buffer; readonly branchId: string }, actorId: string, at: Date): Promise<void> {
    await tx.query(
      `INSERT INTO pos.device_enrolment (id, register_id, device_label, credential_hash, enrolled_by, enrolled_at, branch_id, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $5, $6, $5)`,
      [d.id, d.registerId, d.deviceLabel, d.credentialHash, actorId, at, d.branchId],
    );
  }

  async devices(tx: Transaction, ids: readonly string[]): Promise<DeviceRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<DeviceRow>(`SELECT ${DEVICE_COLUMNS} FROM pos.device_enrolment WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [ids]);
    return rows.map(device);
  }

  async lockDevice(tx: Transaction, id: string): Promise<DeviceRecord | null> {
    const { rows } = await tx.query<DeviceRow>(`SELECT ${DEVICE_COLUMNS} FROM pos.device_enrolment WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id]);
    return rows[0] === undefined ? null : device(rows[0]);
  }

  async deviceByCredential(tx: Transaction, credentialHash: Buffer): Promise<DeviceRecord | null> {
    const { rows } = await tx.query<DeviceRow>(`SELECT ${DEVICE_COLUMNS} FROM pos.device_enrolment WHERE credential_hash = $1 AND deleted_at IS NULL`, [credentialHash]);
    return rows[0] === undefined ? null : device(rows[0]);
  }

  async devicesOfRegister(tx: Transaction, registerId: string, beforeId: string | null, limit: number): Promise<DeviceRecord[]> {
    const { rows } = await tx.query<DeviceRow>(
      `SELECT ${DEVICE_COLUMNS} FROM pos.device_enrolment WHERE register_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
      [registerId, beforeId, limit],
    );
    return rows.map(device);
  }

  async revokeDevice(tx: Transaction, id: string, reason: string, actorId: string, at: Date): Promise<void> {
    await tx.query('UPDATE pos.device_enrolment SET version = version + 1, revoked_at = $2, revoked_by = $3, revoke_reason = $4, updated_at = $2, updated_by = $3 WHERE id = $1', [id, at, actorId, reason]);
  }

  async liveDeviceCounts(tx: Transaction, registerIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (registerIds.length === 0) return new Map();
    const { rows } = await tx.query<{ register_id: string; n: number }>(
      'SELECT register_id, count(*)::int AS n FROM pos.device_enrolment WHERE register_id = ANY($1::uuid[]) AND revoked_at IS NULL AND deleted_at IS NULL GROUP BY register_id',
      [registerIds],
    );
    return new Map(rows.map((r) => [r.register_id, r.n]));
  }

  async insertHeldSale(tx: Transaction, h: Omit<HeldSaleRecord, 'status' | 'recalledAt' | 'recalledBy' | 'lapsedAt' | 'lapseReason'>): Promise<void> {
    await tx.query(
      `INSERT INTO pos.held_sale (id, register_id, shift_id, branch_id, held_by, label, payload, held_gross_pesewas, held_at, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'HELD')`,
      [h.id, h.registerId, h.shiftId, h.branchId, h.heldBy, h.label, JSON.stringify(h.payload), h.heldGrossPesewas.toString(), h.heldAt, h.expiresAt],
    );
  }

  async heldSales(tx: Transaction, ids: readonly string[], forUpdate = false): Promise<HeldSaleRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<HeldSaleRow>(`SELECT ${HELD_SALE_COLUMNS} FROM pos.held_sale h WHERE h.id = ANY($1::uuid[]) ORDER BY h.id${forUpdate ? ' FOR UPDATE' : ''}`, [ids]);
    return rows.map(heldSale);
  }

  async heldSalesOfRegister(tx: Transaction, registerId: string, at: Date, beforeId: string | null, limit: number): Promise<HeldSaleRecord[]> {
    const { rows } = await tx.query<HeldSaleRow>(
      `SELECT ${HELD_SALE_COLUMNS} FROM pos.held_sale h JOIN pos.shift s ON s.id = h.shift_id
        WHERE h.register_id = $1 AND h.status = 'HELD' AND s.status = 'OPEN' AND h.expires_at > $2 AND ($3::uuid IS NULL OR h.id < $3)
        ORDER BY h.id DESC LIMIT $4`,
      [registerId, at, beforeId, limit],
    );
    return rows.map(heldSale);
  }

  async recallHeldSale(tx: Transaction, id: string, r: { readonly by: string; readonly at: Date }): Promise<void> {
    await tx.query("UPDATE pos.held_sale SET status = 'RECALLED', recalled_at = $2, recalled_by = $3 WHERE id = $1", [id, r.at, r.by]);
  }

  async lapseHeldSales(tx: Transaction, shiftId: string, l: { readonly reason: 'SHIFT_CLOSED' | 'SHIFT_FORCE_CLOSED'; readonly at: Date }): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>(
      "UPDATE pos.held_sale SET status = 'LAPSED', lapsed_at = $2, lapse_reason = $3 WHERE shift_id = $1 AND status = 'HELD' RETURNING id",
      [shiftId, l.at, l.reason],
    );
    return rows.map((r) => r.id).sort();
  }
}
