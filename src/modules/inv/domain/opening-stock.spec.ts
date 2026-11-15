import { describe, expect, it } from 'vitest';
import { OPENING_STOCK_COLUMNS, readOpeningRow } from './opening-stock';

const cells = (entries: Record<string, string>) => new Map(Object.entries(entries));
const base = { branch: 'DDW', location: 'COLD', sku: 'MEAT-PORK-15KG', qty: '30.5', valuePesewas: '340000' };

describe('an OPENING_STOCK row (A-128, A-147)', () => {
  it('names its columns, five of them required', () => {
    expect(OPENING_STOCK_COLUMNS.required).toEqual(['branch', 'location', 'sku', 'qty', 'valuePesewas']);
    expect(OPENING_STOCK_COLUMNS.all).toHaveLength(10);
  });

  it('reads a dated lot with its weight, exactly, and leaves blank cells null', () => {
    const { row, errors } = readOpeningRow(2, cells({ ...base, batch: 'PORK-2026-1101', expiresOn: '2027-01-30', weightKg: '30.500', tag: '', sex: ' ' }));
    expect(errors).toEqual([]);
    expect(row.qty?.toDecimalString()).toBe('30.500');
    expect(row.valuePesewas).toBe(340_000n);
    expect(row).toMatchObject({ rowNo: 2, branch: 'DDW', location: 'COLD', sku: 'MEAT-PORK-15KG', batch: 'PORK-2026-1101', expiresOn: '2027-01-30', weightKg: '30.500', tag: null, sex: null });
  });

  it('reads an animal with its tag and its sex in any case', () => {
    const { row, errors } = readOpeningRow(3, cells({ ...base, sku: 'LIV-PIG', qty: '1', tag: 'P-0001', sex: 'female' }));
    expect(errors).toEqual([]);
    expect(row).toMatchObject({ tag: 'P-0001', sex: 'FEMALE' });
  });

  it('names every missing required cell', () => {
    const { row, errors } = readOpeningRow(4, cells({}));
    expect(errors.map((e) => e.column)).toEqual(['branch', 'location', 'sku', 'qty', 'valuePesewas']);
    expect(row).toMatchObject({ branch: '', location: '', sku: '', qty: null, valuePesewas: null });
  });

  it('refuses a malformed or zero quantity and value, a value past the safe range, and bad dates, sexes, weights and codes', () => {
    const bad = readOpeningRow(5, cells({ ...base, qty: '1.2345', valuePesewas: '12.50', expiresOn: '2027-02-30', sex: 'M', weightKg: '1,5', batch: '-x', tag: 'a b' }));
    expect(bad.errors.map((e) => e.column)).toEqual(['qty', 'valuePesewas', 'expiresOn', 'sex', 'weightKg', 'batch', 'tag']);
    expect(bad.row).toMatchObject({ qty: null, valuePesewas: null });
    const zero = readOpeningRow(6, cells({ ...base, qty: '0.000', valuePesewas: '0' }));
    expect(zero.errors.map((e) => e.message)).toEqual(['qty must be above zero', 'Opening stock is carried at its cost: valuePesewas must be above zero']);
    expect(readOpeningRow(7, cells({ ...base, valuePesewas: '9007199254740992' })).errors.map((e) => e.column)).toEqual(['valuePesewas']);
    expect(readOpeningRow(8, cells({ ...base, valuePesewas: '9007199254740991' })).errors).toEqual([]);
    expect(readOpeningRow(9, cells({ ...base, expiresOn: '27-01-30' })).errors.map((e) => e.column)).toEqual(['expiresOn']);
  });
});
