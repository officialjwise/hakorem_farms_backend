import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { NotificationChannel, OutgoingMessage } from '../../../platform/notifications/notification-channel';
import { scrubString } from '../../../platform/logging/log-scrubber';
import { formatPhoneCode, PHONE_CODE_TTL_SECONDS } from '../domain/self-service';
import type { SelfServiceStore } from './self-service-store';

const MILLISECONDS_PER_SECOND = 1_000;
const CODE_LIMIT = 1_000_000;

export function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/** A random secret for a URL or a challenge: 256 bits, base64url. */
export function opaqueSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Phone verification codes and the one-time messages that carry codes and reset tokens (FR-IAM-019, FR-IAM-020,
 * A-123). A code is kept only as a keyed hash beside its challenge. Messages go straight to the SMS channel once the
 * transaction has committed, never through the outbox, so no code sits in an outbox payload (ADR-0009); delivery is
 * not awaited, so a request takes the same time whether a message is sent or not. NTF's templates, preferences and
 * delivery receipts arrive in B11.
 */
export class PhoneCodes {
  private readonly nextId: () => string;
  private readonly codeKey: Buffer;

  constructor(
    private readonly store: SelfServiceStore,
    private readonly sms: NotificationChannel,
    private readonly clock: Clock,
    private readonly logger: Logger,
    lookupKey: Buffer,
  ) {
    this.nextId = createUuidV7Generator(clock);
    this.codeKey = createHmac('sha256', lookupKey).update('hk-phone-code-v1').digest();
  }

  /**
   * A new phone challenge for the principal, spending any open one. With `sendCode: false` (a registration for a phone
   * that already has an account) the challenge holds no code at all, so no guess can ever pass it.
   */
  async issue(tx: Transaction, principalId: string, phone: string, deviceLabel: string | null, sendCode: boolean): Promise<{ challengeToken: string; message: OutgoingMessage }> {
    const now = this.clock.now();
    await this.store.consumeOpenTokens(tx, principalId, 'PHONE_VERIFY', now);
    const id = this.nextId();
    const challengeToken = `hk1.ch.${opaqueSecret()}`;
    const code = formatPhoneCode(randomInt(0, CODE_LIMIT));
    await this.store.createToken(tx, {
      id,
      principalId,
      purpose: 'PHONE_VERIFY',
      tokenHash: sha256(challengeToken),
      codeHash: sendCode ? this.codeHash(id, code) : null,
      deviceLabel,
      expiresAt: new Date(now.getTime() + PHONE_CODE_TTL_SECONDS * MILLISECONDS_PER_SECOND),
      consumedAt: null,
    });
    const text = sendCode
      ? `HaKorem Farms: your verification code is ${code}. It expires in 10 minutes. Never share it.`
      : 'HaKorem Farms: someone tried to register this number, which already has an account. Sign in, or reset your password if you forgot it.';
    return { challengeToken, message: { to: phone, text, idempotencyKey: `iam.verification_token:${id}` } };
  }

  /** Whether the code is the challenge's, in constant time. A challenge with no code never matches. */
  matches(tokenId: string, codeHash: Buffer | null, code: string): boolean {
    return codeHash !== null && timingSafeEqual(codeHash, this.codeHash(tokenId, code));
  }

  /** Sends after commit without waiting; a failure is logged with the phone masked, and the client can ask again. */
  deliver(message: OutgoingMessage): void {
    this.sms.send(message).then(
      () => undefined,
      (error: unknown) => this.logger.error({ to: scrubString(message.to), reference: message.idempotencyKey, err: error }, 'one-time message not sent'),
    );
  }

  private codeHash(tokenId: string, code: string): Buffer {
    return createHmac('sha256', this.codeKey).update(`${tokenId}|${code}`).digest();
  }
}
