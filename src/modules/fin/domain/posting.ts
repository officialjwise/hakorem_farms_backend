import { err, ok, type Money, type Result } from '@hakorem/kernel';
import { numbered } from './line-numbers';

/** The side of a journal line. Amounts are never negative; direction is the side (ADR-0001). */
export type Side = 'D' | 'C';

export type DeterminantType = 'GL_GROUP' | 'PAYMENT_METHOD_KIND' | 'TAX_LEVY' | 'LOSS_GROUP' | 'EXPENSE_CATEGORY' | 'ASSET_CATEGORY';

/**
 * A rule's determinant: one of `fin.account_determination`'s types, or `ENTERED`, the account the amount itself names.
 * Only `fin.ManualJournalApproved` posts as entered (ADR-0003's "As entered", A-190): a person chose each account, and
 * the approval checked it; every other event's accounts come from the rules and determinations.
 */
export type RuleDeterminant = DeterminantType | 'ENTERED';

/** The determinant and role of a rule that posts each amount to the account entered for it. */
export const ENTERED_DETERMINANT = 'ENTERED';
export const ENTERED_ROLE = 'AS_ENTERED';

export type SubledgerKind = 'CUSTOMER' | 'SUPPLIER' | 'INVESTOR' | 'TAX_LEVY' | 'REGISTER' | 'DRIVER' | 'BANK_ACCOUNT' | 'PROVIDER';

/** The party a control account line is held against: its kind, its id in the owning module, and a name for statements. */
export interface SubledgerRef {
  readonly kind: SubledgerKind;
  readonly refId: string;
  readonly displayName: string;
}

/**
 * One named amount of a financial event (ADR-0003): the event names amounts and determinants, never accounts. The
 * subledger parties it may need are listed by kind; each line takes the one its account's subledger asks for.
 */
export interface PostingAmount {
  readonly key: string;
  readonly amount: Money;
  readonly determinants?: Readonly<Partial<Record<DeterminantType, string>>>;
  readonly subledgers?: readonly SubledgerRef[];
  readonly memo?: string | null;
  readonly costObjectId?: string | null;
  /** The account a person entered for this amount; read only by a rule whose determinant is `ENTERED`. */
  readonly enteredAccountId?: string;
}

/** `fin.posting_rule`: one named amount, one side, to a fixed account or to the account a determinant maps to. */
export interface PostingRule {
  readonly amountKey: string;
  readonly side: Side;
  readonly accountId: string | null;
  readonly determinantType: RuleDeterminant | null;
  readonly determinantRole: string | null;
}

/** `fin.account_determination`: a determinant value (or `*`, the default) mapped to an account for one role. */
export interface Determination {
  readonly type: DeterminantType;
  readonly key: string;
  readonly role: string;
  readonly accountId: string;
}

/** What posting needs to know of an account. `postable` is postable, active and not archived. */
export interface LedgerAccount {
  readonly id: string;
  readonly code: string;
  readonly subledgerKind: SubledgerKind | null;
  readonly postable: boolean;
}

/** The rules of one event valid on the posting date, with the determinations and accounts they may name. */
export interface RuleSet {
  readonly rules: readonly PostingRule[];
  readonly determinations: readonly Determination[];
  readonly accounts: ReadonlyMap<string, LedgerAccount>;
}

export interface JournalLineDraft {
  readonly lineNo: number;
  readonly accountId: string;
  readonly accountCode: string;
  readonly side: Side;
  readonly amount: Money;
  readonly subledger: SubledgerRef | null;
  readonly memo: string | null;
  readonly costObjectId: string | null;
}

export type PostingRefusal =
  | { readonly rule: 'UNKNOWN_AMOUNT'; readonly amountKey: string }
  | { readonly rule: 'NO_RULE'; readonly amountKey: string }
  | { readonly rule: 'NO_ACCOUNT'; readonly amountKey: string; readonly determinantType: RuleDeterminant; readonly key: string; readonly role: string }
  | { readonly rule: 'ACCOUNT_NOT_POSTABLE'; readonly accountCode: string }
  | { readonly rule: 'SUBLEDGER_MISSING'; readonly accountCode: string; readonly kind: SubledgerKind }
  | { readonly rule: 'UNBALANCED'; readonly debits: bigint; readonly credits: bigint };

