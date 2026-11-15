import { Money } from '@hakorem/kernel';
import { countByDate, periodDates, type DayTotal, type Period } from './dashboard';

export interface SeriesPoint {
  readonly date: string;
  readonly valuePesewas: Money;
  readonly count: number;
}

/**
 * Every day of the period, in order, with the store's total for the days that had any and an exact zero for the
 * days that had none (a day with no receipt is a real zero, not a placeholder), and the period's total in pesewas.
 * A row outside the period is left out.
 */
export function fillSeries(period: Period, days: readonly DayTotal[]): { readonly points: SeriesPoint[]; readonly total: Money; readonly count: number } {
  const counts = countByDate(period, days);
  const values = new Map<string, Money>();
  for (const day of days) {
    if (counts.byDate.has(day.date)) values.set(day.date, (values.get(day.date) ?? Money.zero()).plus(Money.ofPesewas(day.valuePesewas)));
  }
  const points = periodDates(period).map((date) => ({ date, valuePesewas: values.get(date) ?? Money.zero(), count: counts.byDate.get(date) ?? 0 }));
  return { points, total: Money.sum(points.map((point) => point.valuePesewas)), count: counts.total };
}
