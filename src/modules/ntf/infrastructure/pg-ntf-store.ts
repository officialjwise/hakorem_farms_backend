import type { Transaction } from '../../../platform/database/unit-of-work';
import { keysetClause, sortKeySelect, type SortOrder } from '../../../platform/http/keyset-sort';
import type {
  AttemptRecord,
  ClaimedMessage,
  MessageFilters,
  MessageRecord,
  NewMessage,
  NtfStore,
  ProviderReportRecord,
  SendResult,
  TemplateFilters,
  TemplateRecord,
} from '../application/ntf-store';
import type { AttemptOutcome } from '../domain/messages';

type Row = Record<string, unknown>;

const TEMPLATE_COLUMNS = `t.id, t.code, t.channel, t.locale, t.category, t.subject, t.body, t.provider_template_ref, t.version_no, t.status, t.version, t.created_at, t.created_by`;

function template(row: Row, order: SortOrder | null): TemplateRecord {
  return {
    id: row['id'] as string,
    code: row['code'] as string,
    channel: row['channel'] as TemplateRecord['channel'],
    locale: row['locale'] as string,
    category: row['category'] as TemplateRecord['category'],
    subject: row['subject'] as string | null,
    body: row['body'] as string,
    providerTemplateRef: row['provider_template_ref'] as string | null,
    versionNo: row['version_no'] as number,
    status: row['status'] as TemplateRecord['status'],
    version: row['version'] as number,
    createdAt: row['created_at'] as Date,
    createdBy: row['created_by'] as string,
    position: order === null ? [] : order.keys.map((_key, index) => String(row[`sort_key_${index}`])),
  };
}

const MESSAGE_COLUMNS = `m.id, m.source_event_ref, m.source_event_type, m.branch_id, m.sales_order_id, m.template_id, t.code AS template_code, m.channel, m.category,
  m.recipient_kind, m.customer_id, m.principal_id, m.address_masked, m.rendered_body, m.status, m.suppressed_reason, m.failure_reason, m.attempts,
  m.send_after, m.provider_message_ref, m.sent_at, m.delivered_at, m.created_at`;

function message(row: Row, order: SortOrder | null): MessageRecord {
  return {
    id: row['id'] as string,
    sourceEventRef: row['source_event_ref'] as string,
    sourceEventType: row['source_event_type'] as string,
    branchId: row['branch_id'] as string | null,
    salesOrderId: row['sales_order_id'] as string | null,
    templateId: row['template_id'] as string,
    templateCode: row['template_code'] as string,
    channel: row['channel'] as MessageRecord['channel'],
    category: row['category'] as MessageRecord['category'],
    recipientKind: row['recipient_kind'] as MessageRecord['recipientKind'],
    customerId: row['customer_id'] as string | null,
    principalId: row['principal_id'] as string | null,
    addressMasked: row['address_masked'] as string,
    renderedBody: row['rendered_body'] as string | null,
    status: row['status'] as MessageRecord['status'],
    suppressedReason: row['suppressed_reason'] as MessageRecord['suppressedReason'],
    failureReason: row['failure_reason'] as string | null,
    attempts: row['attempts'] as number,
    sendAfter: row['send_after'] as Date | null,
    providerMessageRef: row['provider_message_ref'] as string | null,
    sentAt: row['sent_at'] as Date | null,
    deliveredAt: row['delivered_at'] as Date | null,
    createdAt: row['created_at'] as Date,
    position: order === null ? [] : order.keys.map((_key, index) => String(row[`sort_key_${index}`])),
  };
}

/** NTF's own tables (migration 0335). Every instant is the application clock's, bound as a parameter (ADR-0067). */
export class PgNtfStore implements NtfStore {
  async insertTemplate(tx: Transaction, t: Omit<TemplateRecord, 'version' | 'position'> & { readonly at: Date }): Promise<void> {
    await tx.query(
      `INSERT INTO ntf.template (id, code, channel, locale, category, subject, body, provider_template_ref, version_no, status, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $11, $12)`,
      [t.id, t.code, t.channel, t.locale, t.category, t.subject, t.body, t.providerTemplateRef, t.versionNo, t.status, t.at, t.createdBy],
    );
  }

