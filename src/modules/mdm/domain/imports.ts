import { normaliseGhanaPhone } from './parties';

/**
 * Master data imports and exports as rules (FR-MDM-019, FR-MDM-020, SEC-009, A-128). Pure: no I/O, no framework.
 * A sheet's first row names its columns; each further row is one record, numbered as the spreadsheet numbers it
 * (the header is row 1). A row error names its row, its column and the rule, never a personal value from the cell.
 */
export const IMPORT_ENTITIES = ['PRODUCT', 'CUSTOMER', 'SUPPLIER', 'PRICE_LIST_ENTRY', 'LOCATION', 'OPENING_STOCK'] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];
export type ImportDirection = 'IMPORT' | 'EXPORT';
export type ImportStatus = 'UPLOADED' | 'VALIDATED' | 'APPLIED' | 'FAILED' | 'CANCELLED';

/**
 * The entities whose sheets are built (A-128, A-130): customers in B04e continued 4; products, suppliers, locations
 * and price list entries in B04e continued 5. Opening stock writes stock, which INV owns, and waits for B5.
 */
export const AVAILABLE_ENTITIES: readonly ImportEntity[] = ['PRODUCT', 'CUSTOMER', 'SUPPLIER', 'PRICE_LIST_ENTRY', 'LOCATION', 'OPENING_STOCK'];

/** The most records one import holds (A-128): a large first load, small enough to validate inside one request. */
export const MAX_IMPORT_ROWS = 5_000;
/** SEC-009 and FR-MDM-020: an export of more rows than this is a bulk export, for the daily exception report. */
export const BULK_EXPORT_ROWS = 100;
/** The spreadsheet row of the first record: row 1 is the header. */
export const FIRST_RECORD_ROW = 2;

export interface RowError {
  readonly rowNo: number;
  readonly column: string | null;
  readonly message: string;
}

export function isAvailable(entity: ImportEntity): boolean {
  return AVAILABLE_ENTITIES.includes(entity);
}

/** An export of more than BULK_EXPORT_ROWS rows is bulk (SEC-009). */
export function isBulkExport(rowCount: number): boolean {
  return rowCount > BULK_EXPORT_ROWS;
}

export interface SheetColumns {
  readonly all: readonly string[];
  readonly required: readonly string[];
}

export type HeaderReading = { readonly ok: true; readonly index: ReadonlyMap<string, number> } | { readonly ok: false; readonly errors: readonly RowError[] };

/** The position of each known column in the header row, matched without regard to case or surrounding spaces. */
export function readHeader(header: readonly string[] | undefined, columns: SheetColumns): HeaderReading {
  if (header === undefined || header.every((cell) => cell.trim() === '')) {
    return { ok: false, errors: [{ rowNo: 1, column: null, message: `The first row must name the columns: ${columns.all.join(', ')}` }] };
  }
  const errors: RowError[] = [];
  const index = new Map<string, number>();
  header.forEach((cell, position) => {
    const name = cell.trim();
    if (name === '') return;
    const known = columns.all.find((column) => column.toLowerCase() === name.toLowerCase());
    if (known === undefined) errors.push({ rowNo: 1, column: name.slice(0, 60), message: `Unknown column "${name.slice(0, 60)}"` });
    else if (index.has(known)) errors.push({ rowNo: 1, column: known, message: `Column ${known} appears twice` });
    else index.set(known, position);
  });
  for (const column of columns.required) if (!index.has(column)) errors.push({ rowNo: 1, column, message: `Column ${column} is missing` });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, index };
}

/** The records below the header, each with its spreadsheet row number and its cells by column; blank rows are left out. */
export function records(rows: readonly (readonly string[])[], index: ReadonlyMap<string, number>): { readonly rowNo: number; readonly cells: ReadonlyMap<string, string> }[] {
  const found: { rowNo: number; cells: Map<string, string> }[] = [];
  rows.slice(1).forEach((row, offset) => {
    if (row.every((cell) => cell.trim() === '')) return;
    const cells = new Map<string, string>();
    for (const [column, position] of index) cells.set(column, (row[position] ?? '').trim());
    found.push({ rowNo: offset + FIRST_RECORD_ROW, cells });
  });
  return found;
}

export type ApplyRefusal = 'NOT_AN_IMPORT' | 'NOT_VALIDATED' | 'HAS_ERRORS' | null;

