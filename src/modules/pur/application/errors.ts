import { databaseErrorOf } from '../../../platform/database/unit-of-work';
import { BusinessRuleError, InvalidStateTransitionError, type ErrorDetail } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';

/** PUR's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'pur.purchase_order_invalid': 'This purchase order cannot be made or changed like this.',
  'pur.purchase_order_rule': 'This value breaks a purchase order rule.',
  'pur.receipt_exceeds_order': 'This receipt would take an order line past its ordered quantity and tolerance.',
  'pur.receipt_order_mismatch': 'This receipt line does not belong to an open line of the order it names.',
  'pur.supplier_invoice_invalid': 'This supplier invoice cannot be entered or changed like this.',
  'pur.supplier_invoice_rule': 'This value breaks a supplier invoice rule.',
  'pur.duplicate_supplier_invoice': 'This supplier invoice number was already entered for this supplier.',
  'pur.three_way_match_failed': 'This invoice does not match its order and receipt, so it cannot be approved or paid.',
  'pur.supplier_payment_invalid': 'This supplier payment cannot be prepared like this.',
  'pur.allocation_exceeds_available': 'This amount is more than the invoice has left to pay.',
  'pur.reference_not_found': 'Something this record refers to does not exist.',
  'pur.duplicate_reference': 'This payment reference was already recorded.',
  'pur.rule': 'This value breaks a rule.',
  'pur.supplier_profile_invalid': 'These supplier terms or payout details cannot be saved like this.',
  'pur.supplier_document_invalid': 'This document cannot be filed for the supplier.',
  'pur.payout_maker_cannot_approve': 'You made the payout change this payment is the first to use, so someone else must approve it.',
  'pur.purchase_requisition_invalid': 'This purchase requisition cannot be made or changed like this.',
  'pur.credit_note_exceeds_invoice': 'This credit is more than the invoice has left uncredited and unpaid.',
  'pur.variance_not_allowed': 'An approved variance covers a price or levy difference only; receive the goods or correct the invoice instead.',
  'pur.invoice_maker_cannot_approve': 'You entered this invoice, so someone else must approve its variance.',
  'pur.approval_pending': 'This document is waiting for approval and cannot change until it is decided or withdrawn.',
  'pur.supplier_claim_invalid': 'This claim cannot be raised or settled like this.',
  'pur.supplier_claim_rule': 'This breaks a rule of the claim.',
});

export interface BrokenRule {
  readonly field: string;
  readonly rule: string;
}

function details(rules: readonly BrokenRule[], messageKey: string): ErrorDetail[] {
  return rules.map((rule) => ({ field: rule.field, code: rule.rule, message: translate(messageKey) }));
}

/**
 * 422 PURCHASE_ORDER_INVALID (FR-PUR-005, FR-PUR-006): `NO_LINES`, `LINE_REPEATED`, `NOT_PURCHASABLE`,
 * `PRODUCT_NOT_ACTIVE`, `SUPPLIER_NOT_ACTIVE`, `NOT_A_RECEIVING_LOCATION`, `EXPECTED_BEFORE_ORDER`, `NO_CONVERSION`,
 * `INEXACT_QUANTITY`, `TAX_INCLUSIVE_NOT_AVAILABLE`, `RECEIVED_ALREADY` (cancel after a receipt) and
 * `NOTHING_RECEIVED` (close with nothing received).
 */
export class PurchaseOrderInvalidError extends BusinessRuleError {
  readonly code = 'PURCHASE_ORDER_INVALID';
  readonly messageKey = 'pur.purchase_order_invalid';

  constructor(rules: readonly BrokenRule[]) {
    super('the purchase order breaks a rule', details(rules, 'pur.purchase_order_rule'));
  }
}

/** 422 RECEIPT_EXCEEDS_ORDER (FR-PUR-007): a goods receipt line would pass ordered plus tolerance. */
export class ReceiptExceedsOrderError extends BusinessRuleError {
  readonly code = 'RECEIPT_EXCEEDS_ORDER';
  readonly messageKey = 'pur.receipt_exceeds_order';

  constructor(rules: readonly BrokenRule[]) {
    super('a receipt exceeds what was ordered', details(rules, 'pur.receipt_exceeds_order'));
  }
}

