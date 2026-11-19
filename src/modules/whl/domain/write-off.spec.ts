import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { judgeWriteOff } from './write-off';

const open = { kind: 'INVOICE', status: 'ISSUED', customerId: 'c', outstanding: Money.ofPesewas(50_000n) };
const rules = (f: Partial<Parameters<typeof judgeWriteOff>[0]>, amount: bigint) => judgeWriteOff({ ...open, ...f }, Money.ofPesewas(amount)).map((r) => `${r.field}:${r.rule}`);

describe('a bad-debt write-off asked for (FR-WHL-012)', () => {
  it('takes all of an open item, or part of it, to the pesewa', () => {
    expect(rules({}, 50_000n)).toEqual([]);
    expect(rules({}, 1n)).toEqual([]);
    expect(rules({ kind: 'DEBIT_NOTE' }, 49_999n)).toEqual([]);
    expect(rules({ kind: 'RECEIPT' }, 50_000n)).toEqual([]);
  });

  it('never more than is outstanding, and never nothing', () => {
    expect(rules({}, 50_001n)).toEqual(['/amountPesewas:MORE_THAN_OUTSTANDING']);
    expect(rules({}, 0n)).toEqual(['/amountPesewas:NOT_POSITIVE']);
    expect(rules({ outstanding: Money.zero() }, 1n)).toEqual(['/billingDocumentId:NOTHING_OUTSTANDING']);
  });

  it('only an issued invoice, receipt or debit note of a named customer', () => {
    expect(rules({ kind: 'CREDIT_NOTE' }, 1n)).toEqual(['/billingDocumentId:NOT_AN_OPEN_ITEM']);
    expect(rules({ kind: 'PROFORMA' }, 1n)).toEqual(['/billingDocumentId:NOT_AN_OPEN_ITEM']);
    expect(rules({ status: 'DRAFT' }, 1n)).toEqual(['/billingDocumentId:NOT_AN_OPEN_ITEM']);
    expect(rules({ customerId: null }, 1n)).toEqual(['/billingDocumentId:NO_CUSTOMER']);
  });
});
