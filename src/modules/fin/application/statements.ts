import type { Transaction } from '../../../platform/database/unit-of-work';
import { trialBalance, type TrialBalance } from '../domain/trial-balance';
import type { LedgerStore } from './ledger-store';

/**
 * Financial statements from the ledger (FR-FIN-011). The trial balance for any date range: every account's lines summed
 * exactly from `fin.journal_line` before the range (opening) and within it, totals over all accounts. The profit and
 * loss, balance sheet and cash flow, and the endpoints, follow in B08 continued.
 */
export class FinancialStatements {
  constructor(private readonly store: LedgerStore) {}

  async trialBalanceIn(tx: Transaction, from: string, to: string): Promise<TrialBalance> {
    return trialBalance(await this.store.accountActivity(tx, from, to));
  }
}