/**
 * 422 RECEIPT_ORDER_MISMATCH (FR-PUR-007): a receipt line names an order line of another order or product, an order of
 * another supplier, or an order that is not open for receipt (`NOT_ON_ORDER`, `PRODUCT_DIFFERS`, `OTHER_SUPPLIER`,
 * `ORDER_NOT_OPEN`, `NO_ORDER`).
 */
export class ReceiptOrderMismatchError extends BusinessRuleError {
  readonly code = 'RECEIPT_ORDER_MISMATCH';
  readonly messageKey = 'pur.receipt_order_mismatch';

  constructor(rules: readonly BrokenRule[]) {
    super('a receipt does not fit its order', details(rules, 'pur.receipt_order_mismatch'));
  }
}

/**
 * 422 SUPPLIER_INVOICE_INVALID (FR-PUR-008): `NO_LINES`, `ORDER_OF_ANOTHER_SUPPLIER`, `ORDER_NOT_RECEIVABLE`,
 * `ORDER_LINE_NOT_ON_ORDER`, `ORDER_REQUIRED`, `PRODUCT_DIFFERS`, `NO_CONVERSION`, `INEXACT_QUANTITY`,
 * `BRANCH_REQUIRED`, `BRANCH_DIFFERS`, `DUE_BEFORE_INVOICE`, `STATED_TOTAL_DIFFERS`, `LEVY_NOT_IN_SCHEME`,
 * `LEVY_REPEATED`, `FILE_NOT_USABLE`; for a credit note (FR-PUR-011) `ORIGINAL_REQUIRED`, `ORIGINAL_NOT_AN_INVOICE`,
 * `ORIGINAL_NOT_APPROVED`, `ORIGINAL_SETTLED`, `ORIGINAL_OF_ANOTHER_SUPPLIER`, `ORDER_DIFFERS`, `NOT_FOR_INVOICE`,
 * `RETURN_REASON_REQUIRED`, `RETURN_REASON_INVALID`, `NOT_A_RETURN_LOCATION`, `LOCATION_OF_ANOTHER_BRANCH`,
 * `CREDIT_EMPTY`, `NOT_A_CREDIT_NOTE` and `CREDIT_NOTE_NEEDS_APPROVAL`; for a variance (FR-PUR-010) `NO_MISMATCH`;
 * `CREDIT_NOTE_ENTERED` on cancelling an invoice a live credit note reduces.
 */
/**
 * 422 SUPPLIER_CLAIM_INVALID (ADR-0076, CR-036): `RECEIPT_NOT_POSTED`, `NOT_A_PURCHASE`, `NO_ORDER`, `NOTHING_REJECTED`,
 * `NO_ORDER_LINE`, `NOTHING_TO_CLAIM` and `CLAIM_EXISTS` on raising; `CREDIT_NOTE_EXISTS` on settling either way;
 * a credit note target's refusal (`ORIGINAL_NOT_APPROVED`, `ORIGINAL_SETTLED`, `ORDER_DIFFERS` and the rest of
 * `judgeCreditTarget`) and `CLAIM_NOT_INVOICED` on drafting its credit note; `INVOICE_NOT_APPROVED`, `ORDER_DIFFERS`,
 * `ORDER_LINE_NOT_INVOICED` and `CLAIM_INVOICED` on settling by an invoice.
 */
export class SupplierClaimInvalidError extends BusinessRuleError {
  readonly code = 'SUPPLIER_CLAIM_INVALID';
  readonly messageKey = 'pur.supplier_claim_invalid';

  constructor(rules: readonly BrokenRule[]) {
    super('the claim breaks a rule', details(rules, 'pur.supplier_claim_rule'));
  }
}

export class SupplierInvoiceInvalidError extends BusinessRuleError {
  readonly code = 'SUPPLIER_INVOICE_INVALID';
  readonly messageKey = 'pur.supplier_invoice_invalid';

  constructor(rules: readonly BrokenRule[]) {
    super('the supplier invoice breaks a rule', details(rules, 'pur.supplier_invoice_rule'));
  }
}

/** 422 DUPLICATE_SUPPLIER_INVOICE (FR-PUR-008): the number was entered for this supplier already. */
export class DuplicateSupplierInvoiceError extends BusinessRuleError {
  readonly code = 'DUPLICATE_SUPPLIER_INVOICE';
  readonly messageKey = 'pur.duplicate_supplier_invoice';

