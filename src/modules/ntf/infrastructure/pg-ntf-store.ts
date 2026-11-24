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
  InAppRecord,
  OptOutRecord,
  PreferenceOwner,
  PreferenceRecord,
  SendResult,
  TemplateFilters,
  TriggerRecord,
  TemplateRecord,
} from '../application/ntf-store';
import type { AttemptOutcome } from '../domain/messages';
import type { Channel } from '../domain/templates';

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

const TRIGGER_COLUMNS = 'id, event_type, template_code, recipient_kind, recipient_role_code, channels, is_active, version';

function trigger(row: Row): TriggerRecord {
  return {
    id: row['id'] as string,
    eventType: row['event_type'] as string,
    templateCode: row['template_code'] as string,
    recipientKind: row['recipient_kind'] as TriggerRecord['recipientKind'],
    recipientRoleCode: row['recipient_role_code'] as string | null,
    channels: row['channels'] as Channel[],
    isActive: row['is_active'] as boolean,
    version: row['version'] as number,
  };
}

function owner(o: PreferenceOwner): [string | null, string | null] {
  return 'customerId' in o ? [o.customerId, null] : [null, o.principalId];
}

const OPT_OUT_COLUMNS = 'id, address_hash, address_masked, channel, direction, source, provider_report_id, occurred_at, recorded_at, actor_id';

function optOut(row: Row): OptOutRecord {
  return {
    id: row['id'] as string,
    addressHash: row['address_hash'] as Buffer,
    addressMasked: row['address_masked'] as string,
    channel: row['channel'] as OptOutRecord['channel'],
    direction: row['direction'] as OptOutRecord['direction'],
    source: row['source'] as OptOutRecord['source'],
    providerReportId: row['provider_report_id'] as string | null,
    occurredAt: row['occurred_at'] as Date,
    recordedAt: row['recorded_at'] as Date,
    actorId: row['actor_id'] as string,
  };
}

const IN_APP_COLUMNS = 'id, principal_id, title, body, link, read_at, created_at';

function inApp(row: Row): InAppRecord {
  return {
    id: row['id'] as string,
    principalId: row['principal_id'] as string,
    title: row['title'] as string,
    body: row['body'] as string,
    link: row['link'] as string | null,
    readAt: row['read_at'] as Date | null,
    createdAt: row['created_at'] as Date,
  };
}

