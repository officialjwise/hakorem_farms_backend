import { describe, expect, it } from 'vitest';
import {
  chooseBankCandidate,
  judgeLineMatch,
  judgeResolution,
  matchSettlementLine,
  parseCedis,
  readSettlementFile,
  readStatementFile,
  settlementPosting,
  type BankCandidate,
} from './reconciliation';

const SETTLEMENT_HEADER = ['settlement_ref', 'settled_on', 'reference', 'amount', 'fee'];
const STATEMENT_HEADER = ['value_date', 'direction', 'amount', 'balance', 'reference', 'narration'];

describe('amounts in a reconciliation file (cedis with exactly two places, read as integer pesewas)', () => {
  it('reads 1500.00 as 150,000 pesewas and 0.01 as 1', () => {
    expect(parseCedis('1500.00')).toBe(150_000n);
    expect(parseCedis('0.01')).toBe(1n);
    expect(parseCedis('0.00')).toBe(0n);
  });

  it('reads the largest amount a pesewa column holds', () => {
    expect(parseCedis('90071992547409.91')).toBe(9_007_199_254_740_991n);
  });

  it('refuses one place, three places, a sign, a separator, a float exponent and an amount beyond the column', () => {
    for (const bad of ['15.0', '15.000', '-15.00', '+15.00', '1,500.00', '1.5e3', '', ' 15.00', '90071992547409.92']) expect(parseCedis(bad)).toBeNull();
  });
});

describe('a provider settlement file (FR-PAY-016)', () => {
  const rows = [
    SETTLEMENT_HEADER,
    ['STL-50001', '2026-11-13', 'HK-a', '500.00', '5.00'],
    ['STL-50001', '2026-11-13', 'HK-b', '400.00', '4.00'],
    ['STL-50001', '2026-11-13', 'HK-c', '600.00', '6.00'],
    ['STL-50001', '2026-11-13', 'T7730994017', '20.00', '0.00'],
  ];

  it('reads four lines totalling 152,000 gross, 1,500 fee and 150,500 net', () => {
    const read = readSettlementFile(rows, '2026-11-16');
    expect(read).toEqual({
      ok: true,
      value: {
        settlementRef: 'STL-50001',
        settledOn: '2026-11-13',
        grossPesewas: 152_000n,
        feePesewas: 1_500n,
        netPesewas: 150_500n,
        lines: [
          { lineNo: 1, reference: 'HK-a', amountPesewas: 50_000n, feePesewas: 500n },
          { lineNo: 2, reference: 'HK-b', amountPesewas: 40_000n, feePesewas: 400n },
          { lineNo: 3, reference: 'HK-c', amountPesewas: 60_000n, feePesewas: 600n },
          { lineNo: 4, reference: 'T7730994017', amountPesewas: 2_000n, feePesewas: 0n },
        ],
      },
    });
  });

  it('accepts the header in any case and with spaces around it', () => {
    expect(readSettlementFile([[' Settlement_Ref', 'SETTLED_ON ', 'Reference', 'Amount', 'Fee'], rows[1]!], '2026-11-16').ok).toBe(true);
  });

  it('refuses a file with another header, or with no lines', () => {
    expect(readSettlementFile([['ref', 'amount'], rows[1]!], '2026-11-16')).toEqual({ ok: false, error: [{ row: 1, rule: 'HEADER_MISMATCH' }] });
    expect(readSettlementFile([SETTLEMENT_HEADER], '2026-11-16')).toEqual({ ok: false, error: [{ row: 1, rule: 'NO_LINES' }] });
    expect(readSettlementFile([], '2026-11-16')).toEqual({ ok: false, error: [{ row: 1, rule: 'HEADER_MISMATCH' }] });
  });

  it('names every broken row at once', () => {
    const read = readSettlementFile(
      [
        SETTLEMENT_HEADER,
        ['STL-50001', '2026-11-13', 'HK-a', '500.0', '5.00'],
        ['STL-50002', '2026-11-13', 'HK-b', '400.00', '4.00'],
        ['STL-50001', '2026-11-12', 'HK-a', '0.00', '0.00'],
        ['STL-50001', '2026-11-13', 'HK-d', '4.00', '4.01'],
        ['STL-50001', '2026-11-13', '', '4.00', 'x'],
        ['STL-50001', '2026-11-13', 'HK-e'],
      ],
      '2026-11-16',
    );
    expect(read).toEqual({
      ok: false,
      error: [
        { row: 2, rule: 'AMOUNT_INVALID' },
        { row: 3, rule: 'SETTLEMENT_REF_MIXED' },
        { row: 4, rule: 'SETTLED_ON_MIXED' },
        { row: 4, rule: 'AMOUNT_NOT_POSITIVE' },
        { row: 4, rule: 'REFERENCE_REPEATED' },
        { row: 5, rule: 'FEE_EXCEEDS_AMOUNT' },
        { row: 6, rule: 'REFERENCE_INVALID' },
        { row: 6, rule: 'FEE_INVALID' },
        { row: 7, rule: 'COLUMNS_MISSING' },
      ],
    });
  });

  it('refuses a settlement dated after today, or not a date, or with a malformed settlement reference', () => {
    expect(readSettlementFile([SETTLEMENT_HEADER, ['STL-50001', '2026-11-17', 'HK-a', '5.00', '0.00']], '2026-11-16')).toEqual({ ok: false, error: [{ row: 2, rule: 'SETTLED_ON_IN_FUTURE' }] });
    expect(readSettlementFile([SETTLEMENT_HEADER, ['STL-50001', '2026-02-30', 'HK-a', '5.00', '0.00']], '2026-11-16')).toEqual({ ok: false, error: [{ row: 2, rule: 'SETTLED_ON_INVALID' }] });
    expect(readSettlementFile([SETTLEMENT_HEADER, ['', '2026-11-13', 'HK-a', '5.00', '0.00']], '2026-11-16')).toEqual({ ok: false, error: [{ row: 2, rule: 'SETTLEMENT_REF_INVALID' }] });
  });
});

