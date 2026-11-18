import type { Transaction } from '../../../platform/database/unit-of-work';
import type { MethodKind } from '../domain/tender';
import type {
  ShiftTenderRow,
  AllocationRecord,
  ChargeChange,
  ChargeRecord,
  NewBreak,
  NewPayment,
  OrderLinkRecord,
  PaymentFilter,
  ReversalRecord,
  StoreCreditEntryRecord,
  PaymentRecord,
  PaymentStore,
  RefundChange,
  RefundFilter,
  RefundRecord,
  RefundStatus,
  WebhookRow,
} from '../application/payment-store';

interface PaymentRow {
  id: string;
  payment_method_id: string;
  method_kind: PaymentRecord['methodKind'];
  amount_pesewas: string;
  allocated_pesewas: string;
  refunded_pesewas: string;
  customer_id: string | null;
  order_document_id: string | null;
  shift_document_id: string | null;
  register_ref: string | null;
  register_code: string | null;
  provider: string | null;
  provider_reference: string | null;
  external_reference: string | null;
  payer_phone_masked: string | null;
  verification: PaymentRecord['verification'];
  status: PaymentRecord['status'];
  received_at: Date;
  cleared_at: Date | null;
  failure_reason: string | null;
  reverses_payment_id: string | null;
  bank_account_id: string | null;
  cheque_due_on: string | null;
  clearance_ref: string | null;
  branch_id: string;
  created_by: string;
  created_at: Date;
}

const PAYMENT_COLUMNS = `id, payment_method_id, method_kind, amount_pesewas::text, allocated_pesewas::text, refunded_pesewas::text, customer_id,
  order_document_id, shift_document_id, register_ref, register_code, provider, provider_reference, external_reference, payer_phone_masked,
  verification, status, received_at, cleared_at, failure_reason, reverses_payment_id, bank_account_id, cheque_due_on::text, clearance_ref, branch_id, created_by, created_at`;

