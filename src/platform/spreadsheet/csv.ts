/**
 * Comma-separated values as RFC 4180 writes them (ADR-0046): fields separated by commas, a field with a comma,
 * a quote or a line break quoted, a quote inside doubled. Read with or without the UTF-8 byte order mark, with
 * CRLF or LF line ends; written with the mark and CRLF, which spreadsheet programs on Windows expect.
 */
export class CsvUnreadableError extends Error {}

const BYTE_ORDER_MARK = '﻿';

/** The rows of a CSV text. A trailing line end does not add a row; an empty line is an empty row. */
export function readCsv(text: string, maxRows: number): string[][] {
  const source = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  const endRow = () => {
    row.push(field);
    rows.push(row.length === 1 && row[0] === '' && !fieldStarted ? [] : row);
    if (rows.length > maxRows) throw new CsvUnreadableError(`more than ${maxRows} rows`);
    row = [];
    field = '';
    fieldStarted = false;
  };
  for (let at = 0; at < source.length; at += 1) {
    const char = source[at]!;
    if (quoted) {
      if (char === '"') {
        if (source[at + 1] === '"') {
          field += '"';
          at += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') {
      if (field.length > 0) throw new CsvUnreadableError(`row ${rows.length + 1}: a quote inside an unquoted field`);
      quoted = true;
      fieldStarted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
      fieldStarted = true;
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && source[at + 1] === '\n') at += 1;
      endRow();
    } else field += char;
  }
  if (quoted) throw new CsvUnreadableError(`row ${rows.length + 1}: a quoted field is not closed`);
  if (field.length > 0 || row.length > 0 || fieldStarted) endRow();
  return rows;
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function writeCsv(rows: ReadonlyArray<readonly string[]>): Buffer {
  return Buffer.from(`${BYTE_ORDER_MARK}${rows.map((row) => row.map(quote).join(',')).join('\r\n')}\r\n`, 'utf8');
}
