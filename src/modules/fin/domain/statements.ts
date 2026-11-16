import { PROFIT_AND_LOSS_TYPES } from './year-close';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'COST_OF_SALES' | 'EXPENSE';
export type CashFlowCategory = 'OPERATING' | 'INVESTING' | 'FINANCING';

/**
 * One account's lines summed exactly from the ledger (or a locked period's balances, ADR-0058): before the range
 * (opening) and within it, with the part of the in-range figures posted by year close entries, which the profit and
 * loss leaves out so a closed year still shows the profit it made.
 */
export interface StatementAccount {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly cashFlowCategory: CashFlowCategory | null;
  readonly openingDebit: bigint;
  readonly openingCredit: bigint;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly closingEntryDebit: bigint;
  readonly closingEntryCredit: bigint;
}

/** A statement row: an account, or a computed figure with no account. `amount` is signed as its section reads. */
export interface StatementLine {
  readonly accountId: string | null;
  readonly code: string | null;
  readonly label: string;
  readonly amount: bigint;
}

export interface StatementPart {
  readonly key: string;
  readonly label: string;
  readonly rows: readonly StatementLine[];
  readonly total: bigint;
}

export interface StatementCheck {
  readonly name: string;
  readonly passed: boolean;
}

export interface Statement {
  readonly sections: readonly StatementPart[];
  readonly checks: readonly StatementCheck[];
}

/** The cash and bank accounts (FR-FIN-013, A-149): tills, safe, drivers, bank, mobile money, provider clearing, cheques. */
export const CASH_ACCOUNTS = { from: '1000', to: '1130' } as const;

export function isCashAccount(code: string): boolean {
  return code >= CASH_ACCOUNTS.from && code <= CASH_ACCOUNTS.to;
}

const sumOf = (rows: readonly StatementLine[]): bigint => rows.reduce((sum, r) => sum + r.amount, 0n);
const nonZero = (rows: StatementLine[]): StatementLine[] => rows.filter((r) => r.amount !== 0n);
const row = (a: { readonly accountId: string; readonly code: string; readonly name: string }, amount: bigint): StatementLine => ({ accountId: a.accountId, code: a.code, label: a.name, amount });
const part = (key: string, label: string, rows: StatementLine[]): StatementPart => {
  const kept = nonZero(rows);
  return { key, label, rows: kept, total: sumOf(kept) };
};
const totalOnly = (key: string, label: string, total: bigint): StatementPart => ({ key, label, rows: [], total });

/** Debits less credits within the range, leaving out what year close entries posted. */
const tradedDebit = (a: StatementAccount): bigint => a.debit - a.closingEntryDebit - (a.credit - a.closingEntryCredit);
/** Debits less credits up to the end of the range, every entry included. */
const closingDebit = (a: StatementAccount): bigint => a.openingDebit + a.debit - a.openingCredit - a.credit;

/**
 * The profit and loss for a range (FR-FIN-012): income (net credits, a contra account such as 4210 a negative row), cost
 * of sales and expenses (net debits), gross and net profit, in exact pesewas. Year close entries are left out. Its
 * checks: net profit equals every income, cost and expense account's net credit summed directly, and the period's
 * debits equal its credits.
 */
export function profitAndLoss(accounts: readonly StatementAccount[]): Statement & { readonly netProfit: bigint } {
  const of = (type: AccountType) => accounts.filter((a) => a.type === type);
  const income = part('INCOME', 'Income', of('INCOME').map((a) => row(a, -tradedDebit(a))));
  const cost = part('COST_OF_SALES', 'Cost of sales', of('COST_OF_SALES').map((a) => row(a, tradedDebit(a))));
  const expenses = part('EXPENSES', 'Operating expenses', of('EXPENSE').map((a) => row(a, tradedDebit(a))));
  const gross = income.total - cost.total;
  const netProfit = gross - expenses.total;
  const direct = accounts.filter((a) => PROFIT_AND_LOSS_TYPES.has(a.type)).reduce((sum, a) => sum - tradedDebit(a), 0n);
  const debits = accounts.reduce((sum, a) => sum + a.debit, 0n);
  const credits = accounts.reduce((sum, a) => sum + a.credit, 0n);
  return {
    sections: [income, cost, totalOnly('GROSS_PROFIT', 'Gross profit', gross), expenses, totalOnly('NET_PROFIT', 'Net profit', netProfit)],
    checks: [
      { name: 'Income less costs equals net profit', passed: direct === netProfit },
      { name: 'Trial balance balanced for the period', passed: debits === credits },
    ],
    netProfit,
  };
}

