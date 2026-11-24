import type { Transaction } from '../../../platform/database/unit-of-work';
import type {
  AcceptanceRecord,
  LinkDecisionRecord,
  StaffMatchRecord,
  LinkRecord,
  LineStockRecord,
  PipelineCell,
  PipelineFilter,
  LineRecord,
  QuoteFilter,
  QuoteRecord,
  QuoteStore,
  RfqFilter,
  RfqRecord,
  RfqStatus,
  VersionFiguresPatch,
  VersionRecord,
} from '../application/quote-store';

const RFQ = `id, rfq_no AS "rfqNo", source, customer_id AS "customerId", contact_name AS "contactName", contact_phone_e164 AS "contactPhone",
  contact_email AS "contactEmail", requirements, product_id AS "productId", stock_unit_id AS "stockUnitId", qty::text AS qty, uom,
  needed_by::text AS "neededBy", delivery_area AS "deliveryArea", assigned_to AS "assignedTo", host(submitted_ip) AS "submittedIp",
  consent_to_contact AS "consentToContact", status, branch_id AS "branchId", version, created_at AS "createdAt"`;

const QUOTE = `id, quote_no AS "quoteNo", rfq_id AS "rfqId", customer_id AS "customerId", contact_name AS "contactName", contact_phone_e164 AS "contactPhone",
  salesperson_id AS "salespersonId", product_line AS "productLine", current_version_no AS "currentVersionNo", accepted_version_id AS "acceptedVersionId",
  converted_order_id AS "convertedOrderId", decline_reason AS "declineReason", cancel_reason AS "cancelReason", status, branch_id AS "branchId", version,
  created_at AS "createdAt", created_by AS "createdBy"`;

const LINK = `t.id, t.quote_version_id AS "quoteVersionId", t.recorded_at AS "createdAt", t.actor_id AS "createdBy", t.expires_at AS "expiresAt",
  r.recorded_at AS "revokedAt", r.actor_id AS "revokedBy", r.reason AS "revokeReason"`;

const DECISION = `id, link_token_id AS "linkTokenId", quote_version_id AS "quoteVersionId", decision, host(ip) AS ip, user_agent AS "userAgent",
  staff_principal_id AS "staffPrincipalId", staff_session_id AS "staffSessionId", decided_at AS "decidedAt"`;

const VERSION = `id, quote_id AS "quoteId", version_no AS "versionNo", status, valid_until AS "validUntil", terms, delivery_estimate AS "deliveryEstimate",
  delivery_fee_pesewas::text AS "deliveryFeePesewas", tax_inclusive AS "taxInclusive", net_pesewas::text AS "netPesewas", tax_pesewas::text AS "taxPesewas",
  gross_pesewas::text AS "grossPesewas", estimated_cost_pesewas::text AS "estimatedCostPesewas", margin_percent::text AS "markupPercent",
  below_margin_floor AS "belowMarginFloor", approval_request_id AS "approvalRequestId", approved_by AS "approvedBy", change_note AS "changeNote",
  issued_at AS "issuedAt", issued_by AS "issuedBy", archived_document_id AS "archivedDocumentId", version, created_at AS "createdAt", created_by AS "createdBy"`;

const LINE = `id, quote_version_id AS "quoteVersionId", line_no AS "lineNo", product_id AS "productId", description, grade_id AS "gradeId",
  weight_band_id AS "weightBandId", stock_unit_id AS "stockUnitId", reservation_id AS "reservationId", qty::text AS qty, uom, base_qty::text AS "baseQty",
  price_basis AS "priceBasis", resolved_unit_price_pesewas::text AS "resolvedUnitPricePesewas",
  resolved_floor_unit_price_pesewas::text AS "resolvedFloorUnitPricePesewas", unit_price_pesewas::text AS "unitPricePesewas",
  line_net_pesewas::text AS "lineNetPesewas", estimated_unit_cost_pesewas::text AS "estimatedUnitCostPesewas"`;

type Raw = Record<string, unknown>;
const big = (v: unknown) => BigInt(v as string);
const bigOrNull = (v: unknown) => (v === null ? null : BigInt(v as string));

function version(r: Raw): VersionRecord {
  return {
    ...(r as unknown as VersionRecord),
    deliveryFeePesewas: big(r['deliveryFeePesewas']),
    netPesewas: big(r['netPesewas']),
    taxPesewas: big(r['taxPesewas']),
    grossPesewas: big(r['grossPesewas']),
    estimatedCostPesewas: bigOrNull(r['estimatedCostPesewas']),
  };
}

