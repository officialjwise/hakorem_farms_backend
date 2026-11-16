import { BusinessRuleError } from '../../../platform/errors/api-error';
import { registerMessages } from '../../../platform/i18n/messages';
import type { PostingRefusal } from '../domain/posting';

/** FIN's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'fin.period_not_open': 'This falls in an accounting period that is not open, so nothing was recorded.',
  'fin.posting_rule_missing': 'The ledger has no complete posting rule for this, so nothing was recorded. Contact the accountant.',
  'fin.subledger_required': 'The ledger needs to know which party this belongs to, so nothing was recorded. Contact the accountant.',
});

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
