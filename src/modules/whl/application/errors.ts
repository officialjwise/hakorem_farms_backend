import { BusinessRuleError, type ErrorDetail } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';

/** WHL's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'whl.statement_invalid': 'This statement cannot be produced like this.',
  'whl.rule': 'This value breaks a statement rule.',
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
