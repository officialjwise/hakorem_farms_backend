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