describe('matching a settlement line to a payment (FR-PAY-016: by reference and amount, nothing corrected)', () => {
  const cleared = { status: 'CLEARED', provider: 'PAYSTACK', amountPesewas: 50_000n, alreadySettled: false } as const;

  it('matches the cleared provider payment of the same reference and amount', () => {
    expect(matchSettlementLine('PAYSTACK', { amountPesewas: 50_000n }, cleared)).toEqual({ status: 'MATCHED', reason: null });
  });

  it('raises a difference for the right payment at another amount, one pesewa either way', () => {
    expect(matchSettlementLine('PAYSTACK', { amountPesewas: 50_001n }, cleared)).toEqual({ status: 'AMOUNT_DIFFERS', reason: 'AMOUNT_DIFFERS' });
    expect(matchSettlementLine('PAYSTACK', { amountPesewas: 49_999n }, cleared)).toEqual({ status: 'AMOUNT_DIFFERS', reason: 'AMOUNT_DIFFERS' });
  });

  it('finds nothing for an unknown reference, another provider, a payment not cleared or one already settled', () => {
    expect(matchSettlementLine('PAYSTACK', { amountPesewas: 2_000n }, null)).toEqual({ status: 'NOT_FOUND', reason: 'NO_PAYMENT' });
    expect(matchSettlementLine('PAYSTACK', { amountPesewas: 50_000n }, { ...cleared, provider: 'HUBTEL' })).toEqual({ status: 'NOT_FOUND', reason: 'NO_PAYMENT' });
    expect(matchSettlementLine('PAYSTACK', { amountPesewas: 50_000n }, { ...cleared, status: 'PENDING' })).toEqual({ status: 'NOT_FOUND', reason: 'NOT_CLEARED' });
    expect(matchSettlementLine('PAYSTACK', { amountPesewas: 50_000n }, { ...cleared, alreadySettled: true })).toEqual({ status: 'NOT_FOUND', reason: 'ALREADY_SETTLED' });
  });

  it('posts only the matched lines: 150,000 gross, 1,500 fee, 148,500 net', () => {
    expect(
      settlementPosting([
        { status: 'MATCHED', amountPesewas: 50_000n, feePesewas: 500n },
        { status: 'MATCHED', amountPesewas: 40_000n, feePesewas: 400n },
        { status: 'MATCHED', amountPesewas: 60_000n, feePesewas: 600n },
        { status: 'NOT_FOUND', amountPesewas: 2_000n, feePesewas: 0n },
        { status: 'AMOUNT_DIFFERS', amountPesewas: 7_000n, feePesewas: 70n },
      ]),
    ).toEqual({ grossPesewas: 150_000n, feePesewas: 1_500n, netPesewas: 148_500n });
    expect(settlementPosting([{ status: 'NOT_FOUND', amountPesewas: 2_000n, feePesewas: 0n }])).toEqual({ grossPesewas: 0n, feePesewas: 0n, netPesewas: 0n });
  });
});

