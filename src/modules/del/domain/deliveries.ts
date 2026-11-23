import { Quantity, type Money } from '@hakorem/kernel';

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

/** A line of what the delivery carries, as the part delivery judges it. */
export interface CarriedLine {
  readonly orderLineId: string;
  readonly quantity: string;
  /** A weighed line (a catch-weight pack) is kept or sent back whole. */
  readonly weightKg: string | null;
}

/** The contract's `ProofOfDeliveryLine`: what the customer kept of one line, in the line's own unit. */
export interface DeliveredLine {
  readonly orderLineId: string;
  readonly deliveredQty: string;
}

/** A line the customer did not keep all of. */
export interface ReturnedLine {
  readonly orderLineId: string;
  readonly dispatchedQty: string;
  readonly deliveredQty: string;
  readonly returnedQty: string;
  readonly weighed: boolean;
}

const DELIVERY_FAILURE = 'DELIVERY_FAILURE';

/**
 * A part delivery (CR-055, A-364 (b)): the lines named say what the customer kept, in each line's own unit; a line not
 * named was kept whole. Never more than was dispatched; a weighed line (a catch-weight pack, priced by its weight) is kept
 * or sent back whole, never split at the door; something must have been kept (nothing kept is a failed attempt). A line
 * kept short needs a `DELIVERY_FAILURE` reason, and a reason is refused when everything was kept.
 */
export function judgePartDelivery(carried: readonly CarriedLine[], lines: readonly DeliveredLine[] | undefined, reason: VarianceReason, note: string | null = null): { readonly broken: ProofRule[]; readonly returned: ReturnedLine[] } {
  const broken: ProofRule[] = [];
  const returned: ReturnedLine[] = [];
  const kept = new Map<string, Quantity>();
  (lines ?? []).forEach((l, i) => {
    const line = carried.find((c) => c.orderLineId === l.orderLineId);
    if (line === undefined) return broken.push({ field: `/lines/${i}/orderLineId`, rule: 'LINE_UNKNOWN' });
    if (kept.has(l.orderLineId)) return broken.push({ field: `/lines/${i}/orderLineId`, rule: 'LINE_REPEATED' });
    const dispatched = Quantity.parse(line.quantity);
    const delivered = Quantity.parse(l.deliveredQty);
    kept.set(l.orderLineId, delivered);
    if (delivered.compareTo(dispatched) > 0) return broken.push({ field: `/lines/${i}/deliveredQty`, rule: 'ABOVE_DISPATCHED' });
    if (line.weightKg !== null && !delivered.isZero() && !delivered.equals(dispatched)) return broken.push({ field: `/lines/${i}/deliveredQty`, rule: 'WEIGHED_LINE_WHOLE' });
    if (delivered.compareTo(dispatched) < 0) {
      returned.push({ orderLineId: line.orderLineId, dispatchedQty: dispatched.toDecimalString(), deliveredQty: delivered.toDecimalString(), returnedQty: dispatched.minus(delivered).toDecimalString(), weighed: line.weightKg !== null });
    }
    return undefined;
  });
  if (broken.length > 0) return { broken, returned: [] };
  if (carried.every((c) => kept.get(c.orderLineId)?.isZero() === true)) return { broken: [{ field: '/lines', rule: 'NOTHING_DELIVERED' }], returned: [] };
  if (returned.length > 0) {
    if (reason === null) broken.push({ field: '/returnedReasonCode', rule: 'REASON_REQUIRED' });
    else if (reason === 'UNKNOWN') broken.push({ field: '/returnedReasonCode', rule: 'REASON_UNKNOWN' });
    else if (reason.domain !== DELIVERY_FAILURE) broken.push({ field: '/returnedReasonCode', rule: 'REASON_NOT_ALLOWED' });
    else if (reason.requiresNote && (note === null || note.trim() === '')) broken.push({ field: '/returnedNote', rule: 'NOTE_REQUIRED' });
  } else {
    if (reason !== null) broken.push({ field: '/returnedReasonCode', rule: 'REASON_NOT_NEEDED' });
    if (note !== null) broken.push({ field: '/returnedNote', rule: 'REASON_NOT_NEEDED' });
  }
  return broken.length > 0 ? { broken, returned: [] } : { broken: [], returned };
}

/**
 * The cash the driver may collect at the door after a part delivery (ADR-0093): the cash due fixed at dispatch less
 * the credit for what came back, never below zero (what the customer paid ahead beyond what they kept is refunded once
 * the credit note is issued, never handed over by the driver). The cash due itself is never changed (ADR-0092).
 */
export function dueAtDoor(due: Money, credited: Money): Money {
  return credited.compareTo(due) >= 0 ? due.minus(due) : due.minus(credited);
}

/** A synced record's outcome (the contract's `DriverSyncItem`). */
export type SyncOutcome = 'APPLIED' | 'APPLIED_WITH_EXCEPTION' | 'DUPLICATE' | 'REJECTED';

/**
 * What a recorded proof answers at sync, first and on every resend (CR-057 point 3): APPLIED when the cash due was
 * collected and everything kept; APPLIED_WITH_EXCEPTION naming a short collection (`COD_VARIANCE:<reason>`) and a part
 * delivery (`PART_DELIVERY:<reason>`). Derived from the stored proof, so a lost answer is never lost.
 */
export function syncOutcomeOfProof(p: { readonly codVarianceReasonCode: string | null; readonly returnedReasonCode: string | null }): { readonly outcome: 'APPLIED' | 'APPLIED_WITH_EXCEPTION'; readonly reason: string | null } {
  const raised = [...(p.codVarianceReasonCode === null ? [] : [`COD_VARIANCE:${p.codVarianceReasonCode}`]), ...(p.returnedReasonCode === null ? [] : [`PART_DELIVERY:${p.returnedReasonCode}`])];
  return raised.length === 0 ? { outcome: 'APPLIED', reason: null } : { outcome: 'APPLIED_WITH_EXCEPTION', reason: raised.join(' ') };
}