function toRecord(row: PaymentRow): PaymentRecord {
  return {
    id: row.id,
    paymentMethodId: row.payment_method_id,
    methodKind: row.method_kind,
    amountPesewas: BigInt(row.amount_pesewas),
    allocatedPesewas: BigInt(row.allocated_pesewas),
    refundedPesewas: BigInt(row.refunded_pesewas),
    customerId: row.customer_id,
    orderDocumentId: row.order_document_id,
    shiftDocumentId: row.shift_document_id,
    registerRef: row.register_ref,
    registerCode: row.register_code,
    provider: row.provider,
    providerReference: row.provider_reference,
    externalReference: row.external_reference,
    payerPhoneMasked: row.payer_phone_masked,
    verification: row.verification,
    status: row.status,
    receivedAt: row.received_at,
    clearedAt: row.cleared_at,
    failureReason: row.failure_reason,
    reversesPaymentId: row.reverses_payment_id,
    bankAccountId: row.bank_account_id,
    chequeDueOn: row.cheque_due_on,
    clearanceRef: row.clearance_ref,
    branchId: row.branch_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

interface ChargeRow {
  id: string;
  payment_id: string;
  provider: string;
  reference: string;
  channel: ChargeRecord['channel'];
  network: ChargeRecord['network'];
  requested_pesewas: string;
  confirmed_pesewas: string | null;
  status: ChargeRecord['status'];
  awaited_until: Date;
  released_at: Date | null;
  created_at: Date;
  branch_id: string;
}

const CHARGE_COLUMNS = `id, payment_id, provider, reference, channel, network, requested_pesewas::text, confirmed_pesewas::text, status, awaited_until,
  released_at, created_at, branch_id`;

function toCharge(row: ChargeRow): ChargeRecord {
  return {
    id: row.id,
    paymentId: row.payment_id,
    provider: row.provider,
    reference: row.reference,
    channel: row.channel,
    network: row.network,
    requestedPesewas: BigInt(row.requested_pesewas),
    confirmedPesewas: row.confirmed_pesewas === null ? null : BigInt(row.confirmed_pesewas),
    status: row.status,
    awaitedUntil: row.awaited_until,
    releasedAt: row.released_at,
    createdAt: row.created_at,
    branchId: row.branch_id,
  };
}

interface RefundRow {
  id: string;
  original_payment_id: string;
  amount_pesewas: string;
  destination: RefundRecord['destination'];
  reason_code: string;
  note: string | null;
  credit_note_id: string | null;
  is_automatic: boolean;
  approval_request_id: string | null;
  provider_reference: string | null;
  external_reference: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  paid_at: Date | null;
  paid_by: string | null;
  paid_from_shift_id: string | null;
  failure_reason: string | null;
  status: RefundStatus;
  branch_id: string;
  created_at: Date;
  created_by: string;
}

const REFUND_COLUMNS = `id, original_payment_id, amount_pesewas::text, destination, reason_code, note, credit_note_id, is_automatic, approval_request_id,
  provider_reference, external_reference, attempts, next_attempt_at, paid_at, paid_by, paid_from_shift_id, failure_reason, status, branch_id, created_at, created_by`;

function toRefund(row: RefundRow): RefundRecord {
  return {
    id: row.id,
    originalPaymentId: row.original_payment_id,
    amountPesewas: BigInt(row.amount_pesewas),
    destination: row.destination,
    reasonCode: row.reason_code,
    note: row.note,
    creditNoteId: row.credit_note_id,
    isAutomatic: row.is_automatic,
    approvalRequestId: row.approval_request_id,
    providerReference: row.provider_reference,
    externalReference: row.external_reference,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    paidAt: row.paid_at,
    paidBy: row.paid_by,
    paidFromShiftId: row.paid_from_shift_id,
    failureReason: row.failure_reason,
    status: row.status,
    branchId: row.branch_id,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

/** PAY's tables in PostgreSQL. Point reads by key or index only: the posting transaction runs at serializable (ADR-0005). */
export class PgPaymentStore implements PaymentStore {
  async insert(tx: Transaction, p: NewPayment): Promise<void> {
    await tx.query(
      `INSERT INTO pay.payment (id, payment_method_id, method_kind, amount_pesewas, customer_id, order_document_id, shift_document_id, register_ref, register_code,
                                provider, provider_reference, external_reference, payer_phone_masked,
                                verification, received_at, cleared_at, status, branch_id, created_by, updated_by, posted_at, posted_by,
                                bank_account_id, cheque_due_on, reverses_payment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $16, $17, $18, $19, $10, $11, $12, $13, $14, $15, $15, $12, CASE WHEN $12::timestamptz IS NULL THEN NULL ELSE $15::uuid END,
               $20, $21::date, $22)`,
      [
        p.id,
        p.paymentMethodId,
        p.methodKind,
        p.amountPesewas.toString(),
        p.customerId,
        p.orderDocumentId,
        p.shiftDocumentId,
        p.register?.id ?? null,
        p.register?.code ?? null,
        p.verification,
        p.receivedAt,
        p.clearedAt,
        p.status,
        p.branchId,
        p.actorId,
        p.provider ?? null,
        p.providerReference ?? null,
        p.externalReference ?? null,
        p.payerPhoneMasked ?? null,
        p.bankAccountId ?? null,
        p.chequeDueOn ?? null,
        p.reversesPaymentId ?? null,
      ],
    );
  }

  async allocate(tx: Transaction, a: AllocationRecord & { readonly actorId: string; readonly reason?: string | null }): Promise<void> {
    await tx.query(
      `INSERT INTO pay.payment_allocation (id, payment_id, billing_document_id, amount_pesewas, direction, reverses_allocation_id, reason, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [a.id, a.paymentId, a.billingDocumentId, a.amountPesewas.toString(), a.direction, a.reversesAllocationId ?? null, a.reason ?? null, a.actorId],
    );
  }

  async payments(tx: Transaction, ids: readonly string[], forUpdate = false): Promise<PaymentRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM pay.payment WHERE id = ANY($1::uuid[]) ORDER BY id${forUpdate ? ' FOR UPDATE' : ''}`, [ids]);
    return rows.map(toRecord);
  }

  async paymentsOfOrder(tx: Transaction, orderDocumentId: string): Promise<PaymentRecord[]> {
    const { rows } = await tx.query<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM pay.payment
        WHERE order_document_id = $1 OR id IN (SELECT l.payment_id FROM pay.payment_order_link l WHERE l.order_document_id = $1)
        ORDER BY id`,
      [orderDocumentId],
    );
    return rows.map(toRecord);
  }

  async insertOrderLink(tx: Transaction, l: OrderLinkRecord): Promise<void> {
    await tx.query(
      `INSERT INTO pay.payment_order_link (payment_id, order_document_id, shift_document_id, customer_id, branch_id, recorded_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [l.paymentId, l.orderDocumentId, l.shiftDocumentId, l.customerId, l.branchId, l.recordedAt, l.actorId],
    );
  }

  async linkedOrders(tx: Transaction, paymentIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (paymentIds.length === 0) return new Map();
    const { rows } = await tx.query<{ payment_id: string; order_document_id: string }>('SELECT payment_id, order_document_id FROM pay.payment_order_link WHERE payment_id = ANY($1::uuid[])', [paymentIds]);
    return new Map(rows.map((r) => [r.payment_id, r.order_document_id]));
  }

  async allocationsOf(tx: Transaction, paymentIds: readonly string[]): Promise<AllocationRecord[]> {
    if (paymentIds.length === 0) return [];
    return this.allocationRows(tx, 'a.payment_id = ANY($1::uuid[])', [paymentIds]);
  }

  async activeAllocations(tx: Transaction, paymentId: string): Promise<AllocationRecord[]> {
    return this.allocationRows(
      tx,
      "a.payment_id = $1 AND a.direction = 'APPLY' AND NOT EXISTS (SELECT 1 FROM pay.payment_allocation u WHERE u.reverses_allocation_id = a.id)",
      [paymentId],
    );
  }

  /** `atReceipt`: written in the payment's own transaction (the same `now()` as the payment row), so its clearing entry credited it. */
  private async allocationRows(tx: Transaction, where: string, params: unknown[]): Promise<AllocationRecord[]> {
    const { rows } = await tx.query<{ id: string; payment_id: string; billing_document_id: string; amount_pesewas: string; direction: 'APPLY' | 'UNAPPLY'; reverses_allocation_id: string | null; recorded_at: Date; at_receipt: boolean }>(
      `SELECT a.id, a.payment_id, a.billing_document_id, a.amount_pesewas::text, a.direction, a.reverses_allocation_id, a.recorded_at, a.recorded_at = p.created_at AS at_receipt
         FROM pay.payment_allocation a JOIN pay.payment p ON p.id = a.payment_id WHERE ${where} ORDER BY a.id`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      paymentId: r.payment_id,
      billingDocumentId: r.billing_document_id,
      amountPesewas: BigInt(r.amount_pesewas),
      direction: r.direction,
      reversesAllocationId: r.reverses_allocation_id,
      recordedAt: r.recorded_at,
      atReceipt: r.at_receipt,
    }));
  }

  async allocation(tx: Transaction, id: string): Promise<(AllocationRecord & { readonly reversed: boolean }) | null> {
    const { rows } = await tx.query<{ id: string; payment_id: string; billing_document_id: string; amount_pesewas: string; direction: 'APPLY' | 'UNAPPLY'; reversed: boolean }>(
      `SELECT a.id, a.payment_id, a.billing_document_id, a.amount_pesewas::text, a.direction,
              EXISTS (SELECT 1 FROM pay.payment_allocation u WHERE u.reverses_allocation_id = a.id) AS reversed
         FROM pay.payment_allocation a WHERE a.id = $1`,
      [id],
    );
    const r = rows[0];
    return r === undefined ? null : { id: r.id, paymentId: r.payment_id, billingDocumentId: r.billing_document_id, amountPesewas: BigInt(r.amount_pesewas), direction: r.direction, reversed: r.reversed };
  }

  async shiftTotals(tx: Transaction, shiftDocumentId: string): Promise<ShiftTenderRow[]> {
    const { rows } = await tx.query<{ payment_method_id: string; method_kind: MethodKind; n: number; amount: string; refunded: string }>(
      // Cash refunded counts against the shift it was paid out of (A-273 (i), ADR-0077), whichever shift took the
      // payment; another method's refunds go back through its provider and count against the payments of the shift.
      `WITH taken AS (
         SELECT payment_method_id, method_kind, count(*)::int AS n, sum(amount_pesewas) AS amount, sum(refunded_pesewas) AS refunded
           FROM pay.payment WHERE shift_document_id = $1 AND status = 'CLEARED'
          GROUP BY payment_method_id, method_kind),
       paid_out AS (
         SELECT p.payment_method_id, p.method_kind, sum(r.amount_pesewas) AS amount
           FROM pay.refund r JOIN pay.payment p ON p.id = r.original_payment_id
          WHERE r.paid_from_shift_id = $1 AND r.status = 'PAID'
          GROUP BY p.payment_method_id, p.method_kind)
       SELECT COALESCE(t.payment_method_id, o.payment_method_id) AS payment_method_id, COALESCE(t.method_kind, o.method_kind) AS method_kind,
              COALESCE(t.n, 0) AS n, COALESCE(t.amount, 0)::text AS amount,
              (CASE WHEN COALESCE(t.method_kind, o.method_kind) = 'CASH' THEN COALESCE(o.amount, 0) ELSE COALESCE(t.refunded, 0) END)::text AS refunded
         FROM taken t FULL JOIN paid_out o ON o.payment_method_id = t.payment_method_id
        ORDER BY 1`,
      [shiftDocumentId],
    );
    return rows.map((r) => ({ paymentMethodId: r.payment_method_id, methodKind: r.method_kind, count: r.n, amountPesewas: BigInt(r.amount), refundedPesewas: BigInt(r.refunded) }));
  }

  async list(tx: Transaction, f: PaymentFilter, beforeId: string | null, limit: number): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM pay.payment
        WHERE branch_id = ANY($1::uuid[])
          AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR method_kind = $3)
          AND ($4::uuid IS NULL OR customer_id = $4) AND ($5::uuid IS NULL OR order_document_id = $5)
          AND ($6::timestamptz IS NULL OR received_at >= $6) AND ($7::timestamptz IS NULL OR received_at < $7)
          AND ($8::uuid IS NULL OR id < $8) AND ($10::uuid IS NULL OR shift_document_id = $10)
          AND (NOT $11 OR amount_pesewas - allocated_pesewas - refunded_pesewas > 0)
        ORDER BY id DESC LIMIT $9`,
      [f.branchIds, f.status, f.methodKind, f.customerId, f.orderId, f.from, f.to, beforeId, limit, f.shiftId, f.unallocatedOnly],
    );
    return rows.map((r) => r.id);
  }

  async unmatched(tx: Transaction, branchIds: readonly string[], beforeId: string | null, limit: number): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT p.id FROM pay.payment p
        WHERE p.branch_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR p.id < $2)
          AND ((p.status = 'PENDING' AND p.provider IS NOT NULL)
               OR EXISTS (SELECT 1 FROM pay.reconciliation_break b
                           WHERE b.payment_id = p.id AND b.status = 'OPEN' AND b.kind IN ('UNMATCHED_PAYMENT', 'PROVIDER_AMOUNT_DIFFERS')))
        ORDER BY p.id DESC LIMIT $3`,
      [branchIds, beforeId, limit],
    );
    return rows.map((r) => r.id);
  }

  async markCleared(tx: Transaction, id: string, verification: PaymentRecord['verification'], at: Date, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE pay.payment SET status = 'CLEARED', verification = $2, cleared_at = $3, posted_at = $3, posted_by = $4, updated_by = $4, version = version + 1
        WHERE id = $1`,
      [id, verification, at, actorId],
    );
  }

  async markFailed(tx: Transaction, id: string, reason: string, actorId: string): Promise<void> {
    await tx.query("UPDATE pay.payment SET status = 'FAILED', failure_reason = $2, updated_by = $3, version = version + 1 WHERE id = $1", [id, reason, actorId]);
  }

  async markChequeCleared(tx: Transaction, id: string, clearanceRef: string, at: Date, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE pay.payment SET status = 'CLEARED', clearance_ref = $2, cleared_at = $3, posted_at = $3, posted_by = $4, updated_by = $4, version = version + 1
        WHERE id = $1`,
      [id, clearanceRef, at, actorId],
    );
  }

  async markReversed(tx: Transaction, id: string, actorId: string): Promise<void> {
    await tx.query("UPDATE pay.payment SET status = 'REVERSED', updated_by = $2, version = version + 1 WHERE id = $1", [id, actorId]);
  }

  async insertReversal(tx: Transaction, r: Omit<ReversalRecord, 'approvalRequestId' | 'reversingPaymentId' | 'status'>): Promise<void> {
    await tx.query(
      `INSERT INTO pay.payment_reversal (id, payment_id, reason_code, note, status, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 'PENDING_APPROVAL', $5, $6, $6)`,
      [r.id, r.paymentId, r.reasonCode, r.note, r.branchId, r.createdBy],
    );
  }

  async reversalByApproval(tx: Transaction, approvalRequestId: string): Promise<ReversalRecord | null> {
    return this.reversalWhere(tx, 'approval_request_id = $1', approvalRequestId);
  }

  async openReversalOf(tx: Transaction, paymentId: string): Promise<ReversalRecord | null> {
    return this.reversalWhere(tx, "payment_id = $1 AND status <> 'REJECTED'", paymentId);
  }

  private async reversalWhere(tx: Transaction, where: string, value: string): Promise<ReversalRecord | null> {
    const { rows } = await tx.query<{ id: string; payment_id: string; reason_code: string; note: string; approval_request_id: string | null; reversing_payment_id: string | null; status: ReversalRecord['status']; branch_id: string; created_by: string }>(
      `SELECT id, payment_id, reason_code, note, approval_request_id, reversing_payment_id, status, branch_id, created_by FROM pay.payment_reversal WHERE ${where} FOR UPDATE`,
      [value],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : { id: r.id, paymentId: r.payment_id, reasonCode: r.reason_code, note: r.note, approvalRequestId: r.approval_request_id, reversingPaymentId: r.reversing_payment_id, status: r.status, branchId: r.branch_id, createdBy: r.created_by };
  }

  async updateReversal(tx: Transaction, id: string, c: { readonly status?: ReversalRecord['status']; readonly approvalRequestId?: string; readonly reversingPaymentId?: string }, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE pay.payment_reversal SET status = COALESCE($2, status), approval_request_id = COALESCE($3, approval_request_id),
              reversing_payment_id = COALESCE($4, reversing_payment_id), updated_by = $5, updated_at = now(), version = version + 1
        WHERE id = $1`,
      [id, c.status ?? null, c.approvalRequestId ?? null, c.reversingPaymentId ?? null, actorId],
    );
  }

  async insertStoreCredit(tx: Transaction, e: Omit<StoreCreditEntryRecord, 'recordedAt'> & { readonly actorId: string }): Promise<void> {
    await tx.query(
      `INSERT INTO pay.store_credit_entry (id, customer_id, direction, amount_pesewas, source_document_id, branch_id, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [e.id, e.customerId, e.direction, e.amountPesewas.toString(), e.sourceDocumentId, e.branchId, e.actorId],
    );
  }

  async storeCreditBalance(tx: Transaction, customerId: string): Promise<bigint> {
    const { rows } = await tx.query<{ balance: string }>('SELECT balance_pesewas::text AS balance FROM pay.store_credit_balance WHERE customer_id = $1', [customerId]);
    return rows[0] === undefined ? 0n : BigInt(rows[0].balance);
  }

  async storeCreditEntries(tx: Transaction, customerId: string, limit: number): Promise<StoreCreditEntryRecord[]> {
    const { rows } = await tx.query<{ id: string; customer_id: string; direction: StoreCreditEntryRecord['direction']; amount: string; source_document_id: string; branch_id: string; recorded_at: Date }>(
      `SELECT id, customer_id, direction, amount_pesewas::text AS amount, source_document_id, branch_id, recorded_at
         FROM pay.store_credit_entry WHERE customer_id = $1 ORDER BY id DESC LIMIT $2`,
      [customerId, limit],
    );
    return rows.map((r) => ({ id: r.id, customerId: r.customer_id, direction: r.direction, amountPesewas: BigInt(r.amount), sourceDocumentId: r.source_document_id, branchId: r.branch_id, recordedAt: r.recorded_at }));
  }

  async insertCharge(tx: Transaction, c: Omit<ChargeRecord, 'confirmedPesewas' | 'status' | 'releasedAt'> & { readonly actorId: string }): Promise<void> {
    await tx.query(
      `INSERT INTO pay.provider_transaction (id, payment_id, provider, reference, kind, channel, network, requested_pesewas, status, awaited_until, branch_id, created_by, updated_by, created_at)
       VALUES ($1, $2, $3, $4, 'CHARGE', $5, $6, $7, 'INITIATED', $8, $9, $10, $10, $11)`,
      [c.id, c.paymentId, c.provider, c.reference, c.channel, c.network, c.requestedPesewas.toString(), c.awaitedUntil, c.branchId, c.actorId, c.createdAt],
    );
  }

  async chargeOfPayment(tx: Transaction, paymentId: string, forUpdate = false): Promise<ChargeRecord | null> {
    const { rows } = await tx.query<ChargeRow>(`SELECT ${CHARGE_COLUMNS} FROM pay.provider_transaction WHERE payment_id = $1 AND kind = 'CHARGE'${forUpdate ? ' FOR UPDATE' : ''}`, [paymentId]);
    return rows[0] === undefined ? null : toCharge(rows[0]);
  }

  async chargeByReference(tx: Transaction, provider: string, reference: string, forUpdate = false): Promise<ChargeRecord | null> {
    const { rows } = await tx.query<ChargeRow>(`SELECT ${CHARGE_COLUMNS} FROM pay.provider_transaction WHERE provider = $1 AND reference = $2${forUpdate ? ' FOR UPDATE' : ''}`, [provider, reference]);
    return rows[0] === undefined ? null : toCharge(rows[0]);
  }

  async updateCharge(tx: Transaction, id: string, change: ChargeChange, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE pay.provider_transaction
          SET status = COALESCE($2, status), provider_status = COALESCE($3, provider_status), confirmed_pesewas = COALESCE($4::bigint, confirmed_pesewas),
              verified_at = COALESCE($5, verified_at), last_checked_at = COALESCE($6, last_checked_at), released_at = COALESCE($7, released_at),
              updated_by = $8, version = version + 1
        WHERE id = $1`,
      [id, change.status ?? null, change.providerStatus ?? null, change.confirmedPesewas?.toString() ?? null, change.verifiedAt ?? null, change.lastCheckedAt ?? null, change.releasedAt ?? null, actorId],
    );
  }

  async openCharges(tx: Transaction, provider: string, before: Date, limit: number): Promise<ChargeRecord[]> {
    const { rows } = await tx.query<ChargeRow>(
      `SELECT ${CHARGE_COLUMNS} FROM pay.provider_transaction
        WHERE status IN ('INITIATED', 'PENDING') AND provider = $1 AND created_at < $2 ORDER BY created_at, id LIMIT $3`,
      [provider, before, limit],
    );
    return rows.map(toCharge);
  }

  async webhookSeen(tx: Transaction, provider: string, eventId: string): Promise<boolean> {
    const { rows } = await tx.query(
      "SELECT 1 FROM pay.webhook_event WHERE provider = $1 AND event_id = $2 AND signature_valid AND outcome IN ('ACCEPTED', 'REJECTED_AMOUNT', 'IGNORED_UNKNOWN_REFERENCE', 'DEFERRED_LOOKUP')",
      [provider, eventId],
    );
    return rows.length > 0;
  }

  async insertWebhook(tx: Transaction, w: WebhookRow): Promise<void> {
    await tx.query(
      `INSERT INTO pay.webhook_event (id, provider, event_id, event_type, signature_valid, within_time_window, payload_hash, payload, reference, payment_id, outcome,
                                      source_ip, correlation_id, received_at, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::inet, $13, $14, $15)`,
      [w.id, w.provider, w.eventId, w.eventType, w.signatureValid, w.withinTimeWindow, w.payloadHash, JSON.stringify(w.payload), w.reference, w.paymentId, w.outcome, w.sourceIp, w.correlationId, w.receivedAt, w.actorId],
    );
  }

  async insertRefund(tx: Transaction, r: Omit<RefundRecord, 'approvalRequestId' | 'providerReference' | 'externalReference' | 'attempts' | 'nextAttemptAt' | 'paidAt' | 'paidBy' | 'paidFromShiftId' | 'failureReason'>): Promise<void> {
    await tx.query(
      `INSERT INTO pay.refund (id, original_payment_id, amount_pesewas, destination, reason_code, note, credit_note_id, is_automatic, status, branch_id, created_by, updated_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12)`,
      [r.id, r.originalPaymentId, r.amountPesewas.toString(), r.destination, r.reasonCode, r.note, r.creditNoteId, r.isAutomatic, r.status, r.branchId, r.createdBy, r.createdAt],
    );
  }

  async refunds(tx: Transaction, ids: readonly string[], forUpdate = false): Promise<RefundRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<RefundRow>(`SELECT ${REFUND_COLUMNS} FROM pay.refund WHERE id = ANY($1::uuid[]) ORDER BY id${forUpdate ? ' FOR UPDATE' : ''}`, [ids]);
    return rows.map(toRefund);
  }

  async refundsOfPayment(tx: Transaction, paymentId: string): Promise<RefundRecord[]> {
    const { rows } = await tx.query<RefundRow>(`SELECT ${REFUND_COLUMNS} FROM pay.refund WHERE original_payment_id = $1 ORDER BY id`, [paymentId]);
    return rows.map(toRefund);
  }

  async listRefunds(tx: Transaction, f: RefundFilter, beforeId: string | null, limit: number): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM pay.refund WHERE branch_id = ANY($1::uuid[]) AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR created_by = $3)
          AND ($4::timestamptz IS NULL OR created_at >= $4) AND ($5::timestamptz IS NULL OR created_at < $5)
          AND ($6::uuid IS NULL OR id < $6) ORDER BY id DESC LIMIT $7`,
      [f.branchIds, f.status, f.createdBy, f.from, f.to, beforeId, limit],
    );
    return rows.map((r) => r.id);
  }

  async updateRefund(tx: Transaction, id: string, c: RefundChange, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE pay.refund
          SET status = COALESCE($2, status), approval_request_id = COALESCE($3, approval_request_id), provider_reference = COALESCE($4, provider_reference),
              provider_status = COALESCE($5, provider_status), external_reference = COALESCE($6, external_reference), attempts = COALESCE($7, attempts),
              next_attempt_at = CASE WHEN $8 THEN $9::timestamptz ELSE next_attempt_at END,
              paid_at = COALESCE($10, paid_at), paid_by = COALESCE($11, paid_by), posted_at = COALESCE($10, posted_at), posted_by = COALESCE($11, posted_by),
              failure_reason = COALESCE($12, failure_reason), paid_from_shift_id = COALESCE($14, paid_from_shift_id), updated_by = $13, version = version + 1
        WHERE id = $1`,
      [
        id,
        c.status ?? null,
        c.approvalRequestId ?? null,
        c.providerReference ?? null,
        c.providerStatus ?? null,
        c.externalReference ?? null,
        c.attempts ?? null,
        c.nextAttemptAt !== undefined,
        c.nextAttemptAt ?? null,
        c.paid?.at ?? null,
        c.paid?.by ?? null,
        c.failureReason ?? null,
        actorId,
        c.paid?.fromShiftId ?? null,
      ],
    );
  }

  async dueRefunds(tx: Transaction, now: Date, limit: number): Promise<RefundRecord[]> {
    const { rows } = await tx.query<RefundRow>(
      `SELECT ${REFUND_COLUMNS} FROM pay.refund
        WHERE status IN ('APPROVED', 'PROCESSING', 'FAILED') AND next_attempt_at IS NOT NULL AND next_attempt_at <= $1 ORDER BY next_attempt_at, id LIMIT $2`,
      [now, limit],
    );
    return rows.map(toRefund);
  }

  async raiseBreak(tx: Transaction, b: NewBreak): Promise<boolean> {
    const inserted = await tx.query(
      `INSERT INTO pay.reconciliation_break (id, branch_id, kind, payment_id, refund_id, provider, reference, amount_pesewas, details, raised_at, created_by, updated_by,
                                             source_document_id, settlement_line_id, bank_statement_line_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $13, $14) ON CONFLICT DO NOTHING`,
      [
        b.id, b.branchId, b.kind, b.paymentId, b.refundId, b.provider, b.reference, b.amountPesewas?.toString() ?? null, JSON.stringify(b.details), b.raisedAt, b.actorId,
        b.sourceDocumentId ?? null, b.settlementLineId ?? null, b.bankStatementLineId ?? null,
      ],
    );
    return inserted.rowCount === 1;
  }

  async resolveRefundBreaks(tx: Transaction, refundId: string, note: string, at: Date, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE pay.reconciliation_break SET status = 'RESOLVED', resolved_by = $4, resolved_at = $3, resolution_note = $2, updated_by = $4, version = version + 1
        WHERE refund_id = $1 AND status = 'OPEN'`,
      [refundId, note, at, actorId],
    );
  }

  async lastSweepEnd(tx: Transaction, provider: string): Promise<Date | null> {
    const { rows } = await tx.query<{ window_to: Date }>('SELECT window_to FROM pay.provider_sweep WHERE provider = $1 ORDER BY window_to DESC LIMIT 1', [provider]);
    return rows[0]?.window_to ?? null;
  }

  async insertSweep(tx: Transaction, s: { id: string; provider: string; from: Date; to: Date; transactions: number; cleared: number; breaksRaised: number; actorId: string }): Promise<void> {
    await tx.query(
      'INSERT INTO pay.provider_sweep (id, provider, window_from, window_to, transactions, cleared, breaks_raised, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [s.id, s.provider, s.from, s.to, s.transactions, s.cleared, s.breaksRaised, s.actorId],
    );
  }
}
