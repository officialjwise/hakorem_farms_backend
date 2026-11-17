import { Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { checkRejection, REJECTION_DOMAIN } from './rejection';

const reasons = new Map([
  ['CRACKED', { domain: REJECTION_DOMAIN, requiresNote: false }],
  ['QUALITY_REJECTED', { domain: REJECTION_DOMAIN, requiresNote: true }],
  ['BREAKAGE', { domain: 'STOCK_ADJUSTMENT', requiresNote: false }],
]);
const at = (rejected: string, reasonCode: string | null, note: string | null) => checkRejection({ rejected: Quantity.parse(rejected), reasonCode, note }, reasons, '/lines/2');

describe('a goods receipt line rejection (A-260, CR-035 point 3)', () => {
  it('accepts nothing rejected with no reason, and a rejection with a reason that needs no note', () => {
    expect(at('0.000', null, null)).toEqual([]);
    expect(at('1.000', 'CRACKED', null)).toEqual([]);
    expect(at('0.001', 'CRACKED', 'One egg hairline cracked')).toEqual([]);
  });

  it('refuses a rejected quantity without a reason', () => {
    expect(at('1.000', null, null)).toEqual([{ field: '/lines/2/rejectionReasonCode', rule: 'REJECTION_REASON_REQUIRED' }]);
  });

  it('refuses a reason or a note on nothing rejected', () => {
    expect(at('0.000', 'CRACKED', null)).toEqual([{ field: '/lines/2/rejectionReasonCode', rule: 'REASON_NOT_ALLOWED' }]);
    expect(at('0.000', null, 'A note')).toEqual([{ field: '/lines/2/rejectionNote', rule: 'REASON_NOT_ALLOWED' }]);
  });

  it('refuses an unknown reason and a reason from another domain', () => {
    expect(at('1.000', 'NO_SUCH', null)).toEqual([{ field: '/lines/2/rejectionReasonCode', rule: 'REASON_NOT_ALLOWED' }]);
    expect(at('1.000', 'BREAKAGE', null)).toEqual([{ field: '/lines/2/rejectionReasonCode', rule: 'REASON_NOT_ALLOWED' }]);
  });

  it('refuses a reason that needs a note without one, and takes it with one', () => {
    expect(at('1.000', 'QUALITY_REJECTED', null)).toEqual([{ field: '/lines/2/rejectionNote', rule: 'NOTE_REQUIRED' }]);
    expect(at('1.000', 'QUALITY_REJECTED', 'Shells thin and soft')).toEqual([]);
  });
});
