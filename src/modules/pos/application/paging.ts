/** A page is read one row past its limit, so the reader knows whether another page follows. */
export function oneMore(limit: number): number {
  return limit + 1;
}
