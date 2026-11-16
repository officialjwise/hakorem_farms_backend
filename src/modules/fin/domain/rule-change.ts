import { err, ok, type Result } from '@hakorem/kernel';
import { ENTERED_DETERMINANT, type DeterminantType, type RuleDeterminant, type Side, type SubledgerKind } from './posting';

/** A posting rule with its validity, `[validFrom, validTo)`, as `fin.posting_rule` holds it. */
export interface DatedRule {
  readonly id: string;
  readonly eventCode: string;
  readonly amountKey: string;
  readonly side: Side;
  readonly accountId: string | null;
  readonly determinantType: RuleDeterminant | null;
  readonly determinantRole: string | null;
  readonly validFrom: string;
  readonly validTo: string | null;
}

/** An account determination with its validity, as `fin.account_determination` holds it. */
export interface DatedDetermination {
  readonly id: string;
  readonly type: DeterminantType;
  readonly key: string;
  readonly role: string;
  readonly accountId: string;
  readonly validFrom: string;
  readonly validTo: string | null;
}

/** What a change is judged against: the event catalogue, every live rule and determination, and the accounts. */
export interface ChangeFacts {
  readonly today: string;
  /** `fin.posting_event_type`: each event's amount keys. */
  readonly eventTypes: ReadonlyMap<string, readonly string[]>;
  readonly rules: readonly DatedRule[];
  readonly determinations: readonly DatedDetermination[];
  /** `postable` is postable, active and not archived. */
  readonly accounts: ReadonlyMap<string, { readonly id: string; readonly code: string; readonly postable: boolean; readonly subledgerKind: SubledgerKind | null }>;
}

export interface RuleProposal {
  readonly eventCode: string;
  readonly amountKey: string;
  readonly side: Side;
  readonly accountId: string | null;
  readonly determinantType: RuleDeterminant | null;
  readonly determinantRole: string | null;
  readonly validFrom: string;
}

export interface DeterminationProposal {
  readonly determinantType: DeterminantType;
  readonly determinantKey: string;
  readonly role: string;
  readonly accountId: string;
  readonly validFrom: string;
}

export type ChangeRuleCode =
  | 'UNKNOWN_EVENT'
  | 'UNKNOWN_AMOUNT'
  | 'POSTS_AS_ENTERED'
  | 'TARGET_INVALID'
  | 'VALID_FROM_PAST'
  | 'LATER_RULE_EXISTS'
  | 'NOTHING_TO_REPLACE'
  | 'UNKNOWN_ACCOUNT'
  | 'ACCOUNT_NOT_POSTABLE'
  | 'NO_DETERMINATION'
  | 'SUBLEDGER_DIFFERS'
  | 'UNCHANGED';

export interface ChangeRule {
  readonly field: string;
  readonly rule: ChangeRuleCode;
}

const refuse = (field: string, rule: ChangeRuleCode) => err([{ field, rule }]);

function inForce(row: { readonly validFrom: string; readonly validTo: string | null }, date: string): boolean {
  return row.validFrom <= date && (row.validTo === null || row.validTo > date);
}

function sameKinds(a: ReadonlySet<SubledgerKind | null>, b: ReadonlySet<SubledgerKind | null>): boolean {
  return a.size === b.size && [...a].every((kind) => b.has(kind));
}

/** The subledger kinds of every account a rule can post to on the date: its own, or each its determinant maps to. */
function kindsOf(target: Pick<RuleProposal, 'accountId' | 'determinantType' | 'determinantRole'>, facts: ChangeFacts, date: string): Set<SubledgerKind | null> {
  const ids =
    target.accountId !== null
      ? [target.accountId]
      : facts.determinations.filter((d) => d.type === target.determinantType && d.role === target.determinantRole && inForce(d, date)).map((d) => d.accountId);
  return new Set(ids.map((id) => facts.accounts.get(id)!.subledgerKind));
}

function accountRule(accountId: string, facts: ChangeFacts): ChangeRuleCode | null {
  const account = facts.accounts.get(accountId);
  if (account === undefined) return 'UNKNOWN_ACCOUNT';
  return account.postable ? null : 'ACCOUNT_NOT_POSTABLE';
}

/**
 * Whether a posting rule may replace the rule in force for one event, amount and side from `validFrom` (FR-FIN-005,
 * A-191), each the most conservative reading: the event and amount are catalogued (amounts change only by migration);
 * a journal posted as entered keeps its rules; the target is exactly one postable account, or one determinant with its
 * role that has determinations in force (never `ENTERED`); the date is today or later and no rule for the same amount
 * and side starts on or after it; a rule in force on that date is replaced (a change never adds a line, so every
 * event's rules stay balanced and the boot assertion whole); the new target posts to accounts of the same subledger
 * kinds as the old (so no posting starts failing for want of a party); and it changes something. Nothing posted before
 * is touched: the old rule is end-dated, never edited or re-posted.
 */
