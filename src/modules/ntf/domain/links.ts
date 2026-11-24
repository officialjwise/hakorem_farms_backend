import { TEMPLATE_CODES, type TemplateCode } from './templates';

/**
 * The records a message may link to (B11 continued 12, ADR-0074, ADR-0096): an online order's tracking (ORD), a synced
 * counter sale's receipt (POS), a shopper's cart (SHP, no token: the cart opens by its own cookie or sign-in) and an
 * archived document (DOC). The module that owns the record makes the link's token when the message is sent.
 */
export const LINK_KINDS = ['TRACKING', 'RECEIPT', 'CART', 'DOCUMENT'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/**
 * What the stored text holds where the link goes: the merge field itself, left unfilled when the message is queued, so
 * neither the outbox nor the message row ever holds a link or a token; the sender fills it in just before the provider.
 */
export const LINK_PLACEHOLDER = '{{link}}';

const PATHS: Readonly<Record<LinkKind, string>> = { TRACKING: 'track', RECEIPT: 'r', CART: 'cart', DOCUMENT: 'd' };

/** The kind of record a template's link opens, or null for a message that carries none. */
export function linkKindOf(code: TemplateCode): LinkKind | null {
  const entry = TEMPLATE_CODES[code];
  return 'link' in entry ? entry.link : null;
}

/** The merge data a message is stored with: the link's field kept as its placeholder for a code that carries a link. */
export function linkDataOf(code: TemplateCode, data: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return linkKindOf(code) === null ? data : { ...data, link: LINK_PLACEHOLDER };
}

/** The text sent: every placeholder filled with the link made now. */
export function withLink(body: string, url: string): string {
  return body.split(LINK_PLACEHOLDER).join(url);
}

/** The link under the shop's https address: `/track/<token>`, `/r/<token>`, `/d/<token>`, or `/cart` (no token). */
export function linkUrl(kind: LinkKind, base: string, token: string | null): string {
  const root = base.replace(/\/+$/, '');
  if (kind === 'CART') return `${root}/${PATHS.CART}`;
  if (token === null) throw new RangeError(`a ${kind} link needs its token`);
  return `${root}/${PATHS[kind]}/${token}`;
}