  constructor() {
    super('the supplier invoice number is taken for this supplier', [{ field: '/supplierInvoiceNo', code: 'TAKEN', message: translate('pur.duplicate_supplier_invoice') }]);
  }
}

/**
 * 422 THREE_WAY_MATCH_FAILED (FR-PUR-010): an invoice that is not matched, or a line that does not match, cannot be
 * approved or allocated to a payment. Each detail names the line or allocation and its reason.
 */
export class ThreeWayMatchFailedError extends BusinessRuleError {
  readonly code = 'THREE_WAY_MATCH_FAILED';
  readonly messageKey = 'pur.three_way_match_failed';

  constructor(rules: readonly BrokenRule[]) {
    super('the three-way match blocks this', details(rules, 'pur.three_way_match_failed'));
  }
}

/**
 * 422 SUPPLIER_PAYMENT_INVALID (FR-PUR-012): `NO_ALLOCATIONS`, `OTHER_SUPPLIER`, `DUPLICATE_INVOICE`, `NOT_APPROVED`,
 * `BRANCH_DIFFERS`, `BANK_ACCOUNT_NOT_AVAILABLE`, and (FR-PUR-002) `PAYOUT_DETAILS_MISSING` or `PAYOUT_METHOD_DIFFERS`
 * when no approved details of the payment's method are in force.
 */
export class SupplierPaymentInvalidError extends BusinessRuleError {
  readonly code = 'SUPPLIER_PAYMENT_INVALID';
  readonly messageKey = 'pur.supplier_payment_invalid';

  constructor(rules: readonly BrokenRule[]) {
    super('the supplier payment breaks a rule', details(rules, 'pur.rule'));
  }
}

/** 422 ALLOCATION_EXCEEDS_AVAILABLE (FR-PUR-012): an allocation is more than the invoice has left unpromised. */
export class AllocationExceedsAvailableError extends BusinessRuleError {
  readonly code = 'ALLOCATION_EXCEEDS_AVAILABLE';
  readonly messageKey = 'pur.allocation_exceeds_available';

  constructor(rules: readonly BrokenRule[]) {
    super('an allocation exceeds what is outstanding', details(rules, 'pur.allocation_exceeds_available'));
  }
}

/** 422 DUPLICATE_VALUE: a bank or mobile money reference already recorded for another payment by the same method. */
export class DuplicatePaymentReferenceError extends BusinessRuleError {
  readonly code = 'DUPLICATE_VALUE';
  readonly messageKey = 'pur.duplicate_reference';

  constructor() {
    super('the payment reference is taken', [{ field: '/externalReference', code: 'TAKEN', message: translate('pur.duplicate_reference') }]);
  }
}

/**
 * 422 SUPPLIER_PROFILE_INVALID (FR-PUR-001, FR-PUR-002): payout details that do not fit their method (`REQUIRED`,
 * `NOT_FOR_METHOD`, `ACCOUNT_NUMBER_INVALID`, `MOMO_NUMBER_INVALID`), or a change asked for while another waits
 * (`PAYOUT_CHANGE_PENDING`).
 */
export class SupplierProfileInvalidError extends BusinessRuleError {
  readonly code = 'SUPPLIER_PROFILE_INVALID';
  readonly messageKey = 'pur.supplier_profile_invalid';

  constructor(rules: readonly BrokenRule[]) {
    super('the supplier profile breaks a rule', details(rules, 'pur.rule'));
  }
}

/** 422 SUPPLIER_DOCUMENT_INVALID (FR-PUR-003): `REFERENCE_NOT_FOUND`, `FILE_NOT_USABLE`, `FILE_ALREADY_FILED`, `EXPIRED`. */
export class SupplierDocumentInvalidError extends BusinessRuleError {
  readonly code = 'SUPPLIER_DOCUMENT_INVALID';
  readonly messageKey = 'pur.supplier_document_invalid';

  constructor(rules: readonly BrokenRule[]) {
    super('the supplier document breaks a rule', details(rules, 'pur.rule'));
  }
}

/**
 * 422 PURCHASE_REQUISITION_INVALID (FR-PUR-004): `NO_LINES`, `LINE_REPEATED`, `NOT_PURCHASABLE`, `PRODUCT_NOT_ACTIVE`,
 * `NEEDED_BY_PAST`, `LOCATION_REQUIRED`, `NOT_A_RECEIVING_LOCATION`, and on conversion `LINE_NOT_ON_REQUISITION`.
 */
