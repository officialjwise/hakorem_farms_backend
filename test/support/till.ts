import { randomUUID } from 'node:crypto';
/** A connection to write through: the caller's own transaction, so the shift is in its snapshot. */
interface Executor {
  query<R extends object = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ readonly rows: R[] }>;
}

/**
 * A till shift for tests that post cash sales through ORD's sale path directly (A-212 (a): cash enters a till only in a
 * shift). It writes, as the migration owner, the rows POS's `openShift` writes: a register at the branch's shop floor,
 * the SHIFT business document and the OPEN shift with no float, so nothing posts. The till is the one the sale's cash
 * names when given (created with that id if new), since cash goes into a till only through its own shift (ADR-0077). One per cashier, as the database
 * holds (uq_shift_open_cashier); the till's own behaviour is tested through POS in `test/integration/pos/`. Written in
 * the sale's own transaction, so a serializable snapshot taken before it still sees the shift its sale names.
 */
export async function openTestShift(admin: Executor, cashierId: string, branchId: string, register?: { readonly id: string; readonly code: string } | null): Promise<string> {
  const open = await admin.query<{ id: string; register_id: string }>("SELECT id, register_id FROM pos.shift WHERE cashier_id = $1 AND status = 'OPEN'", [cashierId]);
  const current = open.rows[0];
  // Cash goes into a till only through its own open shift (ADR-0077): the shift is on the till the tender names.
  if (current !== undefined && (register === undefined || register === null || current.register_id === register.id)) return current.id;
  if (current !== undefined) throw new Error(`test cashier ${cashierId} already has an open shift on another till; one cashier runs one till at a time`);
  const location = await admin.query<{ id: string }>("SELECT id FROM mdm.location WHERE branch_id = $1 AND NOT is_virtual ORDER BY (code = 'SHOP') DESC, code LIMIT 1", [branchId]);
  const registerId = register?.id ?? randomUUID();
  const shiftId = randomUUID();
  // The first X000 to X999 no live till of the branch holds: a random three digits collided about one run in a
  // thousand with the spec's other test till (uq_register_code, price-override's pull_request run 45106049807).
  const code = await freeTillCode(admin, branchId);
  const at = new Date();
  const exists = await admin.query('SELECT 1 FROM pos.register WHERE id = $1', [registerId]);
  if (exists.rows.length === 0) {
    await admin.query(
      `INSERT INTO pos.register (id, branch_id, location_id, code, name, status, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, 'Test till', 'ACTIVE', $5, $6, $5, $6)`,
      [registerId, branchId, location.rows[0]!.id, code, at, cashierId],
    );
  }
  const busy = await admin.query<{ id: string }>("SELECT id FROM pos.shift WHERE register_id = $1 AND status <> 'CLOSED'", [registerId]);
  if (busy.rows[0] !== undefined) throw new Error(`test till ${registerId} already has another cashier's shift open`);
  const seq = await admin.query<{ n: number }>('SELECT COALESCE(max(shift_seq), 0)::int + 1 AS n FROM pos.shift WHERE register_id = $1', [registerId]);
  await admin.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'SHIFT', 'pos', $2, $3)", [shiftId, branchId, cashierId]);
  await admin.query(
    `INSERT INTO pos.shift (id, shift_no, register_id, cashier_id, shift_seq, opened_at, opening_float_pesewas, status, branch_id, created_at, created_by, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, 0, 'OPEN', $7, $6, $4, $6, $4)`,
    [shiftId, `SHF-TEST-${code}-${shiftId.slice(0, 8)}`, registerId, cashierId, seq.rows[0]!.n, at, branchId],
  );
  return shiftId;
}

/** The till a sale's cash tenders name, for `openTestShift`. */
export function tillOf(request: { readonly tenders: readonly { readonly register: { readonly id: string; readonly code: string } | null }[] }): { readonly id: string; readonly code: string } | null {
  return request.tenders.find((t) => t.register !== null)?.register ?? null;
}

/** The first test till code from X000 to X999 that no live till of the branch holds (`uq_register_code`). */
async function freeTillCode(admin: Executor, branchId: string): Promise<string> {
  const free = await admin.query<{ code: string }>(
    `SELECT 'X' || lpad(n::text, 3, '0') AS code FROM generate_series(0, 999) n
      WHERE NOT EXISTS (SELECT 1 FROM pos.register r WHERE r.branch_id = $1 AND r.deleted_at IS NULL AND r.code = 'X' || lpad(n::text, 3, '0'))
      ORDER BY n LIMIT 1`,
    [branchId],
  );
  if (free.rows[0] === undefined) throw new Error(`branch ${branchId} has no free test till code left`);
  return free.rows[0].code;
}

