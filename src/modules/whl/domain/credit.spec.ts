import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { availableCredit, holdTrigger, judgeCredit, overrideCovers, type CreditFacts, type OpenItem } from './credit';
import { daysPastDue } from './time';

const TODAY = '2026-11-14';
const p = (n: bigint) => Money.ofPesewas(n);
let seq = 0n;
function item(outstanding: bigint, dueDate: string | null, issueDate = '2026-10-01'): OpenItem {
  seq += 1n;
  return { documentId: `019a7b06-0000-7000-8000-${seq.toString().padStart(12, '0')}`, documentNo: `INV-2026-DDW-${seq.toString().padStart(6, '0')}`, issueDate, dueDate, outstanding: p(outstanding) };
}
function facts(over: Partial<CreditFacts> = {}): CreditFacts {
  return { status: 'ACTIVE', limit: p(500_000n), openItems: [], uninvoicedOrders: p(0n), order: p(0n), today: TODAY, ...over };
}

describe('the credit limit (FR-WHL-006, SA-21, CR-046)', () => {
  it('passes an order that takes exposure exactly to the limit', () => {
    const j = judgeCredit(facts({ openItems: [item(300_000n, TODAY)], uninvoicedOrders: p(150_000n), order: p(50_000n) }));
    expect([j.outcome, j.reasons, j.exposure.pesewas, j.overLimit.pesewas]).toEqual(['PASSES', [], 450_000n, 0n]);
  });

  it('refuses an order one pesewa over the limit and names the one pesewa', () => {
    const j = judgeCredit(facts({ openItems: [item(300_000n, TODAY)], uninvoicedOrders: p(150_000n), order: p(50_001n) }));
    expect([j.outcome, j.reasons, j.overLimit.pesewas]).toEqual(['OVER_LIMIT', ['OVER_LIMIT'], 1n]);
  });

  it('names 10,000 over for FR-WHL-006: limit 500,000, exposure 450,000, an order of 60,000', () => {
    const j = judgeCredit(facts({ openItems: [item(450_000n, TODAY)], order: p(60_000n) }));
    expect([j.outcome, j.exposure.pesewas, j.overLimit.pesewas]).toEqual(['OVER_LIMIT', 450_000n, 10_000n]);
  });

  it('refuses any credit order on a nil limit', () => {
    const j = judgeCredit(facts({ limit: p(0n), order: p(1n) }));
    expect([j.outcome, j.overLimit.pesewas]).toEqual(['OVER_LIMIT', 1n]);
  });

  it('counts the largest amounts exactly', () => {
    const j = judgeCredit(facts({ limit: p(9_007_199_254_740_991n), openItems: [item(9_007_199_254_740_990n, TODAY)], order: p(1n) }));
    expect([j.outcome, j.exposure.pesewas, j.overLimit.pesewas]).toEqual(['PASSES', 9_007_199_254_740_990n, 0n]);
  });
});

describe('the terms (CR-046: past terms by one day)', () => {
  it('passes an invoice due today', () => {
    const j = judgeCredit(facts({ openItems: [item(1_000n, TODAY)], order: p(1_000n) }));
    expect([j.outcome, j.overdue.pesewas, j.oldestOverdueDays]).toEqual(['PASSES', 0n, null]);
  });

  it('refuses a customer with one pesewa outstanding one day past its due date', () => {
    const j = judgeCredit(facts({ openItems: [item(1n, '2026-11-13')], order: p(1_000n) }));
    expect([j.outcome, j.reasons, j.overdue.pesewas, j.oldestOverdueDays]).toEqual(['PAST_TERMS', ['PAST_TERMS'], 1n, 1]);
  });

  it('reads an item with no due date as due on its issue date', () => {
    const j = judgeCredit(facts({ openItems: [item(5_000n, null, '2026-11-12')] }));
    expect([j.outcome, j.overdue.pesewas, j.oldestOverdueDays]).toEqual(['PAST_TERMS', 5_000n, 2]);
  });

  it('sums every overdue item and names the oldest', () => {
    const j = judgeCredit(facts({ openItems: [item(20_000n, '2026-11-01'), item(30_000n, '2026-10-14'), item(40_000n, '2026-11-20')] }));
    expect([j.overdue.pesewas, j.oldestOverdueDays, j.exposure.pesewas]).toEqual([50_000n, 31, 90_000n]);
  });
});

