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

/** A mobile money charge: the customer approves it on their phone (FR-PAY-003). The phone is used for this call only. */
export interface MobileMoneyCharge {
  readonly reference: string;
  readonly amountPesewas: bigint;
  readonly email: string;
  readonly phone: string;
  readonly network: 'MTN' | 'TELECEL' | 'AIRTELTIGO';
}

/** One refund as the provider holds it: `PENDING` until it is processed or fails. */
export interface ProviderRefund {
  readonly refundId: string;
  readonly status: 'PENDING' | 'PROCESSED' | 'FAILED';
}

/** A webhook body read into the fields PAY acts on; the event id is what the provider processes once (A-210). */
export interface ProviderWebhookEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly reference: string;
  readonly amountPesewas: bigint;
  readonly occurredAt: Date | null;
  /** The fields stored as evidence (`pay.webhook_event.payload`): never card or personal detail. */
  readonly evidence: Readonly<Record<string, unknown>>;
  /** A chargeback's id at the provider, for `charge.dispute.create` only (B09c), confirmed by `lookupDispute`. */
  readonly disputeId?: string;
}

/** A chargeback as the provider holds it (B09c, abuse case 45): the payment it disputes and the amount at stake. */
export interface ProviderDispute {
  readonly disputeId: string;
  readonly reference: string;
  readonly amountPesewas: bigint;
  readonly currency: string;
  readonly status: string;
}

/** One page of the provider's own transaction list, for the sweep (the owner, 2026-11-16). */
export interface ProviderTransactionPage {
  readonly transactions: readonly ProviderTransaction[];
  readonly hasMore: boolean;
}

export interface PaymentProvider {
  readonly name: string;
  initiate(request: PaymentInitiation): Promise<{ readonly authorizationUrl: string; readonly accessCode: string }>;
  /** Sends a mobile money charge; a reference sent before (a retry after a timeout) answers PENDING, never a second charge. */
  chargeMobileMoney(request: MobileMoneyCharge): Promise<{ readonly status: ProviderTransaction['status'] }>;
  /** The server-to-server lookup: the only source of truth for an amount and status (security architecture section 8). */
  lookup(reference: string): Promise<ProviderTransaction>;
  /** The provider's transactions created in a window, a page at a time (page 1 first). */
  listTransactions(window: { readonly from: Date; readonly to: Date; readonly page: number; readonly perPage: number }): Promise<ProviderTransactionPage>;
  refund(request: { readonly reference: string; readonly amountPesewas: bigint; readonly idempotencyKey: string }): Promise<{ readonly refundId: string; readonly status: string }>;
  refundStatus(refundId: string): Promise<ProviderRefund>;
  /** The server-to-server lookup of a chargeback a webhook named: its payload is never trusted (B09c). */
  lookupDispute(disputeId: string): Promise<ProviderDispute>;
  /** Signature over the raw body, compared in constant time. */
  webhookSignatureValid(rawBody: Buffer, signatureHeader: string | undefined): boolean;
  /** The body of a validly signed webhook read into the fields PAY acts on, or null if it has none of them. */
  readWebhook(body: unknown): ProviderWebhookEvent | null;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/**
 * A provider call that failed. `retryable` when the provider may answer if asked again (unreachable, timed out, 5xx,
 * 429); `kind` names the two answers PAY acts on: the provider has no such record (`NOT_FOUND`), or it is not
 * configured or the circuit is open (`UNAVAILABLE`).
 */
export class PaymentProviderError extends Error {
  readonly code = 'PAYMENT_PROVIDER_FAILED';

  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions & { readonly kind?: 'NOT_FOUND' | 'UNAVAILABLE' | 'REFUSED' },
  ) {
    super(message, options);
    this.name = 'PaymentProviderError';
    this.kind = options?.kind ?? (retryable ? 'UNAVAILABLE' : 'REFUSED');
  }

  readonly kind: 'NOT_FOUND' | 'UNAVAILABLE' | 'REFUSED';
  /** The provider's own message, kept to tell a duplicate reference from other refusals; never logged. */
  providerMessage: string | null = null;
}

export interface PaystackSettings {
  readonly baseUrl: string;
  readonly secretKey: string;
  readonly timeoutMs: number;
}

/** Paystack's mobile money provider codes for Ghana's networks (Paystack's charge API, A-210). */
const NETWORK_CODES: Readonly<Record<MobileMoneyCharge['network'], string>> = { MTN: 'mtn', TELECEL: 'vod', AIRTELTIGO: 'atl' };

const REFUND_STATUS: Readonly<Record<string, ProviderRefund['status']>> = {
  pending: 'PENDING',
  processing: 'PENDING',
  'needs-attention': 'PENDING',
  processed: 'PROCESSED',
  failed: 'FAILED',
};

/** The refunds of one transaction read before a refund is sent: a transaction never has this many. */
const REFUND_LIST_PAGE_SIZE = 100;
const REFUND_LIST_MAX_PAGES = 5;

