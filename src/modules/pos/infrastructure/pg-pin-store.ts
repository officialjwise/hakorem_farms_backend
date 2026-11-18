import type { Transaction } from '../../../platform/database/unit-of-work';
import { pinKey, type PinStore, type TillPinEventRecord, type TillPinRecord, type TillSignOutRecord } from '../application/pin-store';

interface PinRow {
  id: string;
  principal_id: string;
  version: number;
  algorithm: string;
  iterations: number;
  salt: Buffer;
  hash: Buffer;
  set_at: Date;
  recorded_at: Date;
  superseded_at: Date | null;
}

const PIN_SELECT = `SELECT p.id, p.principal_id, p.version, p.algorithm, p.iterations, p.salt, p.hash, p.set_at, p.recorded_at,
       (SELECT min(n.set_at) FROM pos.till_pin n WHERE n.principal_id = p.principal_id AND n.version > p.version) AS superseded_at
  FROM pos.till_pin p`;

function pin(r: PinRow): TillPinRecord {
  return {
    id: r.id,
    principalId: r.principal_id,
    version: r.version,
    algorithm: r.algorithm,
    iterations: r.iterations,
    salt: r.salt,
    hash: r.hash,
    setAt: r.set_at,
    recordedAt: r.recorded_at,
    supersededAt: r.superseded_at,
  };
}

interface EventRow {
  id: string;
  register_id: string;
  device_id: string;
  branch_id: string;
  principal_id: string;
  pin_version: number;
  outcome: TillPinEventRecord['outcome'];
  purpose: TillPinEventRecord['purpose'];
  occurred_at: Date;
  received_at: Date;
  recorded_at: Date;
  actor_id: string;
}

interface SignOutRow {
  id: string;
  register_id: string;
  device_id: string;
  branch_id: string;
  shift_id: string | null;
  cashier_id: string;
  supervisor_id: string;
  supervisor_pin_version: number;
  occurred_at: Date;
  received_at: Date;
  recorded_at: Date;
  actor_id: string;
}

/** `pos.till_pin`, `pos.till_pin_event` and `pos.till_sign_out` (migration 0270), parameterised SQL only. */
export class PgPinStore implements PinStore {
  async latestPins(tx: Transaction, principalIds: readonly string[]): Promise<TillPinRecord[]> {
    if (principalIds.length === 0) return [];
    const { rows } = await tx.query<PinRow>(
      `${PIN_SELECT} WHERE p.principal_id = ANY($1::uuid[])
          AND p.version = (SELECT max(m.version) FROM pos.till_pin m WHERE m.principal_id = p.principal_id)
        ORDER BY p.principal_id`,
      [principalIds],
    );
    return rows.map(pin);
  }

  async pinVersion(tx: Transaction, principalId: string, version: number): Promise<TillPinRecord | null> {
    const { rows } = await tx.query<PinRow>(`${PIN_SELECT} WHERE p.principal_id = $1 AND p.version = $2`, [principalId, version]);
    return rows[0] === undefined ? null : pin(rows[0]);
  }

  async saltUsed(tx: Transaction, salt: Buffer): Promise<boolean> {
    const { rows } = await tx.query('SELECT 1 FROM pos.till_pin WHERE salt = $1', [salt]);
    return rows.length > 0;
  }

  async insertPin(tx: Transaction, r: Omit<TillPinRecord, 'supersededAt'>): Promise<void> {
    await tx.query(
      `INSERT INTO pos.till_pin (id, principal_id, version, algorithm, iterations, salt, hash, set_at, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $2)`,
      [r.id, r.principalId, r.version, r.algorithm, r.iterations, r.salt, r.hash, r.setAt, r.recordedAt],
    );
  }

  async wrongTries(tx: Transaction, principalId: string, version: number, at: Date | null): Promise<number> {
    const { rows } = await tx.query<{ n: string }>("SELECT pos.till_pin_wrong_tries($1, $2, COALESCE($3::timestamptz, 'infinity'))::text AS n", [principalId, version, at]);
    return Number(rows[0]!.n);
  }

  async wrongTriesOf(tx: Transaction, pins: readonly { readonly principalId: string; readonly version: number }[]): Promise<ReadonlyMap<string, number>> {
    if (pins.length === 0) return new Map();
    const { rows } = await tx.query<{ principal_id: string; pin_version: number; n: number }>(
      `SELECT e.principal_id, e.pin_version, count(*)::int AS n
         FROM pos.till_pin_event e JOIN unnest($1::uuid[], $2::int[]) AS q (principal_id, version) ON q.principal_id = e.principal_id AND q.version = e.pin_version
        WHERE e.outcome = 'FAILED'
        GROUP BY e.principal_id, e.pin_version`,
      [pins.map((p) => p.principalId), pins.map((p) => p.version)],
    );
    return new Map(rows.map((r) => [pinKey(r.principal_id, r.pin_version), r.n] as const));
  }

  async eventById(tx: Transaction, id: string): Promise<TillPinEventRecord | null> {
    const { rows } = await tx.query<EventRow>(
      'SELECT id, register_id, device_id, branch_id, principal_id, pin_version, outcome, purpose, occurred_at, received_at, recorded_at, actor_id FROM pos.till_pin_event WHERE id = $1',
      [id],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : {
          id: r.id,
          registerId: r.register_id,
          deviceId: r.device_id,
          branchId: r.branch_id,
          principalId: r.principal_id,
          pinVersion: r.pin_version,
          outcome: r.outcome,
          purpose: r.purpose,
          occurredAt: r.occurred_at,
          receivedAt: r.received_at,
          recordedAt: r.recorded_at,
          actorId: r.actor_id,
        };
  }

  async insertEvent(tx: Transaction, r: TillPinEventRecord): Promise<void> {
    await tx.query(
      `INSERT INTO pos.till_pin_event (id, register_id, device_id, branch_id, principal_id, pin_version, outcome, purpose, occurred_at, received_at, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [r.id, r.registerId, r.deviceId, r.branchId, r.principalId, r.pinVersion, r.outcome, r.purpose, r.occurredAt, r.receivedAt, r.recordedAt, r.actorId],
    );
  }

  async signOutById(tx: Transaction, id: string): Promise<TillSignOutRecord | null> {
    const { rows } = await tx.query<SignOutRow>(
      `SELECT id, register_id, device_id, branch_id, shift_id, cashier_id, supervisor_id, supervisor_pin_version, occurred_at, received_at, recorded_at, actor_id
         FROM pos.till_sign_out WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : {
          id: r.id,
          registerId: r.register_id,
          deviceId: r.device_id,
          branchId: r.branch_id,
          shiftId: r.shift_id,
          cashierId: r.cashier_id,
          supervisorId: r.supervisor_id,
          supervisorPinVersion: r.supervisor_pin_version,
          occurredAt: r.occurred_at,
          receivedAt: r.received_at,
          recordedAt: r.recorded_at,
          actorId: r.actor_id,
        };
  }

  async insertSignOut(tx: Transaction, r: TillSignOutRecord): Promise<void> {
    await tx.query(
      `INSERT INTO pos.till_sign_out (id, register_id, device_id, branch_id, shift_id, cashier_id, supervisor_id, supervisor_pin_version, occurred_at, received_at, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [r.id, r.registerId, r.deviceId, r.branchId, r.shiftId, r.cashierId, r.supervisorId, r.supervisorPinVersion, r.occurredAt, r.receivedAt, r.recordedAt, r.actorId],
    );
  }
}
