import { describe, expect, it } from 'vitest';
import { canCancel, CUSTOMER_COLUMNS, duplicateErrors, isAvailable, isBulkExport, judgeApply, readCustomerRow, readHeader, records, sortErrors } from './imports';

const cells = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe('which entities have sheets (A-128, A-130)', () => {
  it('offers every entity, opening stock through the sheet INV registers (ADR-0050)', () => {
    for (const entity of ['PRODUCT', 'CUSTOMER', 'SUPPLIER', 'PRICE_LIST_ENTRY', 'LOCATION', 'OPENING_STOCK'] as const) expect(isAvailable(entity)).toBe(true);
  });
});

describe('a bulk export (SEC-009)', () => {
  it('is more than 100 rows: 100 is not bulk, 101 is', () => {
    expect(isBulkExport(100)).toBe(false);
    expect(isBulkExport(101)).toBe(true);
    expect(isBulkExport(150)).toBe(true);
  });
});

describe('the header row', () => {
  it('matches columns without regard to case or spaces, in any order, ignoring blank header cells', () => {
    const reading = readHeader([' NAME ', '', 'Phone', 'customerno'], CUSTOMER_COLUMNS);
    expect(reading.ok && [...reading.index]).toEqual([['name', 0], ['phone', 2], ['customerNo', 3]]);
  });

  it('refuses an empty header, an unknown column, a column twice and a missing required column, all on row 1', () => {
    expect(readHeader(undefined, CUSTOMER_COLUMNS)).toEqual({ ok: false, errors: [{ rowNo: 1, column: null, message: 'The first row must name the columns: customerNo, kind, name, phone, email, tier' }] });
    expect(readHeader(['', ' '], CUSTOMER_COLUMNS).ok).toBe(false);
    expect(readHeader(['name', 'Name', 'age'], CUSTOMER_COLUMNS)).toEqual({
      ok: false,
      errors: [
        { rowNo: 1, column: 'name', message: 'Column name appears twice' },
        { rowNo: 1, column: 'age', message: 'Unknown column "age"' },
      ],
    });
    expect(readHeader(['phone'], CUSTOMER_COLUMNS)).toEqual({ ok: false, errors: [{ rowNo: 1, column: 'name', message: 'Column name is missing' }] });
  });
});

describe('records below the header', () => {
  it('numbers each row as the spreadsheet does, trims cells, fills short rows and leaves blank rows out', () => {
    const index = new Map([['name', 0], ['phone', 1]]);
    expect(records([['name', 'phone'], [' Ama ', '024'], [], ['  ', ''], ['Kofi']], index)).toEqual([
      { rowNo: 2, cells: new Map([['name', 'Ama'], ['phone', '024']]) },
      { rowNo: 5, cells: new Map([['name', 'Kofi'], ['phone', '']]) },
    ]);
  });
});

describe('applying and cancelling (FR-MDM-019)', () => {
  const job = { direction: 'IMPORT' as const, status: 'VALIDATED' as const, rowsTotal: 200, rowsValid: 200 };
  it('applies only a validated import with every row valid and no error', () => {
    expect(judgeApply(job, 0)).toBeNull();
    expect(judgeApply(job, 3)).toBe('HAS_ERRORS');
    expect(judgeApply({ ...job, rowsValid: 197 }, 0)).toBe('HAS_ERRORS');
    expect(judgeApply({ ...job, rowsTotal: null }, 0)).toBe('HAS_ERRORS');
    for (const status of ['UPLOADED', 'APPLIED', 'FAILED', 'CANCELLED'] as const) expect(judgeApply({ ...job, status }, 0)).toBe('NOT_VALIDATED');
    expect(judgeApply({ ...job, direction: 'EXPORT', status: 'APPLIED' }, 0)).toBe('NOT_AN_IMPORT');
  });

  it('cancels only an import that is uploaded or validated', () => {
    expect(canCancel({ direction: 'IMPORT', status: 'UPLOADED' })).toBe(true);
    expect(canCancel({ direction: 'IMPORT', status: 'VALIDATED' })).toBe(true);
    for (const status of ['APPLIED', 'FAILED', 'CANCELLED'] as const) expect(canCancel({ direction: 'IMPORT', status })).toBe(false);
    expect(canCancel({ direction: 'EXPORT', status: 'APPLIED' })).toBe(false);
  });
});

