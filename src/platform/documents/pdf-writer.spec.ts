import { describe, expect, it } from 'vitest';
import { escPosWithReprintMarker, renderEscPos, wrapColumns, THERMAL_COLUMNS, type ThermalLine } from './escpos-writer';
import { A4, NotAnArchivedPdfError, printable, renderPdf, textWidth, withReprintMarker, wrap, type PdfLine } from './pdf-writer';

const line = (cells: string[], overrides: Partial<PdfLine> = {}): PdfLine => ({ cells, size: 10, bold: false, center: false, rule: false, ...overrides });

/** Every xref entry of every section points at the start of its object. */
function xrefHolds(pdf: Buffer): boolean {
  const text = pdf.toString('latin1');
  const sections = [...text.matchAll(/xref\n((?:\d+ \d+\n(?:\d{10} \d{5} [nf] \n)+)+)trailer/g)];
  if (sections.length === 0) return false;
  for (const section of sections) {
    let current = 0;
    for (const row of section[1]!.split('\n').filter((r) => r !== '')) {
      const head = /^(\d+) (\d+)$/.exec(row);
      if (head !== null) {
        current = Number(head[1]);
        continue;
      }
      const [offset, , kind] = row.trim().split(' ');
      if (kind === 'n' && !text.startsWith(`${current} 0 obj\n`, Number(offset))) return false;
      current += 1;
    }
  }
  const startxref = [...text.matchAll(/startxref\n(\d+)\n%%EOF\n/g)].map((m) => Number(m[1]));
  return startxref.every((offset) => text.startsWith('xref\n', offset));
}

describe('renderPdf (ADR-0061)', () => {
  const lines = [
    line(['HaKorem Farms (SEED)'], { size: 16, bold: true, center: true }),
    line([''], { rule: true }),
    line(['Goat, live (G-0142)', '1.000 HEAD', 'GHS 800.00']),
    line(['A description long enough to wrap onto a second line of the first column, as a long name would', '2.000 PACK', 'GHS 1,244.89']),
    line(['Brackets ( and ) and a \\ are escaped; a cedi sign ₵ prints as ?']),
  ];

  it('gives the same bytes for the same lines, with no date and no identifier', () => {
    const one = renderPdf(lines);
    const two = renderPdf(lines);
    expect(one.equals(two)).toBe(true);
    const text = one.toString('latin1');
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.endsWith('%%EOF\n')).toBe(true);
    expect(text).not.toMatch(/CreationDate|\/ID/);
    expect(xrefHolds(one)).toBe(true);
  });

  it('escapes PDF string delimiters and prints anything outside ASCII as ?', () => {
    const text = renderPdf(lines).toString('latin1');
    expect(text).toContain('(Brackets \\( and \\) and a \\\\ are escaped; a cedi sign ? prints as ?)');
    expect(printable('Ama Mensah ₵')).toBe('Ama?Mensah ?');
  });

  it('right-aligns the columns after the first and wraps the first', () => {
    const text = renderPdf(lines).toString('latin1');
    expect(text).toContain('(GHS 800.00) Tj');
    expect(text).toContain('(1.000 HEAD) Tj');
    expect(text.match(/\(A description[^)]*\) Tj/)).not.toBeNull();
  });

  it('starts a new page when the first is full, every page in the page tree', () => {
    const many = Array.from({ length: 80 }, (_, i) => line([`Line ${i + 1}`]));
    const pdf = renderPdf(many).toString('latin1');
    expect(pdf).toContain('/Kids [6 0 R 8 0 R] /Count 2');
    expect(pdf).toContain('(Line 80) Tj');
    expect(xrefHolds(renderPdf(many))).toBe(true);
  });

  it('measures and wraps by Helvetica widths, splitting a word longer than the column', () => {
    expect(textWidth('0', 10, false)).toBe(5.56);
    expect(textWidth('W', 10, true)).toBe(9.44);
    expect(wrap('', 100, 10, false)).toEqual(['']);
    expect(wrap('one two three', 40, 10, false)).toEqual(['one two', 'three']);
    const pieces = wrap('MMMMMMMMMMMM', 30, 10, false);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join('')).toBe('MMMMMMMMMMMM');
    expect(A4).toEqual({ width: 595, height: 842, margin: 48 });
  });
});

