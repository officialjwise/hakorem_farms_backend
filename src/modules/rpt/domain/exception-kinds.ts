/**
 * The kinds of the daily exception report (FR-RPT-007, THREAT_MODEL section 4, ADR-0103). Every abuse case of the
 * threat model lands as at least one kind. The first twenty-two are the contract's since 1.0.0 and keep their names;
 * the rest are added by B12 continued 3 for the detections named since B7 (CR-059's five controls among them). A
 * source's own finer kind (`TILL_PIN_LOCKED`, `SHIFT_FORCE_CLOSED`, a break's kind) travels beside it as `sourceKind`.
 */
export const EXCEPTION_KINDS = [
  'SALE_VOID',
  'PRICE_OVERRIDE',
  'REFUND',
  'MORTALITY',
  'STOCK_ADJUSTMENT',
  'STOCK_EXCEPTION',
  'UNMATCHED_PAYMENT',
  'WEBHOOK_REJECTED',
  'DRIVER_VARIANCE',
  'SHIFT_OVER_SHORT',
  'DEVICE_COUNTER_GAP',
  'AUTHORISATION_FAILURE',
  'BULK_EXPORT',
  'CREDIT_OVERRIDE',
  'PAYOUT_DETAIL_CHANGE',
  'PERMISSION_CHANGE',
  'YIELD_VARIANCE',
  'AUDIT_INTEGRITY',
  'RECONCILIATION_BREAK',
  'SYNC_REJECTED',
  'LATE_POSTING',
  'QUOTE_ACCEPTED_BY_STAFF',
  // CR-059's controls, each its own kind (the owner, 2026-11-23).
  'CASH_DROP',
  'MORTALITY_PHOTO_REUSED',
  'DELIVERY_PHOTO_REUSED',
  'CASH_HANDED_IN_LATE',
  'NEGATIVE_STOCK',
  // The detections the threat model names after B0.
  'GOODS_RECEIPT_UNMATCHED',
  'ORDER_SPLITTING',
  'SUPPLIER_VARIANCE',
  'SUPPLIER_CREDIT_NOTE',
  'PROCESSING_REVERSAL',
  'ASSET_DISPOSAL',
  'CREDIT_NOTE',
  'PAYMENT_REVERSAL',
  'RECEIPT_CLAIM',
  'RECEIPT_TOKEN_REFUSED',
  'OFFLINE_SALE_REVIEW',
  'BAD_DEBT_WRITE_OFF',
  'WRITTEN_OFF_CUSTOMER_PAID',
  'CONSENT_RECORDED_BY_STAFF',
  'DELIVERY_FAILURE',
  'DELIVERY_WRITE_OFF',
  'DELIVERY_RETURN',
  'DELIVERY_REASSIGNED',
  'PART_DELIVERY',
  'DELIVERY_CANCELLED',
  'BACKORDER_HELD',
  'SALE_RETURN',
  'MESSAGE_REPORT_REJECTED',
  'MESSAGE_SUPPRESSED',
  'MESSAGE_FAILED',
  'DOCUMENT_SENT',
  'QUOTE_HOLD',
  'QUOTE_WITHDRAWN',
  'ACCEPTED_QUOTE_LAPSED',
  'PAYMENT_AFTER_PAYOUT_CHANGE',
  'CAPITAL_WITHDRAWAL',
  'DISTRIBUTION',
  'BACKDATED_CONTRIBUTION',
  'RETENTION_RATE',
  'LOAN_OR_GRANT',
  'ACCRUAL_BLOCKED',
  'OVERHEAD_ALLOCATION',
  'PROJECTION_DRIFT',
  'CHECKOUT_HOLDING',
] as const;

export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];
export type Severity = 'INFO' | 'REVIEW' | 'URGENT';

/** Most urgent first: the report lists URGENT, then REVIEW, then INFO (CR-059, the owner). */
export const SEVERITY_ORDER: Readonly<Record<Severity, number>> = { URGENT: 0, REVIEW: 1, INFO: 2 };

/**
 * The investor books are read by the Owner and the Accountant only (ADR-0100): an item about capital, a distribution,
 * an investor's payout or a loan is shown only to a reader who also holds `cap.capital.read` where it is kept.
 */
export const INVESTOR_ITEM_PERMISSION = 'cap.capital.read';
