import { describe, expect, it } from 'vitest';
import { bankAccountKindFor, glCodeOf, judgePayoutAccount, normaliseAccountNo } from './bank-account';

describe('a bank account number (ADR-0057, A-194)', () => {
  it('keeps a bank number of 6 to 20 digits, spaces and dashes dropped, and its last four digits', () => {
    expect(normaliseAccountNo('BANK', ' 2040-0166 20 ')).toEqual({ ok: true, value: { accountNo: '2040016620', last4: '6620' } });
    expect(normaliseAccountNo('BANK', '123456')).toEqual({ ok: true, value: { accountNo: '123456', last4: '3456' } });
    expect(normaliseAccountNo('BANK', '12345678901234567890')).toEqual({ ok: true, value: { accountNo: '12345678901234567890', last4: '7890' } });
  });

  it('refuses a bank number of five or twenty-one digits, or with a letter', () => {
    for (const bad of ['12345', '123456789012345678901', '20400A6620', '', '+233244123456']) {
      expect(normaliseAccountNo('BANK', bad), bad).toEqual({ ok: false, error: { field: '/accountNo', rule: 'ACCOUNT_NUMBER_INVALID' } });
    }
  });

  it('keeps a wallet number as +233 and nine digits, from E.164 or national form', () => {
    expect(normaliseAccountNo('MOBILE_MONEY', '+233 24 412 7310')).toEqual({ ok: true, value: { accountNo: '+233244127310', last4: '7310' } });
    expect(normaliseAccountNo('MOBILE_MONEY', '024-412-7310')).toEqual({ ok: true, value: { accountNo: '+233244127310', last4: '7310' } });
  });

  it('refuses a wallet number that is not a Ghana mobile number', () => {
    for (const bad of ['24412731', '+23324412731', '+2332441273100', '0244127310x', '2040016620', '00244127310']) {
      expect(normaliseAccountNo('MOBILE_MONEY', bad), bad).toEqual({ ok: false, error: { field: '/accountNo', rule: 'MOMO_NUMBER_INVALID' } });
    }
  });

  it('posts a bank to 1100 and a wallet to 1110', () => {
    expect(glCodeOf('BANK')).toBe('1100');
    expect(glCodeOf('MOBILE_MONEY')).toBe('1110');
  });
});

describe('the account a supplier payment leaves from (A-185, A-194)', () => {
  it('is a bank for a bank transfer or a cheque, a wallet for mobile money, and none for cash', () => {
    expect(bankAccountKindFor('BANK')).toBe('BANK');
    expect(bankAccountKindFor('CHEQUE')).toBe('BANK');
    expect(bankAccountKindFor('MOBILE_MONEY')).toBe('MOBILE_MONEY');
    expect(bankAccountKindFor('CASH')).toBeNull();
  });

  it('must be an active account of the payment method, or none at all', () => {
    const bank = { kind: 'BANK' as const, isActive: true };
    expect(judgePayoutAccount('BANK', null)).toEqual({ ok: true, value: undefined });
    expect(judgePayoutAccount('CASH', null)).toEqual({ ok: true, value: undefined });
    expect(judgePayoutAccount('BANK', bank)).toEqual({ ok: true, value: undefined });
    expect(judgePayoutAccount('CHEQUE', bank)).toEqual({ ok: true, value: undefined });
    expect(judgePayoutAccount('MOBILE_MONEY', { kind: 'MOBILE_MONEY', isActive: true })).toEqual({ ok: true, value: undefined });
    const refused = { ok: false, error: 'BANK_ACCOUNT_NOT_AVAILABLE' };
    expect(judgePayoutAccount('BANK', 'UNKNOWN')).toEqual(refused);
    expect(judgePayoutAccount('BANK', { kind: 'BANK', isActive: false })).toEqual(refused);
    expect(judgePayoutAccount('MOBILE_MONEY', bank)).toEqual(refused);
    expect(judgePayoutAccount('BANK', { kind: 'MOBILE_MONEY', isActive: true })).toEqual(refused);
    expect(judgePayoutAccount('CASH', bank)).toEqual(refused);
  });
});