describe('a bank statement file (FR-PAY-016: its running balance must add up)', () => {
  const period = { start: '2026-11-01', end: '2026-11-15' };
  const rows = [
    STATEMENT_HEADER,
    ['2026-11-13', 'IN', '750.00', '10750.00', 'TRF HK-INV-0042', 'Tema Cold Store transfer'],
    ['2026-11-14', 'OUT', '250.00', '10500.00', '', 'Bank charges'],
    ['2026-11-14', 'IN', '1505.00', '12005.00', 'STL-50001', 'PAYSTACK SETTLEMENT'],
  ];

  it('reads the lines with an opening of 1,000,000 and a closing of 1,200,500', () => {
    expect(readStatementFile(rows, period, '2026-11-16')).toEqual({
      ok: true,
      value: {
        openingPesewas: 1_000_000n,
        closingPesewas: 1_200_500n,
        lines: [
          { lineNo: 1, valueDate: '2026-11-13', direction: 'IN', amountPesewas: 75_000n, balancePesewas: 1_075_000n, reference: 'TRF HK-INV-0042', narration: 'Tema Cold Store transfer' },
          { lineNo: 2, valueDate: '2026-11-14', direction: 'OUT', amountPesewas: 25_000n, balancePesewas: 1_050_000n, reference: null, narration: 'Bank charges' },
          { lineNo: 3, valueDate: '2026-11-14', direction: 'IN', amountPesewas: 150_500n, balancePesewas: 1_200_500n, reference: 'STL-50001', narration: 'PAYSTACK SETTLEMENT' },
        ],
      },
    });
  });

  it('reads the opening of a statement that starts with money going out', () => {
    const read = readStatementFile([STATEMENT_HEADER, ['2026-11-02', 'OUT', '250.00', '9750.00', '', 'Bank charges']], period, '2026-11-16');
    expect(read.ok && [read.value.openingPesewas, read.value.closingPesewas]).toEqual([1_000_000n, 975_000n]);
  });

  it('refuses a running balance broken by one pesewa, and an opening below zero', () => {
    const broken = [...rows.slice(0, 2), ['2026-11-14', 'OUT', '250.00', '10500.01', '', 'Bank charges']];
    expect(readStatementFile(broken, period, '2026-11-16')).toEqual({ ok: false, error: [{ row: 3, rule: 'BALANCE_BROKEN' }] });
    expect(readStatementFile([STATEMENT_HEADER, ['2026-11-13', 'IN', '750.00', '749.99', '', 'x']], period, '2026-11-16')).toEqual({ ok: false, error: [{ row: 2, rule: 'OPENING_NEGATIVE' }] });
  });

  it('refuses a line outside the period, a direction it does not know, and a missing column', () => {
    const read = readStatementFile(
      [STATEMENT_HEADER, ['2026-10-31', 'IN', '1.00', '1.00', '', ''], ['2026-11-02', 'CREDIT', '1.00', '2.00', '', ''], ['2026-11-02', 'IN', 'x', '3.00', '', ''], ['2026-11-02', 'IN', '1.00', 'y', '', ''], ['2026-11-02']],
      period,
      '2026-11-16',
    );
    expect(read).toEqual({
      ok: false,
      error: [
        { row: 2, rule: 'VALUE_DATE_OUT_OF_PERIOD' },
        { row: 3, rule: 'DIRECTION_INVALID' },
        { row: 4, rule: 'AMOUNT_INVALID' },
        { row: 5, rule: 'BALANCE_INVALID' },
        { row: 6, rule: 'COLUMNS_MISSING' },
      ],
    });
  });

  it('refuses a value date that is not a date, and a reference or narration longer than 200 characters', () => {
    expect(readStatementFile([STATEMENT_HEADER, ['2026-11-31', 'IN', '1.00', '1.00', '', '']], period, '2026-11-16')).toEqual({ ok: false, error: [{ row: 2, rule: 'VALUE_DATE_OUT_OF_PERIOD' }] });
    expect(readStatementFile([STATEMENT_HEADER, ['13/11/2026', 'IN', '1.00', '1.00', '', '']], period, '2026-11-16')).toEqual({ ok: false, error: [{ row: 2, rule: 'VALUE_DATE_OUT_OF_PERIOD' }] });
    expect(readStatementFile([STATEMENT_HEADER, ['2026-11-02', 'IN', '1.00', '1.00', 'x'.repeat(201), '']], period, '2026-11-16')).toEqual({ ok: false, error: [{ row: 2, rule: 'TEXT_TOO_LONG' }] });
  });

  it('refuses a zero amount, an empty file, another header, and a period that ends before it starts or after today', () => {
    expect(readStatementFile([STATEMENT_HEADER, ['2026-11-13', 'IN', '0.00', '0.00', '', '']], period, '2026-11-16')).toEqual({ ok: false, error: [{ row: 2, rule: 'AMOUNT_NOT_POSITIVE' }] });
    expect(readStatementFile([STATEMENT_HEADER], period, '2026-11-16')).toEqual({ ok: false, error: [{ row: 1, rule: 'NO_LINES' }] });
    expect(readStatementFile([['date', 'amount']], period, '2026-11-16')).toEqual({ ok: false, error: [{ row: 1, rule: 'HEADER_MISMATCH' }] });
    expect(readStatementFile(rows, { start: '2026-11-15', end: '2026-11-01' }, '2026-11-16')).toEqual({ ok: false, error: [{ row: 0, rule: 'PERIOD_INVALID' }] });
    expect(readStatementFile(rows, { start: '2026-11-01', end: '2026-11-17' }, '2026-11-16')).toEqual({ ok: false, error: [{ row: 0, rule: 'PERIOD_INVALID' }] });
  });
});

