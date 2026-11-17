import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256 random bits per link, above the 128 the owner's decision 5 asks for (ADR-0074). */
export const LINK_TOKEN_BYTES = 32;
const LINK_TOKEN_BODY_LENGTH = 43;
const BASE64URL_BODY = /^[A-Za-z0-9_-]+$/;
const PREFIX = /^[a-z]{2,8}_$/;

/** A link token as it leaves the system once (in the answer or the message) and the only thing that is stored. */
export interface IssuedLinkToken {
  readonly token: string;
  /** SHA-256 of the token's text, 32 bytes: what the owning module stores and looks up by. */
  readonly hash: Buffer;
}

function checkedPrefix(prefix: string): string {
  if (!PREFIX.test(prefix)) throw new Error(`"${prefix}" is not a link token prefix (two to eight lower-case letters and _)`);
  return prefix;
}

function hashOf(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * A new token for a link sent to a customer (order tracking, a receipt, a document link): the prefix and base64url
 * of 32 bytes from the cryptographically secure source, never derived from an id or a key, so nothing a caller
 * knows about the record helps to guess it. The caller stores `hash` only and hands `token` out once.
 */
export function issueLinkToken(prefix: string, random: (size: number) => Buffer = randomBytes): IssuedLinkToken {
  checkedPrefix(prefix);
  const bytes = random(LINK_TOKEN_BYTES);
  if (bytes.length !== LINK_TOKEN_BYTES) throw new Error(`a link token needs ${LINK_TOKEN_BYTES} random bytes`);
  const token = `${prefix}${bytes.toString('base64url')}`;
  return { token, hash: hashOf(token) };
}

/**
 * The hash to look a link up by, or null for text that is not a token of this prefix written exactly as issued
 * (wrong prefix, length or alphabet, or a body that is not the one spelling of its bytes). Looking up by the hash
 * keeps the time of a lookup independent of how close a guess is to a real token.
 */
export function linkTokenHash(prefix: string, text: string): Buffer | null {
  checkedPrefix(prefix);
  if (!text.startsWith(prefix)) return null;
  const body = text.slice(prefix.length);
  if (body.length !== LINK_TOKEN_BODY_LENGTH || !BASE64URL_BODY.test(body) || Buffer.from(body, 'base64url').toString('base64url') !== body) return null;
  return hashOf(text);
}

/** Two stored hashes compared in constant time; a hash of another length is never the same. */
export function sameLinkTokenHash(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