/** The note a refund carries at Paystack: our idempotency key, read back to tell a refund already made (A-218). */
export function refundNoteOf(idempotencyKey: string): string {
  return `ref ${idempotencyKey}`;
}

interface PaystackTransaction {
  id?: number;
  reference?: string;
  status?: string;
  amount?: number | string;
  currency?: string;
  paid_at?: string | null;
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

  async chargeMobileMoney(request: MobileMoneyCharge): Promise<{ status: ProviderTransaction['status'] }> {
    try {
      const data = await this.call<{ status?: string }>('POST', '/charge', {
        reference: request.reference,
        amount: request.amountPesewas.toString(),
        currency: 'GHS',
        email: request.email,
        mobile_money: { phone: request.phone, provider: NETWORK_CODES[request.network] },
      });
      return { status: data.status === 'success' ? 'SUCCESS' : data.status === 'failed' ? 'FAILED' : 'PENDING' };
    } catch (error) {
      // A reference Paystack has seen is a charge already sent (a retry after a timeout): its outcome is the lookup's.
      if (error instanceof PaymentProviderError && /duplicate/i.test(error.providerMessage ?? '')) return { status: 'PENDING' };
      throw error;
    }
  }

  async lookup(reference: string): Promise<ProviderTransaction> {
    const data = await this.call<PaystackTransaction>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    if (data.reference !== reference) {
      throw new PaymentProviderError('Paystack verify answered for another reference', false);
    }
    return transactionOf(data);
  }

  async listTransactions(window: { from: Date; to: Date; page: number; perPage: number }): Promise<ProviderTransactionPage> {
    const query = new URLSearchParams({ from: window.from.toISOString(), to: window.to.toISOString(), page: String(window.page), perPage: String(window.perPage) });
    const { data, meta } = await this.callWithMeta<PaystackTransaction[]>('GET', `/transaction?${query.toString()}`);
    if (!Array.isArray(data)) throw new PaymentProviderError('Paystack list answered without a list', false);
    const pageCount = Number(meta?.pageCount ?? 1);
    return { transactions: data.map(transactionOf), hasMore: window.page < pageCount };
  }

  async refundStatus(refundId: string): Promise<ProviderRefund> {
    const data = await this.call<{ id?: number; status?: string }>('GET', `/refund/${encodeURIComponent(refundId)}`);
    return { refundId: String(data.id ?? refundId), status: REFUND_STATUS[data.status ?? ''] ?? 'PENDING' };
  }

  async lookupDispute(disputeId: string): Promise<ProviderDispute> {
    const data = await this.call<PaystackDispute>('GET', `/dispute/${encodeURIComponent(disputeId)}`);
    const dispute = disputeOf(data);
    if (dispute === null || dispute.disputeId !== disputeId) throw new PaymentProviderError('Paystack answered a dispute without its transaction or amount', false);
    return dispute;
  }

  readWebhook(body: unknown): ProviderWebhookEvent | null {
    const dispute = readDisputeWebhook(body);
    if (dispute !== undefined) return dispute;
    const event = body as { event?: unknown; data?: PaystackTransaction & { created_at?: string; channel?: string } } | null;
    const data = event?.data;
    if (typeof event?.event !== 'string' || typeof data?.reference !== 'string' || !isInteger(data.amount)) return null;
    const time = data.paid_at ?? data.created_at ?? null;
    return {
      eventId: `${event.event}:${data.reference}`,
      eventType: event.event,
      reference: data.reference,
      amountPesewas: BigInt(String(data.amount)),
      occurredAt: time === null ? null : new Date(time),
      evidence: {
        event: event.event,
        data: { id: data.id ?? null, reference: data.reference, amount: Number(data.amount), currency: data.currency ?? null, status: data.status ?? null, channel: data.channel ?? null, paid_at: data.paid_at ?? null },
      },
    };
  }

  /**
   * Paystack ignores an `Idempotency-Key` on `POST /refund` (the sandbox run, A-218): the same key twice makes two
   * refunds. So the key travels in the refund's `merchant_note`, and before sending, the transaction's refunds are
   * read back (`GET /refund?transaction=<id>`); one carrying the note is the refund already made, whose answer was lost.
   */
  async refund(request: { reference: string; amountPesewas: bigint; idempotencyKey: string }): Promise<{ refundId: string; status: string }> {
    const note = refundNoteOf(request.idempotencyKey);
    const made = await this.refundCarrying(request.reference, note);
    if (made !== null) return made;
    const data = await this.call<{ id?: number; status?: string }>(
      'POST',
      '/refund',
      { transaction: request.reference, amount: request.amountPesewas.toString(), merchant_note: note },
      request.idempotencyKey,
    );
    return { refundId: String(data.id ?? ''), status: data.status ?? 'pending' };
  }

