import { describe, expect, it } from 'vitest';
import { judgeRequisitionAction, planConversion } from './requisition';

describe('a requisition lifecycle (FR-PUR-004)', () => {
  it('changes and submits only a draft', () => {
    expect(judgeRequisitionAction('DRAFT', 'UPDATE')).toEqual({ ok: true, value: 'DRAFT' });
    expect(judgeRequisitionAction('DRAFT', 'SUBMIT')).toEqual({ ok: true, value: 'SUBMITTED' });
    expect(judgeRequisitionAction('SUBMITTED', 'UPDATE')).toEqual({ ok: false, error: 'WRONG_STATUS' });
    expect(judgeRequisitionAction('SUBMITTED', 'SUBMIT')).toEqual({ ok: false, error: 'WRONG_STATUS' });
  });

  it('rejects or converts only a submitted requisition, and a rejected one cannot be converted', () => {
    expect(judgeRequisitionAction('SUBMITTED', 'REJECT')).toEqual({ ok: true, value: 'REJECTED' });
    expect(judgeRequisitionAction('SUBMITTED', 'CONVERT')).toEqual({ ok: true, value: 'CONVERTED' });
    for (const status of ['DRAFT', 'REJECTED', 'CONVERTED', 'CANCELLED'] as const) {
      expect(judgeRequisitionAction(status, 'CONVERT')).toEqual({ ok: false, error: 'WRONG_STATUS' });
      expect(judgeRequisitionAction(status, 'REJECT')).toEqual({ ok: false, error: 'WRONG_STATUS' });
    }
  });
});

describe('turning a requisition into order lines (FR-PUR-004)', () => {
  const lines = [
    { id: 'l1', productId: 'broiler', qty: '20.000' },
    { id: 'l2', productId: 'feed', qty: '500.000' },
  ];

  it('orders each named line at its requisitioned quantity unless another is given', () => {
    expect(
      planConversion(lines, [
        { lineId: 'l1', unitPricePesewas: 5_500 },
        { lineId: 'l2', unitPricePesewas: 900, qty: '450.000' },
      ]),
    ).toEqual({
      ok: true,
      value: [
        { productId: 'broiler', qtyOrdered: '20.000', unitPricePesewas: 5_500 },
        { productId: 'feed', qtyOrdered: '450.000', unitPricePesewas: 900 },
      ],
    });
  });

  it('may leave a line out', () => {
    expect(planConversion(lines, [{ lineId: 'l2', unitPricePesewas: 900 }])).toEqual({ ok: true, value: [{ productId: 'feed', qtyOrdered: '500.000', unitPricePesewas: 900 }] });
  });

  it('refuses no lines, a line not on the requisition and a line named twice', () => {
    expect(planConversion(lines, [])).toEqual({ ok: false, error: [{ field: '/lines', rule: 'NO_LINES' }] });
    expect(
      planConversion(lines, [
        { lineId: 'l1', unitPricePesewas: 5_500 },
        { lineId: 'elsewhere', unitPricePesewas: 1 },
        { lineId: 'l1', unitPricePesewas: 5_400 },
      ]),
    ).toEqual({
      ok: false,
      error: [
        { field: '/lines/1/lineId', rule: 'LINE_NOT_ON_REQUISITION' },
        { field: '/lines/2/lineId', rule: 'LINE_REPEATED' },
      ],
    });
  });
});
