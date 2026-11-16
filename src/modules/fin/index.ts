/**
 * FIN's public door (MODULE_BOUNDARIES, FIN card). Higher modules import only from here. No module calls FIN to post:
 * FIN subscribes to every financial event (ADR-0003). B8 publishes `SubledgerSources`, where a higher module registers
 * the subledger it keeps for a control account (INV's stock value, ADR-0056), `LedgerReconciliation`, the nightly job,
 * and `FinancialStatements` (the trial balance). B08 continued adds `ChartOfAccounts` and `Periods`. `Ledger` and `LedgerPostings` are exported for the tests and the
 * worker; a module never posts through them.
 */
export { FinModule } from './fin.module';
export { Ledger, type PostedEntry, type PostingRequest } from './application/ledger';
export { LedgerPostings, STOCK_POSTING_EVENTS } from './application/postings';
export { LedgerReconciliation, SubledgerSources, type ReconciliationReport } from './application/reconciliation';
export { FinancialStatements } from './application/statements';
export { ChartOfAccounts } from './application/chart';
export { Periods } from './application/periods';
export { LedgerCatalogueIncompleteError, LedgerPostingRefusedError } from './application/errors';
export type { SubledgerSource } from './application/ledger-store';
export type { TrialBalance } from './domain/trial-balance';