/** Apply is allowed only on an import whose dry run is VALIDATED with every row valid and no error (FR-MDM-019). */
export function judgeApply(job: { readonly direction: ImportDirection; readonly status: ImportStatus; readonly rowsTotal: number | null; readonly rowsValid: number | null }, errorCount: number): ApplyRefusal {
  if (job.direction !== 'IMPORT') return 'NOT_AN_IMPORT';
  if (job.status !== 'VALIDATED') return 'NOT_VALIDATED';
  if (errorCount > 0 || job.rowsTotal === null || job.rowsValid !== job.rowsTotal) return 'HAS_ERRORS';
  return null;
}

/** Only an import not yet applied, failed or cancelled can be cancelled. */
export function canCancel(job: { readonly direction: ImportDirection; readonly status: ImportStatus }): boolean {
  return job.direction === 'IMPORT' && (job.status === 'UPLOADED' || job.status === 'VALIDATED');
}

// Customers (FR-MDM-008 rules, applied to a sheet).

export const CUSTOMER_COLUMNS: SheetColumns = { all: ['customerNo', 'kind', 'name', 'phone', 'email', 'tier'], required: ['name'] };

const CUSTOMER_NO = /^C-[0-9]{5,}$/;
const KINDS = ['INDIVIDUAL', 'BUSINESS'] as const;
const MAX_NAME = 160;
const MAX_EMAIL = 254;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIER_CODE = /^[A-Z][A-Z_]{1,39}$/;

/** A customer row as the sheet states it, every value checked for form; `customerNo` names the customer to change. */
export interface CustomerRow {
  readonly rowNo: number;
  readonly customerNo: string | null;
  readonly kind: (typeof KINDS)[number] | null;
  readonly name: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly tierCode: string | null;
}

const blank = (value: string | undefined): string | null => (value === undefined || value === '' ? null : value);

/** Reads one customer record: a row with no customer number creates a customer, one with a number changes it. */
export function readCustomerRow(rowNo: number, cells: ReadonlyMap<string, string>): { readonly row: CustomerRow; readonly errors: readonly RowError[] } {
  const errors: RowError[] = [];
  const fail = (column: string, message: string) => errors.push({ rowNo, column, message });
  const customerNo = blank(cells.get('customerNo'))?.toUpperCase() ?? null;
  if (customerNo !== null && !CUSTOMER_NO.test(customerNo)) fail('customerNo', 'Customer number must look like C-00118');
  const kindText = blank(cells.get('kind'))?.toUpperCase() ?? null;
  const kind = KINDS.find((candidate) => candidate === kindText) ?? null;
  if (kindText !== null && kind === null) fail('kind', 'Kind must be INDIVIDUAL or BUSINESS');
  else if (kind === null && customerNo === null) fail('kind', 'Kind is empty');
  const name = blank(cells.get('name'));
  if (name === null && customerNo === null) fail('name', 'Name is empty');
  else if (name !== null && name.length > MAX_NAME) fail('name', `Name is longer than ${MAX_NAME} characters`);
  let phone: string | null = null;
  const phoneText = blank(cells.get('phone'));
  if (phoneText !== null) {
    const normalised = normaliseGhanaPhone(phoneText);
    if (normalised.ok) phone = normalised.value;
    else fail('phone', 'Phone number must be a Ghanaian number such as 024 412 3456, or start with + and the country code');
  }
  const email = blank(cells.get('email'))?.toLowerCase() ?? null;
  if (email !== null && (email.length > MAX_EMAIL || !EMAIL.test(email))) fail('email', 'Email address is not valid');
  const tierCode = blank(cells.get('tier'))?.toUpperCase() ?? null;
  if (tierCode !== null && !TIER_CODE.test(tierCode)) fail('tier', 'Tier must be a tier code such as RETAIL');
  return { row: { rowNo, customerNo, kind, name, phone, email, tierCode }, errors };
}

/** Rows repeating a key an earlier row has: "Duplicate of row N", against the first row that used it. */
export function duplicateErrors<T extends { readonly rowNo: number }>(rows: readonly T[], column: string, key: (row: T) => string | null): RowError[] {
  const first = new Map<string, number>();
  const errors: RowError[] = [];
  for (const row of rows) {
    const value = key(row);
    if (value === null) continue;
    const earlier = first.get(value);
    if (earlier === undefined) first.set(value, row.rowNo);
    else errors.push({ rowNo: row.rowNo, column, message: `Duplicate of row ${earlier}` });
  }
  return errors;
}

/** Errors in spreadsheet order: by row, then column, header errors first. */
export function sortErrors(errors: readonly RowError[]): RowError[] {
  return [...errors].sort((a, b) => a.rowNo - b.rowNo || (a.column ?? '').localeCompare(b.column ?? ''));
}
