import { err, ok, type Result } from '@hakorem/kernel';

/**
 * Whether a payment may be recorded against a distribution line (FR-CAP-012): more than nothing, and never so much
 * that the line is paid above its net payable (the database holds it too, `ck_distribution_line_paid`).
 */
export function judgeDistributionPayment(
  line: { readonly netPayable: bigint; readonly paid: bigint },
  amount: bigint,
): Result<{ readonly paid: bigint; readonly fullyPaid: boolean }, 'NOT_POSITIVE' | 'LINE_PAID' | 'MORE_THAN_PAYABLE'> {
  if (amount <= 0n) return err('NOT_POSITIVE');
  if (line.paid >= line.netPayable) return err('LINE_PAID');
  const paid = line.paid + amount;
  if (paid > line.netPayable) return err('MORE_THAN_PAYABLE');
  return ok({ paid, fullyPaid: paid === line.netPayable });
}