  /** The refund of a transaction that carries `note`, or null; read a page at a time, never more than a bounded few. */
  private async refundCarrying(reference: string, note: string): Promise<{ refundId: string; status: string } | null> {
    const transaction = await this.call<PaystackTransaction>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    if (transaction.reference !== reference || !isInteger(transaction.id)) {
      throw new PaymentProviderError('Paystack verify answered without the transaction to refund', false);
    }
    for (let page = 1; page <= REFUND_LIST_MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ transaction: String(transaction.id), page: String(page), perPage: String(REFUND_LIST_PAGE_SIZE) });
      const { data, meta } = await this.callWithMeta<Array<{ id?: number; status?: string; merchant_note?: string | null }>>('GET', `/refund?${query.toString()}`);
      if (!Array.isArray(data)) throw new PaymentProviderError('Paystack refund list answered without a list', false);
      const found = data.find((refund) => refund.merchant_note === note);
      if (found !== undefined) return { refundId: String(found.id ?? ''), status: found.status ?? 'pending' };
      if (page >= Number(meta?.pageCount ?? 0)) return null;
    }
    throw new PaymentProviderError('Paystack lists more refunds of one transaction than are read before a refund', false);
  }

  webhookSignatureValid(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    if (signatureHeader === undefined || !/^[0-9a-f]{128}$/i.test(signatureHeader)) {
      return false;
    }
    const expected = createHmac('sha512', this.settings.secretKey).update(rawBody).digest();
    return timingSafeEqual(expected, Buffer.from(signatureHeader, 'hex'));
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: object, idempotencyKey?: string): Promise<T> {
    return (await this.callWithMeta<T>(method, path, body, idempotencyKey)).data;
  }

  private async callWithMeta<T>(method: 'GET' | 'POST', path: string, body?: object, idempotencyKey?: string): Promise<{ data: T; meta: { pageCount?: number } | undefined }> {
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
    const envelope = (await response.json().catch(() => ({}))) as PaystackEnvelope<T> & { meta?: { pageCount?: number } };
    if (!response.ok || envelope.status !== true || envelope.data === undefined) {
      const notFound = response.status === 404 || (response.status === 400 && /not found/i.test(envelope.message ?? ''));
      const error = new PaymentProviderError(`Paystack ${method} ${path.split(/[/?]/)[1]} answered ${response.status}`, response.status >= 500 || response.status === 429, notFound ? { kind: 'NOT_FOUND' } : undefined);
      error.providerMessage = typeof envelope.message === 'string' ? envelope.message.slice(0, 200) : null;
      throw error;
    }
    return { data: envelope.data, meta: envelope.meta };
  }
}

interface PaystackDispute {
  id?: number | string;
  refund_amount?: number | string | null;
  currency?: string;
  status?: string;
  created_at?: string;
  createdAt?: string;
  transaction?: { id?: number; reference?: string; amount?: number | string; currency?: string } | null;
}

/** A dispute as Paystack answers it, read into the fields PAY acts on: never the card's bin, last four or the customer. */
function disputeOf(data: PaystackDispute | undefined): ProviderDispute | null {
  const reference = data?.transaction?.reference;
  const amount = isInteger(data?.refund_amount) ? data.refund_amount : data?.transaction?.amount;
  if (data === undefined || !isInteger(data.id) || typeof reference !== 'string' || !isInteger(amount)) return null;
  return { disputeId: String(data.id), reference, amountPesewas: BigInt(String(amount)), currency: data.currency ?? data.transaction?.currency ?? '', status: data.status ?? '' };
}

/** `charge.dispute.create` read into a webhook event (B09c), or undefined for any other event; null when unreadable. */
function readDisputeWebhook(body: unknown): ProviderWebhookEvent | null | undefined {
  const event = body as { event?: unknown; data?: PaystackDispute } | null;
  if (event?.event !== 'charge.dispute.create') return undefined;
  const dispute = disputeOf(event.data);
  if (dispute === null) return null;
  const time = event.data?.createdAt ?? event.data?.created_at ?? null;
  return {
    eventId: `${event.event}:${dispute.disputeId}`,
    eventType: event.event,
    reference: dispute.reference,
    amountPesewas: dispute.amountPesewas,
    occurredAt: time === null ? null : new Date(time),
    disputeId: dispute.disputeId,
    evidence: { event: event.event, data: { id: dispute.disputeId, reference: dispute.reference, amount: Number(dispute.amountPesewas), currency: dispute.currency || null, status: dispute.status || null } },
  };
}

function isInteger(value: unknown): value is number | string {
  return (typeof value === 'number' || typeof value === 'string') && /^\d+$/.test(String(value));
}

function transactionOf(data: PaystackTransaction): ProviderTransaction {
  if (typeof data.reference !== 'string' || !isInteger(data.amount)) {
    throw new PaymentProviderError('Paystack answered a transaction without a reference or an integer amount', false);
  }
  return {
    reference: data.reference,
    status: STATUS[data.status ?? ''] ?? 'PENDING',
    amountPesewas: BigInt(String(data.amount)),
    currency: data.currency ?? '',
    paidAt: data.paid_at === null || data.paid_at === undefined ? null : new Date(data.paid_at),
    providerTransactionId: String(data.id ?? ''),
  };
}
