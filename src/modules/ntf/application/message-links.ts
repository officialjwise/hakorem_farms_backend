import type { Transaction } from '../../../platform/database/unit-of-work';
import { linkUrl, type LinkKind } from '../domain/links';

/**
 * Makes a fresh token for a record, in the sending worker's own transaction, through the module that owns the record
 * (ADR-0074): ORD's tracking link, POS's receipt link for a message, DOC's document link. Answers the token, which is
 * never stored by NTF, or null when the record has no link to give (a sale with no till link, a cart no longer idle).
 */
export type LinkMinter = (tx: Transaction, recordId: string, actorId: string) => Promise<string | null>;

export type MadeLink = { readonly kind: 'URL'; readonly url: string } | { readonly kind: 'NO_LINK' } | { readonly kind: 'UNAVAILABLE'; readonly reason: string };

/**
 * The links a message carries (B11 continued 12, ADR-0084): each made at send time, once per attempt (a message sent
 * again gets another token), under the shop's https address (`RECEIPT_LINK_BASE_URL`, the address the till's receipt
 * links already open). Without that address, or without a module that makes the kind, the message cannot be sent and
 * fails visibly; a cart's link carries no token (the cart opens by its own sign-in), and SHP's minter answers only
 * whether the cart may still be reminded (a cart converted to an order since gets nothing).
 */
export class MessageLinks {
  constructor(
    private readonly base: string | null,
    private readonly minters: Partial<Readonly<Record<LinkKind, LinkMinter>>>,
  ) {}

  async linkIn(tx: Transaction, kind: LinkKind, recordId: string, actorId: string): Promise<MadeLink> {
    if (this.base === null) return { kind: 'UNAVAILABLE', reason: 'no shop address is configured for message links' };
    const mint = this.minters[kind];
    if (mint === undefined) return { kind: 'UNAVAILABLE', reason: `no module makes ${kind} links` };
    const token = await mint(tx, recordId, actorId);
    if (token === null) return { kind: 'NO_LINK' };
    // A cart's link carries no token: SHP answers only whether the cart may still be reminded.
    return { kind: 'URL', url: linkUrl(kind, this.base, kind === 'CART' ? null : token) };
  }
}
