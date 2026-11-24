import { databaseErrorOf, type Transaction } from '../../../platform/database/unit-of-work';
import type { AccountFacts, DunningNoticeFilter, DunningNoticeRecord, DunningStore, NoticeDeliveryRecord } from '../application/dunning-store';
import type { DunningChannel, DunningLevelRule } from '../domain/dunning';

const ACCOUNT = `customer_id, branch_id, credit_limit_pesewas::text AS credit_limit, status, account_manager_id`;
const accountOf = (r: { customer_id: string; branch_id: string; credit_limit: string; status: AccountFacts['status']; account_manager_id: string | null }): AccountFacts => ({
  customerId: r.customer_id,
  branchId: r.branch_id,
  creditLimitPesewas: BigInt(r.credit_limit),
  status: r.status,
  accountManagerId: r.account_manager_id,
});

const NOTICE = `id, customer_id, billing_document_id, branch_id, level, days_past_due, outstanding_pesewas::text AS outstanding, channels, template_code, notice_date::text, queued_at`;
type RawNotice = { id: string; customer_id: string; billing_document_id: string; branch_id: string; level: number; days_past_due: number; outstanding: string; channels: DunningChannel[]; template_code: string; notice_date: string; queued_at: Date };
const noticeOf = (r: RawNotice): DunningNoticeRecord => ({
  id: r.id,
  customerId: r.customer_id,
  billingDocumentId: r.billing_document_id,
  branchId: r.branch_id,
  level: r.level,
  daysPastDue: r.days_past_due,
  outstandingPesewas: BigInt(r.outstanding),
  channels: r.channels,
  templateCode: r.template_code,
  noticeDate: r.notice_date,
  queuedAt: r.queued_at,
});

/** WHL's ageing and dunning tables (migration 0265). Parameterised SQL only. */
export class PgDunningStore implements DunningStore {
  async accountsOf(tx: Transaction, customerIds: readonly string[]): Promise<ReadonlyMap<string, AccountFacts>> {
    if (customerIds.length === 0) return new Map();
    const { rows } = await tx.query<Parameters<typeof accountOf>[0]>(`SELECT ${ACCOUNT} FROM whl.business_account WHERE customer_id = ANY($1::uuid[]) AND deleted_at IS NULL`, [customerIds]);
    return new Map(rows.map((r) => [r.customer_id, accountOf(r)]));
  }

  async customersManagedBy(tx: Transaction, accountManagerId: string): Promise<string[]> {
    const { rows } = await tx.query<{ customer_id: string }>('SELECT customer_id FROM whl.business_account WHERE account_manager_id = $1 AND deleted_at IS NULL', [accountManagerId]);
    return rows.map((r) => r.customer_id);
  }

  async openAccounts(tx: Transaction, afterId: string | null, limit: number): Promise<AccountFacts[]> {
    const { rows } = await tx.query<Parameters<typeof accountOf>[0]>(
      `SELECT ${ACCOUNT} FROM whl.business_account WHERE status <> 'CLOSED' AND deleted_at IS NULL AND ($1::uuid IS NULL OR customer_id > $1) ORDER BY customer_id LIMIT $2`,
      [afterId, limit],
    );
    return rows.map(accountOf);
  }

  async levels(tx: Transaction): Promise<DunningLevelRule[]> {
    const { rows } = await tx.query<{ level: number; days_overdue: number; channels: DunningChannel[]; template_code: string }>(
      'SELECT level, days_overdue, channels, template_code FROM whl.dunning_policy WHERE deleted_at IS NULL ORDER BY level',
    );
    return rows.map((r) => ({ level: r.level, daysOverdue: r.days_overdue, channels: r.channels, templateCode: r.template_code }));
  }

  async replaceLevels(tx: Transaction, levels: readonly (DunningLevelRule & { readonly id: string })[], actorId: string, at: Date): Promise<void> {
    await tx.query("UPDATE whl.dunning_policy SET deleted_at = $1, deleted_by = $2, delete_reason = 'Replaced', updated_at = $1, updated_by = $2, version = version + 1 WHERE deleted_at IS NULL", [at, actorId]);
    if (levels.length === 0) return;
    await tx.query(
      `INSERT INTO whl.dunning_policy (id, level, days_overdue, channels, template_code, created_at, created_by, updated_at, updated_by)
       SELECT l.id, l.level, l.days, string_to_array(l.channels, ','), l.template, $1, $2, $1, $2
         FROM unnest($3::uuid[], $4::integer[], $5::integer[], $6::text[], $7::text[]) AS l (id, level, days, channels, template)`,
      [at, actorId, levels.map((l) => l.id), levels.map((l) => l.level), levels.map((l) => l.daysOverdue), levels.map((l) => l.channels.join(',')), levels.map((l) => l.templateCode)],
    );
  }

