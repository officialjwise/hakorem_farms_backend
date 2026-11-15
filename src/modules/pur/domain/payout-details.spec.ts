import { describe, expect, it } from 'vitest';
import { judgePayee, judgePayoutDetails, maskPayout, type PayoutDetails } from './payout-details';

/** Example accounts only: the digits are obviously not a real account (security review, payout details). */
const BANK = { method: 'BANK', bankName: 'Ecobank Ghana', accountName: 'Awutu Poultry Farm', accountNumber: '0000000003381', bankBranch: 'Kasoa' } as const;
const MOMO = { method: 'MOBILE_MONEY', momoNetwork: 'MTN', momoNumber: '+233240000014' } as const;

describe('payout details (FR-PUR-001, FR-PUR-002)', () => {
  it('takes bank details, trimmed, and masks them to the last four characters of the account', () => {
    const judged = judgePayoutDetails({ ...BANK, bankName: '  Ecobank Ghana ', accountNumber: ' 0000000003381 ' });
    expect(judged).toEqual({ ok: true, value: BANK });
    expect(maskPayout(BANK)).toBe('Ecobank Ghana, Awutu Poultry Farm, ****3381');
  });

  it('masks a bank account without a branch the same way', () => {
    const { bankBranch: _, ...noBranch } = BANK;
    expect(judgePayoutDetails(noBranch)).toEqual({ ok: true, value: noBranch });
    expect(maskPayout(noBranch as PayoutDetails)).toBe('Ecobank Ghana, Awutu Poultry Farm, ****3381');
  });

  it('takes a Ghanaian mobile money wallet and masks it', () => {
    expect(judgePayoutDetails(MOMO)).toEqual({ ok: true, value: MOMO });
    expect(maskPayout(MOMO)).toBe('MTN MoMo, ****0014');
  });

  it('takes cash and a cheque with nothing else: a cheque is made out to the name in the register', () => {
    expect(judgePayoutDetails({ method: 'CASH' })).toEqual({ ok: true, value: { method: 'CASH' } });
    expect(maskPayout({ method: 'CASH' })).toBe('Cash');
    expect(judgePayoutDetails({ method: 'CHEQUE' })).toEqual({ ok: true, value: { method: 'CHEQUE' } });
    expect(maskPayout({ method: 'CHEQUE' })).toBe('Cheque to the registered name');
  });

  it('names every missing bank field', () => {
    expect(judgePayoutDetails({ method: 'BANK' })).toEqual({
      ok: false,
      error: [
        { field: '/payoutDetails/bankName', rule: 'REQUIRED' },
        { field: '/payoutDetails/accountName', rule: 'REQUIRED' },
        { field: '/payoutDetails/accountNumber', rule: 'REQUIRED' },
      ],
    });
    expect(judgePayoutDetails({ ...BANK, bankName: '   ' })).toEqual({ ok: false, error: [{ field: '/payoutDetails/bankName', rule: 'REQUIRED' }] });
  });

  it('refuses an account number that is not 6 to 20 digits', () => {
    for (const accountNumber of ['12345', '123456789012345678901', '0000-0003381', 'ACC0003381']) {
      expect(judgePayoutDetails({ ...BANK, accountNumber })).toEqual({ ok: false, error: [{ field: '/payoutDetails/accountNumber', rule: 'ACCOUNT_NUMBER_INVALID' }] });
    }
    expect(judgePayoutDetails({ ...BANK, accountNumber: '123456' }).ok).toBe(true);
    expect(judgePayoutDetails({ ...BANK, accountNumber: '12345678901234567890' }).ok).toBe(true);
  });

  it('refuses a wallet with no network, no number, or a number outside Ghana', () => {
    expect(judgePayoutDetails({ method: 'MOBILE_MONEY' })).toEqual({
      ok: false,
      error: [
        { field: '/payoutDetails/momoNetwork', rule: 'REQUIRED' },
        { field: '/payoutDetails/momoNumber', rule: 'REQUIRED' },
      ],
    });
    for (const momoNumber of ['+2342400000140', '+23324000001', '0240000014']) {
      expect(judgePayoutDetails({ ...MOMO, momoNumber })).toEqual({ ok: false, error: [{ field: '/payoutDetails/momoNumber', rule: 'MOMO_NUMBER_INVALID' }] });
    }
  });

  it('refuses fields that belong to another method', () => {
    expect(judgePayoutDetails({ ...BANK, momoNumber: '+233240000014' })).toEqual({ ok: false, error: [{ field: '/payoutDetails/momoNumber', rule: 'NOT_FOR_METHOD' }] });
    expect(judgePayoutDetails({ ...MOMO, accountNumber: '0000000003381', bankName: 'GCB' })).toEqual({
      ok: false,
      error: [
        { field: '/payoutDetails/bankName', rule: 'NOT_FOR_METHOD' },
        { field: '/payoutDetails/accountNumber', rule: 'NOT_FOR_METHOD' },
      ],
    });
    expect(judgePayoutDetails({ method: 'CASH', accountName: 'Somebody' })).toEqual({ ok: false, error: [{ field: '/payoutDetails/accountName', rule: 'NOT_FOR_METHOD' }] });
    expect(judgePayoutDetails({ method: 'CHEQUE', accountName: 'Somebody', momoNetwork: 'MTN', bankBranch: 'Adum' })).toEqual({
      ok: false,
      error: [
        { field: '/payoutDetails/accountName', rule: 'NOT_FOR_METHOD' },
        { field: '/payoutDetails/bankBranch', rule: 'NOT_FOR_METHOD' },
        { field: '/payoutDetails/momoNetwork', rule: 'NOT_FOR_METHOD' },
      ],
    });
  });
});

describe('who a payment pays (FR-PUR-002: the details in force)', () => {
  it('pays cash and cheques with no details on file', () => {
    expect(judgePayee('CASH', null)).toEqual({ ok: true, value: null });
    expect(judgePayee('CHEQUE', { id: 'c1', method: 'BANK' })).toEqual({ ok: true, value: null });
  });

  it('pays a bank or wallet only to the approved details of that method in force', () => {
    expect(judgePayee('MOBILE_MONEY', { id: 'c1', method: 'MOBILE_MONEY' })).toEqual({ ok: true, value: 'c1' });
    expect(judgePayee('BANK', { id: 'c2', method: 'BANK' })).toEqual({ ok: true, value: 'c2' });
    expect(judgePayee('BANK', null)).toEqual({ ok: false, error: 'PAYOUT_DETAILS_MISSING' });
    expect(judgePayee('MOBILE_MONEY', { id: 'c2', method: 'BANK' })).toEqual({ ok: false, error: 'PAYOUT_METHOD_DIFFERS' });
  });
});
