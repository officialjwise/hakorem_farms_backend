/** How many rows a keyset page reads: one more than it shows, so it knows whether another page follows. */
export function pageProbe(limit: number): number {
  return limit + 1;
}

/** A page of an ordered list from the first row the cursor's predicate accepts (none: an empty last page). */
export function pageFrom<T>(rows: readonly T[], after: ((row: T) => boolean) | null, limit: number): { readonly page: T[]; readonly hasMore: boolean } {
  const start = after === null ? 0 : rows.findIndex(after);
  if (start < 0) return { page: [], hasMore: false };
  const end = start + limit;
  return { page: rows.slice(start, end), hasMore: end < rows.length };
}