  async sentLevels(tx: Transaction, billingDocumentIds: readonly string[]): Promise<ReadonlyMap<string, number[]>> {
    if (billingDocumentIds.length === 0) return new Map();
    const { rows } = await tx.query<{ billing_document_id: string; levels: number[] }>(
      'SELECT billing_document_id, array_agg(level ORDER BY level) AS levels FROM whl.dunning_notice WHERE billing_document_id = ANY($1::uuid[]) GROUP BY billing_document_id',
      [billingDocumentIds],
    );
    return new Map(rows.map((r) => [r.billing_document_id, r.levels]));
  }

  async insertNotice(tx: Transaction, n: DunningNoticeRecord, actorId: string): Promise<boolean> {
    // A level as high or higher already there is refused by whl.dunning_notice_check (HK010) before the unique key is
    // looked at: either way this level does not reach the document again.
    await tx.query('SAVEPOINT dunning_notice');
    try {
      const inserted = await this.insert(tx, n, actorId);
      await tx.query('RELEASE SAVEPOINT dunning_notice');
      return inserted;
    } catch (error) {
      const failure = databaseErrorOf(error);
      if (failure?.code !== 'HK010' || failure.constraint !== 'ck_dunning_notice_order') throw error;
      await tx.query('ROLLBACK TO SAVEPOINT dunning_notice');
      return false;
    }
  }

  private async insert(tx: Transaction, n: DunningNoticeRecord, actorId: string): Promise<boolean> {
    const { rowCount } = await tx.query(
      `INSERT INTO whl.dunning_notice (id, customer_id, billing_document_id, branch_id, level, days_past_due, outstanding_pesewas, channels, template_code, notice_date, queued_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, $12)
       ON CONFLICT ON CONSTRAINT uq_dunning_notice_level DO NOTHING`,
      [n.id, n.customerId, n.billingDocumentId, n.branchId, n.level, n.daysPastDue, n.outstandingPesewas.toString(), n.channels, n.templateCode, n.noticeDate, n.queuedAt, actorId],
    );
    return rowCount === 1;
  }

  async noticesById(tx: Transaction, ids: readonly string[]): Promise<DunningNoticeRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<RawNotice>(`SELECT ${NOTICE} FROM whl.dunning_notice WHERE id = ANY($1::uuid[])`, [[...new Set(ids)]]);
    return rows.map(noticeOf);
  }

  async notices(tx: Transaction, f: DunningNoticeFilter, beforeId: string | null, limit: number): Promise<DunningNoticeRecord[]> {
    const { rows } = await tx.query<RawNotice>(
      `SELECT ${NOTICE} FROM whl.dunning_notice
        WHERE branch_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR customer_id = $2) AND ($3::timestamptz IS NULL OR queued_at >= $3)
          AND ($4::uuid IS NULL OR id < $4) ORDER BY id DESC LIMIT $5`,
      [f.branchIds, f.customerId, f.from, beforeId, limit],
    );
    return rows.map(noticeOf);
  }

  async insertDelivery(tx: Transaction, d: NoticeDeliveryRecord, at: Date, actorId: string): Promise<boolean> {
    const result = await tx.query(
      `INSERT INTO whl.dunning_notice_delivery (id, dunning_notice_id, channel, status, message_ref, occurred_at, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (message_ref, status) DO NOTHING`,
      [d.id, d.noticeId, d.channel, d.status, d.messageRef, d.occurredAt, at, actorId],
    );
    return result.rowCount === 1;
  }

  async deliveriesOf(tx: Transaction, noticeIds: readonly string[]): Promise<NoticeDeliveryRecord[]> {
    if (noticeIds.length === 0) return [];
    const { rows } = await tx.query<{ id: string; dunning_notice_id: string; channel: NoticeDeliveryRecord['channel']; status: NoticeDeliveryRecord['status']; message_ref: string; occurred_at: Date }>(
      'SELECT id, dunning_notice_id, channel, status, message_ref, occurred_at FROM whl.dunning_notice_delivery WHERE dunning_notice_id = ANY($1::uuid[]) ORDER BY occurred_at, id',
      [[...new Set(noticeIds)]],
    );
    return rows.map((r) => ({ id: r.id, noticeId: r.dunning_notice_id, channel: r.channel, status: r.status, messageRef: r.message_ref, occurredAt: r.occurred_at }));
  }
}
