import type { StockRuleBroken } from './stock-documents';

export type HoldKind = 'WITHDRAWAL' | 'QUARANTINE' | 'INVESTIGATION';
/** Where a hold stands at an instant: not yet begun, blocking, ended by time, or released by a person. */
export type HoldState = 'SCHEDULED' | 'ACTIVE' | 'ENDED' | 'RELEASED';

export interface HoldWindow {
  readonly kind: HoldKind;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly releasedAt: Date | null;
}

/** A hold blocks from its start until its end, if it has one, unless it was released first (ADR-0019, A-134 (h)). */
export function holdState(hold: HoldWindow, at: Date): HoldState {
  if (hold.releasedAt !== null) return 'RELEASED';
  if (hold.startsAt.getTime() > at.getTime()) return 'SCHEDULED';
  if (hold.endsAt !== null && hold.endsAt.getTime() <= at.getTime()) return 'ENDED';
  return 'ACTIVE';
}

export interface HoldPlacement {
  readonly kind: HoldKind;
  readonly unitStatus: string;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
}

/**
 * The rules a new hold keeps (FR-INV-022, A-142): it holds an active animal or lot; it ends after it starts; and a
 * withdrawal hold has an end, because it ends only by time and nobody may release it.
 */
export function checkHoldPlacement(placement: HoldPlacement): StockRuleBroken[] {
  const broken: StockRuleBroken[] = [];
  if (placement.unitStatus !== 'ACTIVE') broken.push({ field: '/stockUnitId', rule: 'STOCK_UNIT_NOT_ACTIVE' });
  if (placement.endsAt !== null && placement.endsAt.getTime() <= placement.startsAt.getTime()) broken.push({ field: '/endsAt', rule: 'ENDS_BEFORE_IT_STARTS' });
  if (placement.kind === 'WITHDRAWAL' && placement.endsAt === null) broken.push({ field: '/endsAt', rule: 'WITHDRAWAL_NEEDS_AN_END' });
  return broken;
}

export interface HoldRelease {
  readonly hold: HoldWindow & { readonly createdBy: string };
  readonly at: Date;
  readonly releasedBy: string;
  /** The list the release reason belongs to, or null when it names no reason code. */
  readonly reasonDomain: string | null;
}

/**
 * Whether a person may release a hold early (FR-INV-022, FR-INV-008, A-142). A withdrawal hold never is; a hold that
 * was released or has ended is not in force to release; otherwise the reason comes from the HOLD_RELEASE list and the
 * person releasing is not the one who placed it.
 */
export function judgeRelease(release: HoldRelease): { readonly refusal: 'WITHDRAWAL' | 'NOT_IN_FORCE' } | { readonly refusal: null; readonly broken: StockRuleBroken[] } {
  if (release.hold.kind === 'WITHDRAWAL') return { refusal: 'WITHDRAWAL' };
  const state = holdState(release.hold, release.at);
  if (state === 'RELEASED' || state === 'ENDED') return { refusal: 'NOT_IN_FORCE' };
  const broken: StockRuleBroken[] = [];
  if (release.reasonDomain !== 'HOLD_RELEASE') broken.push({ field: '/reasonCode', rule: 'REASON_NOT_ALLOWED' });
  if (release.releasedBy === release.hold.createdBy) broken.push({ field: '/id', rule: 'RELEASED_BY_PLACER' });
  return { refusal: null, broken };
}
