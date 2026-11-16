/**
 * FIN's public door (MODULE_BOUNDARIES, FIN card). Higher modules import only from here. No module calls FIN to post:
 * FIN subscribes to every financial event (ADR-0003). B8 publishes `SubledgerSources`, where a higher module registers
 * the subledger it keeps for a control account (INV's stock value, ADR-0056), `LedgerReconciliation`, the nightly job,
 * and `FinancialStatements` (the trial balance). B08 continued adds `ChartOfAccounts` and `Periods`; B08 continued 1b `Journals`, `ManualJournals` and `PostingRules`; B08 continued 1b2 `BankAccounts`, whose `payoutAccountsIn` tells PUR whether a supplier payment may name an account; B08 continued 1c2 `FixedAssets` (the register and depreciation runs, ADR-0059), exported for the seed. `Ledger` and `LedgerPostings` are exported for the tests and the
 * worker; a module never posts through them.
 */
export { FinModule } from './fin.module';
export { Ledger, type PostedEntry, type PostingRequest } from './application/ledger';
export { LedgerPostings, STOCK_POSTING_EVENTS } from './application/postings';
export { LedgerReconciliation, SubledgerSources, type ReconciliationReport } from './application/reconciliation';
export { FinancialStatements } from './application/statements';
export { ChartOfAccounts } from './application/chart';
export { Periods } from './application/periods';
export { Journals } from './application/journals';
export { ManualJournals } from './application/manual-journals';
export { PostingRules } from './application/posting-rules';
export { BankAccounts, type PayoutAccountFacts } from './application/bank-accounts';
export { FixedAssets } from './application/fixed-assets';
export { judgePayoutAccount } from './domain/bank-account';
export { cashPosition, type CashPositionFigures } from './domain/statements';
export { LedgerCatalogueIncompleteError, LedgerPostingRefusedError } from './application/errors';
export type { SubledgerSource } from './application/ledger-store';
export type { TrialBalance } from './domain/trial-balance';
