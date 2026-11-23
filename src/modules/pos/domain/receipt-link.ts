import { createHash } from 'node:crypto';

/**
 * The receipt link (CR-033 points 1 and 2, ADR-0074 and its Amendments, ADR-0083). Pure. The till makes the token
 * offline from its secure source (at least 128 random bits, base64url without padding) and sends it with the sale at
 * sync; the server keeps only its SHA-256 and finds the receipt by it. The token is never an identifier.
 */

/** The till's token as CR-033 writes it: 22 to 86 base64url characters (16 to 64 bytes), so at least 128 bits. */
const TILL_TOKEN = /^[A-Za-z0-9_-]{22,86}$/;
/** A UUID, with or without its hyphens: an identifier is never a key (the owner, 2026-11-17). */
const IDENTIFIER = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
/** What the till replaces in the pack's `receiptLinkTemplate`. */
export const RECEIPT_TOKEN_PLACEHOLDER = '{token}';
/** How long a receipt link reads, from the sale's time (ADR-0074 Amendments): the database checks the same. */
export const RECEIPT_LINK_MONTHS = 12;

/** The hash a receipt is stored and found by, or null for text that is not a till token, which therefore finds nothing. */
export function receiptTokenHash(text: string): Buffer | null {
  if (!TILL_TOKEN.test(text)) return null;
  return createHash('sha256').update(text, 'utf8').digest();
}

export type ReceiptTokenRefusal = 'TOKEN_ALREADY_BOUND' | 'TOKEN_IS_AN_IDENTIFIER';

export type ReceiptTokenVerdict =
  | { readonly kind: 'BIND' }
  /** Already bound to this very sale: nothing more to store. */
  | { readonly kind: 'KEEP' }
  | { readonly kind: 'REFUSE'; readonly reason: ReceiptTokenRefusal; readonly boundTo: string | null };

/**
 * What the server does with a till's token at sync (the owner, 2026-11-17): a fresh one is bound to the sale; one
 * shaped like an identifier, or already bound to another sale, is refused. A refusal never refuses the sale, only its
 * link, and every refusal reaches the exception report's source: a 128-bit token cannot repeat by chance.
 */
export function receiptTokenVerdict(facts: { readonly token: string; readonly saleId: string; readonly boundTo: string | null }): ReceiptTokenVerdict {
  if (IDENTIFIER.test(facts.token)) return { kind: 'REFUSE', reason: 'TOKEN_IS_AN_IDENTIFIER', boundTo: null };
  if (facts.boundTo === null) return { kind: 'BIND' };
  if (facts.boundTo === facts.saleId) return { kind: 'KEEP' };
  return { kind: 'REFUSE', reason: 'TOKEN_ALREADY_BOUND', boundTo: facts.boundTo };
}

/** The link the till shows and prints: the pack's template with the token in place of its placeholder. */
export function receiptLinkOf(template: string, token: string): string {
  if (!template.startsWith('https://')) throw new Error('a receipt link template is an https URL');
  if (!template.includes(RECEIPT_TOKEN_PLACEHOLDER)) throw new Error(`a receipt link template carries the ${RECEIPT_TOKEN_PLACEHOLDER} placeholder`);
  return template.replace(RECEIPT_TOKEN_PLACEHOLDER, token);
}
