export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';

export interface ApprovalState {
  readonly status: ApprovalStatus;
  readonly requestedBy: string;
  /** Hex SHA-256 of the canonical payload the maker asked to have approved. */
  readonly payloadHash: string;
  readonly expiresAt: Date | null;
}

export interface ApprovalDecisionInput {
  readonly decidedBy: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  /** Hex SHA-256 of the subject as it is now; a mismatch means it changed after the request. */
  readonly currentPayloadHash: string;
  readonly now: Date;
}

export type ApprovalRefusal = 'MAKER_CANNOT_CHECK' | 'APPROVAL_ALREADY_DECIDED' | 'APPROVAL_EXPIRED' | 'APPROVAL_SUBJECT_CHANGED';

export type ApprovalDecisionResult = { readonly ok: true } | { readonly ok: false; readonly code: ApprovalRefusal };

/**
 * Whether a checker may decide a request (ADR-0017). The maker cannot be the checker (the database enforces the
 * same rule); a decided or lapsed request cannot be decided again; and an approval is bound to the exact content
 * approved, so a subject that changed since the request cannot be approved.
 */
export function decideApproval(state: ApprovalState, input: ApprovalDecisionInput): ApprovalDecisionResult {
  if (state.status !== 'PENDING') {
    return { ok: false, code: 'APPROVAL_ALREADY_DECIDED' };
  }
  if (state.expiresAt !== null && input.now.getTime() >= state.expiresAt.getTime()) {
    return { ok: false, code: 'APPROVAL_EXPIRED' };
  }
  if (input.decidedBy === state.requestedBy) {
    return { ok: false, code: 'MAKER_CANNOT_CHECK' };
  }
  if (input.decision === 'APPROVED' && input.currentPayloadHash !== state.payloadHash) {
    return { ok: false, code: 'APPROVAL_SUBJECT_CHANGED' };
  }
  return { ok: true };
}
