import { formatCedis } from '@hakorem/kernel';
import { BusinessRuleError } from '../../../platform/errors/api-error';
import type { CreditPolicyAnswer } from './order-confirmation-policy';
import { registerMessages, translate } from '../../../platform/i18n/messages';

/** ORD's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'ord.delivery_fee': 'Delivery',
  'ord.extra_delivery_fee': 'Extra delivery',
  'ord.sale_invalid': 'This sale cannot be recorded like this.',
  'ord.quote_required': 'This item has no price for this sale. Raise a quote instead.',
  'ord.price_override_needs_approval': 'This price needs a manager’s approval.',
  'ord.order_invalid': 'This order cannot be taken like this.',
  'ord.stock_short': 'Not enough stock for this line: {short} short of {wanted}.',
  'ord.void_cashier_cannot_approve': 'The cashier who made this sale cannot approve its void.',
  'ord.return_maker_cannot_approve': 'The person who made this return cannot approve it.',
  'ord.price_seller_cannot_approve': 'The person who sold at this price cannot approve it.',
  'ord.credit_limit_exceeded': 'This order would take the customer over their credit limit.',
  'ord.credit_terms_exceeded': 'This customer is past their payment terms.',
  'ord.account_on_hold': 'This customer’s account is on hold.',
  'ord.fulfilment_invalid': 'This pick list cannot be changed like this.',
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

const CREDIT_CODES = { ON_HOLD: ['ACCOUNT_ON_HOLD', 'ord.account_on_hold'], OVER_LIMIT: ['CREDIT_LIMIT_EXCEEDED', 'ord.credit_limit_exceeded'], PAST_TERMS: ['CREDIT_TERMS_EXCEEDED', 'ord.credit_terms_exceeded'] } as const;

/** The words of one credit refusal reason, with the server's own figures (CR-046: the screen never computes money). */
function creditReasonText(reason: keyof typeof CREDIT_CODES, a: CreditPolicyAnswer): string {
  switch (reason) {
    case 'ON_HOLD':
      return `${a.customerName}'s account is on hold. An Owner or Manager must release it, or approve an override for this order.`;
    case 'OVER_LIMIT':
      return `This order would take ${a.customerName} ${formatCedis(a.overLimitPesewas)} over its ${formatCedis(a.limitPesewas)} credit limit.`;
    case 'PAST_TERMS':
      return `${a.customerName} has ${formatCedis(a.overduePesewas)} past its payment terms, the oldest ${String(a.oldestOverdueDays ?? 0)} ${a.oldestOverdueDays === 1 ? 'day' : 'days'} overdue.`;
  }
}

/**
 * 422 CREDIT_LIMIT_EXCEEDED, CREDIT_TERMS_EXCEEDED or ACCOUNT_ON_HOLD (CR-046), by the first reason (the hold, then the
 * limit, then the terms): a credit order the policy refused, with no approved override covering it. Each reason that
 * holds is a detail (`ON_HOLD`, `OVER_LIMIT`, `PAST_TERMS`) whose message names the amounts; `OVERRIDE_REASON_REQUIRED`
 * says an override is asked with a written reason, or `APPROVAL_PENDING` that one waits for its approver.
 */
export class CreditRefusedError extends BusinessRuleError {
  readonly code: string;
  readonly messageKey: string;
  constructor(answer: CreditPolicyAnswer, step: 'confirm' | 'dispatch' | 'hand over' = 'confirm') {
    const first = answer.reasons[0] ?? 'OVER_LIMIT';
    super(
      `credit order refused: ${answer.reasons.join(', ')}`,
      [
        ...answer.reasons.map((r) => ({ field: '/paymentTerms', code: r, message: creditReasonText(r, answer) })),
        answer.overridePending
          ? { field: null, code: 'APPROVAL_PENDING', message: 'A credit override for this order is waiting for an Owner or Manager other than the person who asked.' }
          : { field: '/creditOverrideReason', code: 'OVERRIDE_REASON_REQUIRED', message: `To ask for a credit override, ${step} again with a written reason.` },
      ],
    );
    this.code = CREDIT_CODES[first][0];
    this.messageKey = CREDIT_CODES[first][1];
  }
}

/**
 * 422 FULFILMENT_INVALID (B11, FR-ORD-008 to FR-ORD-013, CR-054): every rule a pick list, a pick, a pack or a question
 * to the customer breaks, each in `details[].code`: `NOT_A_PICK_LOCATION`, `NOTHING_TO_PICK`, `LINE_NOT_ON_ORDER`,
 * `LINE_NOT_OPEN`, `LINE_REPEATED`, `QUANTITY_ABOVE_REMAINING`, `CATCH_WEIGHT_LINE_WHOLE`, `LINE_NOT_ON_PICK_LIST`,
 * `PICK_OVER`, `PICK_ID_REUSED`, `PICK_NOT_FOUND`, `WEIGHT_REQUIRED`, `WEIGHT_SOURCE_REQUIRED`, `STOCK_UNIT_REQUIRED`,
 * `STOCK_UNIT_OTHER_ANIMAL`, `STOCK_UNIT_OTHER_PRODUCT`, `STOCK_UNIT_NOT_TRACKED`, `ONE_ANIMAL_PER_LINE`, `INEXACT_QUANTITY`,
 * `STOCK_SHORT`, `NOTHING_PICKED`, `SHORT_PICK_NOT_AGREED`, `TOLERANCE_EXCEEDED`, `CONSENT_PENDING`, `NO_CONSENT_PENDING`,
 * `CONSENT_KIND_MISMATCH`, `CONSENT_ASKER_CANNOT_ANSWER`, `SAME_PRODUCT`, `PRODUCT_NOT_ACTIVE`, `PRODUCT_NOT_STOCKED`,
 * `UNIT_NOT_SOLD`, `NO_PRICE`, `CATCH_WEIGHT_NOT_AVAILABLE`, `CATCH_WEIGHT_GOES_BY_WEIGHT`, `SHORT_NOT_LESS`.
 */
export class FulfilmentInvalidError extends BusinessRuleError {
  readonly code = 'FULFILMENT_INVALID';
  readonly messageKey = 'ord.fulfilment_invalid';
  constructor(rules: readonly SaleRule[]) {
    super(
      `fulfilment breaks ${rules.map((r) => r.rule).join(', ')}`,
      rules.map((r) => ({ field: r.field, code: r.rule, message: translate('ord.fulfilment_invalid') })),
    );
  }
}