export class PurchaseRequisitionInvalidError extends BusinessRuleError {
  readonly code = 'PURCHASE_REQUISITION_INVALID';
  readonly messageKey = 'pur.purchase_requisition_invalid';

  constructor(rules: readonly BrokenRule[]) {
    super('the purchase requisition breaks a rule', details(rules, 'pur.rule'));
  }
}

/**
 * 422 PAYOUT_MAKER_CANNOT_APPROVE (owner, 2026-11-15, A-171): the person who made a supplier's payout change approving
 * the first payment to that supplier after it. Raised from approveRequest.
 */
export class PayoutMakerCannotApproveError extends BusinessRuleError {
  readonly code = 'PAYOUT_MAKER_CANNOT_APPROVE';
  readonly messageKey = 'pur.payout_maker_cannot_approve';

  constructor() {
    super('the maker of the payout change may not approve the first payment after it', [{ field: '/approvalRequestId', code: 'PAYOUT_MAKER_CANNOT_APPROVE', message: translate('pur.payout_maker_cannot_approve') }]);
  }
}

/** 422 CREDIT_NOTE_EXCEEDS_INVOICE (FR-PUR-011): the credit is more than its invoice has left uncredited and unpromised. */
export class CreditNoteExceedsInvoiceError extends BusinessRuleError {
  readonly code = 'CREDIT_NOTE_EXCEEDS_INVOICE';
  readonly messageKey = 'pur.credit_note_exceeds_invoice';

  constructor(leftPesewas: bigint | null) {
    super(
      leftPesewas === null ? 'the credit exceeds the invoice' : `the credit exceeds the ${leftPesewas} pesewas the invoice has left`,
      [{ field: '/lines', code: 'CREDIT_EXCEEDS_UNCREDITED', message: translate('pur.credit_note_exceeds_invoice') }],
    );
  }
}

/**
 * 422 VARIANCE_NOT_ALLOWED (FR-PUR-010, A-172): a variance asked for, or approved, on a line whose mismatch is not a
 * price or a levy (`QTY_EXCEEDS_RECEIVED`, `NO_ORDER_LINE`, `PRODUCT_DIFFERS`); each detail names the line.
 */
export class VarianceNotAllowedError extends BusinessRuleError {
  readonly code = 'VARIANCE_NOT_ALLOWED';
  readonly messageKey = 'pur.variance_not_allowed';

  constructor(rules: readonly BrokenRule[]) {
    super('a variance cannot cover this mismatch', details(rules, 'pur.variance_not_allowed'));
  }
}

/** 422 INVOICE_MAKER_CANNOT_APPROVE (FR-PUR-010, A-172): the person who entered an invoice approving its variance. */
export class InvoiceMakerCannotApproveError extends BusinessRuleError {
  readonly code = 'INVOICE_MAKER_CANNOT_APPROVE';
  readonly messageKey = 'pur.invoice_maker_cannot_approve';

  constructor() {
    super('the person who entered the invoice may not approve its variance', [{ field: '/approvalRequestId', code: 'INVOICE_MAKER_CANNOT_APPROVE', message: translate('pur.invoice_maker_cannot_approve') }]);
  }
}

/** 422 APPROVAL_PENDING (A-172): a credit note or a variance waits for approval, so the invoice cannot change meanwhile. */
export class ApprovalPendingError extends BusinessRuleError {
  readonly code = 'APPROVAL_PENDING';
  readonly messageKey = 'pur.approval_pending';

  constructor(approvalRequestId: string) {
    super(`approval request ${approvalRequestId} is still open`, [{ field: '/approvalRequestId', code: 'APPROVAL_PENDING', message: translate('pur.approval_pending') }]);
  }
}

/** 422 REFERENCE_NOT_FOUND: an id in the request names no record. */
export class PurReferenceNotFoundError extends BusinessRuleError {
  readonly code = 'REFERENCE_NOT_FOUND';
  readonly messageKey = 'pur.reference_not_found';

  constructor(fields: readonly string[]) {
    super('a referenced record does not exist', fields.map((field) => ({ field, code: 'REFERENCE_NOT_FOUND', message: translate('pur.reference_not_found') })));
  }
}

