import { BusinessRuleError } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';

/** CST's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'cst.rule': 'This value breaks a rule of costing.',
  'cst.allocation_invalid': 'This allocation cannot be made like this.',
  'cst.maker_cannot_check': 'The person who created this allocation cannot post it.',
  'cst.report_period_invalid': 'Choose dates up to today, the start on or before the end.',
});

export interface CstRule {
  readonly field: string | null;
  readonly rule: string;
}

/**
 * 422 ALLOCATION_INVALID, each broken rule in `details[].code`: `PERIOD_INVALID` (the end before the start, or after
 * today), `SCOPE_NOT_A_PEN` (the scope is virtual, in transit, a site or another branch's), `BASIS_NOT_SUPPORTED`
 * (WEIGHT_GAIN, BL-128), `NO_ANIMALS_IN_SCOPE`, `ALREADY_POSTED`, `PERIOD_ALREADY_POSTED` (a run for the same branch,
 * element, scope and period is posted), and `UNIT_NOT_ON_HAND` (a capitalised share's animal has left since the run was
 * made: make the run again).
 */
export class AllocationInvalidError extends BusinessRuleError {
  readonly code = 'ALLOCATION_INVALID';
  readonly messageKey = 'cst.allocation_invalid';
  constructor(rules: readonly CstRule[]) {
    super('the allocation breaks a rule', rules.map((r) => ({ field: r.field, code: r.rule, message: translate('cst.rule') })));
  }
}

/** 422 MAKER_CANNOT_CHECK: the person who created an allocation run never posts it (FR-CST-002, ADR-0017). */
export class MakerCannotCheckError extends BusinessRuleError {
  readonly code = 'MAKER_CANNOT_CHECK';
  readonly messageKey = 'cst.maker_cannot_check';
}

/** 422 REPORT_PERIOD_INVALID: a range that ends after today or starts after it ends. */
export class CostingPeriodInvalidError extends BusinessRuleError {
  readonly code = 'REPORT_PERIOD_INVALID';
  readonly messageKey = 'cst.report_period_invalid';
  constructor(rules: readonly CstRule[]) {
    super('the period cannot be reported', rules.map((r) => ({ field: r.field, code: r.rule, message: translate('cst.report_period_invalid') })));
  }
}
