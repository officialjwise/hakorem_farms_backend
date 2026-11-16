import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { clearingOf, planTender } from './tender';

const m = (pesewas: bigint) => Money.ofPesewas(pesewas);

describe('each method clears in its own way (FR-PAY-001, FR-PAY-005)', () => {
  it('clears cash and store credit at once, mobile money and card only from the provider, transfers and cheques from the bank', () => {
    expect(clearingOf('CASH')).toBe('AT_ONCE');
    expect(clearingOf('STORE_CREDIT')).toBe('AT_ONCE');
    expect(clearingOf('MOBILE_MONEY')).toBe('PROVIDER');
    expect(clearingOf('CARD')).toBe('PROVIDER');
    expect(clearingOf('BANK_TRANSFER')).toBe('STATEMENT');
    expect(clearingOf('CHEQUE')).toBe('BANK_CONFIRMATION');
  });
});

describe('a tender splits exactly into what it settles and what it leaves on deposit (FR-PAY-009, FR-PAY-010)', () => {
  it('allocates 44,000 of a 44,000 cash tender to one receipt and leaves nothing on deposit', () => {
    const plan = planTender(m(44_000n), [m(44_000n)]);
    expect(plan).toEqual({ ok: true, value: { allocated: m(44_000n), unallocated: m(0n) } });
  });

  it('allocates 100,000 as 60,000 and 40,000 across two documents', () => {
    const plan = planTender(m(100_000n), [m(60_000n), m(40_000n)]);
    expect(plan.ok && plan.value.allocated.pesewas).toBe(100_000n);
    expect(plan.ok && plan.value.unallocated.pesewas).toBe(0n);
  });

  it('holds the 20,000 a customer paid over a 100,000 invoice as unallocated', () => {
    const plan = planTender(m(120_000n), [m(100_000n)]);
    expect(plan.ok && plan.value.unallocated.pesewas).toBe(20_000n);
  });

  it('refuses allocations one pesewa above the tender', () => {
    expect(planTender(m(100_000n), [m(60_001n), m(40_000n)])).toEqual({ ok: false, error: 'ALLOCATIONS_EXCEED_AMOUNT' });
  });

  it('refuses a zero tender and a zero allocation', () => {
    expect(planTender(m(0n), [])).toEqual({ ok: false, error: 'AMOUNT_NOT_POSITIVE' });
    expect(planTender(m(5_000n), [m(0n)])).toEqual({ ok: false, error: 'ALLOCATION_NOT_POSITIVE' });
  });

  it('carries the largest amount the platform holds without losing a pesewa', () => {
    const max = Money.MAX_PESEWAS;
    const plan = planTender(m(max), [m(max - 1n)]);
    expect(plan.ok && plan.value.unallocated.pesewas).toBe(1n);
  });
});
