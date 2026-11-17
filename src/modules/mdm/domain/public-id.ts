/**
 * Public IDs of customers and suppliers (B09q, owner 2026-11-17, ADR-0073): what people see and type in place of the
 * sequential customer and supplier numbers, and of the UUIDs, which are never shown. A type prefix and sixteen
 * characters of Crockford's base32, each five bits from a cryptographically secure source: 80 bits, so one cannot be
 * guessed or counted through. Crockford's alphabet has no I, L, O or U, so nothing reads as a digit.
 */
export const PUBLIC_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PUBLIC_ID_LENGTH = 16;

export type PublicIdKind = 'CUSTOMER' | 'SUPPLIER';
export const PUBLIC_ID_PREFIX: Readonly<Record<PublicIdKind, string>> = { CUSTOMER: 'cus', SUPPLIER: 'sup' };

const BODY = new RegExp(`^[${PUBLIC_ID_ALPHABET}]{${PUBLIC_ID_LENGTH}}$`);
/** Crockford's decoding of the characters people mistype for digits. */
const LOOKALIKE: Readonly<Record<string, string>> = { O: '0', I: '1', L: '1' };

/**
 * A public ID from sixteen random bytes, one character from the low five bits of each: 256 is a multiple of 32, so
 * every character is equally likely. The bytes come from the caller's secure source; this only spells them.
 */
export function publicIdFrom(kind: PublicIdKind, random: Uint8Array): string {
  if (random.length < PUBLIC_ID_LENGTH) throw new RangeError(`a public ID needs ${PUBLIC_ID_LENGTH} random bytes, not ${random.length}`);
  let body = '';
  for (let i = 0; i < PUBLIC_ID_LENGTH; i += 1) body += PUBLIC_ID_ALPHABET[random[i]! & 31];
  return `${PUBLIC_ID_PREFIX[kind]}_${body}`;
}

/**
 * The public ID of that kind a person typed, in its one written form, or null when the text is not one: case, spaces
 * and hyphens do not matter, and O reads as 0, I and L as 1. What a search compares, so `cus_8f3k 2m9q…` finds it.
 */
export function readPublicId(kind: PublicIdKind, text: string): string | null {
  const compact = text.replace(/[\s-]/g, '').toUpperCase();
  const prefix = `${PUBLIC_ID_PREFIX[kind].toUpperCase()}_`;
  if (!compact.startsWith(prefix)) return null;
  const body = [...compact.slice(prefix.length)].map((character) => LOOKALIKE[character] ?? character).join('');
  return BODY.test(body) ? `${PUBLIC_ID_PREFIX[kind]}_${body}` : null;
}
