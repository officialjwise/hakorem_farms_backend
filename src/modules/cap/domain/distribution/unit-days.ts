/** A movement of an investor's units: issued by a contribution, redeemed by a withdrawal, on its effective date. */
export interface UnitMovement {
  readonly investorId: string;
  readonly kind: 'ISSUE' | 'REDEEM';
  /** Ten-thousandths of a unit. */
  readonly unitsE4: bigint;
  /** The capital transaction's value date, an Africa/Accra calendar date (YYYY-MM-DD). */
  readonly effectiveOn: string;
}

/** A distribution period, both ends inclusive (ADR-0028). */
export interface Period {
  readonly start: string;
  readonly end: string;
}

const MS_PER_DAY = 86_400_000;
const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY;

/** Actual calendar days from `start` to `end`, both counted: no 30-day month, no 360-day year. */
export function daysInPeriod(period: Period): number {
  return dayNumber(period.end) - dayNumber(period.start) + 1;
}

/**
 * Unit-days per investor over a period (FR-CAP-007, ADR-0028), in ten-thousandths: the sum over the period's days of
 * the units held that day. Units issued on E are held on E and every later day; units redeemed on R are held up to the
 * day before R. So each movement counts its units for the days from the later of its date and the period's start to
 * the period's end, added for an issue and taken off for a redemption. A movement after the period counts nothing.
 * Integers throughout: this is the weight `allocate` takes.
 */
export function unitDaysByInvestor(movements: readonly UnitMovement[], period: Period): Map<string, bigint> {
  const result = new Map<string, bigint>();
  for (const m of movements) {
    if (m.effectiveOn > period.end) continue;
    const from = m.effectiveOn > period.start ? m.effectiveOn : period.start;
    const days = BigInt(daysInPeriod({ start: from, end: period.end }));
    const signed = m.kind === 'ISSUE' ? m.unitsE4 * days : -m.unitsE4 * days;
    result.set(m.investorId, (result.get(m.investorId) ?? 0n) + signed);
  }
  return result;
}

/** Units each investor holds on a day (FR-CAP-005): issues effective on or before it, less redemptions effective on or before it. */
export function heldOn(movements: readonly UnitMovement[], date: string): Map<string, bigint> {
  const result = new Map<string, bigint>();
  for (const m of movements) {
    if (m.effectiveOn > date) continue;
    result.set(m.investorId, (result.get(m.investorId) ?? 0n) + (m.kind === 'ISSUE' ? m.unitsE4 : -m.unitsE4));
  }
  return result;
}

/**
 * Whether an investor may redeem these units effective on this date (FR-CAP-004): never more than they hold that day,
 * and never so many that a later redemption already recorded would take the holding below nothing. The database holds
 * the same rule (`cap.capital_transaction_check`).
 */
export function judgeWithdrawal(movements: readonly UnitMovement[], investorId: string, unitsE4: bigint, effectiveOn: string): 'MORE_THAN_HELD'[] {
  const own = [...movements.filter((m) => m.investorId === investorId), { investorId, kind: 'REDEEM' as const, unitsE4, effectiveOn }];
  const dates = [...new Set(own.map((m) => m.effectiveOn).filter((d) => d >= effectiveOn))];
  return dates.some((d) => heldOn(own, d).get(investorId)! < 0n) ? ['MORE_THAN_HELD'] : [];
}