describe('a hold and both reasons', () => {
  it('names over the limit and past the terms together, the limit first', () => {
    const j = judgeCredit(facts({ openItems: [item(500_000n, '2026-11-13')], order: p(1n) }));
    expect([j.outcome, j.reasons]).toEqual(['OVER_LIMIT', ['OVER_LIMIT', 'PAST_TERMS']]);
  });

  it('puts a hold first, and still names the rest', () => {
    const j = judgeCredit(facts({ status: 'ON_HOLD', openItems: [item(500_000n, '2026-11-13')], order: p(1n) }));
    expect([j.outcome, j.reasons]).toEqual(['ON_HOLD', ['ON_HOLD', 'OVER_LIMIT', 'PAST_TERMS']]);
  });

  it('refuses an account on hold even within its limit and terms', () => {
    expect(judgeCredit(facts({ status: 'ON_HOLD', order: p(1n) })).reasons).toEqual(['ON_HOLD']);
  });
});

describe('available credit', () => {
  it('is the limit less exposure', () => {
    expect(availableCredit(p(500_000n), p(450_000n)).pesewas).toBe(50_000n);
  });
  it('is never below nil', () => {
    expect(availableCredit(p(500_000n), p(500_001n)).pesewas).toBe(0n);
  });
});

describe('the automatic hold (FR-WHL-008)', () => {
  it('does not hold an invoice due 14 October 30 days past due on 13 November', () => {
    expect(holdTrigger([item(80_000n, '2026-10-14')], '2026-11-13', 30)).toBeNull();
  });
  it('holds on 14 November, 31 days past due, naming the invoice', () => {
    const due = item(80_000n, '2026-10-14');
    expect(holdTrigger([item(1_000n, '2026-11-01'), due], '2026-11-14', 30)).toEqual({ documentId: due.documentId, documentNo: due.documentNo, daysPastDue: 31 });
  });
  it('names the oldest of several past the threshold', () => {
    const older = item(1n, '2026-09-01');
    expect(holdTrigger([item(80_000n, '2026-10-01'), older], '2026-11-14', 30)?.documentId).toBe(older.documentId);
  });
});

describe('an approved override covers the order it was approved for (CR-046)', () => {
  const approved = { orderPesewas: 60_000n, overLimitPesewas: 10_000n, reasons: ['OVER_LIMIT'] as const };
  const now = (order: bigint, open: bigint, status: 'ACTIVE' | 'ON_HOLD' = 'ACTIVE', due = TODAY) => judgeCredit(facts({ status, openItems: [item(open, due)], order: p(order) }));

  it('covers the same order at the same amount over', () => {
    expect(overrideCovers(approved, now(60_000n, 450_000n), p(60_000n))).toBe(true);
  });
  it('covers it when the customer has paid since and is less over', () => {
    expect(overrideCovers(approved, now(60_000n, 445_000n), p(60_000n))).toBe(true);
  });
  it('does not cover one pesewa more over', () => {
    expect(overrideCovers(approved, now(60_000n, 450_001n), p(60_000n))).toBe(false);
  });
  it('does not cover the order at another amount', () => {
    expect(overrideCovers(approved, now(60_001n, 449_999n), p(60_001n))).toBe(false);
  });
  it('does not cover a reason it was not approved for', () => {
    expect(overrideCovers(approved, now(60_000n, 450_000n, 'ACTIVE', '2026-11-13'), p(60_000n))).toBe(false);
    expect(overrideCovers(approved, now(60_000n, 450_000n, 'ON_HOLD'), p(60_000n))).toBe(false);
  });
});

describe('days past due', () => {
  it('counts calendar days and is nil on or before the due date', () => {
    expect([daysPastDue('2026-10-14', '2026-11-14'), daysPastDue('2026-11-14', '2026-11-14'), daysPastDue('2026-11-15', '2026-11-14')]).toEqual([31, 0, 0]);
  });
  it('counts across the year end', () => {
    expect(daysPastDue('2026-12-31', '2027-01-01')).toBe(1);
  });
});
