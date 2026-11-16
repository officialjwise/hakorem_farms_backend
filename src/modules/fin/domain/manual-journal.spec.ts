import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { checkManualJournal, journalTotals, judgeSubmit, manualPostingAmounts, MAX_MANUAL_LINES, type ManualJournalFacts, type ManualLine } from './manual-journal';

const facts: ManualJournalFacts = {
  today: '2026-11-16',
  openingEquityCode: '3900',
  accounts: new Map(
    [
      { id: 'a-1000', code: '1000', postable: true, subledgerKind: 'REGISTER' as const },
      { id: 'a-1010', code: '1010', postable: true, subledgerKind: null },
      { id: 'a-2000', code: '2000', postable: true, subledgerKind: 'SUPPLIER' as const },
      { id: 'a-3900', code: '3900', postable: true, subledgerKind: null },
      { id: 'a-6000', code: '6000', postable: true, subledgerKind: null },
      { id: 'a-6999', code: '6999', postable: false, subledgerKind: null },
    ].map((a) => [a.id, a]),
  ),
  parties: new Map([
    ['p-supplier', { id: 'p-supplier', kind: 'SUPPLIER' as const, refId: 'supplier-1', displayName: 'Asante Feeds' }],
    ['p-register', { id: 'p-register', kind: 'REGISTER' as const, refId: 'register-1', displayName: 'Shop till 1' }],
  ]),
};
const line = (accountId: string, side: 'D' | 'C', amountPesewas: number, extra: Partial<ManualLine> = {}): ManualLine => ({ accountId, side, amountPesewas, subledgerPartyId: null, memo: null, ...extra });
const wages = [line('a-6000', 'D', 960_000), line('a-1010', 'C', 960_000)];

describe('a manual journal is checked line by line (FR-FIN-008, FR-FIN-004)', () => {
  it('accepts November wages paid from the safe, dated today', () => {
    expect(checkManualJournal({ kind: 'MANUAL', postingDate: '2026-11-16', lines: wages }, facts)).toEqual([]);
  });

  it('needs two lines and at most the maximum', () => {
    expect(checkManualJournal({ kind: 'MANUAL', postingDate: '2026-11-16', lines: [wages[0]!] }, facts)).toEqual([{ field: '/lines', rule: 'TOO_FEW_LINES' }]);
    const many = Array.from({ length: 100 }, () => [line('a-6000', 'D', 1), line('a-1010', 'C', 1)]).flat();
    expect(many).toHaveLength(MAX_MANUAL_LINES);
    expect(checkManualJournal({ kind: 'MANUAL', postingDate: '2026-11-16', lines: many }, facts)).toEqual([]);
    many.push(line('a-6000', 'D', 1));
    expect(checkManualJournal({ kind: 'MANUAL', postingDate: '2026-11-16', lines: many }, facts)).toEqual([{ field: '/lines', rule: 'TOO_MANY_LINES' }]);
  });

  it('refuses a date after today, and an unknown or non-postable account', () => {
    expect(
      checkManualJournal({ kind: 'MANUAL', postingDate: '2026-11-17', lines: [line('a-nope', 'D', 5), line('a-6999', 'C', 5)] }, facts),
    ).toEqual([
      { field: '/postingDate', rule: 'FUTURE_DATE' },
      { field: '/lines/0/accountId', rule: 'UNKNOWN_ACCOUNT' },
      { field: '/lines/1/accountId', rule: 'ACCOUNT_NOT_POSTABLE' },
    ]);
  });

  it('names a party exactly on a control account, and one of its kind (FR-FIN-004)', () => {
    expect(
      checkManualJournal(
        {
          kind: 'MANUAL',
          postingDate: '2026-11-01',
          lines: [
            line('a-2000', 'D', 5),
            line('a-2000', 'D', 5, { subledgerPartyId: 'p-register' }),
            line('a-1000', 'D', 5, { subledgerPartyId: 'p-unknown' }),
            line('a-6000', 'C', 15, { subledgerPartyId: 'p-supplier' }),
            line('a-2000', 'C', 0, { subledgerPartyId: 'p-supplier' }),
          ],
        },
        facts,
      ),
    ).toEqual([
      { field: '/lines/0/subledgerPartyId', rule: 'SUBLEDGER_REQUIRED' },
      { field: '/lines/1/subledgerPartyId', rule: 'SUBLEDGER_KIND_DIFFERS' },
      { field: '/lines/2/subledgerPartyId', rule: 'UNKNOWN_SUBLEDGER' },
      { field: '/lines/3/subledgerPartyId', rule: 'SUBLEDGER_NOT_ALLOWED' },
      { field: '/lines/4/amountPesewas', rule: 'AMOUNT_NOT_POSITIVE' },
    ]);
  });

  it('takes the opening balance against 3900 only (A-005)', () => {
    expect(checkManualJournal({ kind: 'OPENING', postingDate: '2026-11-16', lines: wages }, facts)).toEqual([{ field: '/lines', rule: 'OPENING_WITHOUT_3900' }]);
    expect(checkManualJournal({ kind: 'OPENING', postingDate: '2026-11-16', lines: [line('a-1010', 'D', 2_500_000), line('a-3900', 'C', 2_500_000)] }, facts)).toEqual([]);
  });
});

describe('the totals of a manual journal are exact integers', () => {
  it('sums each side and says whether they balance', () => {
    expect(journalTotals([line('a-6000', 'D', 333_334), line('a-6000', 'D', 333_333), line('a-1010', 'C', 666_667)])).toEqual({
      debit: Money.ofPesewas(666_667n),
      credit: Money.ofPesewas(666_667n),
      balanced: true,
    });
    expect(journalTotals([line('a-6000', 'D', 10_000), line('a-1010', 'C', 9_999)]).balanced).toBe(false);
    expect(journalTotals([]).balanced).toBe(false);
  });
});

describe('submitting a manual journal (FR-FIN-008)', () => {
  it('needs a balanced draft', () => {
    expect(judgeSubmit('DRAFT', journalTotals(wages))).toEqual({ ok: true, value: undefined });
    expect(judgeSubmit('DRAFT', journalTotals([line('a-6000', 'D', 10_000), line('a-1010', 'C', 9_999)]))).toEqual({ ok: false, error: 'UNBALANCED' });
    expect(judgeSubmit('PENDING_APPROVAL', journalTotals(wages))).toEqual({ ok: false, error: 'PENDING_APPROVAL' });
    expect(judgeSubmit('POSTED', journalTotals(wages))).toEqual({ ok: false, error: 'POSTED' });
  });
});

describe('a manual journal becomes the named amounts of fin.ManualJournalApproved', () => {
  it('keeps each line as entered: its side as the amount key, its account, party and memo', () => {
    const amounts = manualPostingAmounts([line('a-2000', 'D', 120_000, { subledgerPartyId: 'p-supplier', memo: 'Reclass from unnamed bank' }), line('a-1010', 'C', 120_000)], facts.parties);
    expect(amounts).toEqual([
      { key: 'debit', amount: Money.ofPesewas(120_000n), enteredAccountId: 'a-2000', subledgers: [{ kind: 'SUPPLIER', refId: 'supplier-1', displayName: 'Asante Feeds' }], memo: 'Reclass from unnamed bank' },
      { key: 'credit', amount: Money.ofPesewas(120_000n), enteredAccountId: 'a-1010', subledgers: [], memo: null },
    ]);
  });
});
