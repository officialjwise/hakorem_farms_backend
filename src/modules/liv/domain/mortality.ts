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

/** The register's status once the loss is written off (FR-LIV-017). */
export function statusAfterLoss(kind: MortalityKind): 'DEAD' | 'CULLED' {
  return kind === 'CULL' ? 'CULLED' : 'DEAD';
}
