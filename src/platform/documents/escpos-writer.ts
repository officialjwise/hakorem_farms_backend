import { printable } from './pdf-writer';

/**
 * A deterministic ESC/POS writer for thermal receipts (ADR-0061): the same lines always give the same bytes. Only
 * printable ASCII is sent, so no code page matters. A reprint is the marker followed by the archived bytes unchanged:
 * the original starts with `ESC @`, which resets whatever the marker set.
 */

export interface ThermalLine {
  /** One cell is a full-width line; several are columns, the first left-aligned and wrapped, the rest right-aligned. */
  readonly cells: readonly string[];
  readonly bold: boolean;
  readonly center: boolean;
  /** Double height, for a title. */
  readonly tall: boolean;
  readonly rule: boolean;
}

/** Characters per line in font A: 48 on 80 mm paper, 32 on 58 mm. */
export const THERMAL_COLUMNS = { THERMAL_80MM: 48, THERMAL_58MM: 32 } as const;

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;
const INIT = [ESC, 0x40];
const ALIGN = (center: boolean) => [ESC, 0x61, center ? 1 : 0];
const BOLD = (on: boolean) => [ESC, 0x45, on ? 1 : 0];
const SIZE = (tall: boolean) => [GS, 0x21, tall ? 0x01 : 0x00];
const FEED_AND_CUT = [ESC, 0x64, 4, GS, 0x56, 0x42, 0x00];
const FIRST_COLUMN_SHARE = 0.5;

/** Splits text into pieces of at most `width` characters, at spaces where it can. */
export function wrapColumns(text: string, width: number): string[] {
  const words = printable(text).split(' ').filter((w) => w !== '');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    let rest = word;
    while (rest.length > width) {
      if (current !== '') {
        lines.push(current);
        current = '';
      }
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    const candidate = current === '' ? rest : `${current} ${rest}`;
    if (candidate.length <= width) {
      current = candidate;
    } else {
      lines.push(current);
      current = rest;
    }
  }
  lines.push(current);
  return lines;
}

function textLines(line: ThermalLine, columns: number): string[] {
  const [first = '', ...rest] = line.cells;
  if (rest.length === 0) return wrapColumns(first, columns);
  const cellWidth = Math.floor((columns * (1 - FIRST_COLUMN_SHARE)) / rest.length);
  const firstWidth = columns - cellWidth * rest.length;
  const right = rest.map((cell) => printable(cell).slice(0, cellWidth - 1).padStart(cellWidth)).join('');
  return wrapColumns(first, firstWidth - 1).map((piece, i) => (i === 0 ? piece.padEnd(firstWidth) + right : piece));
}

export function renderEscPos(lines: readonly ThermalLine[], columns: number): Buffer {
  const bytes: number[] = [...INIT];
  for (const line of lines) {
    if (line.rule) {
      bytes.push(...ALIGN(false), ...Buffer.from('-'.repeat(columns), 'latin1'), LF);
      continue;
    }
    bytes.push(...ALIGN(line.center), ...BOLD(line.bold), ...SIZE(line.tall));
    for (const text of textLines(line, columns)) bytes.push(...Buffer.from(text, 'latin1'), LF);
    bytes.push(...SIZE(false), ...BOLD(false));
  }
  bytes.push(...ALIGN(false), ...FEED_AND_CUT);
  return Buffer.from(bytes);
}

/** The marker, centred and bold, then the archived bytes exactly as stored. */
export function escPosWithReprintMarker(original: Buffer, marker: string): Buffer {
  const head = [...INIT, ...ALIGN(true), ...BOLD(true), ...Buffer.from(`*** ${printable(marker)} ***`, 'latin1'), LF, ...BOLD(false), ...ALIGN(false), LF];
  return Buffer.concat([Buffer.from(head), original]);
}
