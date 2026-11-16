import { err, ok, type Result } from '@hakorem/kernel';
import type { PeriodFacts } from './period';

/** Why a period cannot move: its status, or the rule it breaks. */
export type PeriodRefusal = PeriodFacts['status'] | 'PERIOD_NOT_ENDED' | 'EARLIER_PERIOD_NOT_CLOSED';

/** FR-FIN-009: only an OPEN period is locked; the current one may be, and then nothing posts today until reopened. */
export function judgeLock(period: PeriodFacts): Result<void, PeriodRefusal> {
  return period.status === 'OPEN' ? ok(undefined) : err(period.status);
}

/**
 * FR-FIN-009, FR-FIN-010, A-188: closing is final, so only a LOCKED period that has ended (today, in Africa/Accra, is
 * after its last day) is closed, and only once every earlier period is CLOSED: the closed periods always run unbroken
 * from the first, which the database holds too (migration 0126).
 */
export function judgeClose(period: PeriodFacts, periods: readonly PeriodFacts[], today: string): Result<void, PeriodRefusal> {
  if (period.status !== 'LOCKED') {
    return err(period.status);
  }
  if (today <= period.endDate) {
    return err('PERIOD_NOT_ENDED');
  }
  if (periods.some((p) => p.startDate < period.startDate && p.status !== 'CLOSED')) {
    return err('EARLIER_PERIOD_NOT_CLOSED');
  }
  return ok(undefined);
}

/** FR-FIN-010: a LOCKED period is reopened (by the Owner, with approval); a CLOSED period never is. */
export function judgeReopen(period: PeriodFacts): Result<void, PeriodRefusal> {
  return period.status === 'LOCKED' ? ok(undefined) : err(period.status);
}
