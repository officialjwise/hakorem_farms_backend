import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { buildJournalLines, reverseLines, signedTotal, type LedgerAccount, type PostingAmount, type PostingRule, type RuleSet } from './posting';

const account = (code: string, subledgerKind: LedgerAccount['subledgerKind'] = null, postable = true): LedgerAccount => ({ id: `acct-${code}`, code, subledgerKind, postable });
const accounts = new Map<string, LedgerAccount>(
  [account('1310'), account('1320'), account('2010'), account('2000', 'SUPPLIER'), account('1400', 'TAX_LEVY'), account('5100'), account('5110'), account('1999', null, false)].map((a) => [a.id, a]),
);
const fixed = (amountKey: string, side: 'D' | 'C', code: string): PostingRule => ({ amountKey, side, accountId: `acct-${code}`, determinantType: null, determinantRole: null });
const determined = (amountKey: string, side: 'D' | 'C', determinantType: PostingRule['determinantType'], determinantRole: string): PostingRule => ({
  amountKey,
  side,
  accountId: null,
  determinantType,
  determinantRole,
});
const ruleSet = (rules: PostingRule[]): RuleSet => ({
  rules,
  accounts,
  determinations: [
    { type: 'GL_GROUP', key: 'LIVE_ANIMALS', role: 'INVENTORY', accountId: 'acct-1310' },
    { type: 'GL_GROUP', key: 'MEAT', role: 'INVENTORY', accountId: 'acct-1320' },
    { type: 'LOSS_GROUP', key: 'MORTALITY', role: 'LOSS', accountId: 'acct-5100' },
    { type: 'LOSS_GROUP', key: '*', role: 'LOSS', accountId: 'acct-5110' },
    { type: 'TAX_LEVY', key: '*', role: 'INPUT', accountId: 'acct-1400' },
  ],
});
const value = (pesewas: bigint, extra: Partial<PostingAmount> = {}): PostingAmount => ({ key: 'value', amount: Money.ofPesewas(pesewas), ...extra });
const receipt = ruleSet([determined('value', 'D', 'GL_GROUP', 'INVENTORY'), fixed('value', 'C', '2010')]);

