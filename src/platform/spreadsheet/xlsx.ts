import { readZip, writeZip, ZipUnreadableError, type ZipLimits } from './zip';

/**
 * The first worksheet of an Office Open XML workbook as rows of text cells, and a workbook written from rows
 * (ADR-0046). A mechanism with no business rule. Only the parts a worksheet's values need are read: the workbook,
 * its relationships, the shared strings and the sheet. The XML is read as the fixed vocabulary those parts use:
 * no document type definition, no external entity and no entity but the five XML predefines and character
 * references is ever expanded, so there is nothing to inject. A number, a date or a formula's cached result is
 * read as the text the file stores; the reader never evaluates a formula.
 */
export class WorkbookUnreadableError extends Error {}

export const XLSX_LIMITS: ZipLimits = { maxEntries: 200, maxEntryBytes: 50 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024 };

const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const MAX_CODE_POINT = 0x10ffff;
const LETTERS_IN_ALPHABET = 26;
const CHAR_CODE_BEFORE_A = 64;

/** Text content as XML escapes it, and the `_xHHHH_` escapes Office adds for control characters. */
export function decodeXmlText(text: string): string {
  return text
    .replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, name: string) => {
      if (name.startsWith('#')) {
        const code = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
        return code > MAX_CODE_POINT ? whole : String.fromCodePoint(code);
      }
      return ENTITIES[name] ?? whole;
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function encodeXmlText(text: string): string {
  // Control characters XML 1.0 cannot carry are dropped; the rest are escaped.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match === null ? null : decodeXmlText(match[1] ?? match[2] ?? '');
}

/** Every `<t>` run of an element, joined, leaving out phonetic runs. */
function runText(xml: string): string {
  const withoutPhonetic = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
  let text = '';
  for (const match of withoutPhonetic.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) text += decodeXmlText(match[1]!);
  return text;
}

function sharedStrings(xml: string | undefined): string[] {
  if (xml === undefined) return [];
  return [...xml.matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)].map((match) => runText(match[1] ?? ''));
}

/** The zero-based column of a cell reference such as `B7`. */
export function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/.exec(reference.toUpperCase())?.[0] ?? '';
  let index = 0;
  for (const letter of letters) index = index * LETTERS_IN_ALPHABET + (letter.charCodeAt(0) - CHAR_CODE_BEFORE_A);
  return index - 1;
}

function columnName(index: number): string {
  let name = '';
  let rest = index + 1;
  while (rest > 0) {
    const remainder = (rest - 1) % LETTERS_IN_ALPHABET;
    name = String.fromCharCode(CHAR_CODE_BEFORE_A + 1 + remainder) + name;
    rest = Math.floor((rest - 1) / LETTERS_IN_ALPHABET);
  }
  return name;
}

function resolveTarget(target: string): string {
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/** The path of the workbook's first sheet, in the workbook's order. */
function firstSheetPath(parts: Map<string, Buffer>): string {
  const workbook = parts.get('xl/workbook.xml')?.toString('utf8');
  if (workbook === undefined) throw new WorkbookUnreadableError('no workbook part');
  const sheet = /<(?:\w+:)?sheet\b([^>]*)\/?>/.exec(workbook);
  if (sheet === null) throw new WorkbookUnreadableError('the workbook has no sheet');
  const relationId = /(?:^|\s)r:id\s*=\s*"([^"]*)"/.exec(sheet[1]!)?.[1] ?? null;
  const relations = parts.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  for (const match of relations.matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)) {
    if (relationId !== null && attribute(match[1]!, 'Id') === relationId) {
      const target = attribute(match[1]!, 'Target');
      if (target !== null) return resolveTarget(target);
    }
  }
  throw new WorkbookUnreadableError('the first sheet has no part');
}

function cellValue(attributes: string, body: string, strings: readonly string[]): string {
  const type = attribute(attributes, 't') ?? 'n';
  if (type === 'inlineStr') return runText(/<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/.exec(body)?.[1] ?? '');
  const value = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body);
  const raw = value === null ? '' : decodeXmlText(value[1]!);
  if (type === 's') {
    const index = Number.parseInt(raw, 10);
    if (!Number.isInteger(index) || strings[index] === undefined) throw new WorkbookUnreadableError(`shared string ${raw} does not exist`);
    return strings[index];
  }
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  return raw;
}

/**
 * The rows of the first worksheet, each a list of cell texts with empty cells as empty strings, trailing empty
 * cells left off, and an empty row kept as an empty list so row numbers stay true. At most `maxRows` rows are
 * read; one more is an error.
 */
export function readXlsx(bytes: Buffer, maxRows: number): string[][] {
  let parts: Map<string, Buffer>;
  try {
    parts = readZip(bytes, XLSX_LIMITS);
  } catch (error) {
    if (error instanceof ZipUnreadableError) throw new WorkbookUnreadableError(error.message);
    throw error;
  }
  const strings = sharedStrings(parts.get('xl/sharedStrings.xml')?.toString('utf8'));
  const path = firstSheetPath(parts);
  const sheet = parts.get(path)?.toString('utf8');
  if (sheet === undefined) throw new WorkbookUnreadableError(`no sheet part ${path}`);
  const rows: string[][] = [];
  for (const row of sheet.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const declared = attribute(row[1]!, 'r');
    const rowIndex = declared === null ? rows.length : Number.parseInt(declared, 10) - 1;
    if (!Number.isInteger(rowIndex) || rowIndex < rows.length) throw new WorkbookUnreadableError(`row ${declared} is out of order`);
    if (rowIndex >= maxRows) throw new WorkbookUnreadableError(`more than ${maxRows} rows`);
    while (rows.length < rowIndex) rows.push([]);
    const cells: string[] = [];
    for (const cell of (row[2] ?? '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const reference = attribute(cell[1]!, 'r');
      const column = reference === null ? cells.length : columnIndex(reference);
      if (column < cells.length) throw new WorkbookUnreadableError(`cell ${reference} is out of order`);
      while (cells.length < column) cells.push('');
      cells.push(cellValue(cell[1]!, cell[2] ?? '', strings));
    }
    while (cells.length > 0 && cells.at(-1) === '') cells.pop();
    rows.push(cells);
  }
  return rows;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
const ROOT_RELATIONS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
const WORKBOOK_RELATIONS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;
/** Style 1 is bold, for the header row; style 2 is the Text number format, so a re-saved phone keeps its leading 0. */
const HEADER_STYLE = 1;
const TEXT_STYLE = 2;

/** A workbook of one sheet named `sheetName`: the first row bold, every cell an inline string in the Text format. */
export function writeXlsx(sheetName: string, rows: ReadonlyArray<readonly string[]>): Buffer {
  const body = rows
    .map((row, rowIndex) => {
      const style = rowIndex === 0 ? HEADER_STYLE : TEXT_STYLE;
      const cells = row.map((value, column) => `<c r="${columnName(column)}${rowIndex + 1}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${encodeXmlText(value)}</t></is></c>`).join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${encodeXmlText(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  return writeZip([
    ['[Content_Types].xml', Buffer.from(CONTENT_TYPES)],
    ['_rels/.rels', Buffer.from(ROOT_RELATIONS)],
    ['xl/workbook.xml', Buffer.from(workbook)],
    ['xl/_rels/workbook.xml.rels', Buffer.from(WORKBOOK_RELATIONS)],
    ['xl/styles.xml', Buffer.from(STYLES)],
    ['xl/worksheets/sheet1.xml', Buffer.from(sheet)],
  ]);
}
