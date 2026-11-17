/** How many rows a keyset page reads: one more than it shows, so it knows whether another page follows. */
export function pageProbe(limit: number): number {
  return limit + 1;
}

/**
 * The window of an in-memory list (an order's status history) that follows the row `afterId` (the cursor's position),
 * at most `limit` rows, and whether more follow. An unknown `afterId` starts from the top.
 */
export function windowAfter<T extends { readonly id: string }>(rows: readonly T[], afterId: string | null, limit: number): { readonly rows: readonly T[]; readonly hasMore: boolean } {
  const start = afterId === null ? 0 : rows.findIndex((r) => r.id === afterId) + 1;
  const end = start + limit;
  return { rows: rows.slice(start, end), hasMore: end < rows.length };
}
