import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { XLSX } from '../storage/content-sniffer';
import { readCsv, writeCsv } from './csv';
import { neutraliseFormula, readSheet, SheetUnreadableError, writeSheet } from './spreadsheet';
import { columnIndex, decodeXmlText, readXlsx, writeXlsx } from './xlsx';
import { readZip, writeZip, ZipUnreadableError } from './zip';

const FIXTURES = resolve(__dirname, '../../../test/fixtures/spreadsheets');
const LIMITS = { maxEntries: 10, maxEntryBytes: 1_000, maxTotalBytes: 1_500 };

/** A workbook from hand-written parts, as another program might write it. */
function workbook(sheet: string, extra: ReadonlyArray<readonly [string, string]> = []): Buffer {
  return writeZip([
    ['xl/workbook.xml', Buffer.from('<x:workbook xmlns:x="m" xmlns:r="r"><x:sheets><x:sheet name="S" sheetId="1" r:id="rId7"/></x:sheets></x:workbook>')],
    ['xl/_rels/workbook.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1" Target="other.xml"/><Relationship Id="rId7" Target="/xl/worksheets/./../worksheets/s.xml"/></Relationships>')],
    ['xl/worksheets/s.xml', Buffer.from(sheet)],
    ...extra.map(([name, text]) => [name, Buffer.from(text)] as const),
  ]);
}

describe('the ZIP container (ADR-0046)', () => {
  it('writes an archive that reads back part by part, deterministically', () => {
    const parts = [['a.xml', Buffer.from('alpha')], ['dir/b.xml', Buffer.from('b'.repeat(500))]] as const;
    const bytes = writeZip(parts);
    expect(writeZip(parts).equals(bytes)).toBe(true);
    const read = readZip(bytes, LIMITS);
    expect([...read.keys()]).toEqual(['a.xml', 'dir/b.xml']);
    expect(read.get('dir/b.xml')!.toString()).toBe('b'.repeat(500));
  });

  it('reads a stored part and skips a folder entry', () => {
    const bytes = writeZip([['folder/', Buffer.alloc(0)], ['s.txt', Buffer.from('stored')]]);
    // Rewrite s.txt as stored (method 0): its data becomes the raw bytes.
    const stored = Buffer.from(bytes);
    const local = stored.indexOf(Buffer.from('s.txt')) - 30;
    const compressedSize = stored.readUInt32LE(local + 18);
    const raw = Buffer.from('stored');
    const rebuilt = Buffer.concat([stored.subarray(0, local + 30 + 5), raw, stored.subarray(local + 30 + 5 + compressedSize)]);
    const delta = raw.length - compressedSize;
    rebuilt.writeUInt16LE(0, local + 8);
    rebuilt.writeUInt32LE(raw.length, local + 18);
    const end = rebuilt.length - 22;
    const directory = rebuilt.readUInt32LE(end + 16) + delta;
    rebuilt.writeUInt32LE(directory, end + 16);
    const second = rebuilt.indexOf(Buffer.from('s.txt'), directory) - 46;
    rebuilt.writeUInt16LE(0, second + 10);
    rebuilt.writeUInt32LE(raw.length, second + 20);
    const read = readZip(rebuilt, LIMITS);
    expect([...read.keys()]).toEqual(['s.txt']);
    expect(read.get('s.txt')!.toString()).toBe('stored');
  });

  it('refuses what is not an archive, or is cut short', () => {
    expect(() => readZip(Buffer.from('short'), LIMITS)).toThrow(ZipUnreadableError);
    expect(() => readZip(Buffer.alloc(100, 1), LIMITS)).toThrow('no end of central directory');
    const bytes = writeZip([['a', Buffer.from('x'.repeat(50))]]);
    expect(() => readZip(Buffer.concat([bytes.subarray(0, 10), bytes.subarray(bytes.length - 22)]), LIMITS)).toThrow(ZipUnreadableError);
  });

  it('refuses too many parts, a part over its limit and an archive over its total (a decompression bomb)', () => {
    const many = writeZip(Array.from({ length: 11 }, (_, i) => [`p${i}`, Buffer.from('x')] as const));
    expect(() => readZip(many, LIMITS)).toThrow('more than 10 parts');
    expect(() => readZip(writeZip([['big', Buffer.alloc(1_001)]]), LIMITS)).toThrow('larger than 1000 bytes');
    expect(() => readZip(writeZip([['a', Buffer.alloc(800)], ['b', Buffer.alloc(800)]]), LIMITS)).toThrow('more than 1500 bytes');
  });

  it('does not trust a declared size: a part that inflates past its limit is refused', () => {
    const bytes = writeZip([['bomb', Buffer.alloc(5_000)]]);
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(10, central + 24); // claims ten bytes
    expect(() => readZip(bytes, LIMITS)).toThrow('does not inflate within 1000 bytes');
  });

  it('refuses encrypted, ZIP64, multi-disk and unknown-method archives', () => {
    const fresh = () => writeZip([['a', Buffer.from('x')]]);
    const central = (bytes: Buffer) => bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const encrypted = fresh();
    encrypted.writeUInt16LE(0x0801, central(encrypted) + 8);
    expect(() => readZip(encrypted, LIMITS)).toThrow('encrypted');
    const zip64 = fresh();
    zip64.writeUInt32LE(0xffffffff, central(zip64) + 24);
    expect(() => readZip(zip64, LIMITS)).toThrow('ZIP64');
    const disk = fresh();
    disk.writeUInt16LE(1, disk.length - 22 + 4);
    expect(() => readZip(disk, LIMITS)).toThrow('multi-disk');
    const method = fresh();
    method.writeUInt16LE(12, central(method) + 10);
    expect(() => readZip(method, LIMITS)).toThrow('compression method 12');
    const damagedLocal = fresh();
    damagedLocal.writeUInt32LE(0, 0);
    expect(() => readZip(damagedLocal, LIMITS)).toThrow('damaged local header');
    const damagedCentral = fresh();
    damagedCentral.writeUInt32LE(0, central(damagedCentral));
    expect(() => readZip(damagedCentral, LIMITS)).toThrow('damaged central directory');
    const corrupt = fresh();
    corrupt.fill(0xff, 30 + 1, 30 + 1 + 3);
    expect(() => readZip(corrupt, LIMITS)).toThrow(ZipUnreadableError);
  });

  it('refuses a part whose data runs past the end of the archive', () => {
    const bytes = writeZip([['a', Buffer.from('x'.repeat(40))]]);
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(bytes.length, central + 20);
    expect(() => readZip(bytes, LIMITS)).toThrow('cut short');
  });
});