describe('building a journal from posting rules (ADR-0003)', () => {
  it('debits the inventory account of the GL group and credits 2010 with exactly the receipt value', () => {
    const result = buildJournalLines([value(71_400n, { determinants: { GL_GROUP: 'LIVE_ANIMALS' }, costObjectId: 'unit-1', memo: 'goat' })], receipt, ['value']);
    expect(result).toEqual({
      ok: true,
      value: [
        { lineNo: 1, accountId: 'acct-1310', accountCode: '1310', side: 'D', amount: Money.ofPesewas(71_400n), subledger: null, memo: 'goat', costObjectId: 'unit-1' },
        { lineNo: 2, accountId: 'acct-2010', accountCode: '2010', side: 'C', amount: Money.ofPesewas(71_400n), subledger: null, memo: 'goat', costObjectId: 'unit-1' },
      ],
    });
  });

  it('falls back to the default `*` determination when the key has no row of its own', () => {
    const writeOff = ruleSet([determined('value', 'D', 'LOSS_GROUP', 'LOSS'), determined('value', 'C', 'GL_GROUP', 'INVENTORY')]);
    const result = buildJournalLines([value(1_000n, { determinants: { LOSS_GROUP: 'SHRINKAGE', GL_GROUP: 'MEAT' } })], writeOff, ['value']);
    expect(result.ok && result.value.map((l) => [l.accountCode, l.side, l.amount.pesewas])).toEqual([
      ['5110', 'D', 1_000n],
      ['1320', 'C', 1_000n],
    ]);
  });

  it('uses the default determination when the amount names no key of that type', () => {
    const writeOff = ruleSet([determined('value', 'D', 'LOSS_GROUP', 'LOSS'), determined('value', 'C', 'GL_GROUP', 'INVENTORY')]);
    const result = buildJournalLines([value(5n, { determinants: { GL_GROUP: 'MEAT' } })], writeOff, ['value']);
    expect(result.ok && result.value[0]!.accountCode).toBe('5110');
  });

  it('posts nothing for an amount of zero, so a zero-value receipt has no entry', () => {
    expect(buildJournalLines([value(0n, { determinants: { GL_GROUP: 'MEAT' } })], receipt, ['value'])).toEqual({ ok: true, value: [] });
  });

  it('attaches the subledger party of the account kind and none to an account without a subledger', () => {
    const invoice = ruleSet([fixed('receiptValue', 'D', '2010'), determined('levy', 'D', 'TAX_LEVY', 'INPUT'), fixed('gross', 'C', '2000')]);
    const supplier = { kind: 'SUPPLIER' as const, refId: 'sup-1', displayName: 'Kpone Livestock Traders' };
    const levy = { kind: 'TAX_LEVY' as const, refId: 'levy-vat', displayName: 'VAT' };
    const result = buildJournalLines(
      [
        { key: 'receiptValue', amount: Money.ofPesewas(100_000n), subledgers: [supplier] },
        { key: 'levy', amount: Money.ofPesewas(15_000n), determinants: { TAX_LEVY: 'VAT' }, subledgers: [levy] },
        { key: 'gross', amount: Money.ofPesewas(115_000n), subledgers: [supplier] },
      ],
      invoice,
      ['receiptValue', 'levy', 'gross'],
    );
    expect(result.ok && result.value.map((l) => [l.accountCode, l.side, l.amount.pesewas, l.subledger?.refId ?? null])).toEqual([
      ['2010', 'D', 100_000n, null],
      ['1400', 'D', 15_000n, 'levy-vat'],
      ['2000', 'C', 115_000n, 'sup-1'],
    ]);
  });

  it('refuses an amount the event does not declare', () => {
    expect(buildJournalLines([{ key: 'bonus', amount: Money.ofPesewas(1n) }], receipt, ['value'])).toEqual({ ok: false, error: { rule: 'UNKNOWN_AMOUNT', amountKey: 'bonus' } });
  });

  it('refuses an amount with no rule', () => {
    expect(buildJournalLines([{ key: 'gross', amount: Money.ofPesewas(1n) }], receipt, ['value', 'gross'])).toEqual({ ok: false, error: { rule: 'NO_RULE', amountKey: 'gross' } });
  });

  it('refuses when no determination maps the key, not even a default', () => {
    expect(buildJournalLines([value(10n, { determinants: { GL_GROUP: 'SERVICE' } })], receipt, ['value'])).toEqual({
      ok: false,
      error: { rule: 'NO_ACCOUNT', amountKey: 'value', determinantType: 'GL_GROUP', key: 'SERVICE', role: 'INVENTORY' },
    });
  });

  it('refuses a rule whose account is unknown or takes no lines', () => {
    expect(buildJournalLines([value(10n)], ruleSet([fixed('value', 'D', '1999'), fixed('value', 'C', '2010')]), ['value'])).toEqual({
      ok: false,
      error: { rule: 'ACCOUNT_NOT_POSTABLE', accountCode: '1999' },
    });
    expect(buildJournalLines([value(10n)], ruleSet([fixed('value', 'D', '7777'), fixed('value', 'C', '2010')]), ['value'])).toEqual({
      ok: false,
      error: { rule: 'ACCOUNT_NOT_POSTABLE', accountCode: 'acct-7777' },
    });
  });

  it('refuses a control account line without its subledger party', () => {
    expect(buildJournalLines([{ key: 'gross', amount: Money.ofPesewas(10n) }], ruleSet([fixed('gross', 'C', '2000'), fixed('gross', 'D', '2010')]), ['gross'])).toEqual({
      ok: false,
      error: { rule: 'SUBLEDGER_MISSING', accountCode: '2000', kind: 'SUPPLIER' },
    });
  });

  it('refuses a rule set whose lines do not balance, naming both totals', () => {
    expect(buildJournalLines([value(10n, { determinants: { GL_GROUP: 'MEAT' } })], ruleSet([determined('value', 'D', 'GL_GROUP', 'INVENTORY')]), ['value'])).toEqual({
      ok: false,
      error: { rule: 'UNBALANCED', debits: 10n, credits: 0n },
    });
  });
});

describe('reversing a journal (ADR-0003: reverse the original lines, never compute fresh ones)', () => {
  it('swaps every side and keeps accounts, amounts, subledgers and line numbers', () => {
    const built = buildJournalLines([value(71_400n, { determinants: { GL_GROUP: 'LIVE_ANIMALS' } })], receipt, ['value']);
    if (!built.ok) throw new Error('built');
    expect(reverseLines(built.value).map((l) => [l.lineNo, l.accountCode, l.side, l.amount.pesewas])).toEqual([
      [1, '1310', 'C', 71_400n],
      [2, '2010', 'D', 71_400n],
    ]);
  });
});

describe('the signed total of lines', () => {
  it('is debits less credits, exactly zero for a balanced entry', () => {
    const line = (side: 'D' | 'C', pesewas: bigint) => ({ side, amount: Money.ofPesewas(pesewas) });
    expect(signedTotal([line('D', 10_000n), line('C', 9_999n)])).toBe(1n);
    expect(signedTotal([line('D', 10_000n), line('C', 10_000n)])).toBe(0n);
    expect(signedTotal([])).toBe(0n);
  });
});
