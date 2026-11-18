import type { Transaction } from '../../../platform/database/unit-of-work';
import type { Side, StatementLineKind } from '../domain/statement';

export const STATEMENT_STORE = Symbol('STATEMENT_STORE');

export type StatementStatus = 'DRAFT' | 'ISSUED';

/** A `whl.statement` row with its figures (B08 continued 2d). */
export interface StatementRecord {
  readonly id: string;
  readonly statementNo: string | null;
  readonly status: StatementStatus;
  readonly customerId: string;
  readonly branchId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly openingPesewas: bigint;
  readonly openingCreditPesewas: bigint;
  readonly invoicedPesewas: bigint;
  readonly creditedPesewas: bigint;
  readonly paidPesewas: bigint;
  readonly otherChargesPesewas: bigint;
  readonly otherCreditsPesewas: bigint;
  readonly closingPesewas: bigint;
  readonly closingCreditPesewas: bigint;
  readonly issueDate: string | null;
  readonly archivedDocumentId: string | null;
  /** The ageing summary as at the period end (FR-WHL-009, B10 continued 2); null on a statement written before 0263. */
  readonly ageing: StatementAgeingRecord | null;
}

/** A statement's ageing summary as stored (migration 0263): the buckets and what 1200 holds beyond the open items. */
export interface StatementAgeingRecord {
  readonly asOf: string;
  readonly currentPesewas: bigint;
  readonly days1To30Pesewas: bigint;
  readonly days31To60Pesewas: bigint;
  readonly days61To90Pesewas: bigint;
  readonly daysOver90Pesewas: bigint;
  readonly notAgedPesewas: bigint;
  readonly notAgedCreditPesewas: bigint;
}

/** A `whl.statement_line` row. */
export interface StatementLineRecord {
  readonly lineNo: number;
  readonly date: string;
  readonly kind: StatementLineKind;
  readonly reference: string;
  readonly debitPesewas: bigint;
  readonly creditPesewas: bigint;
  readonly balancePesewas: bigint;
  readonly balanceSide: Side;
  readonly sourceDocumentId: string | null;
}

export interface StatementFilter {
  readonly customerId: string | null;
  readonly periodEnd: string | null;
  readonly branchIds: readonly string[];
}

/** WHL's statements in PostgreSQL. The guard and the deferred check of migration 0242 decide too. */
export interface StatementStore {
  insert(tx: Transaction, statement: StatementRecord, lines: readonly StatementLineRecord[], actorId: string, at: Date): Promise<void>;
  statement(tx: Transaction, id: string): Promise<StatementRecord | null>;
  /** The issued statement of the customer, branch and period, if one exists (uq_statement_issued_period). */
  issuedFor(tx: Transaction, key: { readonly customerId: string; readonly branchId: string; readonly periodStart: string; readonly periodEnd: string }): Promise<StatementRecord | null>;
  /** Newest first, before the given id, at the given branches only. */
  list(tx: Transaction, filter: StatementFilter, beforeId: string | null, limit: number): Promise<StatementRecord[]>;
  lines(tx: Transaction, statementId: string): Promise<StatementLineRecord[]>;
  /** Names the archived rendering of an issued statement, once; a statement already linked is left as it is. */
  linkArchive(tx: Transaction, statementId: string, archivedDocumentId: string, actorId: string, at: Date): Promise<void>;
}
