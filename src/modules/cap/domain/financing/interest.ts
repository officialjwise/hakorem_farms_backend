import { halfUpDivide, type Rate } from '@hakorem/kernel';
import { daysIncluding, monthsFrom, type Month } from './calendar';
import { equalMonthlyParts } from './parts';

/**
 * A loan's interest and repayments (FR-CAP-015, ADR-0101): simple interest on the principal outstanding each day,
 * actual/365, summed over a calendar month and rounded half-up once for the month. Principal repaid on day R stops
 * earning interest from R (as a withdrawal's units stop counting on its day, ADR-0028). A repayment goes to accrued
 * interest first, then principal. Pure.
 */
const DAYS_IN_YEAR = 365n;

export interface DatedPesewas {
  readonly date: string;
  readonly pesewas: bigint;
}

/** The month's interest on `principal` at the start of the month, less principal repaid on the given dates. */
export function interestOfMonth(principal: bigint, rate: Rate, month: Month, principalRepaid: readonly DatedPesewas[]): bigint {
  let pesewaDays = 0n;
  let outstanding = principal;
  let from = month.start;
  const within = principalRepaid.filter((r) => r.date > month.start && r.date <= month.end).sort((a, b) => a.date.localeCompare(b.date));
  for (const repaid of within) {
    pesewaDays += outstanding * (daysIncluding(from, repaid.date) - 1n);
    outstanding -= repaid.pesewas;
    from = repaid.date;
  }
  pesewaDays += outstanding * daysIncluding(from, month.end);
  return halfUpDivide(pesewaDays * rate.numerator, rate.denominator * DAYS_IN_YEAR);
}

export interface RepaymentRule {
  readonly field: string;
  readonly rule: 'INTEREST_FIRST' | 'MORE_THAN_ACCRUED' | 'MORE_THAN_OUTSTANDING' | 'NOT_POSITIVE';
}

/** A repayment's split, as asked, against what is owed: interest first, never more than has accrued or is outstanding. */
export function judgeRepayment(
  asked: { readonly principalPesewas: bigint; readonly interestPesewas: bigint },
  owed: { readonly accruedInterestPesewas: bigint; readonly outstandingPrincipalPesewas: bigint },
): RepaymentRule[] {
  const total = asked.principalPesewas + asked.interestPesewas;
  if (total === 0n) return [{ field: '/principalPesewas', rule: 'NOT_POSITIVE' }];
  if (asked.interestPesewas > owed.accruedInterestPesewas) return [{ field: '/interestPesewas', rule: 'MORE_THAN_ACCRUED' }];
  const interestFirst = total < owed.accruedInterestPesewas ? total : owed.accruedInterestPesewas;
  if (asked.interestPesewas < interestFirst) return [{ field: '/interestPesewas', rule: 'INTEREST_FIRST' }];
  if (asked.principalPesewas > owed.outstandingPrincipalPesewas) return [{ field: '/principalPesewas', rule: 'MORE_THAN_OUTSTANDING' }];
  return [];
}

export interface Instalment {
  readonly instalmentNo: number;
  readonly dueDate: string;
  readonly principalDuePesewas: bigint;
  readonly interestDuePesewas: bigint;
}

/**
 * The repayment schedule over a term: the principal in equal monthly parts by `allocate` (summing to it exactly), each
 * due on its month's last day, with the month's interest projected on the balance before it. None without a term.
 */
export function scheduleOf(principal: bigint, rate: Rate, start: string, termMonths: number | null): Instalment[] {
  if (termMonths === null) return [];
  const parts = equalMonthlyParts(principal, termMonths);
  let balance = principal;
  return monthsFrom(start, termMonths).map((month, i) => {
    const interest = interestOfMonth(balance, rate, month, []);
    balance -= parts[i]!;
    return { instalmentNo: i + 1, dueDate: month.end, principalDuePesewas: parts[i]!, interestDuePesewas: interest };
  });
}

/** What was repaid in all, laid against the instalments in due order, each taking its interest and principal due. */
export function instalmentsPaid(schedule: readonly Instalment[], repaidPesewas: bigint): bigint[] {
  let left = repaidPesewas;
  return schedule.map((instalment) => {
    const due = instalment.principalDuePesewas + instalment.interestDuePesewas;
    const paid = left < due ? left : due;
    left -= paid;
    return paid;
  });
}