describe('choosing what a bank statement line matches (never on amount alone, and never a tie)', () => {
  const line = { direction: 'IN' as const, amountPesewas: 75_000n, reference: 'TRF HK-INV-0042', narration: 'Tema Cold Store transfer' };
  const transfer = (id: string, reference: string, amountPesewas: bigint): BankCandidate => ({ id, reference, amountPesewas });

  it('matches the one candidate whose reference the line carries, at the same amount', () => {
    expect(chooseBankCandidate(line, [transfer('p1', 'hk-inv-0042', 75_000n), transfer('p2', 'HK-INV-0043', 75_000n)])).toEqual({ kind: 'MATCH', candidateId: 'p1' });
  });

  it('finds the reference in the narration as well as the bank reference, ignoring case, spaces and punctuation', () => {
    expect(chooseBankCandidate({ ...line, reference: null, narration: 'stl 50001 paystack' }, [transfer('s1', 'STL-50001', 75_000n)])).toEqual({ kind: 'MATCH', candidateId: 's1' });
  });

  it('reads a line with only a reference and no narration', () => {
    expect(chooseBankCandidate({ ...line, narration: null }, [transfer('p1', 'HK-INV-0042', 75_000n)])).toEqual({ kind: 'MATCH', candidateId: 'p1' });
  });

  it('raises a break for a tie: two candidates with the same reference and amount', () => {
    expect(chooseBankCandidate(line, [transfer('p1', 'HK-INV-0042', 75_000n), transfer('p3', 'HK-INV-0042', 75_000n)])).toEqual({ kind: 'BREAK', reason: 'CANDIDATES_TIE' });
  });

  it('raises a break for the right reference at another amount, one pesewa off', () => {
    expect(chooseBankCandidate(line, [transfer('p1', 'HK-INV-0042', 74_999n)])).toEqual({ kind: 'BREAK', reason: 'AMOUNT_DIFFERS' });
  });

  it('never matches on amount alone: a candidate at the same amount whose reference the line lacks is not chosen', () => {
    expect(chooseBankCandidate(line, [transfer('p4', 'CHQ-118230', 75_000n)])).toEqual({ kind: 'BREAK', reason: 'NO_CANDIDATE' });
    expect(chooseBankCandidate(line, [])).toEqual({ kind: 'BREAK', reason: 'NO_CANDIDATE' });
  });

  it('ignores a candidate reference too short to identify anything', () => {
    expect(chooseBankCandidate({ ...line, narration: 'A1 transfer' }, [transfer('p5', 'A1', 75_000n)])).toEqual({ kind: 'BREAK', reason: 'NO_CANDIDATE' });
  });

  it('matches no money going out automatically: it is matched by hand', () => {
    expect(chooseBankCandidate({ ...line, direction: 'OUT' }, [transfer('p1', 'HK-INV-0042', 75_000n)])).toEqual({ kind: 'BREAK', reason: 'NO_CANDIDATE' });
  });
});

