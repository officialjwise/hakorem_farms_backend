import type { Determination, DeterminantType } from './posting';

/** One account's lines summed exactly from the journal: before the range (opening) and within it. */
export interface AccountActivity {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly openingDebit: bigint;
  readonly openingCredit: bigint;
  readonly debit: bigint;
  readonly credit: bigint;
}

export interface TrialBalanceLine extends AccountActivity {
  /** The closing balance on the side it falls: one of the two is zero. */
  readonly closingDebit: bigint;
  readonly closingCredit: bigint;
}

export interface TrialBalanceTotals {
  readonly openingDebit: bigint;
  readonly openingCredit: bigint;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly closingDebit: bigint;
  readonly closingCredit: bigint;
}

export interface TrialBalance {
  readonly lines: readonly TrialBalanceLine[];
  readonly totals: TrialBalanceTotals;
  /** Every debit less every credit up to the end of the range, in pesewas: exactly zero for a sound ledger. */
  readonly signedSum: bigint;
  readonly balanced: boolean;
}

/** FR-FIN-011: each account's opening, debits, credits and closing, and totals over all of them, in exact pesewas. */
export function trialBalance(activity: readonly AccountActivity[]): TrialBalance {
  const totals = { openingDebit: 0n, openingCredit: 0n, debit: 0n, credit: 0n, closingDebit: 0n, closingCredit: 0n };
  const lines = activity.map((a): TrialBalanceLine => {
    const net = a.openingDebit + a.debit - a.openingCredit - a.credit;
    const line = { ...a, closingDebit: net > 0n ? net : 0n, closingCredit: net < 0n ? -net : 0n };
    totals.openingDebit += a.openingDebit;
    totals.openingCredit += a.openingCredit;
    totals.debit += a.debit;
    totals.credit += a.credit;
    totals.closingDebit += line.closingDebit;
    totals.closingCredit += line.closingCredit;
    return line;
  });
  const signedSum = totals.openingDebit + totals.debit - totals.openingCredit - totals.credit;
  return { lines, totals, signedSum, balanced: signedSum === 0n && totals.debit === totals.credit && totals.closingDebit === totals.closingCredit };
}

/** A subledger's value for one determinant key, for example the cost pools of one GL group. */
export interface SubledgerValue {
  readonly key: string;
  readonly pesewas: bigint;
}

/**
 * Sums a subledger by the control account each key maps to in force today, with no `*` fallback: a key no
 * determination names is returned as unmapped, itself a break to report.
 */
export function subledgerByAccount(
  values: readonly SubledgerValue[],
  determinations: readonly Determination[],
  type: DeterminantType,
  role: string,
): { readonly byAccount: Map<string, bigint>; readonly unmapped: SubledgerValue[] } {
  const byAccount = new Map<string, bigint>();
  const unmapped: SubledgerValue[] = [];
  for (const value of values) {
    const target = determinations.find((d) => d.type === type && d.role === role && d.key === value.key);
    if (target === undefined) {
      unmapped.push(value);
      continue;
    }
    byAccount.set(target.accountId, (byAccount.get(target.accountId) ?? 0n) + value.pesewas);
  }
  return { byAccount, unmapped };
}

export interface ControlAccountBreak {
  readonly accountId: string;
  readonly ledgerPesewas: bigint;
  readonly subledgerPesewas: bigint;
  readonly differencePesewas: bigint;
}

/** Every control account whose ledger balance (debits less credits) differs from its subledger, ledger accounts first. */
export function controlAccountBreaks(ledger: ReadonlyMap<string, bigint>, subledger: ReadonlyMap<string, bigint>): ControlAccountBreak[] {
  const breaks: ControlAccountBreak[] = [];
  for (const accountId of new Set([...ledger.keys(), ...subledger.keys()])) {
    const ledgerPesewas = ledger.get(accountId) ?? 0n;
    const subledgerPesewas = subledger.get(accountId) ?? 0n;
    if (ledgerPesewas !== subledgerPesewas) {
      breaks.push({ accountId, ledgerPesewas, subledgerPesewas, differencePesewas: ledgerPesewas - subledgerPesewas });
    }
  }
  return breaks;
}
