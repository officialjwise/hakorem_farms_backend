import { ApiError, BusinessRuleError, type ErrorDetail } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';

/** CAP's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'cap.rule': 'This value breaks a rule of the investor books.',
  'cap.investor_invalid': 'This investor cannot be recorded like this.',
  'cap.capital_invalid': 'This capital transaction cannot be recorded like this.',
  'cap.run_invalid': 'This distribution run cannot be made like this.',
  'cap.payment_invalid': 'This distribution payment cannot be recorded like this.',
  'cap.maker_cannot_check': 'The person who asked cannot approve this.',
  'cap.reference_taken': 'This bank or mobile money reference is already recorded.',
});

export interface CapRule {
  readonly field: string | null;
  readonly rule: string;
}

const details = (rules: readonly CapRule[]): ErrorDetail[] => rules.map((r) => ({ field: r.field, code: r.rule, message: translate('cap.rule') }));

/**
 * 422 INVESTOR_INVALID, each broken rule in `details[].code`: `INVESTOR_HAS_UNITS` (an investor holding units cannot exit),
 * `FIELD_NOT_YET_SUPPORTED` (payout details, the identity number, the agreement and the portal login are B12 continued's).
 */
export class InvestorInvalidError extends BusinessRuleError {
  readonly code = 'INVESTOR_INVALID';
  readonly messageKey = 'cap.investor_invalid';
  constructor(rules: readonly CapRule[]) {
    super('the investor breaks a rule', details(rules));
  }
}

/**
 * 422 CAPITAL_TRANSACTION_INVALID, each broken rule in `details[].code`: `INVESTOR_UNKNOWN`, `INVESTOR_EXITED`,
 * `BANK_ACCOUNT_UNKNOWN`, `BANK_ACCOUNT_INACTIVE`, `UNITS_NOT_EXACT` (the amount does not buy whole ten-thousandths of a
 * unit at the price), `VALUE_DATE_IN_FUTURE`, `PERIOD_NOT_OPEN` (the value date's accounting period is locked, closed or
 * not opened), `MORE_THAN_HELD` (a withdrawal of more units than are held on its value date or any day after),
 * `APPROVAL_PENDING` (a withdrawal of the investor already waits for its approver).
 */
export class CapitalTransactionInvalidError extends BusinessRuleError {
  readonly code = 'CAPITAL_TRANSACTION_INVALID';
  readonly messageKey = 'cap.capital_invalid';
  constructor(rules: readonly CapRule[]) {
    super('the capital transaction breaks a rule', details(rules));
  }
}

/**
 * 422 DISTRIBUTION_RUN_INVALID, each broken rule in `details[].code`: `PERIOD_REVERSED`, `PERIOD_NOT_ENDED`,
 * `PERIOD_NOT_IN_LEDGER` (a day of the period has no accounting period), `PERIOD_NOT_LOCKED` (an accounting period it
 * touches is still open), `PERIOD_ALREADY_DISTRIBUTED` (another run that was not rejected covers a day of it),
 * `NO_UNIT_DAYS` (nobody held units in the period: never an equal split), `NOTHING_TO_DISTRIBUTE` (a loss or nothing
 * left after retention cannot be submitted), and the lifecycle's `RUN_NOT_EDITABLE`, `RUN_NOT_DRAFT`, `RUN_NOT_APPROVED`.
 */
export class DistributionRunInvalidError extends BusinessRuleError {
  readonly code = 'DISTRIBUTION_RUN_INVALID';
  readonly messageKey = 'cap.run_invalid';
  constructor(rules: readonly CapRule[]) {
    super('the distribution run breaks a rule', details(rules));
  }
}

/**
 * 422 DISTRIBUTION_PAYMENT_INVALID, each broken rule in `details[].code`: `RUN_NOT_POSTED`, `LINE_PAID`,
 * `MORE_THAN_PAYABLE` (the line would be paid above its net payable), `NOT_POSITIVE`, `BANK_ACCOUNT_UNKNOWN`,
 * `BANK_ACCOUNT_INACTIVE`.
 */
export class DistributionPaymentInvalidError extends BusinessRuleError {
  readonly code = 'DISTRIBUTION_PAYMENT_INVALID';
  readonly messageKey = 'cap.payment_invalid';
  constructor(rules: readonly CapRule[]) {
    super('the distribution payment breaks a rule', details(rules));
  }
}

/** 422 MAKER_CANNOT_CHECK: the person who asked for a withdrawal or drafted a run never approves it (ADR-0017). */
export class MakerCannotCheckError extends BusinessRuleError {
  readonly code = 'MAKER_CANNOT_CHECK';
  readonly messageKey = 'cap.maker_cannot_check';
}

/** 409 DUPLICATE_VALUE: a payment's bank or mobile money reference is recorded once. */
export class PaymentReferenceTakenError extends ApiError {
  readonly status = 409;
  readonly code = 'DUPLICATE_VALUE';
  readonly messageKey = 'cap.reference_taken';
}
