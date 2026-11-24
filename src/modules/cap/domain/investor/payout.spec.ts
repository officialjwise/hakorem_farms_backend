import { describe, expect, it } from 'vitest';
import { judgeIdNumber, judgePayout, maskPayout } from './payout';

/** FR-CAP-002: payout details are judged, then shown only masked. */
describe('an investor payout', () => {
  it('accepts a bank account and masks it to the bank and the last four digits', () => {
    const judged = judgePayout({ method: 'BANK', bankName: ' GCB ', accountName: 'Ama Owusu-Ansah', accountNumber: '1020304051180' });
    expect(judged).toEqual({ ok: true, value: { method: 'BANK', bankName: 'GCB', accountName: 'Ama Owusu-Ansah', accountNumber: '1020304051180' } });
    expect(maskPayout((judged as { value: Parameters<typeof maskPayout>[0] }).value)).toBe('GCB, ****1180');
  });

  it('accepts a mobile money wallet on a Ghanaian number and masks it', () => {
    const judged = judgePayout({ method: 'MOBILE_MONEY', momoNetwork: 'MTN', momoNumber: '+233244310221' });
    expect(judged.ok).toBe(true);
    expect(maskPayout((judged as { value: Parameters<typeof maskPayout>[0] }).value)).toBe('MTN MoMo, ****0221');
  });

  it('refuses what is missing, what belongs to the other method, and a malformed number', () => {
    expect(judgePayout({ method: 'BANK', bankName: 'GCB', accountNumber: '12AB', momoNumber: '+233244310221' })).toEqual({
      ok: false,
      rules: [
        { field: '/payout/accountName', rule: 'REQUIRED' },
        { field: '/payout/accountNumber', rule: 'ACCOUNT_NUMBER_INVALID' },
        { field: '/payout/momoNumber', rule: 'NOT_FOR_METHOD' },
      ],
    });
    expect(judgePayout({ method: 'MOBILE_MONEY', momoNetwork: 'MTN', momoNumber: '0244310221' })).toEqual({ ok: false, rules: [{ field: '/payout/momoNumber', rule: 'MOMO_NUMBER_INVALID' }] });
  });

  it('reads an identity number upper-cased and shows only its last four characters', () => {
    expect(judgeIdNumber(' gha-723456789-3 ')).toEqual({ ok: true, value: { value: 'GHA-723456789-3', masked: '****89-3' } });
    expect(judgeIdNumber('x')).toEqual({ ok: false, rules: [{ field: '/idNumber', rule: 'ID_NUMBER_INVALID' }] });
  });
});
