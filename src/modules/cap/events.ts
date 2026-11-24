/**
 * CAP's published events (MODULE_BOUNDARIES, CAP card; ADR-0003 rows in migration 0354). Types only: another module
 * imports this file with `import type`. Each ◆ event posts to the ledger in the publisher's transaction; payloads carry
 * the investor's name for the subledger and named amounts, never a payout detail.
 */

/** ◆ `cap.CapitalContributed` v1 and `cap.CapitalWithdrawn` v1: capital in or out of the farm's own account. */
export interface CapitalMoved {
  readonly transactionId: string;
  readonly transactionNo: string;
  readonly investorId: string;
  readonly investorName: string;
  readonly kind: 'CONTRIBUTION' | 'WITHDRAWAL';
  readonly bankAccountId: string;
  readonly branchId: string;
  readonly amountPesewas: number;
  readonly units: string;
  readonly valueDate: string;
  /** The value date, or the ledger's first day when the value date is before the books begin (A-380). */
  readonly postingDate: string;
  /** For a withdrawal: who asked and who approved. */
  readonly requestedBy: string | null;
  readonly approvedBy: string | null;
}

/** ◆ `cap.DistributionDeclared` v1: an approved run posted to the ledger. */
export interface DistributionDeclared {
  readonly runId: string;
  readonly runNo: string;
  readonly branchId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly distributablePesewas: number;
  readonly draftedBy: string;
  readonly approvedBy: string;
  readonly lines: readonly {
    readonly lineId: string;
    readonly investorId: string;
    readonly investorName: string;
    readonly unitDays: string;
    readonly allocatedPesewas: number;
    readonly withheldPesewas: number;
    readonly netPayablePesewas: number;
  }[];
}

/** ◆ `cap.DistributionPaid` v1: money paid to an investor against a line of a posted run. */
export interface DistributionPaid {
  readonly paymentId: string;
  readonly runId: string;
  readonly runNo: string;
  readonly lineId: string;
  readonly investorId: string;
  readonly investorName: string;
  readonly bankAccountId: string;
  readonly branchId: string;
  readonly amountPesewas: number;
  readonly externalReference: string | null;
}