describe('reading an XLSX workbook (ADR-0046)', () => {
  it('reads a workbook openpyxl wrote: shared strings, rich text, a number, an empty row, a boolean, only the first sheet', () => {
    expect(readXlsx(readFileSync(resolve(FIXTURES, 'openpyxl-customers.xlsx')), 100)).toEqual([
      ['customerNo', 'kind', 'name', 'phone', 'email', 'tier'],
      ['', 'INDIVIDUAL', 'Akosua Mensah', '0244 123 456', 'akosua@example.com', 'RETAIL'],
      ['', 'BUSINESS', 'Adom Chop Bar', '244765432', '', 'WHOLESALE'],
      [],
      ['C-00001', '', 'Kofi & Sons <Ltd>', '', '', 'TRUE'],
    ]);
  });

  it('reads a workbook LibreOffice wrote', () => {
    expect(readXlsx(readFileSync(resolve(FIXTURES, 'libreoffice-customers.xlsx')), 100)).toEqual([
      ['customerNo', 'kind', 'name', 'phone', 'email', 'tier'],
      ['', 'INDIVIDUAL', 'Ama "Maa" Owusu', '+233 20 111 2222', '', 'RETAIL'],
    ]);
  });

  it('reads prefixed tags, inline strings, phonetic runs, rows and cells with no reference, booleans and escapes', () => {
    const sheet = `<x:worksheet><x:sheetData>
      <x:row><x:c t="inlineStr"><x:is><x:t>A&#x41;&#66;&amp;_x000D_</x:t></x:is></x:c><x:c t="b"><x:v>0</x:v></x:c><x:c t="s"><x:v>0</x:v></x:c><x:c/><x:c t="str"><x:v>f</x:v></x:c></x:row>
      <x:row r="3"><x:c r="C3"><x:v>7.5</x:v></x:c><x:c r="D3" t="b"><x:v>1</x:v></x:c><x:c r="E3" t="e"><x:v>#N/A</x:v></x:c></x:row>
      <x:row r="4"/>
    </x:sheetData></x:worksheet>`;
    const strings = '<sst><si><r><t>Kum</t></r><r><t xml:space="preserve">asi</t></r><rPh><t>ignored</t></rPh></si><si/></sst>';
    expect(readXlsx(workbook(sheet, [['xl/sharedStrings.xml', strings]]), 10)).toEqual([['AAB&\r', 'FALSE', 'Kumasi', '', 'f'], [], ['', '', '7.5', 'TRUE', '#N/A'], []]);
  });

  it('refuses more rows than allowed, rows or cells out of order, and a missing shared string', () => {
    expect(() => readXlsx(workbook('<row r="3"><c><v>1</v></c></row>'), 2)).toThrow('more than 2 rows');
    expect(() => readXlsx(workbook('<row r="2"/><row r="1"/>'), 5)).toThrow('out of order');
    expect(() => readXlsx(workbook('<row><c r="B1"/><c r="A1"/></row>'), 5)).toThrow('cell A1 is out of order');
    expect(() => readXlsx(workbook('<row><c t="s"><v>4</v></c></row>'), 5)).toThrow('shared string 4 does not exist');
  });

  it('refuses a workbook with no workbook part, no sheet, no relationship or no sheet part, and a file that is not a ZIP', () => {
    expect(() => readXlsx(writeZip([['other.xml', Buffer.from('<a/>')]]), 5)).toThrow('no workbook part');
    expect(() => readXlsx(writeZip([['xl/workbook.xml', Buffer.from('<workbook><sheets/></workbook>')]]), 5)).toThrow('has no sheet');
    expect(() => readXlsx(writeZip([['xl/workbook.xml', Buffer.from('<workbook><sheet name="S"/></workbook>')]]), 5)).toThrow('has no part');
    const unrelated = writeZip([
      ['xl/workbook.xml', Buffer.from('<workbook><sheet r:id="rId1"/></workbook>')],
      ['xl/_rels/workbook.xml.rels', Buffer.from(`<Relationships><Relationship Id='rId1' Target='worksheets/gone.xml'/></Relationships>`)],
    ]);
    expect(() => readXlsx(unrelated, 5)).toThrow('no sheet part xl/worksheets/gone.xml');
    const noTarget = writeZip([
      ['xl/workbook.xml', Buffer.from('<workbook><sheet r:id="rId1"/></workbook>')],
      ['xl/_rels/workbook.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1"/></Relationships>')],
    ]);
    expect(() => readXlsx(noTarget, 5)).toThrow('has no part');
    expect(() => readXlsx(Buffer.from('plain text'), 5)).toThrow('not a ZIP archive');
  });

  it('decodes the five entities and character references and leaves anything else as written', () => {
    expect(decodeXmlText('&lt;&gt;&amp;&quot;&apos;&#233;&#x1F410;&nbsp;&#x110000;')).toBe('<>&"\'é🐐&nbsp;&#x110000;');
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('AA10')).toBe(26);
  });
});