describe('a customer row (FR-MDM-008 through a sheet)', () => {
  it('reads a new customer, normalising the phone, the email, the kind and the tier', () => {
    expect(readCustomerRow(2, cells({ kind: 'individual', name: 'Akosua Mensah', phone: '024 412 3456', email: 'Akosua@Example.com', tier: 'retail', customerNo: '' }))).toEqual({
      row: { rowNo: 2, customerNo: null, kind: 'INDIVIDUAL', name: 'Akosua Mensah', phone: '+233244123456', email: 'akosua@example.com', tierCode: 'RETAIL' },
      errors: [],
    });
  });

  it('reads a change to an existing customer, where every other cell may be blank', () => {
    expect(readCustomerRow(3, cells({ customerNo: 'c-00118', name: '' }))).toEqual({
      row: { rowNo: 3, customerNo: 'C-00118', kind: null, name: null, phone: null, email: null, tierCode: null },
      errors: [],
    });
  });

  it('names the column and the rule of every bad cell, never its personal value', () => {
    const { errors } = readCustomerRow(14, cells({ customerNo: '118', kind: 'VIP', name: 'x'.repeat(161), phone: '12345', email: 'kofi@', tier: 'gold-1' }));
    expect(errors).toEqual([
      { rowNo: 14, column: 'customerNo', message: 'Customer number must look like C-00118' },
      { rowNo: 14, column: 'kind', message: 'Kind must be INDIVIDUAL or BUSINESS' },
      { rowNo: 14, column: 'name', message: 'Name is longer than 160 characters' },
      { rowNo: 14, column: 'phone', message: 'Phone number must be a Ghanaian number such as 024 412 3456, or start with + and the country code' },
      { rowNo: 14, column: 'email', message: 'Email address is not valid' },
      { rowNo: 14, column: 'tier', message: 'Tier must be a tier code such as RETAIL' },
    ]);
    expect(JSON.stringify(errors)).not.toContain('kofi@');
  });

  it('requires a kind and a name to create a customer', () => {
    expect(readCustomerRow(88, cells({})).errors).toEqual([
      { rowNo: 88, column: 'kind', message: 'Kind is empty' },
      { rowNo: 88, column: 'name', message: 'Name is empty' },
    ]);
    expect(readCustomerRow(88, cells({ email: `${'a'.repeat(250)}@b.co` })).errors.map((e) => e.column)).toEqual(['kind', 'name', 'email']);
  });
});

describe('duplicates within a file and the order of errors', () => {
  it('points each repeat at the first row that used the value, ignoring blanks', () => {
    const rows = [{ rowNo: 2, phone: '+233244123456' }, { rowNo: 3, phone: null }, { rowNo: 4, phone: '+233244123456' }, { rowNo: 9, phone: '+233244123456' }];
    expect(duplicateErrors(rows, 'phone', (row) => row.phone)).toEqual([
      { rowNo: 4, column: 'phone', message: 'Duplicate of row 2' },
      { rowNo: 9, column: 'phone', message: 'Duplicate of row 2' },
    ]);
  });

  it('sorts by row, then column, a row-wide error first', () => {
    expect(sortErrors([{ rowNo: 5, column: 'phone', message: 'a' }, { rowNo: 2, column: 'tier', message: 'b' }, { rowNo: 5, column: null, message: 'c' }, { rowNo: 2, column: 'email', message: 'd' }]).map((e) => e.message)).toEqual(['d', 'b', 'c', 'a']);
  });
});
