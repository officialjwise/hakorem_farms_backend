import { describe, expect, it } from 'vitest';
import { ageCustomer, bucketOf, sumAgeing, type AgedItem } from './ageing';

const item = (over: Partial<AgedItem> = {}): AgedItem => ({ issueDate: '2026-09-14', dueDate: '2026-10-14', grossPesewas: 80_000n, creditedPesewas: 0n, appliedPesewas: 0n, ...over });
const MAX = 9_007_199_254_740_991n;

describe('the ageing buckets (FR-WHL-010, SA-21: days past due)', () => {
  it('puts nothing past due in Current, and each band from its first day to its last', () => {
    expect([0, 1, 30, 31, 60, 61, 90, 91, 400].map(bucketOf)).toEqual(['CURRENT', 'DAYS_1_30', 'DAYS_1_30', 'DAYS_31_60', 'DAYS_31_60', 'DAYS_61_90', 'DAYS_61_90', 'DAYS_OVER_90', 'DAYS_OVER_90']);
  });

  it('ages FR-WHL-010: 80,000 due 14 October, 30,000 paid, shows 50,000 in 1 to 30 on 13 November', () => {
    const a = ageCustomer([item({ appliedPesewas: 30_000n })], 50_000n, '2026-11-13');
    expect([a.currentPesewas, a.days1To30Pesewas, a.days31To60Pesewas, a.totalPesewas, a.notAgedPesewas, a.notAgedCreditPesewas]).toEqual([0n, 50_000n, 0n, 50_000n, 0n, 0n]);
  });

  it('ages the same invoice into 31 to 60 on 13 December (60 days) and 61 to 90 on 14 December (61 days, A-317 (b))', () => {
    const a = ageCustomer([item({ appliedPesewas: 30_000n })], 50_000n, '2026-12-13');
    expect([a.days1To30Pesewas, a.days31To60Pesewas, a.days61To90Pesewas, a.totalPesewas]).toEqual([0n, 50_000n, 0n, 50_000n]);
    const b = ageCustomer([item({ appliedPesewas: 30_000n })], 50_000n, '2026-12-14');
    expect([b.days31To60Pesewas, b.days61To90Pesewas, b.totalPesewas]).toEqual([0n, 50_000n, 50_000n]);
  });

  it('keeps an invoice on its due date in Current, and one day later in 1 to 30', () => {
    expect(ageCustomer([item()], 80_000n, '2026-10-14').currentPesewas).toBe(80_000n);
    expect(ageCustomer([item()], 80_000n, '2026-10-15').days1To30Pesewas).toBe(80_000n);
  });

  it('ages a document with no due date from its issue date (due on issue)', () => {
    const a = ageCustomer([item({ dueDate: null, issueDate: '2026-08-01' })], 80_000n, '2026-11-13');
    expect(a.daysOver90Pesewas).toBe(80_000n);
  });

  it('takes credit notes and payments off each item exactly, and leaves a settled item out', () => {
    const a = ageCustomer([item({ creditedPesewas: 20_000n, appliedPesewas: 59_999n }), item({ dueDate: '2026-08-01', creditedPesewas: 80_000n })], 1n, '2026-11-13');
    expect([a.days1To30Pesewas, a.daysOver90Pesewas, a.totalPesewas, a.notAgedPesewas]).toEqual([1n, 0n, 1n, 0n]);
  });

  it('shows what 1200 holds beyond the open items as not aged, never inside a bucket', () => {
    const a = ageCustomer([item()], 100_000n, '2026-10-01');
    expect([a.currentPesewas, a.totalPesewas, a.ledgerPesewas, a.notAgedPesewas, a.notAgedCreditPesewas]).toEqual([80_000n, 80_000n, 100_000n, 20_000n, 0n]);
  });

  it('shows a credit the customer holds beyond its open items on the credit side', () => {
    const a = ageCustomer([item(), item({ creditedPesewas: 95_000n })], -15_000n, '2026-10-01');
    expect([a.totalPesewas, a.ledgerPesewas, a.ledgerCreditPesewas, a.notAgedPesewas, a.notAgedCreditPesewas]).toEqual([80_000n, 0n, 15_000n, 0n, 95_000n]);
  });

  it('ages the largest amounts exactly', () => {
    const a = ageCustomer([item({ grossPesewas: MAX, appliedPesewas: 1n })], MAX - 1n, '2026-11-13');
    expect([a.days1To30Pesewas, a.notAgedPesewas]).toEqual([MAX - 1n, 0n]);
  });

  it('totals rows bucket by bucket, each side of 1200 and of what is not aged kept apart', () => {
    const one = ageCustomer([item()], 100_000n, '2026-10-01');
    const two = ageCustomer([item({ dueDate: '2026-07-15' })], -1n, '2026-10-01');
    const t = sumAgeing([one, two]);
    expect([t.currentPesewas, t.days61To90Pesewas, t.totalPesewas, t.ledgerPesewas, t.ledgerCreditPesewas, t.notAgedPesewas, t.notAgedCreditPesewas]).toEqual([80_000n, 80_000n, 160_000n, 100_000n, 1n, 20_000n, 80_001n]);
    expect(t.totalPesewas + t.notAgedPesewas - t.notAgedCreditPesewas).toBe(t.ledgerPesewas - t.ledgerCreditPesewas);
    expect(sumAgeing([]).totalPesewas).toBe(0n);
  });
});
