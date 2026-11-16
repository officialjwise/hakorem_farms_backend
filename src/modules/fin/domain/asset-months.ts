/**
 * Calendar months of a fixed asset's life (FR-FIN-015, A-199). Month counts are small integers, kept here apart from
 * the pesewa arithmetic of `fixed-asset.ts` (ADR-0001's lint rule keeps number arithmetic out of files that use Money).
 * Dates are business dates in Africa/Accra, `YYYY-MM-DD`. The month an asset is acquired in is its first month of
 * depreciation, whatever the day (A-199).
 */

const MONTHS_PER_YEAR = 12;

/** The month of a date as one integer: year times twelve plus the month from nought. */
function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * MONTHS_PER_YEAR + Number(date.slice(5, 7)) - 1;
}

/** Months from the month of acquisition to the month of `through`, both counted; nil if `through` comes first. */
export function monthsInService(acquiredOn: string, through: string): number {
  return Math.max(0, monthIndex(through) - monthIndex(acquiredOn) + 1);
}

/**
 * The months a run for the period ending `periodEnd` charges: every month in service up to that period, within the
 * useful life, that no posted run has charged yet. A month no run charged (an asset registered late, a period whose
 * run never posted) is caught up by the next run.
 */
export function chargeableMonths(asset: { readonly acquiredOn: string; readonly usefulLifeMonths: number; readonly depreciatedMonths: number }, periodEnd: string): number {
  return Math.max(0, Math.min(monthsInService(asset.acquiredOn, periodEnd), asset.usefulLifeMonths) - asset.depreciatedMonths);
}

/** The months of the useful life not yet charged. */
export function monthsLeft(asset: { readonly usefulLifeMonths: number; readonly depreciatedMonths: number }): number {
  return asset.usefulLifeMonths - asset.depreciatedMonths;
}

/** Months already charged plus months charged now. */
export function plusMonths(charged: number, more: number): number {
  return charged + more;
}

/** A disposal is dated in the last month already charged or later, never before a month depreciation was charged for. */
export function disposalFollowsCharges(asset: { readonly acquiredOn: string; readonly depreciatedMonths: number }, disposedOn: string): boolean {
  return monthIndex(disposedOn) >= monthIndex(asset.acquiredOn) + asset.depreciatedMonths - 1;
}

/** The last day of each of `count` months from `firstMonth` (`YYYY-MM`). */
export function monthEnds(firstMonth: string, count: number): string[] {
  const first = monthIndex(`${firstMonth}-01`);
  return Array.from({ length: count }, (_, offset) => {
    const month = first + offset;
    return new Date(Date.UTC(Math.floor(month / MONTHS_PER_YEAR), (month % MONTHS_PER_YEAR) + 1, 0)).toISOString().slice(0, 10);
  });
}
