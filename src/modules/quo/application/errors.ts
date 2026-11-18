import { ApiError, BusinessRuleError, type ErrorDetail } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';

/** QUO's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'quo.quote_invalid': 'This quote cannot be written or issued like this.',
  'quo.rfq_invalid': 'This request for a quote cannot be taken like this.',
  'quo.rule': 'This value breaks a quote rule.',
  'quo.link_closed': 'This quote link no longer opens the quote.',
  'quo.link_expired': 'This quote has expired. Please ask us for a new one.',
  'quo.link_replaced': 'This quote has been replaced by a newer version. Please use the latest link we sent you.',
  'quo.link_withdrawn': 'This quote has been withdrawn.',
  'quo.already_decided': 'This quote has already been answered.',
  'quo.already_converted': 'This quote has already been turned into an order.',
  'quo.author_cannot_approve': 'The person who drafted this quote version cannot approve its margin.',
});

export interface QuoteRule {
  readonly field: string;
  readonly rule: string;
}

function details(rules: readonly QuoteRule[]): ErrorDetail[] {
  return rules.map((rule) => ({ field: rule.field, code: rule.rule, message: translate('quo.rule') }));
}

/**
 * 422 QUOTE_INVALID, each broken rule in `details[].code`: `BRANCH_REQUIRED`, `CUSTOMER_NOT_ACTIVE`, `RFQ_UNKNOWN`,
 * `RFQ_CLOSED`, `NO_LINES`, `PRODUCT_NOT_ACTIVE`, `NO_CONVERSION`, `INEXACT_QUANTITY`, `STOCK_UNIT_OTHER_PRODUCT`,
 * `STOCK_UNIT_NOT_AVAILABLE`, `ONE_ANIMAL_PER_LINE`, `PRICE_BASIS_MISMATCH`, `LINE_NOT_PRICED`, `VALIDITY_PASSED`,
 * `STOCK_SHORT` (the stock a line would be promised from is not there), `VERSION_OPEN` (a draft or a version waiting
 * for approval already exists), `LINE_WITHOUT_PRODUCT`, `ANIMALS_REQUIRED`, `ANIMAL_NOT_AVAILABLE`.
 */
export class QuoteInvalidError extends BusinessRuleError {
  readonly code = 'QUOTE_INVALID';
  readonly messageKey = 'quo.quote_invalid';
  constructor(rules: readonly QuoteRule[]) {
    super('the quote breaks a rule', details(rules));
  }
}

/** 422 RFQ_INVALID: `PRODUCT_NOT_ACTIVE`, `UOM_NOT_SOLD`, `INEXACT_QUANTITY`, `STOCK_UNIT_OTHER_PRODUCT`, `CUSTOMER_NOT_ACTIVE`, `ASSIGNEE_UNKNOWN`. */
export class RfqInvalidError extends BusinessRuleError {
  readonly code = 'RFQ_INVALID';
  readonly messageKey = 'quo.rfq_invalid';
  constructor(rules: readonly QuoteRule[]) {
    super('the request for quote breaks a rule', details(rules));
  }
}

export type ClosedLinkState = 'EXPIRED' | 'REPLACED' | 'WITHDRAWN';
const CLOSED_MESSAGE: Readonly<Record<ClosedLinkState, string>> = { EXPIRED: 'quo.link_expired', REPLACED: 'quo.link_replaced', WITHDRAWN: 'quo.link_withdrawn' };

/**
 * 422 QUOTE_LINK_CLOSED (CR-047): the link was a real one, but its version is no longer live, so it opens nothing of
 * the quote; `details[0].code` names the state: `EXPIRED`, `REPLACED` (a newer version was issued) or `WITHDRAWN`.
 */
export class QuoteLinkClosedError extends BusinessRuleError {
  readonly code = 'QUOTE_LINK_CLOSED';
  readonly messageKey = 'quo.link_closed';
  constructor(state: ClosedLinkState) {
    super(`the quote link is ${state}`, [{ field: null, code: state, message: translate(CLOSED_MESSAGE[state]) }]);
  }
}

/** 409 QUOTE_ALREADY_DECIDED: the version was accepted, or the quote declined, already (FR-QUO-008: a second use is refused). */
export class QuoteAlreadyDecidedError extends ApiError {
  readonly status = 409;
  readonly code = 'QUOTE_ALREADY_DECIDED';
  readonly messageKey = 'quo.already_decided';
}

/** 409 QUOTE_ALREADY_CONVERTED: a quote converts to exactly one order (FR-QUO-011). */
export class QuoteAlreadyConvertedError extends ApiError {
  readonly status = 409;
  readonly code = 'QUOTE_ALREADY_CONVERTED';
  readonly messageKey = 'quo.already_converted';
}

/** 422 QUOTE_AUTHOR_CANNOT_APPROVE: the checker of a margin is never the version's author (FR-QUO-005, ADR-0017). */
export class QuoteAuthorCannotApproveError extends BusinessRuleError {
  readonly code = 'QUOTE_AUTHOR_CANNOT_APPROVE';
  readonly messageKey = 'quo.author_cannot_approve';
}
