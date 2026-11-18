import { ApiError, BusinessRuleError, type ErrorDetail } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';

/** WHL's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'whl.statement_invalid': 'This statement cannot be produced like this.',
  'whl.rule': 'This value breaks a statement rule.',
  'whl.account_invalid': 'This business account cannot be changed like this.',
  'whl.account_rule': 'This value breaks a business account rule.',
  'whl.account_exists': 'This customer already has a business account.',
  'whl.credit_override_invalid': 'A credit override cannot be asked for this order.',
  'whl.asker_cannot_approve': 'The person who asked cannot approve this.',
});

export interface StatementRule {
  readonly field: string;
  readonly rule: string;
}

function details(rules: readonly StatementRule[]): ErrorDetail[] {
  return rules.map((rule) => ({ field: rule.field, code: rule.rule, message: translate('whl.rule') }));
}

/**
 * 422 STATEMENT_INVALID, each broken rule in `details[].code`: `BRANCH_REQUIRED` (no `branchId`, and the caller produces
 * statements at more than one branch), `CUSTOMER_UNKNOWN`, `PERIOD_REVERSED`, `PERIOD_NOT_ENDED` (it ends after today),
 * `PERIOD_TOO_LONG` (more than 366 days).
 */
export class StatementInvalidError extends BusinessRuleError {
  readonly code = 'STATEMENT_INVALID';
  readonly messageKey = 'whl.statement_invalid';
  constructor(rules: readonly StatementRule[]) {
    super('the statement breaks a rule', details(rules));
  }
}

function accountDetails(rules: readonly StatementRule[]): ErrorDetail[] {
  return rules.map((rule) => ({ field: rule.field, code: rule.rule, message: translate('whl.account_rule') }));
}

/**
 * 422 ACCOUNT_INVALID, each broken rule in `details[].code`: `CUSTOMER_UNKNOWN`, `BRANCH_REQUIRED`, `MANAGER_UNKNOWN`,
 * `ACCOUNT_ON_HOLD` (a held account is released, never reopened or closed by an edit), `ACCOUNT_CLOSED`, `NOT_ON_HOLD`,
 * `ALREADY_ON_HOLD`, `APPROVAL_PENDING` (a change of that kind already waits for its approver), `PRICE_LIST_THROUGH_MDM` (the
 * price list is set with assignCustomerPriceList).
 */
export class AccountInvalidError extends BusinessRuleError {
  readonly code = 'ACCOUNT_INVALID';
  readonly messageKey = 'whl.account_invalid';
  constructor(rules: readonly StatementRule[]) {
    super('the business account breaks a rule', accountDetails(rules));
  }
}

/** 409 ACCOUNT_EXISTS: a customer has at most one business account (FR-WHL-001). */
export class AccountExistsError extends ApiError {
  readonly status = 409;
  readonly code = 'ACCOUNT_EXISTS';
  readonly messageKey = 'whl.account_exists';
}

/**
 * 422 ORDER_INVALID on requestCreditOverride (CR-046): `CREDIT_OVERRIDE_NOT_NEEDED` (the check passes, or an approved
 * override covers the order), `APPROVAL_PENDING`, `CREDIT_CHECK_UNAVAILABLE` (no open business account), `NOT_CREDIT`
 * (the order is not on credit terms), `ORDER_NOT_PLACED`.
 */
export class CreditOverrideInvalidError extends BusinessRuleError {
  readonly code = 'ORDER_INVALID';
  readonly messageKey = 'whl.credit_override_invalid';
  constructor(rule: string) {
    super(`credit override refused: ${rule}`, [{ field: null, code: rule, message: translate('whl.credit_override_invalid') }]);
  }
}

/**
 * 422 MAKER_CANNOT_CHECK, raised by WHL's own handlers as well as IAM's: a credit override, a hold's release or a credit
 * limit change is never decided by the person who asked (ADR-0017, CR-048); the database refuses it too.
 */
export class AskerCannotApproveError extends BusinessRuleError {
  readonly code = 'MAKER_CANNOT_CHECK';
  readonly messageKey = 'whl.asker_cannot_approve';
}
