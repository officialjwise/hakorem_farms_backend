import { err, ok, type Result } from '@hakorem/kernel';
import type { MatchReason } from './three-way-match';

/**
 * The approved variance (FR-PUR-010, A-172): a second person accepts an invoice the three-way match refused, so it can
 * be paid as invoiced. It covers a price outside the tolerance and a levy charged differently from the calculation;
 * never goods that were not received, a line with no order line or a different product, which are resolved by
 * receiving the goods or correcting the invoice. Pure; the database holds the same cap (migration 0107).
 */
export const VARIANCE_COVERS: ReadonlySet<MatchReason> = new Set<MatchReason>(['PRICE_OUTSIDE_TOLERANCE', 'LEVY_DIFFERS']);

/**
 * Each line's mismatch reasons, as the match finds them now: ok when at least one line mismatches and every reason is
 * one a variance covers; otherwise the lines and reasons it cannot cover (empty when nothing mismatches at all).
 */
export function judgeVarianceLines(lines: readonly { readonly reasons: readonly MatchReason[] }[]): Result<void, { readonly index: number; readonly reason: MatchReason }[]> {
  const uncovered = lines.flatMap((line, index) => line.reasons.filter((reason) => !VARIANCE_COVERS.has(reason)).slice(0, 1).map((reason) => ({ index, reason })));
  if (uncovered.length > 0) return err(uncovered);
  return lines.some((line) => line.reasons.length > 0) ? ok(undefined) : err([]);
}

/**
 * Who may approve a variance (ADR-0017): never the person who asked for it (IAM's check too), and never the person
 * who entered the invoice, so one person cannot key a price and then wave it through.
 */
export function judgeVarianceApprover(facts: { readonly invoiceMakerId: string; readonly requesterId: string; readonly approverId: string }): Result<void, 'MAKER_CANNOT_CHECK' | 'INVOICE_MAKER_CANNOT_APPROVE'> {
  if (facts.approverId === facts.requesterId) return err('MAKER_CANNOT_CHECK');
  if (facts.approverId === facts.invoiceMakerId) return err('INVOICE_MAKER_CANNOT_APPROVE');
  return ok(undefined);
}