export function checkRuleChange(proposal: RuleProposal, facts: ChangeFacts): Result<{ readonly replaces: string }, ChangeRule[]> {
  const amountKeys = facts.eventTypes.get(proposal.eventCode);
  if (amountKeys === undefined) return refuse('/eventCode', 'UNKNOWN_EVENT');
  if (!amountKeys.includes(proposal.amountKey)) return refuse('/amountKey', 'UNKNOWN_AMOUNT');
  const same = facts.rules.filter((r) => r.eventCode === proposal.eventCode && r.amountKey === proposal.amountKey && r.side === proposal.side);
  if (facts.rules.some((r) => r.eventCode === proposal.eventCode && r.determinantType === ENTERED_DETERMINANT)) return refuse('/eventCode', 'POSTS_AS_ENTERED');
  const fixed = proposal.accountId !== null;
  const determined = proposal.determinantType !== null && proposal.determinantRole !== null;
  if (fixed === (proposal.determinantType !== null) || (!fixed && !determined) || proposal.determinantType === ENTERED_DETERMINANT) return refuse('/accountId', 'TARGET_INVALID');
  if (proposal.validFrom < facts.today) return refuse('/validFrom', 'VALID_FROM_PAST');
  if (same.some((r) => r.validFrom >= proposal.validFrom)) return refuse('/validFrom', 'LATER_RULE_EXISTS');
  const replaced = same.find((r) => inForce(r, proposal.validFrom));
  if (replaced === undefined) return refuse('/side', 'NOTHING_TO_REPLACE');
  if (fixed) {
    const problem = accountRule(proposal.accountId!, facts);
    if (problem !== null) return refuse('/accountId', problem);
  } else if (kindsOf(proposal, facts, proposal.validFrom).size === 0) {
    return refuse('/determinantType', 'NO_DETERMINATION');
  }
  if (!sameKinds(kindsOf(proposal, facts, proposal.validFrom), kindsOf(replaced, facts, proposal.validFrom))) return refuse('/accountId', 'SUBLEDGER_DIFFERS');
  if (replaced.accountId === proposal.accountId && replaced.determinantType === proposal.determinantType && replaced.determinantRole === proposal.determinantRole) {
    return refuse('/accountId', 'UNCHANGED');
  }
  return ok({ replaces: replaced.id });
}

/**
 * Whether a determination may map one key of a determinant and role to an account from `validFrom` (ADR-0020, A-191):
 * the account is postable; the date is today or later and no row for the same key starts on or after it; the account
 * has the subledger kind of every row of that determinant and role in force (a levy's own account is a levy control
 * account too); and it changes something. A key with no row of its own gets one; a key with a row in force has it
 * replaced, end-dated, never edited.
 */
export function checkDeterminationChange(proposal: DeterminationProposal, facts: ChangeFacts): Result<{ readonly replaces: string | null }, ChangeRule[]> {
  if (proposal.validFrom < facts.today) return refuse('/validFrom', 'VALID_FROM_PAST');
  const problem = accountRule(proposal.accountId, facts);
  if (problem !== null) return refuse('/accountId', problem);
  const same = facts.determinations.filter((d) => d.type === proposal.determinantType && d.key === proposal.determinantKey && d.role === proposal.role);
  if (same.some((d) => d.validFrom >= proposal.validFrom)) return refuse('/validFrom', 'LATER_RULE_EXISTS');
  const siblings = facts.determinations.filter((d) => d.type === proposal.determinantType && d.role === proposal.role && inForce(d, proposal.validFrom));
  const kind = facts.accounts.get(proposal.accountId)!.subledgerKind;
  if (siblings.some((d) => facts.accounts.get(d.accountId)!.subledgerKind !== kind)) return refuse('/accountId', 'SUBLEDGER_DIFFERS');
  const replaced = same.find((d) => inForce(d, proposal.validFrom)) ?? null;
  if (replaced?.accountId === proposal.accountId) return refuse('/accountId', 'UNCHANGED');
  return ok({ replaces: replaced?.id ?? null });
}

/** A change takes effect from the later of the date asked for and the day it is approved: never before its approval. */
export function effectiveFrom(validFrom: string, approvalDay: string): string {
  return validFrom > approvalDay ? validFrom : approvalDay;
}
