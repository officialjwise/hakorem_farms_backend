/** Calendar arithmetic for WHL, kept apart from money (ADR-0001's lint rule): days, never amounts. */
const DAY_MS = 86_400_000;

/**
 * Whole calendar days a document is past its due date on a business date (both `YYYY-MM-DD`, Africa/Accra), nil on or
 * before it: due 14 October is 31 days past due on 14 November (FR-WHL-002, FR-WHL-008).
 */
export function daysPastDue(dueDate: string, asOf: string): number {
  if (dueDate >= asOf) return 0;
  return Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / DAY_MS);
}

/** The business date `days` calendar days after `date` (both `YYYY-MM-DD`): an invoice's due date from its terms. */
export function dueDateAfter(date: string, days: number): string {
  if (!Number.isInteger(days) || days < 0) throw new RangeError(`payment terms of ${days} days`);
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
