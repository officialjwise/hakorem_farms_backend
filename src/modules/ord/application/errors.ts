import { BusinessRuleError } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';

/** ORD's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'ord.sale_invalid': 'This sale cannot be recorded like this.',
  'ord.quote_required': 'This item has no price for this sale. Raise a quote instead.',
  'ord.price_override_needs_approval': 'This price needs a manager’s approval.',
});

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
    super(`sale breaks ${rules.map((r) => r.rule).join(', ')}`, rules.map((r) => ({ field: r.field, code: r.rule, message: translate('ord.sale_invalid') })));
  }
}

/** 422 QUOTE_REQUIRED: the pricing engine cannot price a line; the sale raises a quote instead (FR-MDM-016). */
export class QuoteRequiredError extends BusinessRuleError {
  readonly code = 'QUOTE_REQUIRED';
  readonly messageKey = 'ord.quote_required';
  constructor(lines: readonly { readonly field: string; readonly reason: string }[]) {
    super(`no price for ${lines.map((l) => l.field).join(', ')}`, lines.map((l) => ({ field: l.field, code: l.reason, message: translate('ord.quote_required') })));
  }
}

/** 422 PRICE_OVERRIDE_NEEDS_APPROVAL (FR-ORD-003): outside the band, or below list beyond what the seller may give. */
export class PriceOverrideNeedsApprovalError extends BusinessRuleError {
  readonly code = 'PRICE_OVERRIDE_NEEDS_APPROVAL';
  readonly messageKey = 'ord.price_override_needs_approval';
  constructor(lines: readonly { readonly field: string; readonly reason: string }[]) {
    super(`price override needs approval on ${lines.map((l) => l.field).join(', ')}`, lines.map((l) => ({ field: l.field, code: l.reason, message: translate('ord.price_override_needs_approval') })));
  }
}
