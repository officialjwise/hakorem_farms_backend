import { randomUUID } from 'node:crypto';
/** A connection to write through: the caller's own transaction, so the shift is in its snapshot. */
interface Executor {
  query<R extends object = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ readonly rows: R[] }>;
}

/**
 * A till shift for tests that post cash sales through ORD's sale path directly (A-212 (a): cash enters a till only in a
 * shift). It writes, as the migration owner, the rows POS's `openShift` writes: a register at the branch's shop floor,
 * the SHIFT business document and the OPEN shift with no float, so nothing posts. One per cashier, as the database
 * holds (uq_shift_open_cashier); the till's own behaviour is tested through POS in `test/integration/pos/`. Written in
 * the sale's own transaction, so a serializable snapshot taken before it still sees the shift its sale names.
 */
export async function openTestShift(admin: Executor, cashierId: string, branchId: string): Promise<string> {
  const open = await admin.query<{ id: string }>("SELECT id FROM pos.shift WHERE cashier_id = $1 AND status = 'OPEN'", [cashierId]);
  if (open.rows[0] !== undefined) return open.rows[0].id;
  const location = await admin.query<{ id: string }>("SELECT id FROM mdm.location WHERE branch_id = $1 AND NOT is_virtual ORDER BY (code = 'SHOP') DESC, code LIMIT 1", [branchId]);
  const registerId = randomUUID();
  const shiftId = randomUUID();
  const code = `X${randomUUID().replace(/[^0-9]/g, '').slice(0, 3)}`;
  const at = new Date();
  await admin.query(
    `INSERT INTO pos.register (id, branch_id, location_id, code, name, status, created_at, created_by, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, 'Test till', 'ACTIVE', $5, $6, $5, $6)`,
    [registerId, branchId, location.rows[0]!.id, code, at, cashierId],
  );
  await admin.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'SHIFT', 'pos', $2, $3)", [shiftId, branchId, cashierId]);
  await admin.query(
    `INSERT INTO pos.shift (id, shift_no, register_id, cashier_id, shift_seq, opened_at, opening_float_pesewas, status, branch_id, created_at, created_by, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, 1, $5, 0, 'OPEN', $6, $5, $4, $5, $4)`,
    [shiftId, `SHF-TEST-${code}`, registerId, cashierId, at, branchId],
  );
  return shiftId;
}
