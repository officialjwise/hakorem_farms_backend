import { XLSX } from '../storage/content-sniffer';
import { CsvUnreadableError, readCsv, writeCsv } from './csv';
import { readXlsx, WorkbookUnreadableError, writeXlsx } from './xlsx';

/**
 * Spreadsheets in and out (ADR-0046): the first sheet of an XLSX workbook or a CSV file as rows of text cells, and
 * rows written back as either. A platform mechanism with no business rule: which columns a sheet has and what a
 * cell must hold are the importing module's. Every CSV cell written is neutralised against formula injection
 * (OWASP CSV injection): a cell a spreadsheet program would run as a formula is written with a leading apostrophe,
 * and reading a CSV takes that apostrophe off again, so an export imports back unchanged. An XLSX cell is written as
 * a string, which no program evaluates, so it is written as it is.
 */
export type SheetFormat = 'XLSX' | 'CSV';

export class SheetUnreadableError extends Error {}

export const FORMAT_CONTENT_TYPE: Readonly<Record<SheetFormat, string>> = { XLSX, CSV: 'text/csv' };
export const FORMAT_EXTENSION: Readonly<Record<SheetFormat, string>> = { XLSX: 'xlsx', CSV: 'csv' };

/** The first characters that make a spreadsheet program read a cell as a formula or a command. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** A cell made safe to open: one that would start a formula gets a leading apostrophe, which programs show as text. */
export function neutraliseFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** A CSV cell an export neutralised, as it was. */
function restoreNeutralised(value: string): string {
  return value.startsWith("'") && FORMULA_START.test(value.slice(1)) ? value.slice(1) : value;
}

/** The rows of a file of the given sniffed content type, at most `maxRows` of them. */
export function readSheet(bytes: Buffer, contentType: string, maxRows: number): string[][] {
  try {
    if (contentType === XLSX) return readXlsx(bytes, maxRows);
    if (contentType === 'text/csv') return readCsv(bytes.toString('utf8'), maxRows).map((row) => row.map(restoreNeutralised));
  } catch (error) {
    if (error instanceof WorkbookUnreadableError || error instanceof CsvUnreadableError) throw new SheetUnreadableError(error.message);
    throw error;
  }
  throw new SheetUnreadableError(`${contentType} is not a spreadsheet`);
}

export function writeSheet(format: SheetFormat, sheetName: string, rows: ReadonlyArray<readonly string[]>): Buffer {
  return format === 'XLSX' ? writeXlsx(sheetName, rows) : writeCsv(rows.map((row) => row.map(neutraliseFormula)));
}
