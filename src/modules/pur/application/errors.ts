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
 * `LEVY_REPEATED`, `FILE_NOT_USABLE`, `CREDIT_NOTE_NOT_AVAILABLE`.
 */
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

/** 422 SUPPLIER_PAYMENT_INVALID (FR-PUR-012): `NO_ALLOCATIONS`, `OTHER_SUPPLIER`, `DUPLICATE_INVOICE`, `NOT_APPROVED`, `BRANCH_DIFFERS`, `BANK_ACCOUNT_NOT_AVAILABLE`. */
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
 * The database's own refusals (migration 0094) as the API error they mean, for a writer racing past the handler's
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
  if (failure?.code === 'HK004' && failure.constraint === 'ck_purchase_order_cancel_unreceived') throw new PurchaseOrderInvalidError([{ field: '/status', rule: 'RECEIVED_ALREADY' }]);
  throw error;
}