describe('withReprintMarker (FR-BIL-009)', () => {
  const original = renderPdf([line(['Invoice INV-2026-DDW-000001'], { size: 16, bold: true }), line(['Total', 'GHS 1,244.89'])]);

  it('keeps the archived bytes as a byte-for-byte prefix and adds only the marker', () => {
    const reprint = withReprintMarker(original, 'REPRINT 2');
    expect(reprint.subarray(0, original.length).equals(original)).toBe(true);
    const tail = reprint.subarray(original.length).toString('latin1');
    expect(tail).toContain('(REPRINT 2) Tj');
    expect(tail).toContain('/Contents [7 0 R 8 0 R]');
    expect(tail).toContain('/Prev ');
    expect(xrefHolds(reprint)).toBe(true);
  });

  it('gives copies that differ only in the marker', () => {
    const one = withReprintMarker(original, 'REPRINT 1');
    const two = withReprintMarker(original, 'REPRINT 2');
    expect(one.length).toBe(two.length);
    const differing = [...one].flatMap((byte, i) => (byte === two[i] ? [] : [i]));
    expect(differing.length).toBe(1);
    expect(one.toString('latin1', differing[0]!, differing[0]! + 1)).toBe('1');
  });

  it('refuses bytes it did not write', () => {
    expect(() => withReprintMarker(Buffer.from('%PDF-1.7\nnot ours'), 'REPRINT 1')).toThrow(NotAnArchivedPdfError);
  });
});

describe('renderEscPos (ADR-0061)', () => {
  const thermal = (cells: string[], overrides: Partial<ThermalLine> = {}): ThermalLine => ({ cells, bold: false, center: false, tall: false, rule: false, ...overrides });
  const lines = [
    thermal(['HaKorem Farms (SEED)'], { bold: true, center: true, tall: true }),
    thermal([''], { rule: true }),
    thermal(['Eggs, big, crate of 30', 'GHS 120.00']),
    thermal(['A very long description that wraps over the thermal line', 'GHS 60.00']),
  ];

  it('initialises, aligns, emphasises and cuts, the same bytes every time', () => {
    const bytes = renderEscPos(lines, THERMAL_COLUMNS.THERMAL_80MM);
    expect(bytes.equals(renderEscPos(lines, 48))).toBe(true);
    expect([...bytes.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...bytes.subarray(bytes.length - 4)]).toEqual([0x1d, 0x56, 0x42, 0x00]);
    const text = bytes.toString('latin1');
    expect(text).toContain('-'.repeat(48));
    expect(text).toContain(`${'Eggs, big, crate of 30'.padEnd(24)}${'GHS 120.00'.padStart(24)}\n`);
    expect(text).toContain('\x1b\x61\x01\x1b\x45\x01\x1d\x21\x01HaKorem Farms (SEED)\n');
  });

  it('wraps at the paper width, splitting a word longer than the line', () => {
    expect(wrapColumns('', 10)).toEqual(['']);
    expect(wrapColumns('one two three', 8)).toEqual(['one two', 'three']);
    expect(wrapColumns('abcdefghijkl x', 5)).toEqual(['abcde', 'fghij', 'kl x']);
    expect(wrapColumns('ab abcdefghij', 5)).toEqual(['ab', 'abcde', 'fghij']);
  });

  it('puts the marker before the archived bytes, which follow unchanged', () => {
    const original = renderEscPos(lines, THERMAL_COLUMNS.THERMAL_58MM);
    const reprint = escPosWithReprintMarker(original, 'REPRINT 2');
    expect(reprint.subarray(reprint.length - original.length).equals(original)).toBe(true);
    expect(reprint.subarray(0, reprint.length - original.length).toString('latin1')).toContain('*** REPRINT 2 ***\n');
  });
});