/** A document in the wrong status for what was asked: 422 INVALID_STATE_TRANSITION. */
export function wrongStatus(what: string, status: string): InvalidStateTransitionError {
  return new InvalidStateTransitionError(`${what} is ${status}`);
}

/**
 * The database's own refusals (migrations 0094 and 0098) as the API error they mean, for a writer racing past the handler's
 * checks; anything else is rethrown unchanged.
 */
export function translatePurRefusal(error: unknown): never {
  const failure = databaseErrorOf(error);
  if (failure?.code === '23505' && failure.constraint === 'uq_supplier_invoice_no') throw new DuplicateSupplierInvoiceError();
  if (failure?.code === 'HK010' && failure.constraint === 'ck_supplier_payment_allocation_matched') throw new ThreeWayMatchFailedError([{ field: '/allocations', rule: 'NOT_MATCHED' }]);
  if (failure?.code === 'HK010' && failure.constraint === 'ck_supplier_payment_allocation_outstanding') throw new AllocationExceedsAvailableError([{ field: '/allocations', rule: 'EXCEEDS_OUTSTANDING' }]);
  if (failure?.code === '23505' && failure.constraint === 'uq_supplier_payment_reference') throw new DuplicatePaymentReferenceError();
  if (failure?.code === '23503' && failure.constraint === 'fk_supplier_invoice_line_receipt_line') throw new PurReferenceNotFoundError(['/lines/goodsReceiptLineId']);
  if (failure?.code === 'HK004' && failure.constraint === 'ck_supplier_invoice_cancel_unpaid') throw new SupplierInvoiceInvalidError([{ field: '/status', rule: 'PAYMENT_ALLOCATED' }]);
  if (failure?.code === '23505' && failure.constraint === 'uq_supplier_payout_change_pending') throw new SupplierProfileInvalidError([{ field: '/payoutDetails', rule: 'PAYOUT_CHANGE_PENDING' }]);
  if (failure?.code === '23505' && failure.constraint === 'uq_supplier_document_file') throw new SupplierDocumentInvalidError([{ field: '/fileId', rule: 'FILE_ALREADY_FILED' }]);
  if (failure?.code === 'HK010' && failure.constraint === 'ck_supplier_payment_first_use_approver') throw new PayoutMakerCannotApproveError();
  if (failure?.code === 'HK010' && failure.constraint === 'ck_supplier_payment_payee') throw new SupplierPaymentInvalidError([{ field: '/method', rule: 'PAYOUT_DETAILS_MISSING' }]);
  if (failure?.code === 'HK004' && failure.constraint === 'ck_purchase_order_cancel_unreceived') throw new PurchaseOrderInvalidError([{ field: '/status', rule: 'RECEIVED_ALREADY' }]);
  if (failure?.code === 'HK010' && failure.constraint === 'ck_supplier_credit_note_cap') throw new CreditNoteExceedsInvoiceError(null);
  if (failure?.code === 'HK010' && failure.constraint === 'ck_supplier_credit_note_original') throw new SupplierInvoiceInvalidError([{ field: '/originalInvoiceId', rule: 'ORIGINAL_NOT_APPROVED' }]);
  if (failure?.code === 'HK004' && failure.constraint === 'ck_supplier_invoice_cancel_credited') throw new SupplierInvoiceInvalidError([{ field: '/status', rule: 'CREDIT_NOTE_ENTERED' }]);
  if (failure?.code === 'HK010' && failure.constraint === 'ck_supplier_invoice_variance_cover') throw new VarianceNotAllowedError([{ field: '/lines', rule: 'VARIANCE_NOT_ALLOWED' }]);
  if (failure?.code === '23514' && failure.constraint === 'ck_supplier_invoice_variance') throw new InvoiceMakerCannotApproveError();
  if (failure?.code === '23505' && failure.constraint === 'uq_supplier_claim_receipt') throw new SupplierClaimInvalidError([{ field: '/goodsReceiptId', rule: 'CLAIM_EXISTS' }]);
  if (failure?.code === '23505' && failure.constraint === 'uq_supplier_invoice_claim') throw new SupplierClaimInvalidError([{ field: '/status', rule: 'CREDIT_NOTE_EXISTS' }]);
  throw error;
}
