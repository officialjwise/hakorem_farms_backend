import { daysInPeriod } from '../domain/distribution';

/**
 * Counting that is not money, kept apart from the files that handle pesewas (the lint's ADR-0001 rule): page probes,
 * investor-number order, computation numbers and days of a period that accounting periods cover.
 */
export const probe = (limit: number): number => limit + 1;
export const nextComputation = (computationNo: number): number => computationNo + 1;

/** Investor numbers by value: INV-999 before INV-1000. */
export const byInvestorNo = (a: { readonly investorNo: string }, b: { readonly investorNo: string }): number =>
  a.investorNo.length - b.investorNo.length || (a.investorNo < b.investorNo ? -1 : a.investorNo > b.investorNo ? 1 : 0);

/** How many days of the period the given accounting periods cover (they never overlap one another). */
export function daysCovered(period: { readonly start: string; readonly end: string }, ranges: readonly { readonly startDate: string; readonly endDate: string }[]): number {
  let days = 0;
  for (const r of ranges) {
    const start = r.startDate > period.start ? r.startDate : period.start;
    const end = r.endDate < period.end ? r.endDate : period.end;
    if (start <= end) days += daysInPeriod({ start, end });
  }
  return days;
}