/** The default determination key: a determinant value with no row of its own takes this one (ADR-0020). */
export const DEFAULT_DETERMINANT_KEY = '*';

function accountOf(rule: PostingRule, amount: PostingAmount, set: RuleSet): Result<string, PostingRefusal> {
  if (rule.accountId !== null) {
    return ok(rule.accountId);
  }
  const type = rule.determinantType!;
  const role = rule.determinantRole!;
  if (type === ENTERED_DETERMINANT) {
    return amount.enteredAccountId === undefined ? err({ rule: 'NO_ACCOUNT', amountKey: amount.key, determinantType: type, key: DEFAULT_DETERMINANT_KEY, role }) : ok(amount.enteredAccountId);
  }
  const key = amount.determinants?.[type] ?? DEFAULT_DETERMINANT_KEY;
  const candidates = set.determinations.filter((d) => d.type === type && d.role === role);
  const found = candidates.find((d) => d.key === key) ?? candidates.find((d) => d.key === DEFAULT_DETERMINANT_KEY);
  return found === undefined ? err({ rule: 'NO_ACCOUNT', amountKey: amount.key, determinantType: type, key, role }) : ok(found.accountId);
}

/**
 * Builds the lines of one journal from an event's named amounts (ADR-0003). Each non-zero amount becomes one line per
 * rule for its key, on the rule's fixed account or the account its determinant maps to, falling back to the `*` row.
 * A control account takes the amount's subledger party of its kind. The lines must balance: a rule set that does not
 * is refused, so the business operation that published the event rolls back. An event whose amounts are all zero has
 * no lines, and so no entry.
 */
export function buildJournalLines(amounts: readonly PostingAmount[], set: RuleSet, amountKeys: readonly string[]): Result<JournalLineDraft[], PostingRefusal> {
  const lines: Omit<JournalLineDraft, 'lineNo'>[] = [];
  let debits = 0n;
  let credits = 0n;
  for (const amount of amounts) {
    if (!amountKeys.includes(amount.key)) {
      return err({ rule: 'UNKNOWN_AMOUNT', amountKey: amount.key });
    }
    if (amount.amount.isZero()) {
      continue;
    }
    const rules = set.rules.filter((r) => r.amountKey === amount.key);
    if (rules.length === 0) {
      return err({ rule: 'NO_RULE', amountKey: amount.key });
    }
    for (const rule of rules) {
      const accountId = accountOf(rule, amount, set);
      if (!accountId.ok) {
        return accountId;
      }
      const target = set.accounts.get(accountId.value);
      if (target === undefined || !target.postable) {
        return err({ rule: 'ACCOUNT_NOT_POSTABLE', accountCode: target?.code ?? accountId.value });
      }
      let subledger: SubledgerRef | null = null;
      if (target.subledgerKind !== null) {
        const party = amount.subledgers?.find((s) => s.kind === target.subledgerKind);
        if (party === undefined) {
          return err({ rule: 'SUBLEDGER_MISSING', accountCode: target.code, kind: target.subledgerKind });
        }
        subledger = party;
      }
      if (rule.side === 'D') {
        debits += amount.amount.pesewas;
      } else {
        credits += amount.amount.pesewas;
      }
      lines.push({
        accountId: target.id,
        accountCode: target.code,
        side: rule.side,
        amount: amount.amount,
        subledger,
        memo: amount.memo ?? null,
        costObjectId: amount.costObjectId ?? null,
      });
    }
  }
  if (debits !== credits) {
    return err({ rule: 'UNBALANCED', debits, credits });
  }
  return ok(numbered(lines));
}

/** A correction: the original's lines with every side swapped, nothing recomputed (ADR-0003, hakorem-ledger 8). */
export function reverseLines<L extends { readonly side: Side }>(lines: readonly L[]): L[] {
  return lines.map((line) => ({ ...line, side: line.side === 'D' ? 'C' : 'D' }));
}

/** Debits less credits of a set of lines, as an exact integer: zero for a balanced entry. */
export function signedTotal(lines: readonly { readonly side: Side; readonly amount: Money }[]): bigint {
  return lines.reduce((sum, line) => (line.side === 'D' ? sum + line.amount.pesewas : sum - line.amount.pesewas), 0n);
}
