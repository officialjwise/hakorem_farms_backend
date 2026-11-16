/**
 * A deterministic PDF writer for the document archive (ADR-0061): text lines in the two standard Helvetica faces,
 * WinAnsi encoding, uncompressed content streams, no creation date and no file identifier, so the same lines always
 * give the same bytes and the archive's SHA-256 can be recomputed by anyone. It is the `PdfRenderer` mechanism of
 * ADR-0009: DOC lays a template out into lines; this turns lines into pages.
 *
 * A reprint never changes these bytes: `withReprintMarker` appends a PDF incremental update that overlays the marker
 * on the first page, so the archived original is a byte-for-byte prefix of every reprint.
 */

export interface PdfLine {
  /** One cell is a full-width line; several are columns, the first left-aligned and wrapped, the rest right-aligned. */
  readonly cells: readonly string[];
  /** Points. */
  readonly size: number;
  readonly bold: boolean;
  readonly center: boolean;
  /** A horizontal rule instead of text. */
  readonly rule: boolean;
}

export interface PageSize {
  readonly width: number;
  readonly height: number;
  readonly margin: number;
}

/** ISO A4 in points. */
export const A4: PageSize = { width: 595, height: 842, margin: 48 };

/** Helvetica advance widths (thousandths of an em) for the printable ASCII range 32 to 126, from the standard AFM. */
const REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722,
  722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722,
  722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
  611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
const LINE_GAP = 1.35;
/** The share of the text width the first column takes when a line has several. */
const FIRST_COLUMN_SHARE = 0.46;
const COLUMN_GAP = 6;
/** Pages are object 6 onward (two objects each): the first page is always object 6 and its content object 7. */
const FIRST_PAGE_OBJECT = 6;
const MARKER_SIZE = 13;

/** Printable ASCII only: anything else prints as `?`, so the bytes never depend on an encoding table. */
export function printable(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, '?');
}

export function textWidth(text: string, size: number, bold: boolean): number {
  const table = bold ? BOLD : REGULAR;
  let units = 0;
  for (const ch of printable(text)) units += table[ch.charCodeAt(0) - 32]!;
  return (units * size) / 1000;
}

/** Splits text into pieces no wider than `width`, at spaces where it can and inside a word where it must. */
export function wrap(text: string, width: number, size: number, bold: boolean): string[] {
  const words = printable(text).split(' ').filter((w) => w !== '');
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  const push = (word: string) => {
    let rest = word;
    while (textWidth(rest, size, bold) > width && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && textWidth(rest.slice(0, cut), size, bold) > width) cut -= 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    current = rest;
  };
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (textWidth(candidate, size, bold) <= width) {
      current = candidate;
    } else {
      if (current !== '') lines.push(current);
      push(word);
    }
  }
  lines.push(current);
  return lines;
}

