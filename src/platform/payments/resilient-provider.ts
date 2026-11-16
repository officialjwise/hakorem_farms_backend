import type { Clock } from '@hakorem/kernel';
import { PaymentProviderError, type PaymentProvider, type ProviderWebhookEvent } from './payment-provider';

/** The circuit breaker's settings: consecutive failures before it opens, and how long it stays open. */
export interface BreakerSettings {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
}

/**
 * A circuit breaker (SHARED_BRIEF, failure handling): after `failureThreshold` failures in a row it opens and every
 * call is refused at once for `cooldownMs`; then one call may try, and a failure opens it again while a success
 * closes it.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly settings: BreakerSettings,
    private readonly clock: Clock,
  ) {}

  allows(): boolean {
    return this.openedAt === null || this.clock.now().getTime() - this.openedAt >= this.settings.cooldownMs;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.openedAt !== null || this.failures >= this.settings.failureThreshold) this.openedAt = this.clock.now().getTime();
  }
}

export interface RetrySettings {
  readonly attempts: number;
  readonly baseMs: number;
  readonly capMs: number;
}

export interface RetryEffects {
  readonly random: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** "Full jitter": a random share of the base doubled per attempt, never more than the cap. */
export function jitteredDelayMs(attempt: number, settings: Omit<RetrySettings, 'attempts'>, random: () => number): number {
  return Math.floor(random() * Math.min(settings.capMs, settings.baseMs * 2 ** (attempt - 1)));
}

/** Runs `work` up to `attempts` times while it fails with a retryable provider error, waiting with jitter between. */
export async function withRetry<T>(work: () => Promise<T>, settings: RetrySettings, effects: RetryEffects): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof PaymentProviderError) || !error.retryable || attempt >= settings.attempts) throw error;
      await effects.sleep(jitteredDelayMs(attempt, settings, effects.random));
    }
  }
}

export const DEFAULT_RETRY: RetrySettings = { attempts: 3, baseMs: 200, capMs: 2_000 };
export const DEFAULT_BREAKER: BreakerSettings = { failureThreshold: 5, cooldownMs: 30_000 };

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The payment provider behind a timeout (the adapter's), a bounded retry with jitter and a circuit breaker. While the
 * breaker is open every call fails at once as `UNAVAILABLE`, so a down provider costs the counter nothing and cash
 * stays available (FR-PAY-003). A retried charge reuses its reference, which the provider refuses as a duplicate; a
 * retried refund reuses its idempotency key, which the adapter finds again on the provider's refund before sending
 * (Paystack ignores the header, A-218), so neither can charge or pay twice. A provider that is not configured is
 * always unavailable.
 */
export class ResilientPaymentProvider implements PaymentProvider {
  readonly name: string;
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly inner: PaymentProvider | null,
    clock: Clock,
    private readonly retry: RetrySettings = DEFAULT_RETRY,
    breaker: BreakerSettings = DEFAULT_BREAKER,
    private readonly effects: RetryEffects = { random: Math.random, sleep: realSleep },
  ) {
    this.name = inner?.name ?? 'unconfigured';
    this.breaker = new CircuitBreaker(breaker, clock);
  }

  /** Whether a call would be attempted now (the counter checks before it creates a pending payment). */
  available(): boolean {
    return this.inner !== null && this.breaker.allows();
  }

  initiate(request: Parameters<PaymentProvider['initiate']>[0]) {
    return this.guarded((p) => p.initiate(request));
  }

  chargeMobileMoney(request: Parameters<PaymentProvider['chargeMobileMoney']>[0]) {
    return this.guarded((p) => p.chargeMobileMoney(request));
  }

  lookup(reference: string) {
    return this.guarded((p) => p.lookup(reference));
  }

  listTransactions(window: Parameters<PaymentProvider['listTransactions']>[0]) {
    return this.guarded((p) => p.listTransactions(window));
  }

  refund(request: Parameters<PaymentProvider['refund']>[0]) {
    return this.guarded((p) => p.refund(request));
  }

  refundStatus(refundId: string) {
    return this.guarded((p) => p.refundStatus(refundId));
  }

  webhookSignatureValid(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    return this.inner !== null && this.inner.webhookSignatureValid(rawBody, signatureHeader);
  }

  readWebhook(body: unknown): ProviderWebhookEvent | null {
    return this.inner === null ? null : this.inner.readWebhook(body);
  }

  private async guarded<T>(call: (provider: PaymentProvider) => Promise<T>): Promise<T> {
    const inner = this.inner;
    if (inner === null) throw new PaymentProviderError('the payment provider is not configured', true, { kind: 'UNAVAILABLE' });
    if (!this.breaker.allows()) throw new PaymentProviderError('the payment provider circuit is open', true, { kind: 'UNAVAILABLE' });
    try {
      const result = await withRetry(() => call(inner), this.retry, this.effects);
      this.breaker.recordSuccess();
      return result;
    } catch (error) {
      if (error instanceof PaymentProviderError && error.kind === 'UNAVAILABLE') this.breaker.recordFailure();
      else this.breaker.recordSuccess();
      throw error;
    }
  }
}
