import { renderSVG } from 'uqr';
import type { QrCodes } from '../application/ports';

/**
 * QR codes from `uqr` (ADR-0037), pinned at 0.1.3. Error correction M tolerates a phone camera on a screen; a
 * four-module quiet zone is the standard's minimum; one unit per module keeps the SVG small and lets it scale.
 */
export class UqrQrCodes implements QrCodes {
  svgDataUri(text: string): string {
    const svg = renderSVG(text, { ecc: 'M', border: 4, pixelSize: 1 });
    return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
  }
}
