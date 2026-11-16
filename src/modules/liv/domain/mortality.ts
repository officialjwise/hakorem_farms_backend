import { err, ok, type Money, type Result } from '@hakorem/kernel';
import type { LivRuleBroken } from './rules';

export type MortalityKind = 'DEATH' | 'CULL';

/** The reason list each kind draws from (FR-MDM-011): a cull needs a reason distinct from death. */
const REASON_DOMAIN: Readonly<Record<MortalityKind, string>> = { DEATH: 'MORTALITY', CULL: 'CULL' };

export interface MortalityReportShape {
  readonly kind: MortalityKind;
  /** The domain of the reason code given, from MDM's fixed list. */
  readonly reasonDomain: string;
  readonly tracking: 'SERIAL' | 'LOT';
  readonly head: number;
  /** Whole head on hand where the unit stands now. */
  readonly headOnHand: bigint;
  readonly alive: boolean;
  readonly foundAt: Date;
  readonly now: Date;
}

/** A death or cull of one animal (one head) or of birds from a flock (no more than it has), found alive until then. */
export function checkMortalityReport(shape: MortalityReportShape): LivRuleBroken[] {
  const broken: LivRuleBroken[] = [];
  if (shape.reasonDomain !== REASON_DOMAIN[shape.kind]) broken.push({ field: '/reasonCode', rule: 'REASON_NOT_FOR_KIND' });
  if (!shape.alive) broken.push({ field: '/stockUnitId', rule: 'ANIMAL_NOT_ALIVE' });
  else if (shape.tracking === 'SERIAL' && shape.head !== 1) broken.push({ field: '/head', rule: 'ONE_HEAD_FOR_AN_ANIMAL' });
  else if (shape.tracking === 'LOT' && BigInt(shape.head) > shape.headOnHand) broken.push({ field: '/head', rule: 'HEAD_ABOVE_FLOCK' });
  if (shape.foundAt > shape.now) broken.push({ field: '/foundAt', rule: 'IN_THE_FUTURE' });
  return broken;
}

/**
 * Whether a write-off valued at `value` posts on submit or waits for a different person (FR-LIV-012, threat model
 * abuse case 2): at or above the threshold it needs a photograph before it may even be submitted, and then approval.
 */
export function judgeWriteOff(value: Money, threshold: Money, hasPhoto: boolean): Result<'POST' | 'APPROVAL', 'PHOTO_REQUIRED'> {
  if (value.compareTo(threshold) < 0) return ok('POST');
  return hasPhoto ? ok('APPROVAL') : err('PHOTO_REQUIRED');
}

/**
 * Who must confirm a submission (owner, 2026-11-15; B06r, threat model abuse case 2). At or above the threshold the
 * mortality approver, with a photograph, whoever reports. Below it, a reporter who may post a write-off posts it; one
 * who may not (the Farm hand) never writes stock off alone: a supervisor who may post a write-off confirms it.
 */
export function judgeSubmission(
  value: Money,
  threshold: Money,
  facts: { readonly hasPhoto: boolean; readonly reporterMayPost: boolean },
): Result<'POST' | 'CONFIRMATION' | 'APPROVAL', 'PHOTO_REQUIRED'> {
  const verdict = judgeWriteOff(value, threshold, facts.hasPhoto);
  if (verdict.ok && verdict.value === 'POST' && !facts.reporterMayPost) return ok('CONFIRMATION');
  return verdict;
}

export type EvidenceScan = 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED';
export type EvidenceReturnReason = 'EVIDENCE_INFECTED' | 'EVIDENCE_UNSCANNABLE';

/**
 * What a death photograph's malware scan allows (B06r): a report may be submitted while the scan is PENDING, so nobody
 * waits at the pen; it posts only once CLEAN; a file the scanner rejected sends a waiting report back to its maker.
 */
export function evidenceVerdict(scan: EvidenceScan): { readonly submit: boolean; readonly post: boolean; readonly returnReason: EvidenceReturnReason | null } {
  switch (scan) {
    case 'PENDING':
      return { submit: true, post: false, returnReason: null };
    case 'CLEAN':
      return { submit: true, post: true, returnReason: null };
    case 'INFECTED':
      return { submit: false, post: false, returnReason: 'EVIDENCE_INFECTED' };
    case 'FAILED':
      return { submit: false, post: false, returnReason: 'EVIDENCE_UNSCANNABLE' };
  }
}

/** The register's status once the loss is written off (FR-LIV-017). */
export function statusAfterLoss(kind: MortalityKind): 'DEAD' | 'CULLED' {
  return kind === 'CULL' ? 'CULLED' : 'DEAD';
}
