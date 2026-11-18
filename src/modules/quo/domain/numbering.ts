/** A quote line's number from its position, counted from 1 (`quo.quote_line.line_no > 0`). */
export function lineNumber(index: number): number {
  return index + 1;
}

/** The number of the next version of a quote (FR-QUO-006): one more than its latest. */
export function nextVersionNo(latest: number): number {
  return latest + 1;
}

/** How many times each key occurs. */
export function countOf(keys: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}
