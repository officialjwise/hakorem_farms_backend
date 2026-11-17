import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueLinkToken, LINK_TOKEN_BYTES, linkTokenHash, sameLinkTokenHash } from './link-tokens';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();

describe('customer link tokens: random, at least 128 bits, stored only as a hash (ADR-0074)', () => {
  it('draws 256 bits from the secure source and writes them after the prefix, nothing else', () => {
    const drawn: number[] = [];
    const bytes = Buffer.from(Array.from({ length: LINK_TOKEN_BYTES }, (_, i) => (i * 37 + 11) % 256));
    const issued = issueLinkToken('trk_', (size) => {
      drawn.push(size);
      return bytes;
    });
    expect(LINK_TOKEN_BYTES * 8).toBeGreaterThanOrEqual(128);
    expect(drawn).toEqual([32]);
    expect(issued.token).toBe(`trk_${bytes.toString('base64url')}`);
    expect(issued.token).toMatch(/^trk_[A-Za-z0-9_-]{43}$/);
    expect(issued.hash.equals(sha256(issued.token))).toBe(true);
  });

  it('gives two links two different tokens and hashes from the default source', () => {
    const [a, b] = [issueLinkToken('trk_'), issueLinkToken('trk_')];
    expect(a.token).not.toBe(b.token);
    expect(a.hash.equals(b.hash)).toBe(false);
  });

  it('refuses a source that gives fewer bytes than it was asked for', () => {
    expect(() => issueLinkToken('trk_', () => Buffer.alloc(16))).toThrow(/32 random bytes/);
  });

  it('refuses a prefix that is not lower-case letters and an underscore', () => {
    for (const prefix of ['', 'trk', 'TRK_', 'trk-', 'a_', 'toolongprefix_']) expect(() => issueLinkToken(prefix)).toThrow(/prefix/);
    expect(() => linkTokenHash('trk', 'trk')).toThrow(/prefix/);
  });

  it('hashes a token typed exactly as issued, and only that', () => {
    const issued = issueLinkToken('trk_');
    expect(linkTokenHash('trk_', issued.token)!.equals(issued.hash)).toBe(true);
    const body = issued.token.slice(4);
    const flipped = `trk_${body.slice(0, 10)}${body[10] === 'A' ? 'B' : 'A'}${body.slice(11)}`;
    expect(linkTokenHash('trk_', flipped)!.equals(issued.hash)).toBe(false);
    expect(linkTokenHash('rcp_', issued.token)).toBeNull();
    expect(linkTokenHash('trk_', body)).toBeNull();
    expect(linkTokenHash('trk_', `${issued.token}A`)).toBeNull();
    expect(linkTokenHash('trk_', issued.token.slice(0, -1))).toBeNull();
    expect(linkTokenHash('trk_', `trk_${'+'.repeat(43)}`)).toBeNull();
    expect(linkTokenHash('trk_', 'trk_')).toBeNull();
  });

  it('refuses a body that decodes but is not the one spelling of its bytes', () => {
    const issued = issueLinkToken('trk_', () => Buffer.alloc(LINK_TOKEN_BYTES));
    expect(issued.token).toBe(`trk_${'A'.repeat(43)}`);
    // The 43rd character carries two unused bits: B decodes to the same bytes as A but is not how they are written.
    expect(linkTokenHash('trk_', `trk_${'A'.repeat(42)}B`)).toBeNull();
  });

  it('compares two hashes in constant time, and different lengths as different', () => {
    const issued = issueLinkToken('trk_');
    expect(sameLinkTokenHash(issued.hash, Buffer.from(issued.hash))).toBe(true);
    expect(sameLinkTokenHash(issued.hash, sha256('trk_other'))).toBe(false);
    expect(sameLinkTokenHash(issued.hash, issued.hash.subarray(0, 16))).toBe(false);
  });
});
