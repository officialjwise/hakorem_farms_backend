/**
 * Events IAM publishes (docs/DOMAIN_MODEL.md section 5). Types only: subscribers import them with `import type`.
 */

/** `iam.ApprovalDecided` v1: a maker-checker request was approved or rejected by someone other than its maker. */
export interface ApprovalDecided {
  readonly kind: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly requestedBy: string;
  readonly decidedBy: string;
  readonly subjectDocumentId: string;
}
