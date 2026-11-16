import { BusinessRuleError } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';
import type { AccountRule } from '../domain/accounts';
import type { PostingRefusal } from '../domain/posting';

/** FIN's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'fin.period_not_open': 'This falls in an accounting period that is not open, so nothing was recorded.',
  'fin.posting_rule_missing': 'The ledger has no complete posting rule for this, so nothing was recorded. Contact the accountant.',
  'fin.subledger_required': 'The ledger needs to know which party this belongs to, so nothing was recorded. Contact the accountant.',
  'fin.account_invalid': 'This account cannot be kept in the chart like this.',
  'fin.duplicate_value': 'Another account already uses this code.',
  'fin.reference_not_found': 'Something this request refers to does not exist.',
  'fin.period_state': 'The accounting period is not in a state that allows this.',
});

/** 422 ACCOUNT_INVALID: an account breaks a chart rule; `details[].code` names each (FR-FIN-002). */
export class AccountInvalidError extends BusinessRuleError {
  readonly code = 'ACCOUNT_INVALID';
  readonly messageKey = 'fin.account_invalid';
  constructor(rules: readonly AccountRule[]) {
    super(`account breaks ${rules.map((r) => r.rule).join(', ')}`, rules.map((r) => ({ field: r.field, code: r.rule, message: translate('fin.account_invalid') })));
  }
}

/** 422 DUPLICATE_VALUE: the account code is already used by another live account. */
export class AccountCodeTakenError extends BusinessRuleError {
  readonly code = 'DUPLICATE_VALUE';
  readonly messageKey = 'fin.duplicate_value';
  constructor() {
    super('account code taken', [{ field: '/code', code: 'TAKEN', message: translate('fin.duplicate_value') }]);
  }
}

/** 422 REFERENCE_NOT_FOUND: an id in the request names no live record. */
export class FinReferenceNotFoundError extends BusinessRuleError {
  readonly code = 'REFERENCE_NOT_FOUND';
  readonly messageKey = 'fin.reference_not_found';
  constructor(fields: readonly string[]) {
    super(`unknown ${fields.join(', ')}`, fields.map((field) => ({ field, code: 'UNKNOWN', message: translate('fin.reference_not_found') })));
  }
}

/** 422 INVALID_STATE_TRANSITION: a period cannot move; `details[].code` is its status or the rule (FR-FIN-009, FR-FIN-010). */
export class PeriodStateError extends BusinessRuleError {
  readonly code = 'INVALID_STATE_TRANSITION';
  readonly messageKey = 'error.invalid_state_transition';
  constructor(action: string, refusal: string) {
    super(`period cannot ${action}: ${refusal}`, [{ field: null, code: refusal, message: translate('fin.period_state') }]);
  }
}

/** Why a financial event could not be posted, beyond the rule engine's own refusals. */
export type LedgerRefusal =
  | PostingRefusal
  | { readonly rule: 'PERIOD_NOT_OPEN'; readonly date: string }
  | { readonly rule: 'NOT_CATALOGUED'; readonly eventCode: string }
  | { readonly rule: 'ORIGINAL_NOT_POSTED'; readonly subjectId: string };

function describe(refusal: LedgerRefusal): string {
  return Object.entries(refusal)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}

/**
 * A financial event could not be posted (ADR-0003): the business operation that published it rolls back whole. 422
 * `PERIOD_NOT_OPEN` for a period, `SUBLEDGER_REQUIRED` for a missing party, otherwise `POSTING_RULE_MISSING`.
 */
export class LedgerPostingRefusedError extends BusinessRuleError {
  readonly code: 'PERIOD_NOT_OPEN' | 'SUBLEDGER_REQUIRED' | 'POSTING_RULE_MISSING';
  readonly messageKey: string;

  constructor(
    readonly eventCode: string,
    readonly refusal: LedgerRefusal,
  ) {
    super(`ledger posting of ${eventCode} refused: ${describe(refusal)}`);
    if (refusal.rule === 'PERIOD_NOT_OPEN') {
      this.code = 'PERIOD_NOT_OPEN';
      this.messageKey = 'fin.period_not_open';
    } else if (refusal.rule === 'SUBLEDGER_MISSING') {
      this.code = 'SUBLEDGER_REQUIRED';
      this.messageKey = 'fin.subledger_required';
    } else {
      this.code = 'POSTING_RULE_MISSING';
      this.messageKey = 'fin.posting_rule_missing';
    }
  }
}

/** The boot assertion found a posting event without a handler or a complete rule set (ADR-0003 safeguard one). */
export class LedgerCatalogueIncompleteError extends Error {
  constructor(readonly gaps: readonly string[]) {
    super(`the ledger cannot post every financial event, so the application does not start:\n- ${gaps.join('\n- ')}`);
    this.name = 'LedgerCatalogueIncompleteError';
  }
}