  async template(tx: Transaction, id: string, lock: boolean): Promise<TemplateRecord | null> {
    const { rows } = await tx.query<Row>(`SELECT ${TEMPLATE_COLUMNS} FROM ntf.template t WHERE t.id = $1 AND t.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] === undefined ? null : template(rows[0], null);
  }

  async templates(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, TemplateRecord>> {
    if (ids.length === 0) return new Map();
    const { rows } = await tx.query<Row>(`SELECT ${TEMPLATE_COLUMNS} FROM ntf.template t WHERE t.id = ANY($1::uuid[])`, [[...new Set(ids)]]);
    return new Map(rows.map((row) => [row['id'] as string, template(row, null)] as const));
  }

  async lastVersionNo(tx: Transaction, code: string, channel: string, locale: string): Promise<number> {
    const { rows } = await tx.query<{ version_no: number }>(
      'SELECT version_no FROM ntf.template WHERE code = $1 AND channel = $2 AND locale = $3 ORDER BY version_no DESC LIMIT 1 FOR UPDATE',
      [code, channel, locale],
    );
    return rows[0]?.version_no ?? 0;
  }

  async activeTemplate(tx: Transaction, code: string, channel: string, locale: string, lock: boolean): Promise<TemplateRecord | null> {
    const { rows } = await tx.query<Row>(
      `SELECT ${TEMPLATE_COLUMNS} FROM ntf.template t WHERE t.code = $1 AND t.channel = $2 AND t.locale = $3 AND t.status = 'ACTIVE' AND t.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
      [code, channel, locale],
    );
    return rows[0] === undefined ? null : template(rows[0], null);
  }

