/** Rows to fetch for a page: one more than the limit, to know whether another page follows. */
export function pageProbe(limit: number): number {
  return limit + 1;
}
