/*
 * CST's published events (docs/DOMAIN_MODEL.md section 5). Types only: subscribers import them with `import type`.
 * None posts to the ledger: a posted allocation's journals post from inventory's ◆ inv.OverheadAbsorbed.
 */

/**
 * `cst.ProjectionDriftDetected` v1 (FR-CST-004, ADR-0023, ADR-0102): the nightly comparison found the margin
 * projection's net revenue or cost of sales different from the ledger's for the same dates. Nothing was corrected; the
 * figures are signed decimal strings of pesewas. The daily exception report (B12 continued 3) and the runbook read it.
 */
export interface ProjectionDriftDetected {
  readonly projection: 'cst.margin_fact';
  readonly from: string;
  readonly to: string;
  readonly revenueProjectedPesewas: string;
  readonly revenueLedgerPesewas: string;
  readonly costOfSalesProjectedPesewas: string;
  readonly costOfSalesLedgerPesewas: string;
}
