import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { receiptLinkOf, receiptTokenHash, receiptTokenVerdict, RECEIPT_TOKEN_PLACEHOLDER } from './receipt-link';

const SALE = '019a7afc-7c43-71fc-9734-2899e9daa177';
const OTHER = '019a7afd-1b20-7c4e-8a31-5f2d9e0c6b18';
/** A till token of the shortest form, 22 characters with both of base64url's extra letters; built, so no scanner reads a key. */
const TOKEN = `${'Ab-_'.repeat(5)}Cd`;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest();

describe('receiptTokenHash (ADR-0074 Amendments, CR-033)', () => {
  it('hashes a till token of 22 to 86 base64url characters, exactly as written', () => {
    const token = TOKEN;
    expect(token).toHaveLength(22);
    expect(receiptTokenHash(token)).toEqual(sha(token));
    const long = 'A'.repeat(86);
    expect(receiptTokenHash(long)).toEqual(sha(long));
    expect(receiptTokenHash(`rcp_${'B'.repeat(43)}`)).toEqual(sha(`rcp_${'B'.repeat(43)}`));
  });

  it('answers null for anything else, so a lookup by it finds nothing', () => {
    expect(receiptTokenHash('A'.repeat(21))).toBeNull();
    expect(receiptTokenHash('A'.repeat(87))).toBeNull();
    expect(receiptTokenHash(`${'A'.repeat(21)}=`)).toBeNull();
    expect(receiptTokenHash(`${'A'.repeat(21)}+`)).toBeNull();
    expect(receiptTokenHash(`${'A'.repeat(21)}/`)).toBeNull();
    expect(receiptTokenHash('')).toBeNull();
  });
});

describe('receiptTokenVerdict', () => {
  it('binds a fresh token to its sale', () => {
    expect(receiptTokenVerdict({ token: TOKEN, saleId: SALE, boundTo: null })).toEqual({ kind: 'BIND' });
  });

  it('refuses a token already bound to another sale, naming that sale', () => {
    expect(receiptTokenVerdict({ token: TOKEN, saleId: SALE, boundTo: OTHER })).toEqual({ kind: 'REFUSE', reason: 'TOKEN_ALREADY_BOUND', boundTo: OTHER });
  });

  it('keeps a token already bound to this very sale and adds nothing', () => {
    expect(receiptTokenVerdict({ token: TOKEN, saleId: SALE, boundTo: SALE })).toEqual({ kind: 'KEEP' });
  });

  it('refuses a token shaped like an identifier, the sale id first of all, whatever its case', () => {
    expect(receiptTokenVerdict({ token: SALE, saleId: SALE, boundTo: null })).toEqual({ kind: 'REFUSE', reason: 'TOKEN_IS_AN_IDENTIFIER', boundTo: null });
    expect(receiptTokenVerdict({ token: OTHER.toUpperCase(), saleId: SALE, boundTo: null })).toEqual({ kind: 'REFUSE', reason: 'TOKEN_IS_AN_IDENTIFIER', boundTo: null });
    expect(receiptTokenVerdict({ token: SALE.replaceAll('-', ''), saleId: SALE, boundTo: null })).toEqual({ kind: 'REFUSE', reason: 'TOKEN_IS_AN_IDENTIFIER', boundTo: null });
  });
});

describe('receiptLinkOf', () => {
  it('fills the template with the token', () => {
    expect(receiptLinkOf(`https://shop.hakorem.test/r/${RECEIPT_TOKEN_PLACEHOLDER}`, TOKEN)).toBe(`https://shop.hakorem.test/r/${TOKEN}`);
  });

  it('refuses a template without the placeholder or not https', () => {
    expect(() => receiptLinkOf('https://shop.hakorem.test/r/', 'x')).toThrow(/placeholder/);
    expect(() => receiptLinkOf('http://shop.hakorem.test/r/{token}', 'x')).toThrow(/https/);
  });
});
