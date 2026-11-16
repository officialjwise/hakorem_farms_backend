import { BusinessRuleError } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';
import type { BrokenRule } from '../domain/billing';

/** BIL's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'bil.document_invalid': 'This billing document cannot be issued like this.',
  'bil.credit_note_exceeds_original': 'This credit is more than the original document has left uncredited.',
  'bil.reference_not_found': 'Something this request refers to does not exist.',
  'bil.allocation_exceeds_outstanding': 'This payment is more than the document has left to pay.',
});

/** 422 BILLING_DOCUMENT_INVALID: every rule a billing request breaks, each in `details[].code` (A-200). */
export class BillingDocumentInvalidError extends BusinessRuleError {
  readonly code = 'BILLING_DOCUMENT_INVALID';
  readonly messageKey = 'bil.document_invalid';
  constructor(rules: readonly BrokenRule[]) {
    super(`billing document breaks ${rules.map((r) => r.rule).join(', ')}`, rules.map((r) => ({ field: r.field, code: r.rule, message: translate('bil.document_invalid') })));
  }
}

/** 422 CREDIT_NOTE_EXCEEDS_ORIGINAL (FR-BIL-007): also held by the database (`ck_billing_document_credit_cap`). */
export class CreditNoteExceedsOriginalError extends BusinessRuleError {
  readonly code = 'CREDIT_NOTE_EXCEEDS_ORIGINAL';
  readonly messageKey = 'bil.credit_note_exceeds_original';
  constructor(leftPesewas: bigint | null) {
    super(leftPesewas === null ? 'the credit exceeds the original' : `the credit exceeds the ${leftPesewas} pesewas the original has left`, [
      { field: '/lines', code: 'CREDIT_EXCEEDS_UNCREDITED', message: translate('bil.credit_note_exceeds_original') },
    ]);
  }
}

/** 422 REFERENCE_NOT_FOUND: a customer, product, tax category or reason the request names does not exist. */
export class BilReferenceNotFoundError extends BusinessRuleError {
  readonly code = 'REFERENCE_NOT_FOUND';
  readonly messageKey = 'bil.reference_not_found';
  constructor(fields: readonly string[]) {
    super(`unknown ${fields.join(', ')}`, fields.map((field) => ({ field, code: 'UNKNOWN', message: translate('bil.reference_not_found') })));
  }
}

/** 422 ALLOCATION_EXCEEDS_AVAILABLE (FR-PAY-009): more than the document has outstanding, refused by the database. */
export class AllocationExceedsOutstandingError extends BusinessRuleError {
  readonly code = 'ALLOCATION_EXCEEDS_AVAILABLE';
  readonly messageKey = 'bil.allocation_exceeds_outstanding';
  constructor(documentId: string) {
    super(`the allocation exceeds what billing document ${documentId} has outstanding`, [
      { field: '/allocations', code: 'EXCEEDS_OUTSTANDING', message: translate('bil.allocation_exceeds_outstanding') },
    ]);
  }
}
