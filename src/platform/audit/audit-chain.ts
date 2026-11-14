import { createHash, sign, verify, type KeyObject } from 'node:crypto';

/** The first chain row's previous hash: 32 zero bytes (ADR-0006). */
export const GENESIS_HASH = Buffer.alloc(32);

/** `sha256(prev_hash || content_hash || seq)`, with `seq` as an eight-byte big-endian integer (ADR-0006). */
export function chainHash(previous: Buffer, contentHash: Buffer, seq: bigint): Buffer {
  const position = Buffer.alloc(8);
  position.writeBigUInt64BE(seq);
  return createHash('sha256').update(previous).update(contentHash).update(position).digest();
}

/** What an anchor signs: the chain head and when it was taken, in a fixed text form. */
export function anchorMessage(seq: bigint, head: Buffer, anchoredAt: Date, keyId: string): Buffer {
  return Buffer.from(`hakorem-audit-anchor|v1|${keyId}|${seq.toString()}|${head.toString('hex')}|${anchoredAt.toISOString()}`, 'utf8');
}

export function signAnchor(privateKey: KeyObject, message: Buffer): Buffer {
  return sign(null, message, privateKey);
}

export function anchorSignatureValid(publicKey: KeyObject, message: Buffer, signature: Buffer): boolean {
  return verify(null, message, publicKey, signature);
}
