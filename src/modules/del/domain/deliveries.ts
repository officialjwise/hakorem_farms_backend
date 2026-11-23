import type { Money } from '@hakorem/kernel';

/** The delivery machine (docs/data-model/del.md); `del.delivery_guard` holds the same edges. */
export type DeliveryStatus = 'SCHEDULED' | 'ASSIGNED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'FAILED' | 'RETURNED' | 'WRITTEN_OFF' | 'CANCELLED';

/** The reason a short collection names: a code from the fixed list, `UNKNOWN` when none has that code. */
export type VarianceReason = { readonly domain: string; readonly requiresNote: boolean } | 'UNKNOWN' | null;

/** A file a proof names, as the file store holds it; `MISSING` when no file has that id. */
export type ProofFile = { readonly purpose: string; readonly ownedByDriver: boolean; readonly quarantined: boolean } | 'MISSING' | null;

export interface ProofFacts {
  /** The cash due on delivery, fixed by the server at dispatch. */
  readonly due: Money;
  readonly collected: Money;
  readonly reason: VarianceReason;
  readonly note: string | null;
  readonly signature: ProofFile;
  readonly photo: ProofFile;
}

export interface ProofRule {
  readonly field: string;
  readonly rule: string;
}

const COD_VARIANCE = 'COD_VARIANCE';

/** A proof is taken on a delivery that is assigned to its driver or on its way, never one finished or failed. */
export function takesProof(status: DeliveryStatus): boolean {
  return status === 'ASSIGNED' || status === 'OUT_FOR_DELIVERY';
}

/** What the driver collected short of what was due (never negative: a driver never collects more, A-340). */
export function codVariance(due: Money, collected: Money): Money {
  return due.compareTo(collected) <= 0 ? due.minus(due) : due.minus(collected);
}

function judgeFile(file: ProofFile, purpose: string, field: string): ProofRule[] {
  if (file === null) return [];
  if (file === 'MISSING') return [{ field, rule: 'FILE_UNKNOWN' }];
  if (file.purpose !== purpose) return [{ field, rule: 'FILE_NOT_PROOF' }];
  if (!file.ownedByDriver) return [{ field, rule: 'FILE_NOT_YOURS' }];
  if (file.quarantined) return [{ field, rule: 'FILE_NOT_CLEAN' }];
  return [];
}

/**
 * FR-DEL-008 and FR-DEL-009: a delivery completes only with a signature or a photograph, each a file of its own use that
 * the driver uploaded and the malware scan has not held; the cash collected is never above the amount due; less than due
 * needs a COD_VARIANCE reason (and its note where the reason asks for one), and a reason or a note is refused when the
 * amount due was collected. The database holds the cash rule too (`ck_proof_variance`).
 */
export function judgeProof(f: ProofFacts): ProofRule[] {
  const broken: ProofRule[] = [];
  if (f.signature === null && f.photo === null) broken.push({ field: '/photoFileId', rule: 'EVIDENCE_REQUIRED' });
  broken.push(...judgeFile(f.signature, 'SIGNATURE', '/signatureFileId'), ...judgeFile(f.photo, 'PROOF_OF_DELIVERY', '/photoFileId'));
  const order = f.collected.compareTo(f.due);
  if (order > 0) {
    broken.push({ field: '/codCollectedPesewas', rule: 'ABOVE_DUE' });
  } else if (order < 0) {
    if (f.reason === null) broken.push({ field: '/codVarianceReasonCode', rule: 'REASON_REQUIRED' });
    else if (f.reason === 'UNKNOWN') broken.push({ field: '/codVarianceReasonCode', rule: 'REASON_UNKNOWN' });
    else if (f.reason.domain !== COD_VARIANCE) broken.push({ field: '/codVarianceReasonCode', rule: 'REASON_NOT_ALLOWED' });
    else if (f.reason.requiresNote && (f.note === null || f.note.trim() === '')) broken.push({ field: '/codVarianceNote', rule: 'NOTE_REQUIRED' });
  } else {
    if (f.reason !== null) broken.push({ field: '/codVarianceReasonCode', rule: 'REASON_NOT_NEEDED' });
    if (f.note !== null) broken.push({ field: '/codVarianceNote', rule: 'REASON_NOT_NEEDED' });
  }
  return broken;
}
