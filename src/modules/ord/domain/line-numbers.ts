/** An order line's number from its position in the request, counted from 1 (`ord.sales_order_line.line_no > 0`). */
export function lineNumber(index: number): number {
  return index + 1;
}

/** The number after the highest one used (a line added later, a substitute): 1 when none is. */
export function nextLineNumber(used: readonly number[]): number {
  return Math.max(0, ...used) + 1;
}

/** Oldest line first. */
export function byLineNumber(a: { readonly lineNo: number }, b: { readonly lineNo: number }): number {
  return a.lineNo - b.lineNo;
}

const MS_PER_DAY = 86_400_000;

/** An Africa/Accra calendar day as the instants [from, to): Accra keeps UTC all year, with no daylight saving. */
export function accraDay(date: string): { readonly from: Date; readonly to: Date } {
  const from = Date.parse(`${date}T00:00:00Z`);
  return { from: new Date(from), to: new Date(from + MS_PER_DAY) };
}