/** NTF's own tables (migrations 0335 and 0338). Every instant is the application clock's, bound as a parameter (ADR-0067). */
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
                                customer_id, principal_id, address_masked, address_hash, rendered_body, rendered_subject, link_path, status, suppressed_reason, send_after,
                                created_at, created_by, updated_at, updated_by, link_kind, link_record_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $21, $22, $23, $24)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        m.id,
        m.idempotencyKey,
        m.sourceEventRef,
        m.sourceEventType,
        m.branchId,
        m.salesOrderId,
        m.templateId,
        m.channel,
        m.category,
        m.recipientKind,
        m.customerId,
        m.principalId ?? null,
        m.addressMasked,
        m.addressHash,
        m.renderedBody,
        m.renderedSubject ?? null,
        m.linkPath ?? null,
        m.status,
        m.suppressedReason,
        m.sendAfter ?? null,
        m.at,
        m.actorId,
        m.linkKind ?? null,
        m.linkRecordId ?? null,
      ],
    );
    return result.rowCount === 1;
  }

  async queuedToAddressSince(tx: Transaction, addressHash: Buffer, since: Date): Promise<number> {
    const { rows } = await tx.query<{ n: string }>("SELECT count(*) AS n FROM ntf.message WHERE address_hash = $1 AND created_at > $2 AND status <> 'SUPPRESSED'", [addressHash, since]);
    return Number(rows[0]!.n);
  }

  async claimDue(tx: Transaction, c: { readonly now: Date; readonly until: Date; readonly token: string; readonly limit: number; readonly actorId: string }): Promise<ClaimedMessage[]> {
    const { rows } = await tx.query<Row>(
      `UPDATE ntf.message m SET version = m.version + 1, claimed_until = $2, claim_token = $3, updated_at = $1, updated_by = $5
        WHERE m.id IN (SELECT q.id FROM ntf.message q
                        WHERE q.status IN ('QUEUED', 'DEFERRED_QUIET_HOURS') AND (q.send_after IS NULL OR q.send_after <= $1) AND (q.claimed_until IS NULL OR q.claimed_until < $1)
                        ORDER BY q.created_at, q.id
                        LIMIT $4
                        FOR UPDATE SKIP LOCKED)
       RETURNING m.id, m.sales_order_id, m.customer_id, m.principal_id, m.category, m.channel, m.rendered_body, m.rendered_subject, m.link_path, m.link_kind, m.link_record_id, m.attempts`,
      [c.now, c.until, c.token, c.limit, c.actorId],
    );
    return rows
      .map((r) => ({
        id: r['id'] as string,
        salesOrderId: r['sales_order_id'] as string | null,
        customerId: r['customer_id'] as string | null,
        principalId: r['principal_id'] as string | null,
        category: r['category'] as ClaimedMessage['category'],
        channel: r['channel'] as ClaimedMessage['channel'],
        renderedBody: r['rendered_body'] as string,
        renderedSubject: r['rendered_subject'] as string | null,
        linkPath: r['link_path'] as string | null,
        linkKind: r['link_kind'] as ClaimedMessage['linkKind'],
        linkRecordId: r['link_record_id'] as string | null,
        attemptNo: (r['attempts'] as number) + 1,
        claimToken: c.token,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async finishAttempt(
    tx: Transaction,
    f: { readonly id: string; readonly token: string; readonly attemptNo: number; readonly outcome: AttemptOutcome | null; readonly providerResponse: string | null; readonly result: SendResult; readonly at: Date; readonly actorId: string },
  ): Promise<boolean> {
    const r = f.result;
    const updated = await tx.query(
      `UPDATE ntf.message
          SET version = version + 1, status = $3::text, attempts = CASE WHEN $4 THEN $5 ELSE attempts END, claimed_until = NULL, claim_token = NULL,
              send_after = $6, provider_message_ref = COALESCE($7, provider_message_ref), sent_at = CASE WHEN $3 = 'SENT' THEN $8 ELSE sent_at END,
              failed_at = CASE WHEN $3 = 'FAILED' THEN $8 ELSE failed_at END, failure_reason = $9, suppressed_reason = $10,
              address_masked = COALESCE($11, address_masked), address_hash = COALESCE($12, address_hash), updated_at = $8, updated_by = $13
        WHERE id = $1 AND claim_token = $2`,
      [
        f.id,
        f.token,
        r.kind === 'DEFERRED' ? 'DEFERRED_QUIET_HOURS' : r.kind,
        f.outcome !== null,
        f.attemptNo,
        r.kind === 'QUEUED' || r.kind === 'DEFERRED' ? r.sendAfter : null,
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
    if (r.kind === 'SENT' && r.inApp !== undefined) {
      await tx.query('INSERT INTO ntf.in_app_notification (id, principal_id, message_id, title, body, link, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (message_id) DO NOTHING', [
        r.inApp.id,
        r.inApp.principalId,
        f.id,
        r.inApp.title,
        r.inApp.body,
        r.inApp.link,
        f.at,
      ]);
    }
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

  async messageExistsFor(tx: Transaction, sourceEventRef: string, code: string, recordId: string): Promise<boolean> {
    const { rows } = await tx.query(
      "SELECT 1 FROM ntf.message m JOIN ntf.template t ON t.id = m.template_id WHERE m.source_event_ref = $1 AND t.code = $2 AND m.idempotency_key LIKE '%:' || $3 LIMIT 1",
      [sourceEventRef, code, recordId],
    );
    return rows.length > 0;
  }

  async triggerFor(tx: Transaction, eventType: string, templateCode: string): Promise<TriggerRecord | null> {
    const { rows } = await tx.query<Row>(`SELECT ${TRIGGER_COLUMNS} FROM ntf.trigger_rule WHERE event_type = $1 AND template_code = $2 AND deleted_at IS NULL`, [eventType, templateCode]);
    return rows[0] === undefined ? null : trigger(rows[0]);
  }

  async trigger(tx: Transaction, id: string, lock: boolean): Promise<TriggerRecord | null> {
    const { rows } = await tx.query<Row>(`SELECT ${TRIGGER_COLUMNS} FROM ntf.trigger_rule WHERE id = $1 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] === undefined ? null : trigger(rows[0]);
  }

  async triggerPage(tx: Transaction, after: readonly [string, string] | null, limit: number): Promise<TriggerRecord[]> {
    const { rows } = await tx.query<Row>(
      `SELECT ${TRIGGER_COLUMNS} FROM ntf.trigger_rule
        WHERE deleted_at IS NULL AND ($1::text IS NULL OR (event_type, template_code) > ($1::text, $2::text))
        ORDER BY event_type, template_code LIMIT $3`,
      [after?.[0] ?? null, after?.[1] ?? null, limit],
    );
    return rows.map(trigger);
  }

  async updateTrigger(tx: Transaction, id: string, change: { readonly channels: readonly Channel[]; readonly isActive: boolean }, at: Date, actorId: string): Promise<void> {
    await tx.query('UPDATE ntf.trigger_rule SET version = version + 1, channels = $2::text[], is_active = $3, updated_at = $4, updated_by = $5 WHERE id = $1', [id, change.channels, change.isActive, at, actorId]);
  }

  async preferencesOf(tx: Transaction, o: PreferenceOwner): Promise<PreferenceRecord[]> {
    const [customerId, principalId] = owner(o);
    const { rows } = await tx.query<Row>(
      `SELECT category, channel, rank, is_enabled, to_char(quiet_from, 'HH24:MI') AS quiet_from, to_char(quiet_to, 'HH24:MI') AS quiet_to
         FROM ntf.preference
        WHERE customer_id IS NOT DISTINCT FROM $1::uuid AND principal_id IS NOT DISTINCT FROM $2::uuid AND deleted_at IS NULL
        ORDER BY CASE category WHEN 'TRANSACTIONAL' THEN 1 WHEN 'REMINDER' THEN 2 WHEN 'MARKETING' THEN 3 ELSE 4 END, rank`,
      [customerId, principalId],
    );
    return rows.map((r) => ({
      category: r['category'] as PreferenceRecord['category'],
      channel: r['channel'] as Channel,
      rank: r['rank'] as number,
      isEnabled: r['is_enabled'] as boolean,
      quietFrom: r['quiet_from'] as string | null,
      quietTo: r['quiet_to'] as string | null,
    }));
  }

  async replacePreferences(tx: Transaction, o: PreferenceOwner, rows: readonly (Omit<PreferenceRecord, 'rank'> & { readonly id: string })[], at: Date, actorId: string): Promise<void> {
    const [customerId, principalId] = owner(o);
    await tx.query(
      `UPDATE ntf.preference SET version = version + 1, deleted_at = $3, deleted_by = $4, delete_reason = 'replaced', updated_at = $3, updated_by = $4
        WHERE customer_id IS NOT DISTINCT FROM $1::uuid AND principal_id IS NOT DISTINCT FROM $2::uuid AND deleted_at IS NULL`,
      [customerId, principalId, at, actorId],
    );
    const ranks = new Map<string, number>();
    for (const row of rows) {
      const rank = (ranks.get(row.category) ?? 0) + 1;
      ranks.set(row.category, rank);
      await tx.query(
        `INSERT INTO ntf.preference (id, customer_id, principal_id, category, channel, rank, is_enabled, quiet_from, quiet_to, created_at, created_by, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::time, $9::time, $10, $11, $10, $11)`,
        [row.id, customerId, principalId, row.category, row.channel, rank, row.isEnabled, row.quietFrom, row.quietTo, at, actorId],
      );
    }
  }

  async insertOptOut(tx: Transaction, o: OptOutRecord): Promise<void> {
    await tx.query(
      `INSERT INTO ntf.opt_out (${OPT_OUT_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [o.id, o.addressHash, o.addressMasked, o.channel, o.direction, o.source, o.providerReportId, o.occurredAt, o.recordedAt, o.actorId],
    );
  }

  async optedOutChannels(tx: Transaction, addressHash: Buffer): Promise<ReadonlySet<Channel>> {
    const { rows } = await tx.query<{ channel: Channel }>(
      `SELECT channel FROM (SELECT DISTINCT ON (channel) channel, direction FROM ntf.opt_out WHERE address_hash = $1 ORDER BY channel, recorded_at DESC, id DESC) latest
        WHERE direction = 'OPT_OUT'`,
      [addressHash],
    );
    return new Set(rows.map((r) => r.channel));
  }

  async optOutPage(tx: Transaction, after: readonly [Date, string] | null, limit: number): Promise<OptOutRecord[]> {
    const { rows } = await tx.query<Row>(
      `SELECT ${OPT_OUT_COLUMNS} FROM ntf.opt_out WHERE ($1::timestamptz IS NULL OR (recorded_at, id) < ($1::timestamptz, $2::uuid)) ORDER BY recorded_at DESC, id DESC LIMIT $3`,
      [after?.[0] ?? null, after?.[1] ?? null, limit],
    );
    return rows.map(optOut);
  }

  async inAppPage(tx: Transaction, principalId: string, unreadOnly: boolean, after: readonly [Date, string] | null, limit: number): Promise<InAppRecord[]> {
    const { rows } = await tx.query<Row>(
      `SELECT ${IN_APP_COLUMNS} FROM ntf.in_app_notification
        WHERE principal_id = $1 AND (NOT $2 OR read_at IS NULL) AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $5`,
      [principalId, unreadOnly, after?.[0] ?? null, after?.[1] ?? null, limit],
    );
    return rows.map(inApp);
  }

  async inApp(tx: Transaction, principalId: string, id: string, lock: boolean): Promise<InAppRecord | null> {
    const { rows } = await tx.query<Row>(`SELECT ${IN_APP_COLUMNS} FROM ntf.in_app_notification WHERE id = $1 AND principal_id = $2${lock ? ' FOR UPDATE' : ''}`, [id, principalId]);
    return rows[0] === undefined ? null : inApp(rows[0]);
  }

  async markInAppRead(tx: Transaction, id: string, at: Date): Promise<void> {
    await tx.query('UPDATE ntf.in_app_notification SET read_at = $2 WHERE id = $1 AND read_at IS NULL', [id, at]);
  }

  async unreadCount(tx: Transaction, principalId: string): Promise<number> {
    const { rows } = await tx.query<{ n: string }>('SELECT count(*) AS n FROM ntf.in_app_notification WHERE principal_id = $1 AND read_at IS NULL', [principalId]);
    return Number(rows[0]!.n);
  }
}
