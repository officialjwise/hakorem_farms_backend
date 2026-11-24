/** Counting that is not money, kept apart from the files that handle pesewas (the lint's ADR-0001 rule): page probes. */
export const probe = (limit: number): number => limit + 1;

/** A page of rows from an offset, whether more follow, and the offset of the next page. */
export function pageAt<T>(all: readonly T[], offset: number, limit: number): { readonly rows: T[]; readonly hasMore: boolean; readonly next: number } {
  const end = offset + limit;
  return { rows: all.slice(offset, end), hasMore: all.length > end, next: end };
}
