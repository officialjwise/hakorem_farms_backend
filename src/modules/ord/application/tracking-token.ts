import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import { issueLinkToken, linkTokenHash, sameLinkTokenHash } from '../../../platform/crypto/link-tokens';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { OrderStore } from './order-store';

const TOKEN_PREFIX = 'trk_';
/** How long a tracking link reads its order, from when it was made (A-256); the database holds the same cap. */
export const TRACKING_LINK_DAYS = 30;
const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * The tracking link of an online order (trackOrder, ADR-0074, superseding ADR-0070's signed token): `trk_` and 256
 * random bits from the secure source, made when the order is placed (and again for each replay of the placement, whose
 * stored answer keeps no token), never derived from the order id. Only its SHA-256 is stored, in
 * `ord.order_tracking_token`; a link is looked up by that hash and reads its order for thirty days.
 */
export class TrackingTokens {
  private readonly nextId: () => string;

  constructor(
    private readonly store: OrderStore,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** A new token for the order, stored as its hash; the text is answered once and kept nowhere. */
  async issueIn(tx: Transaction, orderId: string, actorId: string): Promise<string> {
    const issued = issueLinkToken(TOKEN_PREFIX);
    const at = this.clock.now();
    await this.store.insertTrackingToken(tx, { id: this.nextId(), salesOrderId: orderId, tokenHash: issued.hash, recordedAt: at, expiresAt: new Date(at.getTime() + TRACKING_LINK_DAYS * MILLISECONDS_PER_DAY), actorId });
    return issued.token;
  }

  /** The order a live token opens, or null for anything else: not of the form, unknown, or expired. */
  async orderOfIn(tx: Transaction, token: string): Promise<string | null> {
    const hash = linkTokenHash(TOKEN_PREFIX, token);
    if (hash === null) return null;
    const found = await this.store.trackingToken(tx, hash, this.clock.now());
    return found !== null && sameLinkTokenHash(found.tokenHash, hash) ? found.salesOrderId : null;
  }
}
