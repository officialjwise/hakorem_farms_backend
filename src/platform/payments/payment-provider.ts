import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The payment provider port (ADR-0009): initiate, look up, refund and verify a webhook signature. It records
 * nothing and decides nothing; PAY (B9a) owns payments, allocation, refunds and the webhook order of checks. Amounts
 * are integer pesewas, the provider's smallest unit for GHS.
 */
export interface PaymentInitiation {
  /** Our reference, stored before the charge request is sent (docs/API.md section 13, step 5). */
  readonly reference: string;
  readonly amountPesewas: bigint;
  readonly email: string;
  readonly channels: readonly ('card' | 'mobile_money')[];
  readonly callbackUrl?: string;
}

export interface ProviderTransaction {
  readonly reference: string;
  readonly status: 'SUCCESS' | 'FAILED' | 'ABANDONED' | 'PENDING' | 'REVERSED';
  readonly amountPesewas: bigint;
  readonly currency: string;
  readonly paidAt: Date | null;
  readonly providerTransactionId: string;
}

export interface PaymentProvider {
  readonly name: string;
  initiate(request: PaymentInitiation): Promise<{ readonly authorizationUrl: string; readonly accessCode: string }>;
  /** The server-to-server lookup: the only source of truth for an amount and status (security architecture section 8). */
  lookup(reference: string): Promise<ProviderTransaction>;
  refund(request: { readonly reference: string; readonly amountPesewas: bigint; readonly idempotencyKey: string }): Promise<{ readonly refundId: string; readonly status: string }>;
  /** Signature over the raw body, compared in constant time. */
  webhookSignatureValid(rawBody: Buffer, signatureHeader: string | undefined): boolean;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export class PaymentProviderError extends Error {
  readonly code = 'PAYMENT_PROVIDER_FAILED';

  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PaymentProviderError';
  }
}

export interface PaystackSettings {
  readonly baseUrl: string;
  readonly secretKey: string;
  readonly timeoutMs: number;
}

const STATUS: Readonly<Record<string, ProviderTransaction['status']>> = {
  success: 'SUCCESS',
  failed: 'FAILED',
  abandoned: 'ABANDONED',
  reversed: 'REVERSED',
  ongoing: 'PENDING',
  pending: 'PENDING',
  processing: 'PENDING',
  queued: 'PENDING',
};

interface PaystackEnvelope<T> {
  status?: boolean;
  message?: string;
  data?: T;
}

/**
 * The first payment adapter, Paystack (A-047): `POST /transaction/initialize`, `GET /transaction/verify/{reference}`,
 * `POST /refund`, and the `X-Paystack-Signature` webhook check, an HMAC-SHA512 of the raw body keyed with the secret
 * key (docs/API.md section 13). B9a verifies it against the provider's sandbox (A-064).
 */
export class PaystackPaymentProvider implements PaymentProvider {
  readonly name = 'paystack';

  constructor(
    private readonly settings: PaystackSettings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async initiate(request: PaymentInitiation): Promise<{ authorizationUrl: string; accessCode: string }> {
    const data = await this.call<{ authorization_url?: string; access_code?: string }>('POST', '/transaction/initialize', {
      reference: request.reference,
      amount: request.amountPesewas.toString(),
      currency: 'GHS',
      email: request.email,
      channels: request.channels,
      ...(request.callbackUrl === undefined ? {} : { callback_url: request.callbackUrl }),
    });
    if (typeof data.authorization_url !== 'string' || typeof data.access_code !== 'string') {
      throw new PaymentProviderError('Paystack initialize answered without an authorization URL', false);
    }
    return { authorizationUrl: data.authorization_url, accessCode: data.access_code };
  }

  async lookup(reference: string): Promise<ProviderTransaction> {
    const data = await this.call<{ id?: number; reference?: string; status?: string; amount?: number | string; currency?: string; paid_at?: string | null }>(
      'GET',
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
    const amount = data.amount;
    if (data.reference !== reference || (typeof amount !== 'number' && typeof amount !== 'string') || !/^\d+$/.test(String(amount))) {
      throw new PaymentProviderError('Paystack verify answered for another reference or without an integer amount', false);
    }
    return {
      reference,
      status: STATUS[data.status ?? ''] ?? 'PENDING',
      amountPesewas: BigInt(String(amount)),
      currency: data.currency ?? '',
      paidAt: data.paid_at === null || data.paid_at === undefined ? null : new Date(data.paid_at),
      providerTransactionId: String(data.id ?? ''),
    };
  }

  async refund(request: { reference: string; amountPesewas: bigint; idempotencyKey: string }): Promise<{ refundId: string; status: string }> {
    const data = await this.call<{ id?: number; status?: string }>(
      'POST',
      '/refund',
      { transaction: request.reference, amount: request.amountPesewas.toString(), merchant_note: `ref ${request.idempotencyKey}` },
      request.idempotencyKey,
    );
    return { refundId: String(data.id ?? ''), status: data.status ?? 'pending' };
  }

  webhookSignatureValid(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    if (signatureHeader === undefined || !/^[0-9a-f]{128}$/i.test(signatureHeader)) {
      return false;
    }
    const expected = createHmac('sha512', this.settings.secretKey).update(rawBody).digest();
    return timingSafeEqual(expected, Buffer.from(signatureHeader, 'hex'));
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: object, idempotencyKey?: string): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.settings.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.settings.secretKey}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
    } catch (error) {
      throw new PaymentProviderError(`Paystack ${method} ${path.split('/')[1]} could not be reached`, true, { cause: error });
    }
    const envelope = (await response.json().catch(() => ({}))) as PaystackEnvelope<T>;
    if (!response.ok || envelope.status !== true || envelope.data === undefined) {
      throw new PaymentProviderError(`Paystack ${method} ${path.split('/')[1]} answered ${response.status}`, response.status >= 500 || response.status === 429);
    }
    return envelope.data;
  }
}
