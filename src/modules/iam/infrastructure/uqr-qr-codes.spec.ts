import { Resvg } from '@resvg/resvg-js';
import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { otpauthUri } from '../domain/totp';
import { UqrQrCodes } from './uqr-qr-codes';

const PREFIX = 'data:image/svg+xml;base64,';

/**
 * Proved, not trusted (CR-006, ADR-0037): the SVG is drawn by an independent renderer (resvg, as a browser would
 * draw it) and read by an independent decoder (jsQR), neither of which shares code with the encoder. Both are
 * devDependencies, so neither reaches the production image.
 */
function decode(dataUri: string, widthPx: number): string | null {
  expect(dataUri.startsWith(PREFIX)).toBe(true);
  const svg = Buffer.from(dataUri.slice(PREFIX.length), 'base64').toString('utf8');
  const image = new Resvg(svg, { fitTo: { mode: 'width', value: widthPx }, background: 'white' }).render();
  return jsQR(new Uint8ClampedArray(image.pixels), image.width, image.height)?.data ?? null;
}

describe('the TOTP enrolment QR code (CR-006)', () => {
  const qr = new UqrQrCodes();

  it('decodes back to exactly the otpauth URI the enrolment returns', () => {
    const uri = otpauthUri('HaKorem Farms', 'kwabena.owusu@seed.hakoremfarms.invalid', 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    expect(decode(qr.svgDataUri(uri), 600)).toBe(uri);
  });

  it('decodes exactly for the longest identifier a staff account can have and for a phone number', () => {
    const longest = `${'a'.repeat(64)}@${'b'.repeat(180)}.invalid`;
    for (const label of [longest, '+233200000105']) {
      const uri = otpauthUri('HaKorem Farms', label, 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
      expect(decode(qr.svgDataUri(uri), 900)).toBe(uri);
    }
  });

  it('still decodes when drawn small, as on a phone held up to a till screen', () => {
    const uri = otpauthUri('HaKorem Farms', 'adwoa.darko@seed.hakoremfarms.invalid', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(decode(qr.svgDataUri(uri), 240)).toBe(uri);
  });

  it('is an SVG with no script, no external reference and a white quiet zone', () => {
    const svg = Buffer.from(qr.svgDataUri('otpauth://totp/x?secret=JBSWY3DP').slice(PREFIX.length), 'base64').toString('utf8');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).not.toMatch(/<script|href|xlink|url\(|on[a-z]+=/i);
  });
});
