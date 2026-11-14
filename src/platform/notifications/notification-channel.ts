import type { Logger } from 'pino';
import { scrubString } from '../logging/log-scrubber';

/**
 * The notification channel port (ADR-0009): sends one message on one channel. No templates, preferences, opt-out or
 * quiet hours here; those are NTF's (B11). Modules never call it directly: they publish events and NTF sends from the
 * outbox, except IAM's one-time codes, which must not sit in an outbox payload.
 */
export interface OutgoingMessage {
  readonly to: string;
  readonly text: string;
  /** Derived from the outbox message id or the token id, so a retried send cannot deliver twice (ADR-0014). */
  readonly idempotencyKey: string;
}

export interface NotificationChannel {
  readonly channel: 'SMS' | 'WHATSAPP' | 'EMAIL';
  send(message: OutgoingMessage): Promise<{ readonly providerReference: string }>;
}

export const SMS_CHANNEL = Symbol('SMS_CHANNEL');

export class NotificationSendError extends Error {
  readonly code = 'NOTIFICATION_SEND_FAILED';

  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'NotificationSendError';
  }
}

export interface GenericHttpSmsSettings {
  /** MESSAGING_MODE: `live` and `sandbox` send to SMS_BASE_URL; `capture` sends nothing and logs a masked line. */
  readonly mode: 'live' | 'sandbox' | 'capture';
  readonly baseUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly senderId: string;
  readonly timeoutMs: number;
}

const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * The one SMS adapter, `generic-http` (docs/OPERATIONS.md section 3.6): `POST {SMS_BASE_URL}/messages` with a bearer
 * key and `{ to, from, text, reference }`, the reference being the idempotency key, which the provider must treat as
 * unique. A 4xx is permanent; a 5xx, a timeout or a network failure is retryable by the outbox.
 */
export class GenericHttpSms implements NotificationChannel {
  readonly channel = 'SMS' as const;

  constructor(
    private readonly settings: GenericHttpSmsSettings,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: OutgoingMessage): Promise<{ providerReference: string }> {
    if (!E164.test(message.to)) {
      throw new NotificationSendError('the recipient is not an E.164 phone number', false);
    }
    if (this.settings.mode === 'capture') {
      this.logger.info({ to: scrubString(message.to), reference: message.idempotencyKey, characters: message.text.length }, 'sms captured, not sent');
      return { providerReference: `captured:${message.idempotencyKey}` };
    }
    if (this.settings.baseUrl === undefined || this.settings.apiKey === undefined) {
      throw new NotificationSendError('SMS_BASE_URL and SMS_API_KEY are needed to send', false);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.settings.baseUrl}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.settings.apiKey}`, 'Idempotency-Key': message.idempotencyKey },
        body: JSON.stringify({ to: message.to, from: this.settings.senderId, text: message.text, reference: message.idempotencyKey }),
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
    } catch (error) {
      throw new NotificationSendError('the SMS provider could not be reached', true, { cause: error });
    }
    if (!response.ok) {
      throw new NotificationSendError(`the SMS provider answered ${response.status}`, response.status >= 500 || response.status === 429);
    }
    const body = (await response.json().catch(() => ({}))) as { id?: unknown };
    return { providerReference: typeof body.id === 'string' ? body.id : message.idempotencyKey };
  }
}