/**
 * The balance sheet at the end of the range (FR-FIN-012): each asset (debit balance; accumulated depreciation a
 * negative row), liability and equity account (credit balance), with the earnings not yet closed to 3100 as one equity
 * row: every income, cost and expense account's balance to date. Assets equal liabilities plus equity exactly whenever
 * the ledger balances.
 */
export function balanceSheet(accounts: readonly StatementAccount[]): Statement {
  const of = (type: AccountType) => accounts.filter((a) => a.type === type);
  const assets = part('ASSETS', 'Assets', of('ASSET').map((a) => row(a, closingDebit(a))));
  const liabilities = part('LIABILITIES', 'Liabilities', of('LIABILITY').map((a) => row(a, -closingDebit(a))));
  const earnings = accounts.filter((a) => PROFIT_AND_LOSS_TYPES.has(a.type)).reduce((sum, a) => sum - closingDebit(a), 0n);
  const equity = part('EQUITY', 'Equity', [
    ...of('EQUITY').map((a) => row(a, -closingDebit(a))),
    { accountId: null, code: null, label: 'Earnings not yet closed to retained earnings', amount: earnings },
  ]);
  const claims = liabilities.total + equity.total;
  return {
    sections: [assets, liabilities, equity, totalOnly('LIABILITIES_AND_EQUITY', 'Liabilities and equity', claims)],
    checks: [{ name: 'Assets equal liabilities plus equity', passed: assets.total === claims }],
  };
}

/** One cash account's balance, debits less credits. */
export interface CashBalance {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly balance: bigint;
}

/**
 * What one account on the other side of the cash lines brought in within the range: its credits less its debits on the
 * entries that moved cash. Summed over all of them it is exactly the change in cash, since each entry balances.
 */
export interface CashFlowLine {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly category: CashFlowCategory | null;
  readonly inflow: bigint;
}

/**
 * The cash flow for a range (FR-FIN-013), direct method: the opening cash on accounts 1000 to 1130, each counterpart of
 * the cash lines in its account's category (operating when it has none), the net change and the closing cash. A move
 * between two cash accounts is no flow. Its check: opening plus net change equals closing.
 */
export function cashFlow(input: { readonly opening: readonly CashBalance[]; readonly flows: readonly CashFlowLine[]; readonly closing: readonly CashBalance[] }): Statement {
  const opening = part('OPENING_CASH', 'Opening cash', input.opening.map((b) => row(b, b.balance)));
  const category = (key: CashFlowCategory, label: string) =>
    part(key, label, input.flows.filter((f) => (f.category ?? 'OPERATING') === key).map((f) => row(f, f.inflow)));
  const operating = category('OPERATING', 'Operating activities');
  const investing = category('INVESTING', 'Investing activities');
  const financing = category('FINANCING', 'Financing activities');
  const net = operating.total + investing.total + financing.total;
  const closing = part('CLOSING_CASH', 'Closing cash', input.closing.map((b) => row(b, b.balance)));
  return {
    sections: [opening, operating, investing, financing, totalOnly('NET_CHANGE', 'Net change in cash', net), closing],
    checks: [{ name: 'Opening cash plus net change equals closing cash', passed: opening.total + net === closing.total }],
  };
}

/** The dashboard's cash position (FR-RPT-001, A-149), each signed: an overdrawn bank stays negative. */
export interface CashPositionFigures {
  readonly tills: bigint;
  readonly safe: bigint;
  readonly drivers: bigint;
  readonly bank: bigint;
  readonly mobileMoney: bigint;
  readonly total: bigint;
}

const POSITION_OF: Readonly<Record<string, keyof Omit<CashPositionFigures, 'total'>>> = { '1000': 'tills', '1010': 'safe', '1020': 'drivers', '1110': 'mobileMoney' };

/**
 * Buckets the balances of accounts 1000 to 1130: tills 1000, safe 1010, drivers 1020, mobile money 1110, and bank for
 * the rest (1100, provider clearing 1120 and cheques 1130, money on its way to the bank, and any cash account the
 * accountant adds), so the total is every cash account exactly.
 */
export function cashPosition(balances: readonly { readonly code: string; readonly balance: bigint }[]): CashPositionFigures {
  const figures = { tills: 0n, safe: 0n, drivers: 0n, bank: 0n, mobileMoney: 0n, total: 0n };
  for (const b of balances) {
    figures[POSITION_OF[b.code] ?? 'bank'] += b.balance;
    figures.total += b.balance;
  }
  return figures;
}
