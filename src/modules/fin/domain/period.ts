import { err, ok, type Result } from '@hakorem/kernel';

/** An accounting period as posting reads it. Dates are business dates in Africa/Accra, `YYYY-MM-DD`. */
export interface PeriodFacts {
  readonly id: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: 'FUTURE' | 'OPEN' | 'LOCKED' | 'CLOSED';
}

export interface PostingDate {
  readonly postingDate: string;
  readonly periodId: string;
  /** The event happened on a day whose period is not open, so it posts on the day it is recorded (FR-FIN-009). */
  readonly late: boolean;
}

export interface PeriodNotOpen {
  readonly rule: 'PERIOD_NOT_OPEN';
  readonly date: string;
}

function openPeriodOn(date: string, periods: readonly PeriodFacts[]): PeriodFacts | undefined {
  return periods.find((p) => p.startDate <= date && date <= p.endDate && p.status === 'OPEN');
}

/**
 * The late-event rule (FR-FIN-009): an event posts on the day it happened when that day's period is OPEN; otherwise
 * (its period locked, closed, not yet open, or before any period) it posts on the day it is recorded, keeping its
 * original `occurred_at`, provided that day's period is OPEN. Nothing ever posts into a period that is not open.
 */
export function choosePostingDate(occurredDate: string, recordedDate: string, periods: readonly PeriodFacts[]): Result<PostingDate, PeriodNotOpen> {
  const onTime = openPeriodOn(occurredDate, periods);
  if (onTime !== undefined) {
    return ok({ postingDate: occurredDate, periodId: onTime.id, late: false });
  }
  const late = openPeriodOn(recordedDate, periods);
  if (late === undefined) {
    return err({ rule: 'PERIOD_NOT_OPEN', date: recordedDate });
  }
  return ok({ postingDate: recordedDate, periodId: late.id, late: true });
}

/** The fiscal year is the calendar year (A-028), so a number series restarts each 1 January. */
export function fiscalYearOf(postingDate: string): number {
  return Number(postingDate.slice(0, 4));
}