  async setTemplateStatus(tx: Transaction, id: string, status: 'ACTIVE' | 'RETIRED', at: Date, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE ntf.template SET status = $2, version = version + 1, updated_at = $3, updated_by = $4,
              activated_at = CASE WHEN $2 = 'ACTIVE' THEN $3 ELSE activated_at END,
              activated_by = CASE WHEN $2 = 'ACTIVE' THEN $4::uuid ELSE activated_by END
        WHERE id = $1`,
      [id, status, at, actorId],
    );
  }

  async templatePage(tx: Transaction, filters: TemplateFilters, order: SortOrder, position: readonly string[] | null, limit: number): Promise<TemplateRecord[]> {
    const clause = keysetClause(order, position, 5);
    const { rows } = await tx.query<Row>(
      `SELECT ${TEMPLATE_COLUMNS}, ${sortKeySelect(order)}
         FROM ntf.template t
        WHERE t.deleted_at IS NULL
          AND ($1::text IS NULL OR t.code = $1) AND ($2::text IS NULL OR t.channel = $2) AND ($3::text IS NULL OR t.status = $3)
          AND ${clause.after}
        ORDER BY ${clause.orderBy}
        LIMIT $4`,
      [filters.code, filters.channel, filters.status, limit, ...clause.values],
    );
    return rows.map((row) => template(row, order));
  }

  async insertMessage(tx: Transaction, m: NewMessage): Promise<boolean> {
    const result = await tx.query(
      `INSERT INTO ntf.message (id, idempotency_key, source_event_ref, source_event_type, branch_id, sales_order_id, template_id, channel, category, recipient_kind,
                                customer_id, address_masked, address_hash, rendered_body, status, suppressed_reason, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $17, $18)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [m.id, m.idempotencyKey, m.sourceEventRef, m.sourceEventType, m.branchId, m.salesOrderId, m.templateId, m.channel, m.category, m.recipientKind, m.customerId, m.addressMasked, m.addressHash, m.renderedBody, m.status, m.suppressedReason, m.at, m.actorId],
    );
    return result.rowCount === 1;
  }

  async queuedToAddressSince(tx: Transaction, addressHash: Buffer, since: Date): Promise<number> {
    const { rows } = await tx.query<{ n: string }>("SELECT count(*) AS n FROM ntf.message WHERE address_hash = $1 AND created_at > $2 AND status <> 'SUPPRESSED'", [addressHash, since]);
    return Number(rows[0]!.n);
  }

  async claimDue(tx: Transaction, c: { readonly now: Date; readonly until: Date; readonly token: string; readonly limit: number; readonly actorId: string }): Promise<ClaimedMessage[]> {
    const { rows } = await tx.query<{ id: string; sales_order_id: string | null; channel: ClaimedMessage['channel']; rendered_body: string; attempts: number }>(
      `UPDATE ntf.message m SET version = m.version + 1, claimed_until = $2, claim_token = $3, updated_at = $1, updated_by = $5
        WHERE m.id IN (SELECT q.id FROM ntf.message q
                        WHERE q.status = 'QUEUED' AND (q.send_after IS NULL OR q.send_after <= $1) AND (q.claimed_until IS NULL OR q.claimed_until < $1)
                        ORDER BY q.created_at, q.id
                        LIMIT $4
                        FOR UPDATE SKIP LOCKED)
       RETURNING m.id, m.sales_order_id, m.channel, m.rendered_body, m.attempts`,
      [c.now, c.until, c.token, c.limit, c.actorId],
    );
    return rows
      .map((r) => ({ id: r.id, salesOrderId: r.sales_order_id, channel: r.channel, renderedBody: r.rendered_body, attemptNo: r.attempts + 1, claimToken: c.token }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async finishAttempt(
    tx: Transaction,
    f: { readonly id: string; readonly token: string; readonly attemptNo: number; readonly outcome: AttemptOutcome | null; readonly providerResponse: string | null; readonly result: SendResult; readonly at: Date; readonly actorId: string },
  ): Promise<boolean> {
    const r = f.result;
    const updated = await tx.query(
      `UPDATE ntf.message
          SET version = version + 1, status = $3, attempts = CASE WHEN $4 THEN $5 ELSE attempts END, claimed_until = NULL, claim_token = NULL,
              send_after = $6, provider_message_ref = COALESCE($7, provider_message_ref), sent_at = CASE WHEN $3 = 'SENT' THEN $8 ELSE sent_at END,
              failed_at = CASE WHEN $3 = 'FAILED' THEN $8 ELSE failed_at END, failure_reason = $9, suppressed_reason = $10,
              address_masked = COALESCE($11, address_masked), address_hash = COALESCE($12, address_hash), updated_at = $8, updated_by = $13
        WHERE id = $1 AND claim_token = $2`,
      [
        f.id,
        f.token,
        r.kind,
        f.outcome !== null,
        f.attemptNo,
        r.kind === 'QUEUED' ? r.sendAfter : null,
        r.kind === 'SENT' ? r.providerRef : null,
        f.at,
        r.kind === 'FAILED' || r.kind === 'QUEUED' ? r.reason.slice(0, 500) : null,
        r.kind === 'SUPPRESSED' ? r.reason : null,
        r.kind === 'SENT' ? r.addressMasked : null,
        r.kind === 'SENT' ? r.addressHash : null,
        f.actorId,
      ],
    );
    if (updated.rowCount !== 1) return false;
    if (f.outcome !== null) {
      await tx.query('INSERT INTO ntf.message_attempt (message_id, attempt_no, outcome, provider_response, attempted_at, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, $5, $6)', [
        f.id,
        f.attemptNo,
        f.outcome,
        f.providerResponse?.slice(0, 500) ?? null,
        f.at,
        f.actorId,
      ]);
    }
    return true;
  }

  async message(tx: Transaction, id: string, lock: boolean): Promise<MessageRecord | null> {
    const { rows } = await tx.query<Row>(`SELECT ${MESSAGE_COLUMNS} FROM ntf.message m JOIN ntf.template t ON t.id = m.template_id WHERE m.id = $1${lock ? ' FOR UPDATE OF m' : ''}`, [id]);
    return rows[0] === undefined ? null : message(rows[0], null);
  }

  async messagePage(tx: Transaction, filters: MessageFilters, order: SortOrder, position: readonly string[] | null, limit: number): Promise<MessageRecord[]> {
    const clause = keysetClause(order, position, 9);
    const { rows } = await tx.query<Row>(
      `SELECT ${MESSAGE_COLUMNS}, ${sortKeySelect(order)}
         FROM ntf.message m JOIN ntf.template t ON t.id = m.template_id
        WHERE m.branch_id = ANY($1::uuid[])
          AND ($2::text IS NULL OR m.status = $2) AND ($3::text IS NULL OR m.channel = $3) AND ($4::uuid IS NULL OR m.customer_id = $4)
          AND ($5::text IS NULL OR t.code = $5) AND ($6::timestamptz IS NULL OR m.created_at >= $6) AND ($7::timestamptz IS NULL OR m.created_at < $7)
          AND ${clause.after}
        ORDER BY ${clause.orderBy}
        LIMIT $8`,
      [filters.branchIds, filters.status, filters.channel, filters.customerId, filters.templateCode, filters.from, filters.to, limit, ...clause.values],
    );
    return rows.map((row) => message(row, order));
  }

  async attemptsOf(tx: Transaction, messageIds: readonly string[]): Promise<AttemptRecord[]> {
    if (messageIds.length === 0) return [];
    const { rows } = await tx.query<{ message_id: string; attempt_no: number; outcome: AttemptOutcome; provider_response: string | null; attempted_at: Date }>(
      'SELECT message_id, attempt_no, outcome, provider_response, attempted_at FROM ntf.message_attempt WHERE message_id = ANY($1::uuid[]) ORDER BY message_id, attempt_no',
      [messageIds],
    );
    return rows.map((r) => ({ messageId: r.message_id, attemptNo: r.attempt_no, outcome: r.outcome, providerResponse: r.provider_response, attemptedAt: r.attempted_at }));
  }

  async requeue(tx: Transaction, id: string, at: Date, actorId: string): Promise<void> {
    await tx.query("UPDATE ntf.message SET version = version + 1, status = 'QUEUED', send_after = NULL, failure_reason = NULL, updated_at = $2, updated_by = $3 WHERE id = $1", [id, at, actorId]);
  }

  async applyReport(tx: Transaction, id: string, status: 'DELIVERED' | 'FAILED', at: Date, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE ntf.message SET version = version + 1, status = $2, delivered_at = CASE WHEN $2 = 'DELIVERED' THEN $3 ELSE delivered_at END,
              failed_at = CASE WHEN $2 = 'FAILED' THEN $3 ELSE failed_at END,
              failure_reason = CASE WHEN $2 = 'FAILED' THEN 'reported undelivered by the provider' ELSE failure_reason END, updated_at = $3, updated_by = $4
        WHERE id = $1`,
      [id, status, at, actorId],
    );
  }

  async insertReport(tx: Transaction, r: ProviderReportRecord): Promise<boolean> {
    const result = await tx.query(
      `INSERT INTO ntf.provider_report (id, provider, report_key, outcome, message_id, reported_status, payload_hash, source_ip, received_at, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)
       ON CONFLICT (provider, report_key) WHERE outcome IN ('APPLIED', 'NO_CHANGE', 'UNKNOWN_MESSAGE') DO NOTHING`,
      [r.id, r.provider, r.reportKey, r.outcome, r.messageId, r.reportedStatus, r.payloadHash, r.sourceIp, r.receivedAt, r.actorId],
    );
    return result.rowCount === 1;
  }
}