describe('matching a statement line by hand', () => {
  const line = { direction: 'IN' as const, amountPesewas: 75_000n, matched: false };
  const transfer = { kind: 'PAYMENT' as const, methodKind: 'BANK_TRANSFER', status: 'PENDING', sameBankAccount: true, amountPesewas: 75_000n, alreadyMatched: false };

  it('matches a pending bank transfer into the same account at the same amount', () => {
    expect(judgeLineMatch(line, transfer)).toEqual({ ok: true, value: undefined });
  });

  it('refuses a line already matched, another method, a transfer no longer pending, another account, another amount, or a transfer matched elsewhere', () => {
    expect(judgeLineMatch({ ...line, matched: true }, transfer)).toEqual({ ok: false, error: ['LINE_ALREADY_MATCHED'] });
    expect(judgeLineMatch(line, { ...transfer, methodKind: 'CHEQUE' })).toEqual({ ok: false, error: ['NOT_A_PENDING_TRANSFER'] });
    expect(judgeLineMatch(line, { ...transfer, status: 'CLEARED' })).toEqual({ ok: false, error: ['NOT_A_PENDING_TRANSFER'] });
    expect(judgeLineMatch(line, { ...transfer, sameBankAccount: false })).toEqual({ ok: false, error: ['OTHER_BANK_ACCOUNT'] });
    expect(judgeLineMatch(line, { ...transfer, amountPesewas: 75_001n })).toEqual({ ok: false, error: ['AMOUNT_DIFFERS'] });
    expect(judgeLineMatch(line, { ...transfer, alreadyMatched: true })).toEqual({ ok: false, error: ['TARGET_ALREADY_MATCHED'] });
    expect(judgeLineMatch({ ...line, direction: 'OUT' }, transfer)).toEqual({ ok: false, error: ['DIRECTION_DIFFERS'] });
  });

  it('matches a journal entry whose leg on this bank account is on the line\'s side for the same amount', () => {
    const entry = { kind: 'JOURNAL' as const, leg: { side: 'D' as const, amountPesewas: 75_000n }, alreadyMatched: false };
    expect(judgeLineMatch(line, entry)).toEqual({ ok: true, value: undefined });
    expect(judgeLineMatch({ ...line, direction: 'OUT' }, { ...entry, leg: { side: 'C', amountPesewas: 75_000n } })).toEqual({ ok: true, value: undefined });
    expect(judgeLineMatch(line, { ...entry, leg: null })).toEqual({ ok: false, error: ['ENTRY_HAS_NO_BANK_LEG'] });
    expect(judgeLineMatch(line, { ...entry, leg: { side: 'C', amountPesewas: 75_000n } })).toEqual({ ok: false, error: ['DIRECTION_DIFFERS'] });
    expect(judgeLineMatch(line, { ...entry, leg: { side: 'D', amountPesewas: 74_999n } })).toEqual({ ok: false, error: ['AMOUNT_DIFFERS'] });
    expect(judgeLineMatch(line, { ...entry, alreadyMatched: true })).toEqual({ ok: false, error: ['TARGET_ALREADY_MATCHED'] });
  });
});