function line(r: Raw): LineRecord {
  return {
    ...(r as unknown as LineRecord),
    resolvedUnitPricePesewas: bigOrNull(r['resolvedUnitPricePesewas']),
    resolvedFloorUnitPricePesewas: bigOrNull(r['resolvedFloorUnitPricePesewas']),
    unitPricePesewas: big(r['unitPricePesewas']),
    lineNetPesewas: big(r['lineNetPesewas']),
    estimatedUnitCostPesewas: bigOrNull(r['estimatedUnitCostPesewas']),
  };
}

const text = (v: bigint | null) => (v === null ? null : v.toString());

/** QUO's tables (migration 0251). Updates move `version` on by one, as platform.touch_version requires. */
export class PgQuoteStore implements QuoteStore {
  async insertRfq(tx: Transaction, r: Omit<RfqRecord, 'version' | 'status'>, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO quo.rfq (id, rfq_no, source, customer_id, contact_name, contact_phone_e164, contact_email, requirements, product_id, stock_unit_id, qty, uom,
         needed_by, delivery_area, assigned_to, submitted_ip, consent_to_contact, status, branch_id, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'NEW', $18, $19, $20, $19, $20)`,
      [r.id, r.rfqNo, r.source, r.customerId, r.contactName, r.contactPhone, r.contactEmail, r.requirements, r.productId, r.stockUnitId, r.qty, r.uom, r.neededBy, r.deliveryArea, r.assignedTo, r.submittedIp, r.consentToContact, r.branchId, r.createdAt, actorId],
    );
  }

  async rfqs(tx: Transaction, ids: readonly string[]): Promise<RfqRecord[]> {
    if (ids.length === 0) return [];
    return (await tx.query(`SELECT ${RFQ} FROM quo.rfq WHERE id = ANY($1::uuid[])`, [ids])).rows as RfqRecord[];
  }

  async lockRfq(tx: Transaction, id: string): Promise<RfqRecord | null> {
    return ((await tx.query(`SELECT ${RFQ} FROM quo.rfq WHERE id = $1 FOR UPDATE`, [id])).rows[0] as RfqRecord | undefined) ?? null;
  }

  async listRfqs(tx: Transaction, f: RfqFilter, beforeId: string | null, limit: number): Promise<RfqRecord[]> {
    return (
      await tx.query(
        `SELECT ${RFQ} FROM quo.rfq
          WHERE branch_id = ANY($1::uuid[]) AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR source = $3)
            AND ($4::uuid IS NULL OR assigned_to = $4) AND ($5::uuid IS NULL OR id < $5)
          ORDER BY id DESC LIMIT $6`,
        [f.branchIds, f.status, f.source, f.assignedToId, beforeId, limit],
      )
    ).rows as RfqRecord[];
  }

  async updateRfq(tx: Transaction, id: string, p: { status: RfqStatus; customerId: string | null; assignedTo: string | null }, actorId: string, at: Date): Promise<void> {
    await tx.query('UPDATE quo.rfq SET status = $2, customer_id = $3, assigned_to = $4, updated_by = $5, updated_at = $6, version = version + 1 WHERE id = $1', [id, p.status, p.customerId, p.assignedTo, actorId, at]);
  }

  async quoteIdsOfRfqs(tx: Transaction, rfqIds: readonly string[]): Promise<ReadonlyMap<string, string[]>> {
    const found = new Map<string, string[]>(rfqIds.map((i) => [i, []]));
    if (rfqIds.length === 0) return found;
    for (const r of (await tx.query<{ rfq_id: string; id: string }>('SELECT rfq_id, id FROM quo.quote WHERE rfq_id = ANY($1::uuid[]) ORDER BY id', [rfqIds])).rows) found.get(r.rfq_id)!.push(r.id);
    return found;
  }

  async insertQuote(tx: Transaction, q: Omit<QuoteRecord, 'version' | 'status' | 'currentVersionNo' | 'acceptedVersionId' | 'convertedOrderId' | 'declineReason' | 'cancelReason'>): Promise<void> {
    await tx.query(
      `INSERT INTO quo.quote (id, quote_no, rfq_id, customer_id, contact_name, contact_phone_e164, salesperson_id, product_line, status, branch_id,
         created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'DRAFT', $9, $10, $11, $10, $11)`,
      [q.id, q.quoteNo, q.rfqId, q.customerId, q.contactName, q.contactPhone, q.salespersonId, q.productLine, q.branchId, q.createdAt, q.createdBy],
    );
  }

  async quotes(tx: Transaction, ids: readonly string[]): Promise<QuoteRecord[]> {
    if (ids.length === 0) return [];
    return (await tx.query(`SELECT ${QUOTE} FROM quo.quote WHERE id = ANY($1::uuid[]) ORDER BY id DESC`, [ids])).rows as QuoteRecord[];
  }

  async lockQuote(tx: Transaction, id: string): Promise<QuoteRecord | null> {
    return ((await tx.query(`SELECT ${QUOTE} FROM quo.quote WHERE id = $1 FOR UPDATE`, [id])).rows[0] as QuoteRecord | undefined) ?? null;
  }

  async listQuotes(tx: Transaction, f: QuoteFilter, beforeId: string | null, limit: number): Promise<QuoteRecord[]> {
    return (
      await tx.query(
        `SELECT ${QUOTE} FROM quo.quote
          WHERE branch_id = ANY($1::uuid[]) AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR customer_id = $3)
            AND ($4::uuid IS NULL OR salesperson_id = $4) AND ($5::timestamptz IS NULL OR created_at >= $5) AND ($6::timestamptz IS NULL OR created_at < $6)
            AND ($7::uuid IS NULL OR id < $7)
          ORDER BY id DESC LIMIT $8`,
        [f.branchIds, f.status, f.customerId, f.salespersonId, f.from, f.to, beforeId, limit],
      )
    ).rows as QuoteRecord[];
  }

  async updateQuote(tx: Transaction, id: string, patch: Partial<QuoteRecord>, actorId: string, at: Date): Promise<void> {
    const columns: Record<string, string> = {
      status: 'status',
      currentVersionNo: 'current_version_no',
      acceptedVersionId: 'accepted_version_id',
      convertedOrderId: 'converted_order_id',
      declineReason: 'decline_reason',
      cancelReason: 'cancel_reason',
    };
    const keys = Object.keys(patch).filter((k) => columns[k] !== undefined);
    const sets = keys.map((k, i) => `${columns[k]} = $${i + 4}`);
    await tx.query(`UPDATE quo.quote SET ${[...sets, 'updated_by = $2', 'updated_at = $3', 'version = version + 1'].join(', ')} WHERE id = $1`, [
      id,
      actorId,
      at,
      ...keys.map((k) => (patch as Record<string, unknown>)[k]),
    ]);
  }

  async lockLapsed(tx: Transaction, now: Date, limit: number): Promise<QuoteRecord[]> {
    const due = await tx.query<{ id: string }>(
      `SELECT q.id FROM quo.quote q
        WHERE q.status = 'ISSUED' AND EXISTS (SELECT 1 FROM quo.quote_version v WHERE v.quote_id = q.id AND v.status = 'ISSUED' AND v.valid_until < $1)
        ORDER BY q.id LIMIT $2 FOR UPDATE OF q SKIP LOCKED`,
      [now, limit],
    );
    return this.quotes(
      tx,
      due.rows.map((r) => r.id),
    );
  }

  async insertVersion(tx: Transaction, v: Omit<VersionRecord, 'version' | 'status' | 'approvalRequestId' | 'approvedBy' | 'issuedAt' | 'issuedBy' | 'archivedDocumentId'>): Promise<void> {
    await tx.query(
      `INSERT INTO quo.quote_version (id, quote_id, version_no, status, valid_until, terms, delivery_estimate, delivery_fee_pesewas, tax_inclusive, net_pesewas,
         tax_pesewas, gross_pesewas, estimated_cost_pesewas, margin_percent, below_margin_floor, change_note, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $16, $17)`,
      [
        v.id,
        v.quoteId,
        v.versionNo,
        v.validUntil,
        v.terms,
        v.deliveryEstimate,
        v.deliveryFeePesewas.toString(),
        v.taxInclusive,
        v.netPesewas.toString(),
        v.taxPesewas.toString(),
        v.grossPesewas.toString(),
        text(v.estimatedCostPesewas),
        v.markupPercent,
        v.belowMarginFloor,
        v.changeNote,
        v.createdAt,
        v.createdBy,
      ],
    );
  }

  async versionsOf(tx: Transaction, quoteIds: readonly string[]): Promise<VersionRecord[]> {
    if (quoteIds.length === 0) return [];
    return (await tx.query(`SELECT ${VERSION} FROM quo.quote_version WHERE quote_id = ANY($1::uuid[]) ORDER BY quote_id, version_no DESC`, [quoteIds])).rows.map(version);
  }

  async version(tx: Transaction, id: string): Promise<VersionRecord | null> {
    const r = (await tx.query(`SELECT ${VERSION} FROM quo.quote_version WHERE id = $1`, [id])).rows[0];
    return r === undefined ? null : version(r);
  }

  async setFigures(tx: Transaction, id: string, f: VersionFiguresPatch, actorId: string, at: Date): Promise<void> {
    await tx.query(
      `UPDATE quo.quote_version SET valid_until = $2, terms = $3, delivery_estimate = $4, delivery_fee_pesewas = $5, net_pesewas = $6, tax_pesewas = $7,
         gross_pesewas = $8, estimated_cost_pesewas = $9, margin_percent = $10, below_margin_floor = $11, updated_by = $12, updated_at = $13, version = version + 1
       WHERE id = $1`,
      [id, f.validUntil, f.terms, f.deliveryEstimate, f.deliveryFeePesewas.toString(), f.netPesewas.toString(), f.taxPesewas.toString(), f.grossPesewas.toString(), text(f.estimatedCostPesewas), f.markupPercent, f.belowMarginFloor, actorId, at],
    );
  }

  async setVersionStatus(
    tx: Transaction,
    id: string,
    p: { status: string; approvalRequestId?: string | null; approvedBy?: string | null; approvedAt?: Date | null; issuedAt?: Date | null; issuedBy?: string | null },
    actorId: string,
    at: Date,
  ): Promise<void> {
    const columns: Record<string, string> = { approvalRequestId: 'approval_request_id', approvedBy: 'approved_by', approvedAt: 'approved_at', issuedAt: 'issued_at', issuedBy: 'issued_by' };
    const keys = Object.keys(p).filter((k) => columns[k] !== undefined);
    await tx.query(
      `UPDATE quo.quote_version SET ${['status = $2', ...keys.map((k, i) => `${columns[k]} = $${i + 5}`), 'updated_by = $3', 'updated_at = $4', 'version = version + 1'].join(', ')} WHERE id = $1`,
      [id, p.status, actorId, at, ...keys.map((k) => (p as Record<string, unknown>)[k])],
    );
  }

  async replaceLines(tx: Transaction, versionId: string, lines: readonly LineRecord[]): Promise<void> {
    // A draft's lines are set aside, never deleted (DOCUMENT, migration 0253), and the new ones written.
    await tx.query('UPDATE quo.quote_line SET removed = true WHERE quote_version_id = $1 AND NOT removed', [versionId]);
    for (const l of lines) {
      await tx.query(
        `INSERT INTO quo.quote_line (id, quote_version_id, line_no, product_id, description, grade_id, weight_band_id, stock_unit_id, reservation_id, qty, uom,
           base_qty, price_basis, resolved_unit_price_pesewas, resolved_floor_unit_price_pesewas, unit_price_pesewas, line_net_pesewas, estimated_unit_cost_pesewas)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          l.id,
          versionId,
          l.lineNo,
          l.productId,
          l.description,
          l.gradeId,
          l.weightBandId,
          l.stockUnitId,
          l.reservationId,
          l.qty,
          l.uom,
          l.baseQty,
          l.priceBasis,
          text(l.resolvedUnitPricePesewas),
          text(l.resolvedFloorUnitPricePesewas),
          l.unitPricePesewas.toString(),
          l.lineNetPesewas.toString(),
          text(l.estimatedUnitCostPesewas),
        ],
      );
    }
  }

  async linesOf(tx: Transaction, versionIds: readonly string[]): Promise<LineRecord[]> {
    if (versionIds.length === 0) return [];
    return (await tx.query(`SELECT ${LINE} FROM quo.quote_line WHERE quote_version_id = ANY($1::uuid[]) AND NOT removed ORDER BY quote_version_id, line_no`, [versionIds])).rows.map(line);
  }

  async holdLine(tx: Transaction, lineId: string, reservationId: string): Promise<void> {
    await tx.query('UPDATE quo.quote_line SET reservation_id = $2 WHERE id = $1', [lineId, reservationId]);
  }

  async insertAcceptance(tx: Transaction, a: AcceptanceRecord, actorId: string, at: Date): Promise<void> {
    await tx.query(
      `INSERT INTO quo.quote_acceptance (id, quote_version_id, method, accepted_name, note, ip, user_agent, accepted_at, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [a.id, a.quoteVersionId, a.method, a.acceptedName, a.note, a.ip, a.userAgent, a.acceptedAt, at, actorId],
    );
  }

  async acceptancesOf(tx: Transaction, versionIds: readonly string[]): Promise<AcceptanceRecord[]> {
    if (versionIds.length === 0) return [];
    return (
      await tx.query(
        `SELECT id, quote_version_id AS "quoteVersionId", method, accepted_name AS "acceptedName", note, host(ip) AS ip, user_agent AS "userAgent", accepted_at AS "acceptedAt"
           FROM quo.quote_acceptance WHERE quote_version_id = ANY($1::uuid[])`,
        [versionIds],
      )
    ).rows as AcceptanceRecord[];
  }

  async insertLinkToken(tx: Transaction, t: { id: string; quoteVersionId: string; tokenHash: Buffer; expiresAt: Date }, actorId: string, at: Date): Promise<void> {
    await tx.query('INSERT INTO quo.quote_link_token (id, quote_version_id, token_hash, recorded_at, expires_at, actor_id) VALUES ($1, $2, $3, $4, $5, $6)', [t.id, t.quoteVersionId, t.tokenHash, at, t.expiresAt, actorId]);
  }

  async linkToken(tx: Transaction, tokenHash: Buffer): Promise<{ id: string; quoteVersionId: string; tokenHash: Buffer; expiresAt: Date; revoked: boolean } | null> {
    const r = (
      await tx.query(
        `SELECT t.id, t.quote_version_id AS "quoteVersionId", t.token_hash AS "tokenHash", t.expires_at AS "expiresAt",
                EXISTS (SELECT 1 FROM quo.quote_link_revocation r WHERE r.link_token_id = t.id) AS revoked
           FROM quo.quote_link_token t WHERE t.token_hash = $1`,
        [tokenHash],
      )
    ).rows[0];
    return (r as { id: string; quoteVersionId: string; tokenHash: Buffer; expiresAt: Date; revoked: boolean } | undefined) ?? null;
  }

  async linksOf(tx: Transaction, versionIds: readonly string[]): Promise<LinkRecord[]> {
    if (versionIds.length === 0) return [];
    return (
      await tx.query(`SELECT ${LINK} FROM quo.quote_link_token t LEFT JOIN quo.quote_link_revocation r ON r.link_token_id = t.id WHERE t.quote_version_id = ANY($1::uuid[]) ORDER BY t.id`, [
        versionIds,
      ])
    ).rows as LinkRecord[];
  }

  async link(tx: Transaction, id: string): Promise<LinkRecord | null> {
    return ((await tx.query(`SELECT ${LINK} FROM quo.quote_link_token t LEFT JOIN quo.quote_link_revocation r ON r.link_token_id = t.id WHERE t.id = $1`, [id])).rows[0] as LinkRecord | undefined) ?? null;
  }

  async insertLinkRevocation(tx: Transaction, r: { id: string; linkTokenId: string; reason: string }, actorId: string, at: Date): Promise<void> {
    await tx.query('INSERT INTO quo.quote_link_revocation (id, link_token_id, reason, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5)', [r.id, r.linkTokenId, r.reason, at, actorId]);
  }

  async insertLinkDecision(tx: Transaction, d: LinkDecisionRecord, actorId: string, at: Date): Promise<void> {
    await tx.query(
      `INSERT INTO quo.quote_link_decision (id, link_token_id, quote_version_id, decision, ip, user_agent, staff_principal_id, staff_session_id, decided_at, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [d.id, d.linkTokenId, d.quoteVersionId, d.decision, d.ip, d.userAgent, d.staffPrincipalId, d.staffSessionId, d.decidedAt, at, actorId],
    );
  }

  async insertStaffMatches(tx: Transaction, rows: readonly StaffMatchRecord[], actorId: string, at: Date): Promise<void> {
    for (const m of rows) {
      await tx.query(
        `INSERT INTO quo.quote_link_staff_match (id, link_decision_id, staff_principal_id, staff_session_id, same_browser, session_last_seen_at, window_hours, recorded_at, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [m.id, m.linkDecisionId, m.staffPrincipalId, m.staffSessionId, m.sameBrowser, m.sessionLastSeenAt, m.windowHours, at, actorId],
      );
    }
  }

  async linkDecisionsOf(tx: Transaction, versionIds: readonly string[]): Promise<LinkDecisionRecord[]> {
    if (versionIds.length === 0) return [];
    return (await tx.query(`SELECT ${DECISION} FROM quo.quote_link_decision WHERE quote_version_id = ANY($1::uuid[])`, [versionIds])).rows as LinkDecisionRecord[];
  }

  async quoteIdsOfCustomer(tx: Transaction, customerId: string, beforeId: string | null, limit: number): Promise<string[]> {
    return (
      await tx.query(
        `SELECT q.id FROM quo.quote q
          WHERE q.customer_id = $1 AND ($2::uuid IS NULL OR q.id < $2) AND q.status IN ('ISSUED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CONVERTED')
            AND EXISTS (SELECT 1 FROM quo.quote_version v WHERE v.quote_id = q.id AND v.issued_at IS NOT NULL)
          ORDER BY q.id DESC LIMIT $3`,
        [customerId, beforeId, limit],
      )
    ).rows.map((r) => (r as { id: string }).id);
  }
  async insertLineStock(tx: Transaction, r: LineStockRecord, actorId: string, at: Date): Promise<void> {
    await tx.query(
      `INSERT INTO quo.quote_line_stock (id, quote_line_id, quote_version_id, available_qty, held_qty, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [r.id, r.quoteLineId, r.quoteVersionId, r.availableQty, r.heldQty, at, actorId],
    );
  }

  async lineStockOf(tx: Transaction, versionIds: readonly string[]): Promise<LineStockRecord[]> {
    if (versionIds.length === 0) return [];
    return (
      await tx.query(
        `SELECT id, quote_line_id AS "quoteLineId", quote_version_id AS "quoteVersionId", available_qty::text AS "availableQty", held_qty::text AS "heldQty"
           FROM quo.quote_line_stock WHERE quote_version_id = ANY($1::uuid[])`,
        [versionIds],
      )
    ).rows as LineStockRecord[];
  }

  async setArchivedDocument(tx: Transaction, versionId: string, archivedDocumentId: string, actorId: string, at: Date): Promise<boolean> {
    const r = await tx.query(
      `UPDATE quo.quote_version SET archived_document_id = $2, version = version + 1, updated_at = $3, updated_by = $4 WHERE id = $1 AND archived_document_id IS NULL`,
      [versionId, archivedDocumentId, at, actorId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async versionByNo(tx: Transaction, quoteId: string, versionNo: number): Promise<VersionRecord | null> {
    const r = await tx.query(`SELECT ${VERSION} FROM quo.quote_version WHERE quote_id = $1 AND version_no = $2`, [quoteId, versionNo]);
    return (r.rows[0] as VersionRecord | undefined) ?? null;
  }

  async pipelineCells(tx: Transaction, f: PipelineFilter): Promise<PipelineCell[]> {
    const group = f.groupBy === 'SALESPERSON' ? 'q.salesperson_id::text' : 'q.product_line';
    const rows = (
      await tx.query<{ groupKey: string | null; status: PipelineCell['status']; count: string; grossPesewas: string }>(
        `SELECT ${group} AS "groupKey", q.status, count(*)::text AS count, sum(v.gross_pesewas)::text AS "grossPesewas"
           FROM quo.quote q
           CROSS JOIN LATERAL (
             SELECT s.gross_pesewas FROM quo.quote_version s
              WHERE s.quote_id = q.id AND s.issued_at IS NOT NULL
              ORDER BY (s.id = q.accepted_version_id) DESC NULLS LAST, s.version_no DESC LIMIT 1) v
          WHERE q.branch_id = ANY($1::uuid[]) AND q.created_at >= $2 AND q.created_at < $3
            AND q.status IN ('ISSUED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CONVERTED', 'CANCELLED')
          GROUP BY 1, 2`,
        [f.branchIds, f.from, f.to],
      )
    ).rows;
    return rows.map((r) => ({ groupKey: r.groupKey, status: r.status, count: Number(r.count), grossPesewas: BigInt(r.grossPesewas) }));
  }
}
