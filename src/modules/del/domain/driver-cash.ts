import { Money } from '@hakorem/kernel';

/** The driver variance report's direction (docs/data-model/del.md, `del.driver_cash_reconciliation`). */
export type VarianceDirection = 'OVER' | 'SHORT' | 'EXACT';

/**
 * A hand-in's figures (FR-DEL-010, CR-057, ADR-0092): what is expected is exactly the cash the driver still holds (each
 * collection not yet handed in); what the till received is what the cashier counted; a count below what was expected
 * is short and above it over, never typed in as loose cash. Balanced by construction: received plus short is expected
 * plus over, which is the journal FIN posts (Dr 1000 received, Dr 6900 short, Cr 1020 expected, Cr 6900 over).
 */
export interface HandInFigures {
  readonly expected: Money;
  readonly received: Money;
  readonly short: Money;
  readonly over: Money;
  readonly direction: VarianceDirection;
}

export function handInFigures(held: readonly Money[], declared: Money): HandInFigures {
  const expected = Money.sum(held);
  const order = declared.compareTo(expected);
  const zero = Money.zero();
  return {
    expected,
    received: declared,
    short: order < 0 ? expected.minus(declared) : zero,
    over: order > 0 ? declared.minus(expected) : zero,
    direction: order < 0 ? 'SHORT' : order > 0 ? 'OVER' : 'EXACT',
  };
}

export interface HandInRule {
  readonly field: string;
  readonly rule: string;
}

/**
 * Who may hand in and who may receive (FR-DEL-010, abuse cases 6 and 43): the person receiving the cash is never the
 * driver whose cash it is, and a hand-in needs at least one collection still held, so a till never takes cash in a
 * driver's name that no delivery collected.
 */
export function judgeHandIn(f: { readonly driverId: string; readonly receiverId: string; readonly heldCount: number }): HandInRule[] {
  const broken: HandInRule[] = [];
  if (f.driverId === f.receiverId) broken.push({ field: '/driverId', rule: 'RECEIVER_IS_DRIVER' });
  if (f.heldCount === 0) broken.push({ field: '/driverId', rule: 'NOTHING_HELD' });
  return broken;
}
