import { describe, expect, it } from 'vitest';
import { controlAccountBreaks, subledgerByAccount, trialBalance, type AccountActivity } from './trial-balance';

const activity = (code: string, openingDebit: bigint, openingCredit: bigint, debit: bigint, credit: bigint): AccountActivity => ({
  accountId: `acct-${code}`,
  code,
  name: `Account ${code}`,
  openingDebit,
  openingCredit,
  debit,
  credit,
});

describe('the trial balance (FR-FIN-011)', () => {
  it('lists opening, debits, credits and closing per account and totals that sum to zero', () => {
    const tb = trialBalance([activity('1310', 100_000n, 0n, 71_400n, 0n), activity('2010', 0n, 100_000n, 0n, 71_400n)]);
    expect(tb.lines.map((l) => [l.code, l.closingDebit, l.closingCredit])).toEqual([
      ['1310', 171_400n, 0n],
      ['2010', 0n, 171_400n],
    ]);
    expect(tb.totals).toEqual({ openingDebit: 100_000n, openingCredit: 100_000n, debit: 71_400n, credit: 71_400n, closingDebit: 171_400n, closingCredit: 171_400n });
    expect(tb.signedSum).toBe(0n);
    expect(tb.balanced).toBe(true);
  });

  it('nets an account with both sides to one closing side, and a nil account to zero on both', () => {
    const tb = trialBalance([activity('1340', 0n, 0n, 76_400n, 76_400n), activity('5140', 0n, 0n, 1_000n, 1_001n), activity('2000', 0n, 0n, 1n, 0n)]);
    expect(tb.lines.map((l) => [l.code, l.closingDebit, l.closingCredit])).toEqual([
      ['1340', 0n, 0n],
      ['5140', 0n, 1n],
      ['2000', 1n, 0n],
    ]);
    expect(tb.signedSum).toBe(0n);
    expect(tb.balanced).toBe(true);
  });

  it('reports an unbalanced ledger by its exact signed sum', () => {
    const tb = trialBalance([activity('1310', 0n, 0n, 10_000n, 0n), activity('2010', 0n, 0n, 0n, 9_999n)]);
    expect(tb.signedSum).toBe(1n);
    expect(tb.balanced).toBe(false);
  });

  it('is balanced and zero for an empty ledger', () => {
    expect(trialBalance([])).toEqual({
      lines: [],
      totals: { openingDebit: 0n, openingCredit: 0n, debit: 0n, credit: 0n, closingDebit: 0n, closingCredit: 0n },
      signedSum: 0n,
      balanced: true,
    });
  });
});

describe('control accounts against their subledger (FR-FIN-016)', () => {
  const determinations = [
    { type: 'GL_GROUP' as const, key: 'LIVE_ANIMALS', role: 'INVENTORY', accountId: 'acct-1310' },
    { type: 'GL_GROUP' as const, key: 'MEAT', role: 'INVENTORY', accountId: 'acct-1320' },
    { type: 'GL_GROUP' as const, key: 'OFFAL', role: 'INVENTORY', accountId: 'acct-1320' },
    { type: 'GL_GROUP' as const, key: 'LIVE_ANIMALS', role: 'COST_OF_SALES', accountId: 'acct-5000' },
  ];

  it('sums the subledger by the account each key maps to, and names a key that maps to none', () => {
    expect(
      subledgerByAccount(
        [
          { key: 'LIVE_ANIMALS', pesewas: 71_400n },
          { key: 'MEAT', pesewas: 69_568n },
          { key: 'OFFAL', pesewas: 6_832n },
          { key: 'SERVICE', pesewas: 5n },
        ],
        determinations,
        'GL_GROUP',
        'INVENTORY',
      ),
    ).toEqual({
      byAccount: new Map([
        ['acct-1310', 71_400n],
        ['acct-1320', 76_400n],
      ]),
      unmapped: [{ key: 'SERVICE', pesewas: 5n }],
    });
  });

  it('finds no break when every control account equals its subledger, and each difference exactly otherwise', () => {
    const ledger = new Map([
      ['acct-1310', 71_400n],
      ['acct-1320', 76_400n],
    ]);
    expect(controlAccountBreaks(ledger, new Map(ledger))).toEqual([]);
    expect(
      controlAccountBreaks(
        new Map([
          ['acct-1310', 71_400n],
          ['acct-1330', 10n],
        ]),
        new Map([
          ['acct-1310', 71_399n],
          ['acct-1320', 76_400n],
        ]),
      ),
    ).toEqual([
      { accountId: 'acct-1310', ledgerPesewas: 71_400n, subledgerPesewas: 71_399n, differencePesewas: 1n },
      { accountId: 'acct-1330', ledgerPesewas: 10n, subledgerPesewas: 0n, differencePesewas: 10n },
      { accountId: 'acct-1320', ledgerPesewas: 0n, subledgerPesewas: 76_400n, differencePesewas: -76_400n },
    ]);
  });
});
