import { createHmac, timingSafeEqual } from 'node:crypto';

const TOKEN_PREFIX = 'trk_';
const TOKEN_MAC_BYTES = 16;
const UUID_BYTES = 16;

/**
 * The signed tracking link of an online order (trackOrder, A-232): `trk_` and base64url of the order id's 16 bytes and
 * a 128-bit HMAC-SHA256 over them, under a key derived from the lookup key for this purpose only. It is never stored,
 * cannot be guessed or altered, and is not the order id as the console shows it.
 */
export class TrackingTokens {
  private readonly key: Buffer;

  constructor(lookupKey: Buffer) {
    this.key = createHmac('sha256', lookupKey).update('hk-order-tracking-v1').digest();
  }

  sign(orderId: string): string {
    const id = Buffer.from(orderId.replaceAll('-', ''), 'hex');
    return `${TOKEN_PREFIX}${Buffer.concat([id, this.mac(id)]).toString('base64url')}`;
  }

  /** The order a token names, or null for anything that is not a token this key signed. */
  orderOf(token: string): string | null {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const body = token.slice(TOKEN_PREFIX.length);
    const raw = Buffer.from(body, 'base64url');
    if (raw.length !== UUID_BYTES + TOKEN_MAC_BYTES || raw.toString('base64url') !== body) return null;
    const id = raw.subarray(0, UUID_BYTES);
    if (!timingSafeEqual(raw.subarray(UUID_BYTES), this.mac(id))) return null;
    const hex = id.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private mac(id: Buffer): Buffer {
    return createHmac('sha256', this.key).update(id).digest().subarray(0, TOKEN_MAC_BYTES);
  }
}
