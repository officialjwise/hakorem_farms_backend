import type { Transaction } from '../../../platform/database/unit-of-work';
import type { EntryRow, EventTypeRow, LedgerStore, LineRow, UnbalancedEntry } from '../application/ledger-store';
import type { PeriodFacts } from '../domain/period';
import type { Determination, LedgerAccount, PostingRule, Side, SubledgerRef } from '../domain/posting';
import type { AccountActivity } from '../domain/trial-balance';

const IN_FORCE = 'valid_from <= $DATE::date AND (valid_to IS NULL OR valid_to > $DATE::date) AND deleted_at IS NULL';
const inForce = (placeholder: string): string => IN_FORCE.replaceAll('$DATE', placeholder);

/** The ledger in PostgreSQL (migration 0123). Posting reads by key or by small lookup tables; the triggers decide. */
export class PgLedgerStore implements LedgerStore {
  async periodsOn(tx: Transaction, dates: readonly string[]): Promise<PeriodFacts[]> {
    const { rows } = await tx.query<{ id: string; start_date: string; end_date: string; status: PeriodFacts['status'] }>(
      `SELECT p.id, p.start_date::text AS start_date, p.end_date::text AS end_date, p.status
         FROM fin.accounting_period p, unnest($1::date[]) AS d (day)
        WHERE p.start_date <= d.day AND p.end_date >= d.day`,
      [dates],
    );
    return rows.map((r) => ({ id: r.id, startDate: r.start_date, endDate: r.end_date, status: r.status }));
  }

  async eventType(tx: Transaction, code: string): Promise<EventTypeRow | null> {
    const { rows } = await tx.query<{ code: string; description: string; amount_keys: string[] }>(
      'SELECT code, description, amount_keys FROM fin.posting_event_type WHERE code = $1',
      [code],
    );
    const row = rows[0];
    return row === undefined ? null : { code: row.code, description: row.description, amountKeys: row.amount_keys };
  }

  async rulesFor(tx: Transaction, eventCode: string, date: string): Promise<PostingRule[]> {
    const { rows } = await tx.query<{ amount_key: string; side: Side; account_id: string | null; determinant_type: PostingRule['determinantType']; determinant_role: string | null }>(
      `SELECT amount_key, side, account_id, determinant_type, determinant_role FROM fin.posting_rule
        WHERE event_code = $1 AND ${inForce('$2')} ORDER BY amount_key, side DESC`,
      [eventCode, date],
    );
    return rows.map((r) => ({ amountKey: r.amount_key, side: r.side, accountId: r.account_id, determinantType: r.determinant_type, determinantRole: r.determinant_role }));
  }

  async determinations(tx: Transaction, date: string): Promise<Determination[]> {
    const { rows } = await tx.query<{ determinant_type: Determination['type']; determinant_key: string; role: string; account_id: string }>(
      `SELECT determinant_type, determinant_key, role, account_id FROM fin.account_determination WHERE ${inForce('$1')}`,
      [date],
    );
    return rows.map((r) => ({ type: r.determinant_type, key: r.determinant_key, role: r.role, accountId: r.account_id }));
  }

  async accounts(tx: Transaction): Promise<Map<string, LedgerAccount>> {
    const { rows } = await tx.query<{ id: string; code: string; subledger_kind: LedgerAccount['subledgerKind']; postable: boolean }>(
      `SELECT id, code, subledger_kind, (is_postable AND status = 'ACTIVE' AND deleted_at IS NULL) AS postable FROM fin.account`,
    );
    return new Map(rows.map((r) => [r.id, { id: r.id, code: r.code, subledgerKind: r.subledger_kind, postable: r.postable }] as const));
  }

  async subledgerPartyIn(tx: Transaction, party: SubledgerRef, newId: string): Promise<string> {
    await tx.query(
      `INSERT INTO fin.subledger_party (id, kind, ref_id, display_name) VALUES ($1, $2, $3, $4)
       ON CONFLICT ON CONSTRAINT uq_subledger_party_ref DO NOTHING`,
      [newId, party.kind, party.refId, party.displayName],
    );
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM fin.subledger_party WHERE kind = $1 AND ref_id = $2', [party.kind, party.refId]);
    return rows[0]!.id;
  }

