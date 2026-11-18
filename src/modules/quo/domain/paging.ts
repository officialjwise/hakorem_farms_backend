/** How many rows a keyset page reads: one more than it shows, so it knows whether another page follows. */
export function pageProbe(limit: number): number {
  return limit + 1;
}
