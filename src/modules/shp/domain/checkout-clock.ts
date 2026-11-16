const MS_PER_MINUTE = 60_000;

/** When a checkout's stock is released: `minutes` after it started (A-045, the reservation lifetime setting). */
export function reservedUntil(startedAt: Date, minutes: number): Date {
  return new Date(startedAt.getTime() + minutes * MS_PER_MINUTE);
}

/** A checkout line's number: the cart line's position, from 1. */
export function lineNumber(index: number): number {
  return index + 1;
}