function escape(text: string): string {
  return printable(text).replace(/[\\()]/g, (c) => `\\${c}`);
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();

function textOp(x: number, y: number, size: number, bold: boolean, text: string): string {
  return `BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${num(x)} ${num(y)} Td (${escape(text)}) Tj ET`;
}

/** The content stream of each page. */
function layout(lines: readonly PdfLine[], page: PageSize): string[] {
  const pages: string[][] = [[]];
  const left = page.margin;
  const right = page.width - page.margin;
  const width = right - left;
  let y = page.height - page.margin;
  const advance = (height: number) => {
    if (y - height < page.margin) {
      pages.push([]);
      y = page.height - page.margin;
    }
    y -= height;
  };
  const ops = () => pages[pages.length - 1]!;
  for (const line of lines) {
    const height = line.size * LINE_GAP;
    if (line.rule) {
      advance(height / 2);
      ops().push(`0.5 w ${num(left)} ${num(y + height / 4)} m ${num(right)} ${num(y + height / 4)} l S`);
      continue;
    }
    const [first = '', ...rest] = line.cells;
    if (rest.length === 0) {
      for (const piece of wrap(first, width, line.size, line.bold)) {
        advance(height);
        const x = line.center ? left + (width - textWidth(piece, line.size, line.bold)) / 2 : left;
        ops().push(textOp(x, y, line.size, line.bold, piece));
      }
      continue;
    }
    const firstWidth = width * FIRST_COLUMN_SHARE;
    const columnWidth = (width - firstWidth) / rest.length;
    const pieces = wrap(first, firstWidth - COLUMN_GAP, line.size, line.bold);
    pieces.forEach((piece, i) => {
      advance(height);
      ops().push(textOp(left, y, line.size, line.bold, piece));
      if (i > 0) return;
      rest.forEach((cell, c) => {
        const cellRight = left + firstWidth + columnWidth * (c + 1);
        const fitted = wrap(cell, columnWidth - COLUMN_GAP, line.size, line.bold)[0]!;
        ops().push(textOp(cellRight - textWidth(fitted, line.size, line.bold), y, line.size, line.bold, fitted));
      });
    });
  }
  return pages.map((p) => p.join('\n'));
}

/** Lays the lines out on pages of the given size and writes the PDF. The same input always gives the same bytes. */
export function renderPdf(lines: readonly PdfLine[], page: PageSize = A4): Buffer {
  const streams = layout(lines, page);
  const objects: string[] = [];
  const kids = streams.map((_, i) => `${FIRST_PAGE_OBJECT + 2 * i} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${streams.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Font << /F1 3 0 R /F2 4 0 R >> >>');
  streams.forEach((stream, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources 5 0 R /Contents ${FIRST_PAGE_OBJECT + 2 * i + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });
  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

export class NotAnArchivedPdfError extends Error {
  constructor(reason: string) {
    super(`not a PDF this writer produced: ${reason}`);
    this.name = 'NotAnArchivedPdfError';
  }
}

/**
 * The original PDF with a reprint marker on its first page, as an incremental update appended after `%%EOF`: the
 * original bytes are unchanged and come first, the marker is a second content stream drawn over page one.
 */
export function withReprintMarker(original: Buffer, marker: string, page: PageSize = A4): Buffer {
  const text = original.toString('latin1');
  const size = /trailer\n<< \/Size (\d+) \/Root 1 0 R(?: \/Prev \d+)? >>\nstartxref\n(\d+)\n%%EOF\n$/.exec(text);
  const pageObject = new RegExp(`\n${FIRST_PAGE_OBJECT} 0 obj\n(<< /Type /Page [^\n]*/Contents )(\\[?[0-9 R]+\\]?)( >>)\nendobj\n`).exec(text);
  if (size === null || pageObject === null) throw new NotAnArchivedPdfError('no trailer or first page found');
  const markerObject = Number(size[1]);
  const prev = Number(size[2]);
  const contents = pageObject[2]!.replace(/^\[|\]$/g, '').trim();
  const width = textWidth(marker, MARKER_SIZE, true);
  const stream = `q 0.8 0 0 rg ${textOp(page.width - page.margin - width, page.height - page.margin / 2 - MARKER_SIZE / 2, MARKER_SIZE, true, marker)} Q`;
  let update = '';
  const base = original.length;
  const markerOffset = base + Buffer.byteLength(update, 'latin1');
  update += `${markerObject} 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream\nendobj\n`;
  const pageOffset = base + Buffer.byteLength(update, 'latin1');
  update += `${FIRST_PAGE_OBJECT} 0 obj\n${pageObject[1]}[${contents} ${markerObject} 0 R]${pageObject[3]}\nendobj\n`;
  const xref = base + Buffer.byteLength(update, 'latin1');
  update += `xref\n${FIRST_PAGE_OBJECT} 1\n${pageOffset.toString().padStart(10, '0')} 00000 n \n${markerObject} 1\n${markerOffset.toString().padStart(10, '0')} 00000 n \n`;
  update += `trailer\n<< /Size ${markerObject + 1} /Root 1 0 R /Prev ${prev} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([original, Buffer.from(update, 'latin1')]);
}
