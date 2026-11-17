import { BusinessRuleError } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';

/** ORD's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'ord.sale_invalid': 'This sale cannot be recorded like this.',
  'ord.quote_required': 'This item has no price for this sale. Raise a quote instead.',
  'ord.price_override_needs_approval': 'This price needs a manager’s approval.',
  'ord.order_invalid': 'This order cannot be taken like this.',
  'ord.stock_short': 'Not enough stock for this line: {short} short of {wanted}.',
  'ord.void_cashier_cannot_approve': 'The cashier who made this sale cannot approve its void.',
  'ord.return_maker_cannot_approve': 'The person who made this return cannot approve it.',
  'ord.price_seller_cannot_approve': 'The person who sold at this price cannot approve it.',
});

/** A registered message with its `{name}` placeholders filled (the values are numbers, never user text). */
function fill(key: string, values: Readonly<Record<string, string>>): string {
  return translate(key).replace(/\{(\w+)\}/g, (_match, name: string) => values[name] ?? '');
}

export interface SaleRule {
  readonly field: string;
  readonly rule: string;
}

/**
 * 422 SALE_INVALID: every rule a sale breaks, each in `details[].code` (A-208): `CHANNEL_NOT_AVAILABLE`,
 * `FULFILMENT_NOT_AVAILABLE`, `NO_LINES`, `NO_TENDERS`, `CUSTOMER_NOT_ACTIVE`, `PRODUCT_NOT_ACTIVE`, `PRODUCT_NOT_STOCKED`,
 * `LOCATION_NOT_IN_BRANCH`, `NOT_A_SELLING_LOCATION`, `STOCK_UNIT_REQUIRED`, `STOCK_UNIT_OTHER_PRODUCT`, `ONE_ANIMAL_PER_LINE`,
 * `WEIGHT_REQUIRED`, `WEIGHT_SOURCE_REQUIRED`, `NO_CONVERSION`, `INEXACT_QUANTITY`, `RESERVATION_NOT_ACTIVE`,
 * `RESERVATION_DIFFERS`, `VARIANCE_REASON_REQUIRED`, `VARIANCE_REASON_INVALID`, `VARIANCE_NOTE_REQUIRED`, `TENDER_SHORT`,
 * `TENDER_OVER`.
 */
export class SaleInvalidError extends BusinessRuleError {
  readonly code = 'SALE_INVALID';
  readonly messageKey = 'ord.sale_invalid';
  constructor(rules: readonly SaleRule[]) {
    super(
      `sale breaks ${rules.map((r) => r.rule).join(', ')}`,
      rules.map((r) => ({ field: r.field, code: r.rule, message: translate('ord.sale_invalid') })),
    );
  }
}

/** 422 QUOTE_REQUIRED: the pricing engine cannot price a line; the sale raises a quote instead (FR-MDM-016). */
export class QuoteRequiredError extends BusinessRuleError {
  readonly code = 'QUOTE_REQUIRED';
  readonly messageKey = 'ord.quote_required';
  constructor(lines: readonly { readonly field: string; readonly reason: string }[]) {
    super(
      `no price for ${lines.map((l) => l.field).join(', ')}`,
      lines.map((l) => ({ field: l.field, code: l.reason, message: translate('ord.quote_required') })),
    );
  }
}

/**
 * 422 PRICE_OVERRIDE_NEEDS_APPROVAL (FR-ORD-003, A-230): outside the band (`OUTSIDE_BAND`), or below list beyond what the
 * seller may give (`BEYOND_ROLE_LIMIT`), with no approval to name; the approval still waits (`APPROVAL_PENDING`), was
 * rejected, withdrawn or lapsed (`APPROVAL_REJECTED`), or was given for another price (`APPROVAL_DIFFERS`).
 */
