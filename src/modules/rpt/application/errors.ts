import { BusinessRuleError } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';
import type { PeriodRule } from '../domain/dashboard';

/** RPT's user-facing messages (docs/API.md section 10.3). Registered when the module loads. */
registerMessages({
  'rpt.report_period_invalid': 'This period cannot be reported.',
  'rpt.report_period_rule': 'Choose dates up to today, the start on or before the end, at most 92 days apart.',
});

/** 422: a period that ends after today, starts after it ends, or covers more than 92 days. */
export class ReportPeriodInvalidError extends BusinessRuleError {
  readonly code = 'REPORT_PERIOD_INVALID';
  readonly messageKey = 'rpt.report_period_invalid';

  constructor(rules: readonly PeriodRule[]) {
    super('the period cannot be reported', rules.map((rule) => ({ field: rule.field, code: rule.rule, message: translate('rpt.report_period_rule') })));
  }
}
