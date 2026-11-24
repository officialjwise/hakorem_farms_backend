/** A distribution run's statuses (FR-CAP-010, `cap.distribution_run.status`). */
export type RunStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'POSTED' | 'PAID' | 'REJECTED';
export type RunAction = 'RECOMPUTE' | 'SUBMIT' | 'POST' | 'PAY';
export type RunRefusal = 'RUN_NOT_EDITABLE' | 'RUN_NOT_DRAFT' | 'NOTHING_TO_DISTRIBUTE' | 'RUN_NOT_APPROVED' | 'RUN_NOT_POSTED';

/** The rule a run records it used (ADR-0028), written on every run. */
export const DAY_COUNT_CONVENTION =
  'Actual calendar days in Africa/Accra, both ends of the period counted; the contribution day counts, the withdrawal day does not; weights are units held multiplied by days held (unit-days), allocated by largest remainder, ties to the lower investor number.';

/**
 * Whether a run may take an action (FR-CAP-010): draft, then pending approval, approved by a different person with
 * step-up, posted, paid. Only a draft is recomputed: a submitted run is never edited, so its approval always decides
 * what was submitted; a run that must change is rejected (or its maker withdraws the request) and drafted again (A-382).
 * Only a draft with something to share may be submitted; only an approved run is posted, once; only a posted run is paid. Approval and rejection are IAM's decision, checked by the approval handler.
 */
export function judgeRunAction(action: RunAction, status: RunStatus, distributablePesewas: bigint): RunRefusal | null {
  switch (action) {
    case 'RECOMPUTE':
      return status === 'DRAFT' ? null : 'RUN_NOT_EDITABLE';
    case 'SUBMIT':
      if (status !== 'DRAFT') return 'RUN_NOT_DRAFT';
      return distributablePesewas > 0n ? null : 'NOTHING_TO_DISTRIBUTE';
    case 'POST':
      return status === 'APPROVED' ? null : 'RUN_NOT_APPROVED';
    case 'PAY':
      return status === 'POSTED' ? null : 'RUN_NOT_POSTED';
  }
}
