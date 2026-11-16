import type { Transaction } from '../../../platform/database/unit-of-work';
import type { BankAccountRow, BankAccountStore, NewBankAccount } from '../application/bank-account-store';

/** Never selects `account_no_enc` or `account_no_data_key`: no read here can return the number (ADR-0057). */
const COLUMNS = `b.id, b.kind, b.name, b.institution, b.account_no_last4 AS "accountNoLast4", b.gl_account_id AS "glAccountId",
  a.code AS "glAccountCode", a.name AS "glAccountName", b.branch_id AS "branchId", b.is_active AS "isActive", b.version`;

/** FIN's bank accounts. Every write names its actor; the version moves by one (platform.touch_version). */
export class PgBankAccountStore implements BankAccountStore {
  async list(tx: Transaction, after: { readonly name: string; readonly id: string } | null, limit: number): Promise<BankAccountRow[]> {
    const { rows } = await tx.query<BankAccountRow>(
      `SELECT ${COLUMNS} FROM fin.bank_account b JOIN fin.account a ON a.id = b.gl_account_id
        WHERE b.deleted_at IS NULL AND ($1::text IS NULL OR (lower(btrim(b.name)), b.id) > ($1, $2::uuid))
        ORDER BY lower(btrim(b.name)), b.id LIMIT $3`,
      [after?.name ?? null, after?.id ?? null, limit],
    );
    return rows;
  }

  async find(tx: Transaction, id: string, forUpdate: boolean): Promise<BankAccountRow | null> {
    const { rows } = await tx.query<BankAccountRow>(
      `SELECT ${COLUMNS} FROM fin.bank_account b JOIN fin.account a ON a.id = b.gl_account_id WHERE b.id = $1 AND b.deleted_at IS NULL${forUpdate ? ' FOR UPDATE OF b' : ''}`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findMany(tx: Transaction, ids: readonly string[]): Promise<BankAccountRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<BankAccountRow>(`SELECT ${COLUMNS} FROM fin.bank_account b JOIN fin.account a ON a.id = b.gl_account_id WHERE b.id = ANY($1::uuid[]) AND b.deleted_at IS NULL`, [ids]);
    return rows;
  }

  async nameTaken(tx: Transaction, name: string, exceptId: string | null): Promise<boolean> {
    const { rows } = await tx.query('SELECT 1 FROM fin.bank_account WHERE lower(btrim(name)) = lower(btrim($1)) AND deleted_at IS NULL AND id IS DISTINCT FROM $2', [name, exceptId]);
    return rows.length > 0;
  }

  async bankLegOf(tx: Transaction, journalEntryId: string, bankAccountId: string): Promise<{ readonly debitPesewas: bigint; readonly creditPesewas: bigint }> {
    const { rows } = await tx.query<{ d: string; c: string }>(
      `SELECT COALESCE(sum(l.amount_pesewas) FILTER (WHERE l.side = 'D'), 0)::text AS d, COALESCE(sum(l.amount_pesewas) FILTER (WHERE l.side = 'C'), 0)::text AS c
         FROM fin.journal_line l
         JOIN fin.bank_account b ON b.id = $2 AND b.gl_account_id = l.account_id
         JOIN fin.subledger_party p ON p.id = l.subledger_party_id AND p.kind = 'BANK_ACCOUNT' AND p.ref_id = b.id
        WHERE l.journal_entry_id = $1`,
      [journalEntryId, bankAccountId],
    );
    return { debitPesewas: BigInt(rows[0]!.d), creditPesewas: BigInt(rows[0]!.c) };
  }

  async entryOf(tx: Transaction, eventCode: string, sourceDocumentId: string): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM fin.journal_entry WHERE source_document_id = $1 AND event_code = $2 ORDER BY posting_date, id LIMIT 1', [sourceDocumentId, eventCode]);
    return rows[0]?.id ?? null;
  }

  async glAccountIdOf(tx: Transaction, code: string): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM fin.account WHERE code = $1 AND deleted_at IS NULL', [code]);
    return rows[0]?.id ?? null;
  }

  async insert(tx: Transaction, row: NewBankAccount, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO fin.bank_account (id, kind, name, institution, account_no_enc, account_no_data_key, account_no_kek_version, account_no_last4, gl_account_id, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
      [row.id, row.kind, row.name, row.institution, row.accountNoEnc, row.accountNoDataKey, row.accountNoKekVersion, row.accountNoLast4, row.glAccountId, row.branchId, actorId],
    );
  }

  async update(tx: Transaction, id: string, change: { readonly name: string; readonly isActive: boolean }, actorId: string): Promise<void> {
    await tx.query('UPDATE fin.bank_account SET version = version + 1, name = $2, is_active = $3, updated_by = $4 WHERE id = $1', [id, change.name, change.isActive, actorId]);
  }
}
