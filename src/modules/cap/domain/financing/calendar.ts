/** Calendar months for loans and grants: Africa/Accra business dates as `YYYY-MM-DD`, actual days. Pure. */
export interface Month {
  readonly start: string;
  readonly end: string;
}

const MS_PER_DAY = 86_400_000;
const pad = (n: number): string => String(n).padStart(2, '0');
const lastDay = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Days from one date to another, both counted. */
export function daysIncluding(start: string, end: string): bigint {
  return BigInt((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / MS_PER_DAY + 1);
}

/** The first `count` calendar months from a date: the first from that date to its month's end, the rest whole. */
export function monthsFrom(start: string, count: number): Month[] {
  const [y, m] = start.split('-').map(Number) as [number, number];
  const months: Month[] = [];
  for (let i = 0; i < count; i += 1) {
    const year = y + Math.floor((m - 1 + i) / 12);
    const month = ((m - 1 + i) % 12) + 1;
    months.push({ start: i === 0 ? start : `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(lastDay(year, month))}` });
  }
  return months;
}

/** The months from a drawing day that have ended before `today`. */
export function completeMonths(start: string, today: string): Month[] {
  const [sy, sm] = start.split('-').map(Number) as [number, number];
  const [ty, tm] = today.split('-').map(Number) as [number, number];
  return monthsFrom(start, (ty - sy) * 12 + (tm - sm) + 1).filter((month) => month.end < today);
}
