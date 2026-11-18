import { daysPastDue } from './time';

/** SA-21's bands of days past due (FR-WHL-010). */
export type AgeingBucket = 'CURRENT' | 'DAYS_1_30' | 'DAYS_31_60' | 'DAYS_61_90' | 'DAYS_OVER_90';

const LAST_DAY_OF: ReadonlyArray<readonly [number, AgeingBucket]> = [
  [0, 'CURRENT'],
  [30, 'DAYS_1_30'],
  [60, 'DAYS_31_60'],
  [90, 'DAYS_61_90'],
];

/** An invoice, receipt or debit note as it stood at the end of the day aged at: its gross, credit notes and net payments by then. */
export interface AgedItem {
  readonly issueDate: string;
  /** Null means due on issue (A-313 (b)). */
  readonly dueDate: string | null;
  readonly grossPesewas: bigint;
  readonly creditedPesewas: bigint;
  readonly appliedPesewas: bigint;
}

/**
 * A customer's ageing as at a date, in pesewas. The five buckets hold the open items' balances (never negative) and
 * `totalPesewas` is their sum. The customer's 1200 balance as at the same date is beside them, owed (`ledgerPesewas`)
 * or in the customer's favour (`ledgerCreditPesewas`), and so is what 1200 holds that no open item explains: an
 * opening balance journal, a refund, a credit note beyond its invoice (`notAgedPesewas`, `notAgedCreditPesewas`), so
 * that total plus not aged less not aged credit is the 1200 balance exactly (ADR-0089). One side of each pair is nil.
 */
export interface AgeingFigures {
  readonly currentPesewas: bigint;
  readonly days1To30Pesewas: bigint;
  readonly days31To60Pesewas: bigint;
  readonly days61To90Pesewas: bigint;
  readonly daysOver90Pesewas: bigint;
  readonly totalPesewas: bigint;
  readonly ledgerPesewas: bigint;
  readonly ledgerCreditPesewas: bigint;
  readonly notAgedPesewas: bigint;
  readonly notAgedCreditPesewas: bigint;
}

const FIELD: Record<AgeingBucket, keyof AgeingFigures> = {
  CURRENT: 'currentPesewas',
  DAYS_1_30: 'days1To30Pesewas',
  DAYS_31_60: 'days31To60Pesewas',
  DAYS_61_90: 'days61To90Pesewas',
  DAYS_OVER_90: 'daysOver90Pesewas',
};

/** The band of a number of days past due: nil is Current, 1 to 30, 31 to 60, 61 to 90, then over 90. */
export function bucketOf(days: number): AgeingBucket {
  return LAST_DAY_OF.find(([last]) => days <= last)?.[1] ?? 'DAYS_OVER_90';
}

/**
 * Ages one customer's items as at a business date (FR-WHL-010): each item's balance, its gross less its credit notes
 * and net payments, goes whole into the band of its days past due (from its due date, or its issue date when it has
 * none); a balance of nil or below is no open item. `ledgerSignedPesewas` is the customer's 1200 balance as at the
 * date, debits less credits; the difference from the buckets' total is shown as not aged, never put into a bucket.
 */
export function ageCustomer(items: readonly AgedItem[], ledgerSignedPesewas: bigint, asOf: string): AgeingFigures {
  const buckets: Record<AgeingBucket, bigint> = { CURRENT: 0n, DAYS_1_30: 0n, DAYS_31_60: 0n, DAYS_61_90: 0n, DAYS_OVER_90: 0n };
  for (const i of items) {
    const balance = i.grossPesewas - i.creditedPesewas - i.appliedPesewas;
    if (balance <= 0n) continue;
    const bucket = bucketOf(daysPastDue(i.dueDate ?? i.issueDate, asOf));
    buckets[bucket] += balance;
  }
  const total = buckets.CURRENT + buckets.DAYS_1_30 + buckets.DAYS_31_60 + buckets.DAYS_61_90 + buckets.DAYS_OVER_90;
  const notAged = ledgerSignedPesewas - total;
  return {
    currentPesewas: buckets.CURRENT,
    days1To30Pesewas: buckets.DAYS_1_30,
    days31To60Pesewas: buckets.DAYS_31_60,
    days61To90Pesewas: buckets.DAYS_61_90,
    daysOver90Pesewas: buckets.DAYS_OVER_90,
    totalPesewas: total,
    ledgerPesewas: ledgerSignedPesewas > 0n ? ledgerSignedPesewas : 0n,
    ledgerCreditPesewas: ledgerSignedPesewas < 0n ? -ledgerSignedPesewas : 0n,
    notAgedPesewas: notAged > 0n ? notAged : 0n,
    notAgedCreditPesewas: notAged < 0n ? -notAged : 0n,
  };
}

/** The total over a filter: every figure summed row by row, each side kept apart, so the identity holds on the total too. */
export function sumAgeing(rows: readonly AgeingFigures[]): AgeingFigures {
  const keys = [...Object.values(FIELD), 'totalPesewas', 'ledgerPesewas', 'ledgerCreditPesewas', 'notAgedPesewas', 'notAgedCreditPesewas'] as const;
  const total = Object.fromEntries(keys.map((k) => [k, 0n])) as Record<keyof AgeingFigures, bigint>;
  for (const row of rows) for (const k of keys) total[k] += row[k];
  return total;
}
