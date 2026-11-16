import { describe, expect, it } from 'vitest';
import { checkAccountClosing, checkNewAccount, normalSideOf, type NewAccount } from './accounts';

const fuel: NewAccount = { code: '6110', type: 'EXPENSE', isPostable: true, subledgerKind: null };

describe('a new account (FR-FIN-002)', () => {
  it('takes the normal side of its type: assets, cost of sales and expenses are debit, the rest credit', () => {
    expect(normalSideOf('ASSET')).toBe('D');
    expect(normalSideOf('COST_OF_SALES')).toBe('D');
    expect(normalSideOf('EXPENSE')).toBe('D');
    expect(normalSideOf('LIABILITY')).toBe('C');
    expect(normalSideOf('EQUITY')).toBe('C');
    expect(normalSideOf('INCOME')).toBe('C');
  });

  it('accepts an account whose code is in its type class, with no parent', () => {
    expect(checkNewAccount(fuel, null)).toEqual([]);
  });

  it('refuses a code outside its type class: the first digit gives the class', () => {
    for (const [code, type] of [
      ['1999', 'LIABILITY'],
      ['2999', 'ASSET'],
      ['3999', 'INCOME'],
      ['4999', 'EQUITY'],
      ['5999', 'EXPENSE'],
      ['6999', 'COST_OF_SALES'],
    ] as const) {
      expect(checkNewAccount({ ...fuel, code, type }, null)).toEqual([{ field: '/code', rule: 'CLASS_MISMATCH' }]);
    }
  });

  it('refuses a subledger on a header account, which takes no lines', () => {
    expect(checkNewAccount({ code: '1150', type: 'ASSET', isPostable: false, subledgerKind: 'BANK_ACCOUNT' }, null)).toEqual([{ field: '/subledgerKind', rule: 'SUBLEDGER_ON_HEADER' }]);
    expect(checkNewAccount({ code: '1150', type: 'ASSET', isPostable: true, subledgerKind: 'BANK_ACCOUNT' }, null)).toEqual([]);
  });

  it('rolls up only under a parent of its own type, and lists every rule it breaks', () => {
    expect(checkNewAccount(fuel, { type: 'EXPENSE' })).toEqual([]);
    expect(checkNewAccount({ code: '1150', type: 'LIABILITY', isPostable: false, subledgerKind: 'BANK_ACCOUNT' }, { type: 'ASSET' })).toEqual([
      { field: '/code', rule: 'CLASS_MISMATCH' },
      { field: '/subledgerKind', rule: 'SUBLEDGER_ON_HEADER' },
      { field: '/parentId', rule: 'PARENT_TYPE_MISMATCH' },
    ]);
  });
});

describe('closing an account (FR-FIN-002)', () => {
  it('closes an account with a nil balance that no rule or determination in force names', () => {
    expect(checkAccountClosing({ balancePesewas: 0n, namedInForce: false })).toEqual([]);
  });

  it('refuses while it carries a balance, by a pesewa either side', () => {
    expect(checkAccountClosing({ balancePesewas: 1n, namedInForce: false })).toEqual([{ field: '/status', rule: 'BALANCE_NOT_ZERO' }]);
    expect(checkAccountClosing({ balancePesewas: -1n, namedInForce: false })).toEqual([{ field: '/status', rule: 'BALANCE_NOT_ZERO' }]);
  });

  it('refuses while a posting rule or determination in force names it, so no posting is left with nowhere to go', () => {
    expect(checkAccountClosing({ balancePesewas: 5n, namedInForce: true })).toEqual([
      { field: '/status', rule: 'BALANCE_NOT_ZERO' },
      { field: '/status', rule: 'IN_USE_BY_RULE' },
    ]);
  });
});
