/**
 * Events FIN publishes (docs/DOMAIN_MODEL.md section 5). Types only: subscribers import them with `import type`.
 */

/**
 * `fin.TrialBalanceDriftDetected` v1 (FR-FIN-016): the nightly reconciliation found the ledger unbalanced overall or in
 * an entry, a control account apart from its subledger, or a number series with a gap. Nothing was corrected; the
 * daily exception report (B12) lists it as `RECONCILIATION_BREAK`.
 */
export interface TrialBalanceDriftDetected {
  readonly signedSumPesewas: number;
  readonly unbalancedEntries: readonly { readonly entryId: string; readonly entryNo: string; readonly lineCount: number; readonly debitPesewas: number; readonly creditPesewas: number }[];
  readonly controlBreaks: readonly { readonly source: string; readonly accountCode: string; readonly ledgerPesewas: number; readonly subledgerPesewas: number; readonly differencePesewas: number }[];
  readonly unmapped: readonly { readonly source: string; readonly key: string; readonly pesewas: number }[];
  readonly seriesGaps: readonly { readonly seriesId: string; readonly docType: string; readonly fiscalYear: number; readonly issued: number; readonly allocations: number; readonly maxValue: number }[];
}

/**
 * `fin.ManualJournalApproved` v1 ◆ (FR-FIN-008, ADR-0003 "As entered", A-190): a different person approved a manual
 * journal. The ledger posts it in the approval's transaction, each line to the account entered for it, on its own date.
 */
export interface ManualJournalApproved {
  readonly manualJournalId: string;
  readonly kind: 'MANUAL' | 'OPENING';
  readonly postingDate: string;
  readonly description: string;
  readonly approvalRequestId: string;
  readonly requestedBy: string;
  readonly lines: readonly {
    readonly lineNo: number;
    readonly accountId: string;
    readonly side: 'D' | 'C';
    readonly amountPesewas: number;
    readonly subledgerPartyId: string | null;
    readonly memo: string | null;
  }[];
}
