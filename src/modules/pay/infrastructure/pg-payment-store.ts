import type { Transaction } from '../../../platform/database/unit-of-work';
import type { AllocationRecord, NewPayment, PaymentRecord, PaymentStore } from '../application/payment-store';

interface PaymentRow {
  id: string;
  payment_method_id: string;
  method_kind: PaymentRecord['methodKind'];
  amount_pesewas: string;
  allocated_pesewas: string;
  refunded_pesewas: string;
  customer_id: string | null;
  order_document_id: string | null;
  register_ref: string | null;
  register_code: string | null;
  verification: PaymentRecord['verification'];
  status: PaymentRecord['status'];
  received_at: Date;
  cleared_at: Date | null;
  branch_id: string;
}

const PAYMENT_COLUMNS = `id, payment_method_id, method_kind, amount_pesewas::text, allocated_pesewas::text, refunded_pesewas::text, customer_id,
  order_document_id, register_ref, register_code, verification, status, received_at, cleared_at, branch_id`;

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
    registerRef: row.register_ref,
    registerCode: row.register_code,
    verification: row.verification,
    status: row.status,
    receivedAt: row.received_at,
    clearedAt: row.cleared_at,
    branchId: row.branch_id,
  };
}

/** PAY's tables in PostgreSQL. Point reads by key only: the posting transaction runs at serializable (ADR-0005). */
export class PgPaymentStore implements PaymentStore {
  async insert(tx: Transaction, p: NewPayment): Promise<void> {
    await tx.query(
      `INSERT INTO pay.payment (id, payment_method_id, method_kind, amount_pesewas, customer_id, order_document_id, shift_document_id, register_ref, register_code,
                                verification, received_at, cleared_at, status, branch_id, created_by, updated_by, posted_at, posted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15, $12, CASE WHEN $12::timestamptz IS NULL THEN NULL ELSE $15::uuid END)`,
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
      ],
    );
  }

  async allocate(tx: Transaction, a: AllocationRecord & { readonly actorId: string }): Promise<void> {
    await tx.query(
      'INSERT INTO pay.payment_allocation (id, payment_id, billing_document_id, amount_pesewas, direction, actor_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [a.id, a.paymentId, a.billingDocumentId, a.amountPesewas.toString(), a.direction, a.actorId],
    );
  }

  async payments(tx: Transaction, ids: readonly string[]): Promise<PaymentRecord[]> {
    const { rows } = await tx.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM pay.payment WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids]);
    return rows.map(toRecord);
  }

  async paymentsOfOrder(tx: Transaction, orderDocumentId: string): Promise<PaymentRecord[]> {
    const { rows } = await tx.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM pay.payment WHERE order_document_id = $1 ORDER BY id`, [orderDocumentId]);
    return rows.map(toRecord);
  }

  async allocationsOf(tx: Transaction, paymentIds: readonly string[]): Promise<AllocationRecord[]> {
    if (paymentIds.length === 0) return [];
    const { rows } = await tx.query<{ id: string; payment_id: string; billing_document_id: string; amount_pesewas: string; direction: 'APPLY' | 'UNAPPLY' }>(
      'SELECT id, payment_id, billing_document_id, amount_pesewas::text, direction FROM pay.payment_allocation WHERE payment_id = ANY($1::uuid[]) ORDER BY id',
      [paymentIds],
    );
    return rows.map((r) => ({ id: r.id, paymentId: r.payment_id, billingDocumentId: r.billing_document_id, amountPesewas: BigInt(r.amount_pesewas), direction: r.direction }));
  }
}
