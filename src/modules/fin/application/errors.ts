import { ApiError, BusinessRuleError } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';
import type { AccountRule } from '../domain/accounts';
import type { BankAccountRule } from '../domain/bank-account';
import type { FixedAssetRule } from '../domain/fixed-asset';
import type { ManualJournalRule } from '../domain/manual-journal';
import type { ChangeRule } from '../domain/rule-change';
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
  'fin.manual_journal_invalid': 'This manual journal cannot be recorded like this.',
  'fin.manual_journal_state': 'The manual journal is not in a state that allows this.',
  'fin.journal_unbalanced': 'The debits of this journal do not equal its credits.',
  'fin.opening_already_posted': 'The opening balance journal has already been entered.',
  'fin.posting_rule_invalid': 'This posting rule or account mapping cannot be changed like this.',
  'fin.not_maker': 'Only the person who drafted this journal can change or submit it.',
  'fin.bank_account_invalid': 'This bank account or wallet cannot be recorded like this.',
  'fin.fixed_asset_invalid': 'This fixed asset cannot be recorded like this.',
  'fin.depreciation_run_exists': 'Depreciation has already been calculated for this period.',
  'fin.depreciation_run_invalid': 'This depreciation run cannot be calculated or posted like this.',
  'fin.maker_is_checker': 'A depreciation run is posted by someone other than the person who calculated it.',
});

/** 422 FIXED_ASSET_INVALID: an asset, a change to it or its disposal breaks a rule; `details[].code` names each (A-199). */
export class FixedAssetInvalidError extends BusinessRuleError {
  readonly code = 'FIXED_ASSET_INVALID';
  readonly messageKey = 'fin.fixed_asset_invalid';
  constructor(rules: readonly (FixedAssetRule | { readonly field: string | null; readonly rule: 'DEPRECIATION_RUN_PENDING' | 'BANK_ACCOUNT_NOT_AVAILABLE' })[]) {
    super(`fixed asset breaks ${rules.map((r) => r.rule).join(', ')}`, rules.map((r) => ({ field: r.field, code: r.rule, message: translate('fin.fixed_asset_invalid') })));
  }
}

/** 422 DEPRECIATION_RUN_EXISTS: a period has one run, ever (FR-FIN-015; the database holds it, `uq_depreciation_run_period`). */
export class DepreciationRunExistsError extends BusinessRuleError {
  readonly code = 'DEPRECIATION_RUN_EXISTS';
  readonly messageKey = 'fin.depreciation_run_exists';
  constructor(periodId: string) {
    super(`period ${periodId} already has a depreciation run`, [{ field: '/periodId', code: 'DEPRECIATION_RUN_EXISTS', message: translate('fin.depreciation_run_exists') }]);
  }
}

/** 422 DEPRECIATION_RUN_INVALID: `PERIOD_NOT_ENDED`, `NOTHING_TO_DEPRECIATE` or `RUN_STALE` in `details[].code` (A-199). */
export class DepreciationRunInvalidError extends BusinessRuleError {
  readonly code = 'DEPRECIATION_RUN_INVALID';
  readonly messageKey = 'fin.depreciation_run_invalid';
  constructor(rule: 'PERIOD_NOT_ENDED' | 'NOTHING_TO_DEPRECIATE' | 'RUN_STALE', field: string | null) {
    super(`depreciation run refused: ${rule}`, [{ field, code: rule, message: translate('fin.depreciation_run_invalid') }]);
  }
}

/** 403 FORBIDDEN: the maker of a depreciation run cannot post it (ADR-0017; the database holds it too). */
export class MakerIsCheckerError extends ApiError {
  readonly status = 403;
  readonly code = 'FORBIDDEN';
  readonly messageKey = 'fin.maker_is_checker';
}

/** 422 MANUAL_JOURNAL_INVALID: a manual journal breaks a rule; `details[].code` names each (FR-FIN-004, FR-FIN-008, A-190). */
export class ManualJournalInvalidError extends BusinessRuleError {
  readonly code = 'MANUAL_JOURNAL_INVALID';
  readonly messageKey = 'fin.manual_journal_invalid';
  constructor(rules: readonly ManualJournalRule[]) {
    super(`manual journal breaks ${rules.map((r) => r.rule).join(', ')}`, rules.map((r) => ({ field: r.field, code: r.rule, message: translate('fin.manual_journal_invalid') })));
  }
}

/** 422 INVALID_STATE_TRANSITION: a manual journal or a rule change is no longer in the state the action needs. */
export class FinStateError extends BusinessRuleError {
  readonly code = 'INVALID_STATE_TRANSITION';
  readonly messageKey = 'error.invalid_state_transition';
  constructor(what: string, status: string) {
    super(`${what} is ${status}`, [{ field: null, code: status, message: translate('fin.manual_journal_state') }]);
  }
}

/** 422 JOURNAL_UNBALANCED: a manual journal's debits differ from its credits, so it is not submitted (FR-FIN-003). */
export class JournalUnbalancedError extends BusinessRuleError {
  readonly code = 'JOURNAL_UNBALANCED';
  readonly messageKey = 'fin.journal_unbalanced';
  constructor(debit: bigint, credit: bigint) {
    super(`debits ${debit} differ from credits ${credit}`, [{ field: '/lines', code: 'UNBALANCED', message: translate('fin.journal_unbalanced') }]);
  }
}

/** 422 OPENING_ALREADY_POSTED: one opening balance journal only, pending or posted (A-005, A-190). */
export class OpeningAlreadyPostedError extends BusinessRuleError {
  readonly code = 'OPENING_ALREADY_POSTED';
  readonly messageKey = 'fin.opening_already_posted';
  constructor() {
    super('an opening balance journal is already pending or posted', [{ field: '/kind', code: 'OPENING_ALREADY_POSTED', message: translate('fin.opening_already_posted') }]);
  }
}

/** 422 POSTING_RULE_INVALID: a posting rule or determination change breaks a rule; `details[].code` names it (A-191). */
export class PostingRuleInvalidError extends BusinessRuleError {
  readonly code = 'POSTING_RULE_INVALID';
  readonly messageKey = 'fin.posting_rule_invalid';
  constructor(rules: readonly (ChangeRule | { readonly field: string; readonly rule: 'CHANGE_PENDING' })[]) {
    super(`posting rule change breaks ${rules.map((r) => r.rule).join(', ')}`, rules.map((r) => ({ field: r.field, code: r.rule, message: translate('fin.posting_rule_invalid') })));
  }
}

/** 422 BANK_ACCOUNT_INVALID: a bank account breaks a rule; `details[].code` names it, never the number (A-194). */
export class BankAccountInvalidError extends BusinessRuleError {
  readonly code = 'BANK_ACCOUNT_INVALID';
  readonly messageKey = 'fin.bank_account_invalid';
  constructor(rules: readonly BankAccountRule[]) {
    super(`bank account breaks ${rules.map((r) => r.rule).join(', ')}`, rules.map((r) => ({ field: r.field, code: r.rule, message: translate('fin.bank_account_invalid') })));
  }
}

/** 403 FORBIDDEN: only the person who drafted a manual journal changes or submits it, so the maker is one person (ADR-0017). */
export class NotMakerError extends ApiError {
  readonly status = 403;
  readonly code = 'FORBIDDEN';
  readonly messageKey = 'fin.not_maker';
}

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
