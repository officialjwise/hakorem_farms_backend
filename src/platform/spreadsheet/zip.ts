import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * The ZIP container an Office Open XML workbook is (ADR-0046), read and written with Node's own zlib: no library.
 * Reading is bounded, so a hostile archive cannot exhaust memory: at most `maxEntries` parts, each at most
 * `maxEntryBytes` once inflated, and at most `maxTotalBytes` in all. Only the two methods spreadsheet programs use
 * are read: stored (0) and deflated (8). Encrypted, multi-disk and ZIP64 archives are refused.
 */
export class ZipUnreadableError extends Error {}

export interface ZipLimits {
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const END_RECORD_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
const STORED = 0;
const DEFLATED = 8;
const ENCRYPTED_FLAG = 0x0001;
const UTF8_FLAG = 0x0800;
const ZIP64_MARKER = 0xffffffff;
const VERSION = 20;

function endRecordOffset(bytes: Buffer): number {
  const earliest = Math.max(0, bytes.length - END_RECORD_BYTES - MAX_COMMENT_BYTES);
  for (let at = bytes.length - END_RECORD_BYTES; at >= earliest; at -= 1) {
    if (bytes.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) return at;
  }
  throw new ZipUnreadableError('not a ZIP archive: no end of central directory');
}

/** The parts of an archive, by name, inflated. */
export function readZip(bytes: Buffer, limits: ZipLimits): Map<string, Buffer> {
  if (bytes.length < END_RECORD_BYTES) throw new ZipUnreadableError('not a ZIP archive: too short');
  const end = endRecordOffset(bytes);
  const count = bytes.readUInt16LE(end + 10);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) !== 0 || directoryOffset === ZIP64_MARKER) throw new ZipUnreadableError('multi-disk and ZIP64 archives are not read');
  if (count > limits.maxEntries) throw new ZipUnreadableError(`more than ${limits.maxEntries} parts`);
  const parts = new Map<string, Buffer>();
  let total = 0;
  let at = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (at + CENTRAL_HEADER_BYTES > bytes.length || bytes.readUInt32LE(at) !== CENTRAL_FILE_HEADER) throw new ZipUnreadableError('damaged central directory');
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const compressedSize = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const localOffset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + CENTRAL_HEADER_BYTES, at + CENTRAL_HEADER_BYTES + nameLength).toString((flags & UTF8_FLAG) !== 0 ? 'utf8' : 'latin1');
    at += CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
    if ((flags & ENCRYPTED_FLAG) !== 0) throw new ZipUnreadableError('encrypted archives are not read');
    if (compressedSize === ZIP64_MARKER || size === ZIP64_MARKER) throw new ZipUnreadableError('ZIP64 archives are not read');
    if (size > limits.maxEntryBytes) throw new ZipUnreadableError(`part ${name} is larger than ${limits.maxEntryBytes} bytes`);
    if (name.endsWith('/')) continue;
    if (localOffset + LOCAL_HEADER_BYTES > bytes.length || bytes.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) throw new ZipUnreadableError('damaged local header');
    const dataStart = localOffset + LOCAL_HEADER_BYTES + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    if (data.length !== compressedSize) throw new ZipUnreadableError(`part ${name} is cut short`);
    let content: Buffer;
    if (method === STORED) content = Buffer.from(data);
    else if (method === DEFLATED) {
      try {
        // The declared size is only a claim: the inflater itself stops one byte past the part's limit.
        content = inflateRawSync(data, { maxOutputLength: limits.maxEntryBytes + 1 });
      } catch {
        throw new ZipUnreadableError(`part ${name} does not inflate within ${limits.maxEntryBytes} bytes`);
      }
    } else throw new ZipUnreadableError(`part ${name} uses compression method ${method}`);
    if (content.length > limits.maxEntryBytes) throw new ZipUnreadableError(`part ${name} is larger than ${limits.maxEntryBytes} bytes`);
    total += content.length;
    if (total > limits.maxTotalBytes) throw new ZipUnreadableError(`the archive inflates to more than ${limits.maxTotalBytes} bytes`);
    parts.set(name, content);
  }
  return parts;
}

/** An archive of the given parts, deflated, in the order given, with a fixed timestamp so equal parts give equal bytes. */
export function writeZip(parts: ReadonlyArray<readonly [name: string, content: Buffer]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of parts) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(content);
    const checksum = crc32(content);
    const local = Buffer.alloc(LOCAL_HEADER_BYTES);
    local.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(DEFLATED, 8);
    local.writeUInt16LE(0, 10); // 00:00:00
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(CENTRAL_HEADER_BYTES);
    central.writeUInt32LE(CENTRAL_FILE_HEADER, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(DEFLATED, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    centrals.push(central, nameBytes);
    offset += LOCAL_HEADER_BYTES + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(END_RECORD_BYTES);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