  async insertEntry(tx: Transaction, entry: EntryRow, lines: readonly LineRow[]): Promise<void> {
    await tx.query(
      `INSERT INTO fin.journal_entry (id, entry_no, posting_date, period_id, branch_id, kind, event_code, event_id, event_subject_id, source_document_id,
                                      posting_group_id, description, reverses_entry_id, occurred_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        entry.id, entry.entryNo, entry.postingDate, entry.periodId, entry.branchId, entry.kind, entry.eventCode, entry.eventId, entry.eventSubjectId,
        entry.sourceDocumentId, entry.postingGroupId, entry.description, entry.reversesEntryId, entry.occurredAt, entry.actorId,
      ],
    );
    await tx.query(
      `INSERT INTO fin.journal_line (journal_entry_id, line_no, account_id, side, amount_pesewas, branch_id, subledger_party_id, memo, cost_object_id, posting_date)
       SELECT $1, l.line_no, l.account_id, l.side, l.amount_pesewas, $2, l.subledger_party_id, l.memo, l.cost_object_id, $3
         FROM unnest($4::int[], $5::uuid[], $6::char(1)[], $7::bigint[], $8::uuid[], $9::text[], $10::uuid[])
              AS l (line_no, account_id, side, amount_pesewas, subledger_party_id, memo, cost_object_id)`,
      [
        entry.id,
        entry.branchId,
        entry.postingDate,
        lines.map((l) => l.lineNo),
        lines.map((l) => l.accountId),
        lines.map((l) => l.side),
        lines.map((l) => l.amountPesewas.toString()),
        lines.map((l) => l.subledgerPartyId),
        lines.map((l) => l.memo),
        lines.map((l) => l.costObjectId),
      ],
    );
  }

  async originalEntryOf(tx: Transaction, eventSubjectId: string): Promise<{ readonly id: string; readonly lines: LineRow[] } | null> {
    const entry = await tx.query<{ id: string }>(
      `SELECT id FROM fin.journal_entry WHERE event_subject_id = $1 AND kind = 'AUTO' ORDER BY recorded_at, id LIMIT 1`,
      [eventSubjectId],
    );
    const id = entry.rows[0]?.id;
    if (id === undefined) {
      return null;
    }
    const { rows } = await tx.query<{ line_no: number; account_id: string; side: Side; amount_pesewas: string; subledger_party_id: string | null; memo: string | null; cost_object_id: string | null }>(
      'SELECT line_no, account_id, side, amount_pesewas, subledger_party_id, memo, cost_object_id FROM fin.journal_line WHERE journal_entry_id = $1 ORDER BY line_no',
      [id],
    );
    return {
      id,
      lines: rows.map((r) => ({
        lineNo: r.line_no,
        accountId: r.account_id,
        side: r.side,
        amountPesewas: BigInt(r.amount_pesewas),
        subledgerPartyId: r.subledger_party_id,
        memo: r.memo,
        costObjectId: r.cost_object_id,
      })),
    };
  }

  async catalogue(tx: Transaction, date: string) {
    const types = await tx.query<{ code: string; description: string; amount_keys: string[] }>('SELECT code, description, amount_keys FROM fin.posting_event_type ORDER BY code');
    const rules = await tx.query<{ event_code: string; amount_key: string; side: Side }>(`SELECT event_code, amount_key, side FROM fin.posting_rule WHERE ${inForce('$1')}`, [date]);
    return {
      eventTypes: types.rows.map((r) => ({ code: r.code, description: r.description, amountKeys: r.amount_keys })),
      rules: rules.rows.map((r) => ({ eventCode: r.event_code, amountKey: r.amount_key, side: r.side })),
    };
  }

  async accountActivity(tx: Transaction, from: string, to: string): Promise<AccountActivity[]> {
    const { rows } = await tx.query<{ id: string; code: string; name: string; od: string; oc: string; d: string; c: string }>(
      `SELECT a.id, a.code, a.name,
              COALESCE(sum(l.amount_pesewas) FILTER (WHERE l.side = 'D' AND l.posting_date < $1::date), 0) AS od,
              COALESCE(sum(l.amount_pesewas) FILTER (WHERE l.side = 'C' AND l.posting_date < $1::date), 0) AS oc,
              COALESCE(sum(l.amount_pesewas) FILTER (WHERE l.side = 'D' AND l.posting_date >= $1::date), 0) AS d,
              COALESCE(sum(l.amount_pesewas) FILTER (WHERE l.side = 'C' AND l.posting_date >= $1::date), 0) AS c
         FROM fin.account a LEFT JOIN fin.journal_line l ON l.account_id = a.id AND l.posting_date <= $2::date
        GROUP BY a.id, a.code, a.name
        ORDER BY a.code`,
      [from, to],
    );
    return rows.map((r) => ({ accountId: r.id, code: r.code, name: r.name, openingDebit: BigInt(r.od), openingCredit: BigInt(r.oc), debit: BigInt(r.d), credit: BigInt(r.c) }));
  }

  async unbalancedEntries(tx: Transaction): Promise<UnbalancedEntry[]> {
    const { rows } = await tx.query<{ id: string; entry_no: string; n: number; d: string; c: string }>(
      `SELECT e.id, e.entry_no, count(l.line_no)::int AS n,
              COALESCE(sum(l.amount_pesewas) FILTER (WHERE l.side = 'D'), 0) AS d, COALESCE(sum(l.amount_pesewas) FILTER (WHERE l.side = 'C'), 0) AS c
         FROM fin.journal_entry e LEFT JOIN fin.journal_line l ON l.journal_entry_id = e.id
        GROUP BY e.id, e.entry_no
       HAVING count(l.line_no) < 2
           OR COALESCE(sum(l.amount_pesewas) FILTER (WHERE l.side = 'D'), 0) <> COALESCE(sum(l.amount_pesewas) FILTER (WHERE l.side = 'C'), 0)
        ORDER BY e.entry_no`,
    );
    return rows.map((r) => ({ entryId: r.id, entryNo: r.entry_no, lineCount: r.n, debitPesewas: BigInt(r.d), creditPesewas: BigInt(r.c) }));
  }

  async accountBalances(tx: Transaction, accountIds: readonly string[]): Promise<Map<string, bigint>> {
    const { rows } = await tx.query<{ account_id: string; balance: string }>(
      `SELECT l.account_id, sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END) AS balance
         FROM fin.journal_line l WHERE l.account_id = ANY($1::uuid[]) GROUP BY l.account_id`,
      [accountIds],
    );
    return new Map(rows.map((r) => [r.account_id, BigInt(r.balance)] as const));
  }

  async accountCodes(tx: Transaction): Promise<Map<string, string>> {
    const { rows } = await tx.query<{ id: string; code: string }>('SELECT id, code FROM fin.account');
    return new Map(rows.map((r) => [r.id, r.code] as const));
  }
}
