import { describe, expect, it } from 'vitest';
import { sniffContentType, XLSX } from './content-sniffer';

const bytes = (...values: number[]) => Buffer.from(values);

describe('content sniffing (SC-12): the bytes decide the type, never the name', () => {
  it('recognises a JPEG, a PNG, a WebP and a PDF by their signatures', () => {
    expect(sniffContentType(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00))).toBe('image/jpeg');
    expect(sniffContentType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))).toBe('image/png');
    expect(sniffContentType(Buffer.concat([Buffer.from('RIFF'), bytes(0x10, 0, 0, 0), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
    expect(sniffContentType(Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3', 'latin1'))).toBe('application/pdf');
  });

  it('tells a workbook from any other ZIP, so a ZIP renamed .jpg or .xlsx is only a ZIP', () => {
    const zip = bytes(0x50, 0x4b, 0x03, 0x04);
    expect(sniffContentType(Buffer.concat([zip, Buffer.from('....[Content_Types].xml....xl/workbook.xml')]))).toBe(XLSX);
    expect(sniffContentType(Buffer.concat([zip, Buffer.from('....[Content_Types].xml....word/document.xml')]))).toBe('application/zip');
    expect(sniffContentType(Buffer.concat([zip, Buffer.from('payload.exe')]))).toBe('application/zip');
  });

  it('takes UTF-8 text with tabs and line ends as comma-separated values', () => {
    expect(sniffContentType(Buffer.from('sku,name\r\nGOAT-LIVE,Live goat\tAdwoa\n'))).toBe('text/csv');
    expect(sniffContentType(Buffer.from('code,name\nYAM,Puna yam — Ɛkumfi\n'))).toBe('text/csv');
  });

  it('refuses control bytes, invalid UTF-8, an empty file and a RIFF that is not WebP', () => {
    expect(sniffContentType(bytes(0x4d, 0x5a, 0x90, 0x00))).toBeNull(); // a Windows executable
    expect(sniffContentType(Buffer.from('a,b\u007f'))).toBeNull();
    expect(sniffContentType(bytes(0x61, 0xc3, 0x28))).toBeNull();
    expect(sniffContentType(Buffer.alloc(0))).toBeNull();
    expect(sniffContentType(Buffer.concat([Buffer.from('RIFF'), bytes(0x10, 0, 0, 0), Buffer.from('WAVE')]))).toBeNull();
    expect(sniffContentType(bytes(0xff, 0xd8))).toBeNull();
  });
});
