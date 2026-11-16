import { describe, expect, it } from 'vitest';
import { judgeVarianceApprover, judgeVarianceLines } from './variance';

describe('what an approved variance may cover (FR-PUR-010)', () => {
  it('covers a price outside the 1 percent tolerance and a levy charged differently', () => {
    expect(judgeVarianceLines([{ reasons: ['PRICE_OUTSIDE_TOLERANCE'] }, { reasons: [] }, { reasons: ['LEVY_DIFFERS', 'PRICE_OUTSIDE_TOLERANCE'] }])).toEqual({ ok: true, value: undefined });
  });

  it('never covers goods that were not received, a line with no order line or a different product', () => {
    expect(judgeVarianceLines([{ reasons: ['PRICE_OUTSIDE_TOLERANCE'] }, { reasons: ['QTY_EXCEEDS_RECEIVED', 'PRICE_OUTSIDE_TOLERANCE'] }, { reasons: ['NO_ORDER_LINE'] }, { reasons: ['PRODUCT_DIFFERS'] }])).toEqual({
      ok: false,
      error: [
        { index: 1, reason: 'QTY_EXCEEDS_RECEIVED' },
        { index: 2, reason: 'NO_ORDER_LINE' },
        { index: 3, reason: 'PRODUCT_DIFFERS' },
      ],
    });
  });

  it('has nothing to approve when no line mismatches', () => {
    expect(judgeVarianceLines([{ reasons: [] }])).toEqual({ ok: false, error: [] });
  });
});

describe('who may approve a variance (FR-PUR-010, ADR-0017)', () => {
  it('is someone other than the person who asked for it and the person who entered the invoice', () => {
    expect(judgeVarianceApprover({ invoiceMakerId: 'accountant', requesterId: 'accountant', approverId: 'manager' })).toEqual({ ok: true, value: undefined });
    expect(judgeVarianceApprover({ invoiceMakerId: 'accountant', requesterId: 'owner', approverId: 'accountant' })).toEqual({ ok: false, error: 'INVOICE_MAKER_CANNOT_APPROVE' });
    expect(judgeVarianceApprover({ invoiceMakerId: 'owner', requesterId: 'accountant', approverId: 'accountant' })).toEqual({ ok: false, error: 'MAKER_CANNOT_CHECK' });
  });
});
