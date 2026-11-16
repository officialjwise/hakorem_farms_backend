/** Time and paging arithmetic for PAY, kept apart from money (ADR-0001's lint rule): instants and counts, never amounts. */
export function addMs(at: Date, ms: number): Date {
  return new Date(at.getTime() + ms);
}

export function elapsedMs(from: Date, to: Date): number {
  return to.getTime() - from.getTime();
}

/** The nth retry's time: the base doubled for each failure after the first. */
export function backoffAt(now: Date, baseMs: number, failures: number): Date {
  return addMs(now, baseMs * 2 ** (failures - 1));
}

/** One row more than a page, to know whether another page follows. */
export function pageProbe(limit: number): number {
  return limit + 1;
}
