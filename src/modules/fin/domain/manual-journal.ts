import { err, Money, ok, type Result } from '@hakorem/kernel';
import type { PostingAmount, Side, SubledgerKind, SubledgerRef } from './posting';

/** The most lines one manual journal may carry: enough for an opening balance, few enough to review. */
export const MAX_MANUAL_LINES = 200;

/** One line of a manual journal as entered (FR-FIN-008). `amountPesewas` is a JSON integer of pesewas. */
export interface ManualLine {
  readonly accountId: string;
  readonly side: Side;
  readonly amountPesewas: number;
  readonly subledgerPartyId: string | null;
  readonly memo: string | null;
}

export interface ManualJournalDraft {
  readonly kind: 'MANUAL' | 'OPENING';
  readonly postingDate: string;
  readonly lines: readonly ManualLine[];
}

/** What the check needs to know: the accounts and parties the lines name, today in Africa/Accra, the opening equity code. */
export interface ManualJournalFacts {
  readonly today: string;
  readonly openingEquityCode: string;
  /** `postable` is postable, active and not archived. */
  readonly accounts: ReadonlyMap<string, { readonly id: string; readonly code: string; readonly postable: boolean; readonly subledgerKind: SubledgerKind | null }>;
  readonly parties: ReadonlyMap<string, { readonly id: string; readonly kind: SubledgerKind; readonly refId: string; readonly displayName: string }>;
}

export type ManualJournalRuleCode =
  | 'TOO_FEW_LINES'
  | 'TOO_MANY_LINES'
  | 'FUTURE_DATE'
  | 'UNKNOWN_ACCOUNT'
  | 'ACCOUNT_NOT_POSTABLE'
  | 'SUBLEDGER_REQUIRED'
  | 'SUBLEDGER_NOT_ALLOWED'
  | 'SUBLEDGER_KIND_DIFFERS'
  | 'UNKNOWN_SUBLEDGER'
  | 'AMOUNT_NOT_POSITIVE'
  | 'OPENING_WITHOUT_3900';

export interface ManualJournalRule {
  readonly field: string;
  readonly rule: ManualJournalRuleCode;
}

function partyRule(line: ManualLine, kind: SubledgerKind | null, facts: ManualJournalFacts): ManualJournalRuleCode | null {
  if (line.subledgerPartyId === null) {
    return kind === null ? null : 'SUBLEDGER_REQUIRED';
  }
  if (kind === null) {
    return 'SUBLEDGER_NOT_ALLOWED';
  }
  const party = facts.parties.get(line.subledgerPartyId);
  if (party === undefined) {
    return 'UNKNOWN_SUBLEDGER';
  }
  return party.kind === kind ? null : 'SUBLEDGER_KIND_DIFFERS';
}

/**
 * Every rule a manual journal breaks, in the order of its fields (FR-FIN-004, FR-FIN-008, A-190): two to
 * `MAX_MANUAL_LINES` lines; dated today or earlier (a journal never posts ahead of the day it is approved); each line on
 * a postable, active account, for a positive amount, naming a subledger party exactly when the account is a control
 * account and a party of its kind; an opening balance journal has its balancing line on opening balance equity (A-005).
 * Balance is not a rule here: a draft may be unbalanced, and only a balanced one is submitted (`judgeSubmit`).
 */
export function checkManualJournal(draft: ManualJournalDraft, facts: ManualJournalFacts): ManualJournalRule[] {
  const rules: ManualJournalRule[] = [];
  if (draft.lines.length < 2) {
    rules.push({ field: '/lines', rule: 'TOO_FEW_LINES' });
  } else if (draft.lines.length > MAX_MANUAL_LINES) {
    rules.push({ field: '/lines', rule: 'TOO_MANY_LINES' });
  }
  if (draft.postingDate > facts.today) {
    rules.push({ field: '/postingDate', rule: 'FUTURE_DATE' });
  }
  draft.lines.forEach((line, index) => {
    const at = `/lines/${index}`;
    const account = facts.accounts.get(line.accountId);
    if (account === undefined) {
      rules.push({ field: `${at}/accountId`, rule: 'UNKNOWN_ACCOUNT' });
    } else if (!account.postable) {
      rules.push({ field: `${at}/accountId`, rule: 'ACCOUNT_NOT_POSTABLE' });
    } else {
      const party = partyRule(line, account.subledgerKind, facts);
      if (party !== null) {
        rules.push({ field: `${at}/subledgerPartyId`, rule: party });
      }
    }
    if (!Number.isSafeInteger(line.amountPesewas) || line.amountPesewas <= 0) {
      rules.push({ field: `${at}/amountPesewas`, rule: 'AMOUNT_NOT_POSITIVE' });
    }
  });
  if (draft.kind === 'OPENING' && !draft.lines.some((l) => facts.accounts.get(l.accountId)?.code === facts.openingEquityCode)) {
    rules.push({ field: '/lines', rule: 'OPENING_WITHOUT_3900' });
  }
  return rules;
}

export interface JournalTotals {
  readonly debit: Money;
  readonly credit: Money;
  /** Debits equal credits over at least two lines. */
  readonly balanced: boolean;
}

/** Each side summed exactly. */
export function journalTotals(lines: readonly Pick<ManualLine, 'side' | 'amountPesewas'>[]): JournalTotals {
  const debit = Money.sum(lines.filter((l) => l.side === 'D').map((l) => Money.fromJsonInteger(l.amountPesewas)));
  const credit = Money.sum(lines.filter((l) => l.side === 'C').map((l) => Money.fromJsonInteger(l.amountPesewas)));
  return { debit, credit, balanced: lines.length >= 2 && debit.equals(credit) };
}

export type ManualJournalStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'POSTED' | 'REJECTED';

/** Only a balanced draft is submitted for approval; anything else names its status, or `UNBALANCED`. */
export function judgeSubmit(status: ManualJournalStatus, totals: JournalTotals): Result<void, Exclude<ManualJournalStatus, 'DRAFT'> | 'UNBALANCED'> {
  if (status !== 'DRAFT') {
    return err(status);
  }
  return totals.balanced ? ok(undefined) : err('UNBALANCED');
}

/**
 * The named amounts of `fin.ManualJournalApproved`: one per line, in the order entered, keyed by its side and carrying
 * the account and party entered, so the ledger posts it through the same rules, numbering and database checks as every
 * other event (ADR-0003, "As entered").
 */
export function manualPostingAmounts(
  lines: readonly ManualLine[],
  parties: ReadonlyMap<string, { readonly kind: SubledgerKind; readonly refId: string; readonly displayName: string }>,
): PostingAmount[] {
  return lines.map((l) => {
    const party = l.subledgerPartyId === null ? undefined : parties.get(l.subledgerPartyId);
    const subledgers: SubledgerRef[] = party === undefined ? [] : [{ kind: party.kind, refId: party.refId, displayName: party.displayName }];
    return { key: l.side === 'D' ? 'debit' : 'credit', amount: Money.fromJsonInteger(l.amountPesewas), enteredAccountId: l.accountId, subledgers, memo: l.memo };
  });
}
