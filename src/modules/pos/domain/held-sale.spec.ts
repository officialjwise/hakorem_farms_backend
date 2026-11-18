import { describe, expect, it } from 'vitest';
import { HELD_SALE_LIFETIME_MS, heldSaleExpiry, indexOfLineNo, judgeHold, judgeRecall, lineNoOf, type HeldSaleFacts } from './held-sale';

const KOFI = 'kofi';
const AMA = 'ama';
const at = (iso: string) => new Date(iso);

describe('a sale is held on the till open shift, by its own cashier (FR-POS-007, A-276)', () => {
  it('holds on an open shift of the cashier', () => {
    expect(judgeHold({ status: 'OPEN', cashierId: KOFI }, KOFI)).toEqual({ ok: true, value: null });
  });

  it('refuses a till with no open shift: none, closing or closed', () => {
    expect(judgeHold(null, KOFI)).toEqual({ ok: false, error: 'NO_OPEN_SHIFT' });
    expect(judgeHold({ status: 'CLOSING', cashierId: KOFI }, KOFI)).toEqual({ ok: false, error: 'NO_OPEN_SHIFT' });
    expect(judgeHold({ status: 'CLOSED', cashierId: KOFI }, KOFI)).toEqual({ ok: false, error: 'NO_OPEN_SHIFT' });
  });

  it('refuses anyone but the cashier of the open shift, a manager included (nobody sells on another cashier shift)', () => {
    expect(judgeHold({ status: 'OPEN', cashierId: KOFI }, AMA)).toEqual({ ok: false, error: 'NOT_SHIFT_CASHIER' });
  });

  it('lapses twelve hours after it was held at the latest, if the shift has not closed first', () => {
    expect(HELD_SALE_LIFETIME_MS).toBe(43_200_000);
    expect(heldSaleExpiry(at('2026-11-17T08:00:00.000Z')).toISOString()).toBe('2026-11-17T20:00:00.000Z');
  });
});

describe('a held sale is recalled once, on the shift it was held on (FR-POS-007)', () => {
  const hold = (fields: Partial<HeldSaleFacts> = {}): HeldSaleFacts => ({
    status: 'HELD',
    expiresAt: at('2026-11-17T20:00:00.000Z'),
    shift: { status: 'OPEN', cashierId: KOFI },
    ...fields,
  });

  it('recalls a live hold for the shift cashier before it expires', () => {
    expect(judgeRecall(hold(), KOFI, at('2026-11-17T19:59:59.999Z'))).toEqual({ ok: true, value: null });
  });

  it('is gone once recalled or lapsed, at its expiry, or once its shift is no longer open', () => {
    expect(judgeRecall(hold({ status: 'RECALLED' }), KOFI, at('2026-11-17T09:00:00.000Z'))).toEqual({ ok: false, error: 'HELD_SALE_GONE' });
    expect(judgeRecall(hold({ status: 'LAPSED' }), KOFI, at('2026-11-17T09:00:00.000Z'))).toEqual({ ok: false, error: 'HELD_SALE_GONE' });
    expect(judgeRecall(hold(), KOFI, at('2026-11-17T20:00:00.000Z'))).toEqual({ ok: false, error: 'HELD_SALE_GONE' });
    expect(judgeRecall(hold({ shift: { status: 'CLOSING', cashierId: KOFI } }), KOFI, at('2026-11-17T09:00:00.000Z'))).toEqual({ ok: false, error: 'HELD_SALE_GONE' });
    expect(judgeRecall(hold({ shift: { status: 'CLOSED', cashierId: KOFI } }), KOFI, at('2026-11-17T09:00:00.000Z'))).toEqual({ ok: false, error: 'HELD_SALE_GONE' });
  });

  it('refuses a live hold to anyone but the cashier of its shift', () => {
    expect(judgeRecall(hold(), AMA, at('2026-11-17T09:00:00.000Z'))).toEqual({ ok: false, error: 'NOT_SHIFT_CASHIER' });
  });
});

describe('a held sale lines are numbered from 1', () => {
  it('numbers the lines from 1 and finds each line again by its number', () => {
    expect([lineNoOf(0), lineNoOf(2)]).toEqual([1, 3]);
    expect(indexOfLineNo(lineNoOf(7))).toBe(7);
  });
});
