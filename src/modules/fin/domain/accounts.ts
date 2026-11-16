import type { Side, SubledgerKind } from './posting';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'COST_OF_SALES' | 'EXPENSE';

/** The class each first digit of an account code gives (docs/data-model/fin.md, ADR-0003). */
const TYPE_OF_CLASS: Readonly<Record<string, AccountType>> = { '1': 'ASSET', '2': 'LIABILITY', '3': 'EQUITY', '4': 'INCOME', '5': 'COST_OF_SALES', '6': 'EXPENSE' };

const DEBIT_NORMAL: ReadonlySet<AccountType> = new Set(['ASSET', 'COST_OF_SALES', 'EXPENSE']);

/** One rule an account change breaks, at the request field it names. */
export interface AccountRule {
  readonly field: string;
  readonly rule: 'CLASS_MISMATCH' | 'SUBLEDGER_ON_HEADER' | 'PARENT_TYPE_MISMATCH' | 'BALANCE_NOT_ZERO' | 'IN_USE_BY_RULE';
}

export interface NewAccount {
  readonly code: string;
  readonly type: AccountType;
  readonly isPostable: boolean;
  readonly subledgerKind: SubledgerKind | null;
}

/**
 * The normal side of an account the accountant adds: debit for assets, cost of sales and expenses, credit for the
 * rest. A contra account (4200 to 4220, 1590, 3300, 5210) is seeded by migration with its own side (A-188).
 */
export function normalSideOf(type: AccountType): Side {
  return DEBIT_NORMAL.has(type) ? 'D' : 'C';
}

/**
 * Every rule a new account breaks (FR-FIN-002): its code is in its type's class, a header takes no subledger because
 * it takes no lines, and it rolls up only under a parent of its own type. An unknown parent is the caller's 422
 * `REFERENCE_NOT_FOUND`.
 */
export function checkNewAccount(account: NewAccount, parent: { readonly type: AccountType } | null): AccountRule[] {
  const rules: AccountRule[] = [];
  if (TYPE_OF_CLASS[account.code.charAt(0)] !== account.type) {
    rules.push({ field: '/code', rule: 'CLASS_MISMATCH' });
  }
  if (account.subledgerKind !== null && !account.isPostable) {
    rules.push({ field: '/subledgerKind', rule: 'SUBLEDGER_ON_HEADER' });
  }
  if (parent !== null && parent.type !== account.type) {
    rules.push({ field: '/parentId', rule: 'PARENT_TYPE_MISMATCH' });
  }
  return rules;
}

/** What closing an account must know about it now. */
export interface AccountUsage {
  /** Debits less credits over the whole ledger. */
  readonly balancePesewas: bigint;
  /** A posting rule or account determination in force today names it. */
  readonly namedInForce: boolean;
}

/**
 * Every rule closing an account breaks (FR-FIN-002, A-188): a closed account takes no new lines, so it is closed only
 * at a nil balance and once no rule or determination in force would post to it.
 */
export function checkAccountClosing(usage: AccountUsage): AccountRule[] {
  const rules: AccountRule[] = [];
  if (usage.balancePesewas !== 0n) {
    rules.push({ field: '/status', rule: 'BALANCE_NOT_ZERO' });
  }
  if (usage.namedInForce) {
    rules.push({ field: '/status', rule: 'IN_USE_BY_RULE' });
  }
  return rules;
}
