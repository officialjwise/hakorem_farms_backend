import type { Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { Cursors } from '../../../platform/http/cursor';
import type { Authoriser } from '../../iam';
import { jsonPesewas } from '../domain/balance';
import { balanceSheet, CASH_ACCOUNTS, cashFlow, isCashAccount, profitAndLoss, type Statement, type StatementAccount } from '../domain/statements';
import { trialBalance, type TrialBalance } from '../domain/trial-balance';
import type { LedgerStore } from './ledger-store';
import type { Page } from './periods';
import type { StatementRange, StatementStore } from './statement-store';

export const REPORT_PERMISSION = 'fin.report.read';

interface AccountRefView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** The contract's `TrialBalanceRow`. */
export interface TrialBalanceRowView {
  readonly account: AccountRefView;
  readonly type: string;
  readonly openingDebitPesewas: number;
  readonly openingCreditPesewas: number;
  readonly periodDebitPesewas: number;
  readonly periodCreditPesewas: number;
  readonly closingDebitPesewas: number;
  readonly closingCreditPesewas: number;
}

/** The contract's `TrialBalance`: a page of rows, with totals over the whole filter. */
export interface TrialBalanceView extends Page<TrialBalanceRowView> {
  readonly from: string;
  readonly to: string;
  readonly branchId: string | null;
  readonly totalDebitPesewas: number;
  readonly totalCreditPesewas: number;
  readonly balanced: boolean;
  readonly currency: 'GHS';
  readonly asOf: string;
}

/** The contract's `FinancialStatement`: amounts are never negative, `isNegative` carries the sign. */
export interface FinancialStatementView {
  readonly statement: 'PROFIT_AND_LOSS' | 'BALANCE_SHEET' | 'CASH_FLOW';
  readonly from: string | null;
  readonly to: string | null;
  readonly asOfDate: string | null;
  readonly branchId: string | null;
  readonly sections: readonly {
    readonly key: string;
    readonly label: string;
    readonly rows: readonly { readonly account: AccountRefView | null; readonly label: string; readonly amountPesewas: number; readonly isNegative: boolean }[];
    readonly totalPesewas: number;
    readonly totalIsNegative: boolean;
  }[];
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly currency: 'GHS';
  readonly generatedAt: string;
}

export interface RangeQuery {
  readonly from: string;
  readonly to: string;
  readonly branchId?: string | undefined;
}

export interface TrialBalanceQuery extends RangeQuery {
  readonly includeZero?: boolean | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

const abs = (n: bigint): bigint => (n < 0n ? -n : n);
const isZeroRow = (r: TrialBalance['lines'][number]): boolean => r.openingDebit === 0n && r.openingCredit === 0n && r.debit === 0n && r.credit === 0n;

/** The day before a business date, for a balance sheet's range: everything up to and including `asOf`. */
function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * The financial statements from the ledger (FR-FIN-011 to FR-FIN-013, ADR-0058): the trial balance, profit and loss,
 * balance sheet and cash flow for any range, over one branch or all of them, each an exact sum of journal lines (a
 * LOCKED or CLOSED period's lines read from its period balances). Every read authorises `fin.report.read` in the
 * handler (ADR-0035), for the branch asked for or anywhere; totals are over the whole filter, never a page.
 */
export class FinancialStatements {
  constructor(
    private readonly ledgerStore: LedgerStore,
    private readonly store: StatementStore,
    private readonly uow: UnitOfWork,
    private readonly authoriser: Authoriser,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {}

  /** The B8 trial balance straight from the journal lines, for the nightly checks and the tests. */
  async trialBalanceIn(tx: Transaction, from: string, to: string): Promise<TrialBalance> {
    return trialBalance(await this.ledgerStore.accountActivity(tx, from, to));
  }

  /**
   * The net profit of a range over every branch, in the caller's transaction (B12, FR-CAP-006: a distribution run reads
   * it through FIN's door): income less cost of sales less expenses, signed, the profit and loss statement's own
   * figure, year-end closing entries left out. The caller authorises.
   */
  async netProfitIn(tx: Transaction, from: string, to: string): Promise<bigint> {
    return profitAndLoss(await this.store.accounts(tx, { from, to, branchId: null })).netProfit;
  }

  /**
   * Total equity at the end of a day over every branch, in the caller's transaction (B12 continued, FR-CAP-014: an
   * investor's closing value for the IRR is their share of it): the balance sheet's equity section, earnings not yet
   * closed included, signed. The caller authorises.
   */
  async equityIn(tx: Transaction, asOf: string): Promise<bigint> {
    const sheet = balanceSheet(await this.store.accounts(tx, { from: dayBefore(asOf), to: asOf, branchId: null }));
    return sheet.sections.find((section) => section.key === 'EQUITY')!.total;
  }

  /**
   * Each account's traded net debit over a range, in the caller's transaction (B12 continued 2, FR-CST-004, FR-CST-005:
   * costing ties its margins to the ledger and reads the period's operating expenses through FIN's door): debits less
   * credits within the range, year-end closing entries left out, signed, by account code, over one branch or all of
   * them. The caller authorises.
   */
  async tradedNetDebitsIn(tx: Transaction, range: { readonly from: string; readonly to: string; readonly branchId: string | null }): Promise<ReadonlyMap<string, { readonly type: string; readonly cashFlowCategory: string | null; readonly netDebit: bigint }>> {
    const accounts = await this.store.accounts(tx, range);
    return new Map(accounts.map((a) => [a.code, { type: a.type, cashFlowCategory: a.cashFlowCategory, netDebit: a.debit - a.closingEntryDebit - (a.credit - a.closingEntryCredit) }] as const));
  }

  trialBalance(actor: Actor | undefined, query: TrialBalanceQuery): Promise<TrialBalanceView> {
    return this.read(actor, query.branchId, async (tx, branchId) => {
      const accounts = await this.store.accounts(tx, { from: query.from, to: query.to, branchId });
      const tb = trialBalance(accounts);
      const types = new Map(accounts.map((a) => [a.code, a.type] as const));
      const filters = { from: query.from, to: query.to, branchId, includeZero: query.includeZero ?? false };
      const binding = { operationId: 'getTrialBalance', principalId: actor!.principalId, filters };
      const after = query.cursor === undefined ? null : ((this.cursors.decode(query.cursor, binding)['code'] as string | undefined) ?? null);
      const listed = tb.lines.filter((l) => (filters.includeZero || !isZeroRow(l)) && (after === null || l.code > after));
      const rows = listed.slice(0, query.limit);
      const hasMore = listed.length > query.limit;
      return {
        data: rows.map((l) => ({
          account: { id: l.accountId, code: l.code, name: l.name },
          type: types.get(l.code)!,
          openingDebitPesewas: jsonPesewas(l.openingDebit),
          openingCreditPesewas: jsonPesewas(l.openingCredit),
          periodDebitPesewas: jsonPesewas(l.debit),
          periodCreditPesewas: jsonPesewas(l.credit),
          closingDebitPesewas: jsonPesewas(l.closingDebit),
          closingCreditPesewas: jsonPesewas(l.closingCredit),
        })),
        page: { nextCursor: hasMore ? this.cursors.encode(binding, { code: rows.at(-1)!.code }) : null, limit: query.limit, hasMore },
        from: query.from,
        to: query.to,
        branchId,
        totalDebitPesewas: jsonPesewas(tb.totals.debit),
        totalCreditPesewas: jsonPesewas(tb.totals.credit),
        balanced: tb.balanced,
        currency: 'GHS',
        asOf: this.clock.now().toISOString(),
      };
    });
  }

  profitAndLoss(actor: Actor | undefined, query: RangeQuery): Promise<FinancialStatementView> {
    return this.read(actor, query.branchId, async (tx, branchId) => {
      const accounts = await this.store.accounts(tx, { from: query.from, to: query.to, branchId });
      return this.view('PROFIT_AND_LOSS', profitAndLoss(accounts), accounts, { from: query.from, to: query.to, asOfDate: null, branchId });
    });
  }

  balanceSheet(actor: Actor | undefined, query: { readonly asOf: string; readonly branchId?: string | undefined }): Promise<FinancialStatementView> {
    return this.read(actor, query.branchId, async (tx, branchId) => {
      const accounts = await this.store.accounts(tx, { from: dayBefore(query.asOf), to: query.asOf, branchId });
      return this.view('BALANCE_SHEET', balanceSheet(accounts), accounts, { from: null, to: null, asOfDate: query.asOf, branchId });
    });
  }

  cashFlow(actor: Actor | undefined, query: RangeQuery): Promise<FinancialStatementView> {
    return this.read(actor, query.branchId, async (tx, branchId) => {
      const range: StatementRange = { from: query.from, to: query.to, branchId };
      const accounts = await this.store.accounts(tx, range);
      const cash = accounts.filter((a) => isCashAccount(a.code));
      const statement = cashFlow({
        opening: cash.map((a) => ({ accountId: a.accountId, code: a.code, name: a.name, balance: a.openingDebit - a.openingCredit })),
        closing: cash.map((a) => ({ accountId: a.accountId, code: a.code, name: a.name, balance: a.openingDebit + a.debit - a.openingCredit - a.credit })),
        flows: await this.store.cashFlowLines(tx, range, CASH_ACCOUNTS),
      });
      return this.view('CASH_FLOW', statement, accounts, { from: query.from, to: query.to, asOfDate: null, branchId });
    });
  }

  private read<V>(actor: Actor | undefined, branchId: string | undefined, work: (tx: Transaction, branchId: string | null) => Promise<V>): Promise<V> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, REPORT_PERMISSION, branchId === undefined ? {} : { branchId });
      return work(tx, branchId ?? null);
    });
  }

  private view(
    kind: FinancialStatementView['statement'],
    statement: Statement,
    accounts: readonly StatementAccount[],
    range: Pick<FinancialStatementView, 'from' | 'to' | 'asOfDate' | 'branchId'>,
  ): FinancialStatementView {
    const byId = new Map(accounts.map((a) => [a.accountId, a] as const));
    return {
      statement: kind,
      ...range,
      sections: statement.sections.map((s) => ({
        key: s.key,
        label: s.label,
        rows: s.rows.map((r) => {
          const account = r.accountId === null ? undefined : byId.get(r.accountId);
          return {
            account: account === undefined ? null : { id: account.accountId, code: account.code, name: account.name },
            label: r.label,
            amountPesewas: jsonPesewas(abs(r.amount)),
            isNegative: r.amount < 0n,
          };
        }),
        totalPesewas: jsonPesewas(abs(s.total)),
        totalIsNegative: s.total < 0n,
      })),
      checks: statement.checks,
      currency: 'GHS',
      generatedAt: this.clock.now().toISOString(),
    };
  }
}

