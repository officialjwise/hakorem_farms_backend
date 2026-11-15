/**
 * What a file is, by its bytes alone (SC-12, security architecture section 5, file uploads): the name a person gave
 * it and the type their browser declared are ignored. A mechanism with no business rule: which types a use accepts
 * is the caller's allow-list. Returns null for anything not recognised, which every allow-list refuses.
 */
export type SniffedType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'application/pdf'
  | 'application/zip'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  | 'text/csv';

export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];
/** How far into a ZIP the sniffer looks for the parts that make it a workbook. */
const ZIP_LOOKAHEAD_BYTES = 65_536;
const WEBP_TAG_OFFSET = 8;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const FIRST_PRINTABLE = 0x20;
const DELETE = 0x7f;

function startsWith(bytes: Buffer, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** An Office Open XML workbook is a ZIP whose parts include `[Content_Types].xml` and the `xl/` folder. */
function isWorkbook(bytes: Buffer): boolean {
  const head = bytes.subarray(0, ZIP_LOOKAHEAD_BYTES).toString('latin1');
  return head.includes('[Content_Types].xml') && head.includes('xl/');
}

/** Text a spreadsheet program reads as comma-separated values: valid UTF-8 with no control bytes but tab and line ends. */
function isPlainText(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  for (const byte of bytes) {
    if (byte === DELETE || (byte < FIRST_PRINTABLE && byte !== TAB && byte !== LINE_FEED && byte !== CARRIAGE_RETURN)) {
      return false;
    }
  }
  return Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes);
}

export function sniffContentType(bytes: Buffer): SniffedType | null {
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, WEBP_TAG_OFFSET)) return 'image/webp';
  if (startsWith(bytes, PDF)) return 'application/pdf';
  if (startsWith(bytes, ZIP)) return isWorkbook(bytes) ? XLSX : 'application/zip';
  if (isPlainText(bytes)) return 'text/csv';
  return null;
}
