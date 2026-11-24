import { Money } from '@hakorem/kernel';
import { daysPastDue } from './time';

/** What a credit order is refused for (CR-046). An account on hold is named first, then the limit, then the terms. */
export type CreditReason = 'ON_HOLD' | 'OVER_LIMIT' | 'PAST_TERMS';
export type CreditOutcome = 'PASSES' | CreditReason;

/** One of the customer's issued documents with something still outstanding, from BIL's settlement. */
export interface OpenItem {
  readonly documentId: string;
  readonly documentNo: string | null;
  readonly issueDate: string;
  /** Null for a document with no terms: it is due on its issue date. */
  readonly dueDate: string | null;
  readonly outstanding: Money;
}

export interface CreditFacts {
  readonly status: 'ACTIVE' | 'ON_HOLD';
  readonly limit: Money;
  /** Every open item of the customer, at every branch. */
  readonly openItems: readonly OpenItem[];
  /** Confirmed credit orders of the customer not yet invoiced, at their estimated totals. */
  readonly uninvoicedOrders: Money;
  /** The order being judged, at its estimated total; nil when only the account is read. */
  readonly order: Money;
  /** The business date in Africa/Accra the terms are judged on. */
  readonly today: string;
}

export interface CreditJudgement {
  readonly outcome: CreditOutcome;
  readonly reasons: readonly CreditReason[];
  /** Outstanding invoiced balance plus confirmed uninvoiced orders, before the order (SA-21). */
  readonly exposure: Money;
  /** By how much exposure plus the order exceeds the limit; nil within it. */
  readonly overLimit: Money;
  /** What is outstanding on items past their due date. */
  readonly overdue: Money;
  /** Days the oldest overdue item is past its due date; null when nothing is overdue. */
  readonly oldestOverdueDays: number | null;
}

const dueOf = (i: OpenItem): string => i.dueDate ?? i.issueDate;

/**
 * The credit check of a credit order (FR-WHL-006, FR-WHL-008, CR-046), on integers only: over the limit when exposure
 * plus the order exceeds the limit (exactly at the limit passes); past the terms when anything is outstanding a day or
 * more past its due date; and an account on hold is refused whatever its figures. Every reason that holds is named.
 */
export function judgeCredit(f: CreditFacts): CreditJudgement {
  const exposure = Money.sum(f.openItems.map((i) => i.outstanding)).plus(f.uninvoicedOrders);
  const withOrder = exposure.plus(f.order);
  const overLimit = withOrder.compareTo(f.limit) > 0 ? withOrder.minus(f.limit) : Money.zero();
  const late = f.openItems.filter((i) => !i.outstanding.isZero() && daysPastDue(dueOf(i), f.today) > 0);
  const overdue = Money.sum(late.map((i) => i.outstanding));
  const oldest = late.reduce<string | null>((o, i) => (o === null || dueOf(i) < o ? dueOf(i) : o), null);
  const reasons: CreditReason[] = [];
  if (f.status === 'ON_HOLD') reasons.push('ON_HOLD');
  if (!overLimit.isZero()) reasons.push('OVER_LIMIT');
  if (late.length > 0) reasons.push('PAST_TERMS');
  return { outcome: reasons[0] ?? 'PASSES', reasons, exposure, overLimit, overdue, oldestOverdueDays: oldest === null ? null : daysPastDue(oldest, f.today) };
}

/** The limit less exposure, never below nil. */
export function availableCredit(limit: Money, exposure: Money): Money {
  return limit.compareTo(exposure) > 0 ? limit.minus(exposure) : Money.zero();
}

/**
 * The item that puts an account on hold (FR-WHL-008): the oldest with something outstanding more than the threshold's
 * days past its due date, or null. Due 14 October on a 30-day threshold: 30 days on 13 November, no hold; 31 on 14
 * November, held.
 */
export function holdTrigger(items: readonly OpenItem[], today: string, thresholdDays: number): { readonly documentId: string; readonly documentNo: string | null; readonly daysPastDue: number } | null {
  const late = items.filter((i) => !i.outstanding.isZero() && daysPastDue(dueOf(i), today) > thresholdDays).sort((a, b) => dueOf(a).localeCompare(dueOf(b)));
  const first = late[0];
  return first === undefined ? null : { documentId: first.documentId, documentNo: first.documentNo, daysPastDue: daysPastDue(dueOf(first), today) };
}

/**
 * Whether an approved override still covers an order (CR-046): the same order at the same amount, no more over the
 * limit than was approved, and for no reason the approver was not asked about. Anything else needs a new approval.
 */
export function overrideCovers(approved: { readonly orderPesewas: bigint; readonly overLimitPesewas: bigint; readonly reasons: readonly CreditReason[] }, now: CreditJudgement, order: Money): boolean {
  return (
    approved.orderPesewas === order.pesewas &&
    now.overLimit.compareTo(Money.ofPesewas(approved.overLimitPesewas)) <= 0 &&
    now.reasons.every((r) => approved.reasons.includes(r))
  );
}

/**
 * Whether an approved override still covers the dispatch or hand-over of an order on account (B11 continued 8, the owner,
 * 2026-11-23): the goods actually sent are judged, so an override approved on the order's estimate covers a dispatch of
 * no more than that amount, no more over the limit than was approved, and for no reason the approver was not asked
 * about. A heavier dispatch, or a customer further over since, needs a new approval.
 */
export function overrideCoversDispatch(approved: { readonly orderPesewas: bigint; readonly overLimitPesewas: bigint; readonly reasons: readonly CreditReason[] }, now: CreditJudgement, gross: Money): boolean {
  return (
    gross.pesewas <= approved.orderPesewas &&
    now.overLimit.compareTo(Money.ofPesewas(approved.overLimitPesewas)) <= 0 &&
    now.reasons.every((r) => approved.reasons.includes(r))
  );
}

/**
 * Whether paying releases a hold (the owner, 2026-11-18, decision 4 on A-314): only a hold the system placed for being
 * overdue, and only once nothing is past its due date any more (the overdue balance is nil; what is owed but not yet
 * due does not keep the hold). A hold a person placed stays until an Owner or Manager who did not ask releases it.
 */
export function releasesOnPayment(placedBySystem: boolean, items: readonly OpenItem[], today: string): boolean {
  if (!placedBySystem) return false;
  return items.every((i) => i.outstanding.isZero() || daysPastDue(dueOf(i), today) === 0);
}
