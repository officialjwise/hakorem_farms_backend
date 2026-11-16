import { renderEscPos, THERMAL_COLUMNS, type ThermalLine } from '../../../platform/documents/escpos-writer';
import { renderPdf, type PdfLine } from '../../../platform/documents/pdf-writer';
import { layoutMarkup, renderTemplate, type Line } from '../domain/templates';
import type { TemplateOutput } from './doc-store';

/** The platform's writers (ADR-0009's PDF renderer): DOC lays out lines, a renderer writes the bytes. */
export interface DocumentRenderer {
  pdf(lines: readonly PdfLine[]): Buffer;
  thermal(lines: readonly ThermalLine[], columns: number): Buffer;
}

export const PLATFORM_RENDERER: DocumentRenderer = { pdf: (lines) => renderPdf(lines), thermal: renderEscPos };

const PDF_SIZE = { h1: 16, h2: 12, p: 10, small: 8 } as const;

function pdfLine(line: Line): PdfLine {
  return { cells: line.cells, size: PDF_SIZE[line.style], bold: line.style === 'h1' || line.style === 'h2', center: line.center, rule: line.rule };
}

function thermalLine(line: Line): ThermalLine {
  return { cells: line.cells, bold: line.style === 'h1' || line.style === 'h2', center: line.center, tall: line.style === 'h1', rule: line.rule };
}

/** A template body rendered with its data in the template's output: PDF for A4, ESC/POS for thermal paper. */
export function renderBody(renderer: DocumentRenderer, body: string, output: TemplateOutput, data: Record<string, unknown>): Buffer {
  return write(renderer, layoutMarkup(renderTemplate(body, data)), output);
}

/** Printed first and last on every preview, so a specimen can never pass for an issued document (ADR-0062). */
export const PREVIEW_MARKER = 'SPECIMEN PREVIEW - NOT A VALID DOCUMENT';

const markerLine: Line = { cells: [PREVIEW_MARKER], style: 'h2', center: true, rule: false };

/** A preview: the body rendered with the data given, between two specimen markers. Nothing is stored or numbered. */
export function renderPreview(renderer: DocumentRenderer, body: string, output: TemplateOutput, data: Record<string, unknown>): Buffer {
  return write(renderer, [markerLine, ...layoutMarkup(renderTemplate(body, data)), markerLine], output);
}

function write(renderer: DocumentRenderer, lines: readonly Line[], output: TemplateOutput): Buffer {
  return output === 'PDF_A4' ? renderer.pdf(lines.map(pdfLine)) : renderer.thermal(lines.map(thermalLine), THERMAL_COLUMNS[output]);
}
