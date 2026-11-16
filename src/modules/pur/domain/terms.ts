/** A calendar day in milliseconds: business dates are whole days, so this arithmetic never meets a clock change. */
const DAY_MS = 86_400_000;

/**
 * When a supplier invoice falls due (FR-PUR-001, FR-PUR-008): the invoice date plus the supplier's payment terms in
 * calendar days. Both are business dates (Africa/Accra, which keeps UTC all year). Pure.
 */
export function dueDateFrom(invoiceDate: string, termsDays: number): string {
  return new Date(Date.parse(`${invoiceDate}T00:00:00Z`) + termsDays * DAY_MS).toISOString().slice(0, 10);
}
