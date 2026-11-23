/** A page read asks for one row more than it shows, to know whether another page follows. */
export function pageProbe(limit: number): number {
  return limit + 1;
}

/** Attempts are numbered from 1, in the order they happen (`uq_delivery_attempt_no`). */
export function nextAttemptNo(attempts: number): number {
  return attempts + 1;
}