describe('resolving a break (FR-PAY-017: through a second person, never by itself)', () => {
  const unknownSettlementLine = { status: 'OPEN' as const, kind: 'SETTLEMENT_NOT_FOUND', line: { source: 'SETTLEMENT' as const, reason: 'NO_PAYMENT', direction: 'IN' as const, matched: false } };
  const unknownBankLine = { status: 'OPEN' as const, kind: 'BANK_LINE_UNMATCHED', line: { source: 'BANK' as const, reason: 'NO_CANDIDATE', direction: 'IN' as const, matched: false } };

  it('holds a settlement line nobody paid for, or money in from an unknown payer, in suspense', () => {
    expect(judgeResolution(unknownSettlementLine, 'UNIDENTIFIED_RECEIPT', 'Payer not found in the dashboard')).toEqual({ ok: true, value: undefined });
    expect(judgeResolution(unknownBankLine, 'UNIDENTIFIED_RECEIPT', 'No customer named on the transfer')).toEqual({ ok: true, value: undefined });
  });

  it('resolves any open break with a note and no posting', () => {
    expect(judgeResolution({ status: 'OPEN', kind: 'SETTLEMENT_AMOUNT_DIFFERS', line: null }, 'NONE', 'Fee netted, agreed with Paystack in writing')).toEqual({ ok: true, value: undefined });
  });

  it('refuses a break already resolved, a blank note, and suspense for anything but an unknown payer\'s money in', () => {
    expect(judgeResolution({ ...unknownBankLine, status: 'RESOLVED' }, 'NONE', 'x')).toEqual({ ok: false, error: ['BREAK_NOT_OPEN'] });
    expect(judgeResolution(unknownBankLine, 'NONE', '   ')).toEqual({ ok: false, error: ['NOTE_REQUIRED'] });
    expect(judgeResolution({ status: 'OPEN', kind: 'SETTLEMENT_AMOUNT_DIFFERS', line: { source: 'SETTLEMENT', reason: 'AMOUNT_DIFFERS', direction: 'IN', matched: false } }, 'UNIDENTIFIED_RECEIPT', 'x')).toEqual({ ok: false, error: ['POSTING_NOT_FOR_BREAK'] });
    expect(judgeResolution({ ...unknownSettlementLine, line: { ...unknownSettlementLine.line, reason: 'NOT_CLEARED' } }, 'UNIDENTIFIED_RECEIPT', 'x')).toEqual({ ok: false, error: ['POSTING_NOT_FOR_BREAK'] });
    expect(judgeResolution({ ...unknownBankLine, line: { ...unknownBankLine.line, direction: 'OUT' } }, 'UNIDENTIFIED_RECEIPT', 'x')).toEqual({ ok: false, error: ['POSTING_NOT_FOR_BREAK'] });
    expect(judgeResolution({ status: 'OPEN', kind: 'UNMATCHED_PAYMENT', line: null }, 'UNIDENTIFIED_RECEIPT', 'x')).toEqual({ ok: false, error: ['POSTING_NOT_FOR_BREAK'] });
    expect(judgeResolution({ ...unknownBankLine, line: { ...unknownBankLine.line, matched: true } }, 'UNIDENTIFIED_RECEIPT', 'x')).toEqual({ ok: false, error: ['LINE_ALREADY_MATCHED'] });
  });
});