export class PriceOverrideNeedsApprovalError extends BusinessRuleError {
  readonly code = 'PRICE_OVERRIDE_NEEDS_APPROVAL';
  readonly messageKey = 'ord.price_override_needs_approval';
  constructor(lines: readonly { readonly field: string; readonly reason: string }[]) {
    super(
      `price override needs approval on ${lines.map((l) => l.field).join(', ')}`,
      lines.map((l) => ({ field: l.field, code: l.reason, message: translate('ord.price_override_needs_approval') })),
    );
  }
}

/**
 * 422 ORDER_INVALID (FR-ORD-001, FR-ORD-005, A-224): every rule an order entered by staff, or its confirmation, breaks,
 * each in `details[].code`: `BRANCH_REQUIRED`, `CUSTOMER_NOT_ACTIVE`, `FULFILMENT_NOT_AVAILABLE`, `NO_LINES`,
 * `PRODUCT_NOT_ACTIVE`, `PRODUCT_NOT_STOCKED`, `PRODUCT_REPEATED`, `STOCK_UNIT_REQUIRED`, `STOCK_UNIT_OTHER_PRODUCT`,
 * `STOCK_UNIT_NOT_AVAILABLE`, `ONE_ANIMAL_PER_LINE`, `CATCH_WEIGHT_NOT_AVAILABLE`, `NO_CONVERSION`, `INEXACT_QUANTITY`,
 * `VARIANCE_REASON_REQUIRED`, `VARIANCE_REASON_INVALID`, `VARIANCE_NOTE_REQUIRED`; at confirmation `PREPAYMENT_SHORT`,
 * `CREDIT_CHECK_UNAVAILABLE`, `CREDIT_REFUSED` and `TERMS_NOT_CONFIRMED`; at cancellation and void (B09a continued 2c, A-226)
 * `REASON_NOT_ALLOWED`, `NOTE_REQUIRED`, `VOID_DAY_CLOSED`, `NOT_A_COUNTER_SALE`, `VOID_PENDING` and `TENDER_NOT_VOIDABLE`.
 */
export class OrderInvalidError extends BusinessRuleError {
  readonly code = 'ORDER_INVALID';
  readonly messageKey = 'ord.order_invalid';
  constructor(rules: readonly SaleRule[]) {
    super(
      `order breaks ${rules.map((r) => r.rule).join(', ')}`,
      rules.map((r) => ({ field: r.field, code: r.rule, message: translate('ord.order_invalid') })),
    );
  }
}

/**
 * 422 STOCK_UNAVAILABLE at confirmation (FR-ORD-005): the lines that cannot all be reserved, each with what is short;
 * nothing was reserved and the order stays PLACED.
 */
export class OrderStockShortError extends BusinessRuleError {
  readonly code = 'STOCK_UNAVAILABLE';
  readonly messageKey = 'ord.stock_short';
  constructor(lines: readonly { readonly lineNo: number; readonly wanted: string; readonly short: string }[]) {
    super(
      `not enough stock for line ${lines.map((l) => l.lineNo).join(', ')}`,
      lines.map((l) => ({ field: `/lines/${l.lineNo}`, code: 'NOT_ENOUGH_STOCK', message: fill('ord.stock_short', { short: l.short, wanted: l.wanted }) })),
    );
  }
}

/** 422 MAKER_CANNOT_CHECK: the supervisor approving a void is the cashier who made the sale (abuse case 1). */
export class VoidApproverIsCashierError extends BusinessRuleError {
  readonly code = 'MAKER_CANNOT_CHECK';
  readonly messageKey = 'ord.void_cashier_cannot_approve';
}

export class ReturnApproverIsMakerError extends BusinessRuleError {
  readonly code = 'MAKER_CANNOT_CHECK';
  readonly messageKey = 'ord.return_maker_cannot_approve';
}

/** 422 MAKER_CANNOT_CHECK: the approver of a price override is the order's salesperson or the person who wrote it (abuse case 3). */
export class PriceApproverIsSellerError extends BusinessRuleError {
  readonly code = 'MAKER_CANNOT_CHECK';
  readonly messageKey = 'ord.price_seller_cannot_approve';
}
