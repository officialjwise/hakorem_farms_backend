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
  /** Added in B08 continued 1c (ADR-0058): a locked or closed period whose period balances differ from its lines. */
  readonly periodBalanceDrift?: readonly {
    readonly periodId: string;
    readonly accountCode: string;
    readonly branchId: string;
    readonly projectedDebitPesewas: number;
    readonly projectedCreditPesewas: number;
    readonly lineDebitPesewas: number;
    readonly lineCreditPesewas: number;
  }[];
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

/**
 * `fin.YearClosed` v1 ◆ (FR-FIN-010, ADR-0003, ADR-0058): the last period of a fiscal year was closed. One event per
 * branch with anything to close: each income, cost, expense and distributions balance on the last day of the year, by
 * the key that says what it closes and to where, and the profit or loss moved from 3200 to 3100. The ledger posts it as
 * the branch's one CLOSING entry, dated the last day of the year, in the transaction that closes the period.
 */
export interface YearClosed {
  readonly yearCloseId: string;
  readonly fiscalYear: number;
  readonly periodId: string;
  readonly postingDate: string;
  readonly amounts: readonly {
    readonly key: string;
    /** The account whose balance this amount closes; null for the profit or loss moved from 3200 to 3100. */
    readonly accountId: string | null;
    readonly subledger: { readonly kind: string; readonly refId: string; readonly displayName: string } | null;
    readonly amountPesewas: number;
  }[];
}

/**
 * `fin.DepreciationRun` v1 ◆ (FR-FIN-015, ADR-0003, ADR-0059): a depreciation run was posted by someone other than the
 * person who calculated it. One event per branch with assets on the run: each asset's exact charge for the months it
 * covers. The ledger posts it as the branch's entry, Dr 6500 and Cr 1590 per asset, dated the period's last day.
 */
export interface DepreciationRunPosted {
  readonly depreciationRunId: string;
  readonly periodId: string;
  readonly postingDate: string;
  readonly lines: readonly {
    readonly fixedAssetId: string;
    readonly assetNo: string;
    readonly category: 'VEHICLE' | 'COLD_ROOM' | 'HOUSING' | 'EQUIPMENT';
    readonly months: number;
    readonly amountPesewas: number;
  }[];
}

/**
 * `fin.FixedAssetDisposed` v1 ◆ (FR-FIN-014, ADR-0059): a fixed asset was sold or scrapped. The ledger posts its cost
 * and accumulated depreciation out, the proceeds into the farm's own account of the kind they came in by, and the exact
 * gain or loss to 4920, on the disposal date.
 */
export interface FixedAssetDisposed {
  readonly fixedAssetId: string;
  readonly disposalId: string;
  readonly assetNo: string;
  readonly category: 'VEHICLE' | 'COLD_ROOM' | 'HOUSING' | 'EQUIPMENT';
  readonly disposedOn: string;
  readonly costPesewas: number;
  readonly accumulatedPesewas: number;
  readonly proceedsPesewas: number;
  readonly gainPesewas: number;
  readonly lossPesewas: number;
  readonly proceedsMethod: 'CASH' | 'BANK' | 'MOBILE_MONEY';
  readonly bankAccountId: string | null;
  /** The threat model's abuse cases this event lets B12's daily exception report detect (30: a disposal at a loss). */
  readonly abuseCases: readonly number[];
}
