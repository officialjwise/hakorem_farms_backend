import { Quantity } from '@hakorem/kernel';
import type { ReceiptRuleBroken } from './goods-receipt';

/** The reason code domain of goods rejected at the door (A-260, migration 0220). */
export const REJECTION_DOMAIN = 'GOODS_RECEIPT_REJECTION';

export interface Rejection {
  /** In the product's base unit. */
  readonly rejected: Quantity;
  readonly reasonCode: string | null;
  readonly note: string | null;
}

/**
 * A goods receipt line's rejection (the owner's decision 5, CR-035 point 3): a quantity rejected carries a reason
 * from the GOODS_RECEIPT_REJECTION domain, and a reason that requires a note has one; nothing rejected carries no
 * reason and no note. Pure: the reasons are MDM's facts, read by the caller. The database holds the presence rule too
 * (`ck_goods_receipt_line_rejection`, migration 0221).
 */
export function checkRejection(line: Rejection, reasons: ReadonlyMap<string, { readonly domain: string; readonly requiresNote: boolean }>, at: string): ReceiptRuleBroken[] {
  const rejecting = line.rejected.compareTo(Quantity.zero()) > 0;
  if (!rejecting) {
    if (line.reasonCode !== null) return [{ field: `${at}/rejectionReasonCode`, rule: 'REASON_NOT_ALLOWED' }];
    return line.note === null ? [] : [{ field: `${at}/rejectionNote`, rule: 'REASON_NOT_ALLOWED' }];
  }
  if (line.reasonCode === null) return [{ field: `${at}/rejectionReasonCode`, rule: 'REJECTION_REASON_REQUIRED' }];
  const reason = reasons.get(line.reasonCode);
  if (reason?.domain !== REJECTION_DOMAIN) return [{ field: `${at}/rejectionReasonCode`, rule: 'REASON_NOT_ALLOWED' }];
  return reason.requiresNote && line.note === null ? [{ field: `${at}/rejectionNote`, rule: 'NOTE_REQUIRED' }] : [];
}