describe('writing an XLSX workbook (ADR-0046)', () => {
  it('writes a workbook that reads back exactly, with escapes, a column past Z and characters XML cannot carry dropped', () => {
    const header = Array.from({ length: 28 }, (_, i) => `c${i}`);
    const rows = [header, ['Kofi & "Sons" <Ltd>', '=SUM(A1)', 'Efua\u0001'], []];
    expect(readXlsx(writeXlsx('Customers', rows), 10)).toEqual([header, ['Kofi & "Sons" <Ltd>', '=SUM(A1)', 'Efua'], []]);
  });
});

describe('CSV (ADR-0046)', () => {
  it('reads quoting, doubled quotes, line breaks in a field, CRLF and LF, a byte order mark and empty rows', () => {
    expect(readCsv('﻿a,b\r\n"x,y","say ""hi""",\n"two\nlines"\n\n,\n', 10)).toEqual([['a', 'b'], ['x,y', 'say "hi"', ''], ['two\nlines'], [], ['', '']]);
    expect(readCsv('last', 10)).toEqual([['last']]);
    expect(readCsv('""', 10)).toEqual([['']]);
    expect(readCsv('', 10)).toEqual([]);
  });

  it('refuses a stray quote, an unclosed quote and too many rows', () => {
    expect(() => readCsv('ab"c"', 10)).toThrow('a quote inside an unquoted field');
    expect(() => readCsv('"open', 10)).toThrow('not closed');
    expect(() => readCsv('1\n2\n3\n', 2)).toThrow('more than 2 rows');
  });

  it('writes with a byte order mark and CRLF, quoting only what needs it', () => {
    expect(writeCsv([['a', 'b,c'], ['say "hi"', 'x\ny']]).toString('utf8')).toBe('﻿a,"b,c"\r\n"say ""hi""","x\ny"\r\n');
  });
});

describe('spreadsheets in and out (ADR-0046)', () => {
  it('neutralises a CSV cell that would start a formula and takes the apostrophe off when it is read back', () => {
    for (const cell of ['=HYPERLINK("x")', '+233244123456', '-1', '@SUM(A1)', '\tx', '\rx']) expect(neutraliseFormula(cell)).toBe(`'${cell}`);
    expect(neutraliseFormula("Ama's shop")).toBe("Ama's shop");
    const csv = writeSheet('CSV', 'Customers', [['phone', 'note'], ['+233244123456', "'quoted"]]);
    expect(csv.toString('utf8')).toContain("'+233244123456");
    expect(readSheet(csv, 'text/csv', 10)).toEqual([['phone', 'note'], ['+233244123456', "'quoted"]]);
  });

  it('writes an XLSX string cell as it is, since no program evaluates a string', () => {
    expect(readSheet(writeSheet('XLSX', 'Customers', [['=1+1']]), XLSX, 10)).toEqual([['=1+1']]);
  });

  it('refuses a type that is not a spreadsheet and turns either format error into one error', () => {
    expect(() => readSheet(Buffer.from('x'), 'application/pdf', 10)).toThrow(SheetUnreadableError);
    expect(() => readSheet(Buffer.from('"open'), 'text/csv', 10)).toThrow(SheetUnreadableError);
    expect(() => readSheet(Buffer.from('not a zip'), XLSX, 10)).toThrow(SheetUnreadableError);
    expect(() => readSheet(Buffer.from(deflateRawSync(Buffer.from('x'))), XLSX, 10)).toThrow(SheetUnreadableError);
  });
});
