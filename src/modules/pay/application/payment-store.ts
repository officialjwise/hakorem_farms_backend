import type { Transaction } from '../../../platform/database/unit-of-work';
import type { MethodKind } from '../domain/tender';

export const PAYMENT_STORE = Symbol('PAYMENT_STORE');

export interface PaymentRecord {
  readonly id: string;
  readonly paymentMethodId: string;
  readonly methodKind: MethodKind;
  readonly amountPesewas: bigint;
  readonly allocatedPesewas: bigint;
  readonly refundedPesewas: bigint;
  readonly customerId: string | null;
  readonly orderDocumentId: string | null;
  readonly registerRef: string | null;
  readonly registerCode: string | null;
  readonly verification: 'NOT_REQUIRED' | 'PROVIDER_CALLBACK' | 'PROVIDER_LOOKUP' | 'UNVERIFIED';
  readonly status: 'PENDING' | 'CLEARED' | 'FAILED' | 'REVERSED';
  readonly receivedAt: Date;
  readonly clearedAt: Date | null;
  readonly branchId: string;
}

export interface AllocationRecord {
  readonly id: string;
  readonly paymentId: string;
  readonly billingDocumentId: string;
  readonly amountPesewas: bigint;
  readonly direction: 'APPLY' | 'UNAPPLY';
}

export interface NewPayment {
  readonly id: string;
  readonly paymentMethodId: string;
  readonly methodKind: MethodKind;
  readonly amountPesewas: bigint;
  readonly customerId: string | null;
  readonly orderDocumentId: string | null;
  readonly shiftDocumentId: string | null;
  readonly register: { readonly id: string; readonly code: string } | null;
  readonly verification: PaymentRecord['verification'];
  readonly status: 'PENDING' | 'CLEARED';
  readonly receivedAt: Date;
  readonly clearedAt: Date | null;
  readonly branchId: string;
  readonly actorId: string;
}

/** PAY's own tables (schema `pay`). Allocation rows are inserted only; the trigger keeps the payment's allocated amount. */
export interface PaymentStore {
  insert(tx: Transaction, payment: NewPayment): Promise<void>;
  allocate(tx: Transaction, allocation: AllocationRecord & { readonly actorId: string }): Promise<void>;
  payments(tx: Transaction, ids: readonly string[]): Promise<PaymentRecord[]>;
  paymentsOfOrder(tx: Transaction, orderDocumentId: string): Promise<PaymentRecord[]>;
  allocationsOf(tx: Transaction, paymentIds: readonly string[]): Promise<AllocationRecord[]>;
}
