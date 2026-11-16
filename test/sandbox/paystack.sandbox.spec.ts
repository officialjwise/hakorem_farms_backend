import { appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PaymentProviderError, PaystackPaymentProvider } from '../../src/platform/payments/payment-provider';

/**
 * The real Paystack sandbox run (A-064, owner 2026-11-16): the adapter against Paystack's test mode, never in CI.
 * The vitest project `sandbox` exists only with PAYSTACK_SANDBOX=1 (`pnpm test:sandbox`), so no other command
 * includes, or skips, this file. The TEST secret key is never in this repository or this process: the session's
 * network proxy puts it on every request to api.paystack.co, and the adapter sends a placeholder it replaces.
 * The first test refuses to go on unless Paystack answers from its test domain, so a live key moves no money.
 * Raw answers, with anything key-like removed, go to PAYSTACK_SANDBOX_LOG (outside the repository) for the report.
 */
const BASE_URL = 'https://api.paystack.co';
const PLACEHOLDER = process.env['PAYSTACK_SECRET_KEY'] ?? 'proxy-injected';
const LOG = process.env['PAYSTACK_SANDBOX_LOG'] ?? join(tmpdir(), 'paystack-sandbox.log');
const EMAIL = process.env['PAYSTACK_SANDBOX_EMAIL'] ?? 'payments@example.com';
/** Paystack's documented Ghana test number for MTN mobile money. */
const MTN_TEST_PHONE = process.env['PAYSTACK_SANDBOX_PHONE'] ?? '0551234987';
const RUN = `hk-sbx-${Date.now().toString(36)}`;
const STARTED = new Date(Date.now() - 60_000);
const POLL_MS = 3_000;
const SETTLE_TIMEOUT_MS = 90_000;

const provider = new PaystackPaymentProvider({ baseUrl: BASE_URL, secretKey: PLACEHOLDER, timeoutMs: 20_000 });

function redact(text: string): string {
  return text.replace(/\b(sk|pk)_(test|live)_[A-Za-z0-9]+/g, '[key removed]').replace(/"(authorization_code|signature|access_code)":"[^"]*"/g, '"$1":"[removed]"');
}

function record(label: string, value: unknown): void {
  appendFileSync(LOG, `\n### ${label}\n${redact(typeof value === 'string' ? value : JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2))}\n`);
}

/** One raw call, recorded, for the fields the adapter does not read. */
async function raw(method: 'GET' | 'POST', path: string, body?: object, idempotencyKey?: string): Promise<{ http: number; json: Record<string, unknown> }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${PLACEHOLDER}`, 'Content-Type': 'application/json', ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await response.json()) as Record<string, unknown>;
  record(`${method} ${path} -> HTTP ${response.status}`, json);
  return { http: response.status, json };
}

async function refusal(work: Promise<unknown>): Promise<PaymentProviderError> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PaymentProviderError);
  const failed = error as PaymentProviderError;
  record('refusal', { message: failed.message, retryable: failed.retryable, kind: failed.kind, providerMessage: failed.providerMessage });
  return failed;
}

/** An adapter call whose refusal is recorded with the provider's own message before it is thrown on. */
async function adapter<T>(label: string, work: Promise<T>): Promise<T> {
  try {
    const answer = await work;
    record(label, answer);
    return answer;
  } catch (error) {
    if (error instanceof PaymentProviderError) record(`${label} refused`, { message: error.message, retryable: error.retryable, kind: error.kind, providerMessage: error.providerMessage });
    throw error;
  }
}

async function settled(reference: string): Promise<Awaited<ReturnType<PaystackPaymentProvider['lookup']>>> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const found = await provider.lookup(reference);
    if (found.status !== 'PENDING' || Date.now() > deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

describe('Paystack test mode, through the real adapter (A-064)', () => {
  const unpaid = `${RUN}-init`;
  const momo = `${RUN}-momo`;
  const timedOut = `${RUN}-timeout`;
  let testDomain = false;

  beforeAll(() => {
    writeFileSync(LOG, `Paystack sandbox run ${RUN} at ${new Date().toISOString()}\n`);
  });

  it('initialises a transaction in the test domain, and an unpaid one verifies as abandoned', async () => {
    const started = await adapter('initiate(unpaid)', provider.initiate({ reference: unpaid, amountPesewas: 12_345n, email: EMAIL, channels: ['card', 'mobile_money'] }));
    expect(started.authorizationUrl).toMatch(/^https:\/\/checkout\.paystack\.com\//);
    expect(started.accessCode.length).toBeGreaterThan(0);
    const verified = await raw('GET', `/transaction/verify/${unpaid}`);
    const data = verified.json['data'] as Record<string, unknown>;
    testDomain = data['domain'] === 'test';
    expect(data['domain'], 'refusing to go on: Paystack did not answer from its test domain').toBe('test');
    const found = await provider.lookup(unpaid);
    record('lookup(unpaid)', found);
    expect(found).toMatchObject({ reference: unpaid, amountPesewas: 12_345n, currency: 'GHS', paidAt: null });
    expect(['ABANDONED', 'PENDING']).toContain(found.status);
  });

  it('refuses a payer email on the reserved .example domain, on initialise and on a charge', async () => {
    expect(testDomain).toBe(true);
    const initiated = await refusal(provider.initiate({ reference: `${RUN}-bad-email-i`, amountPesewas: 100n, email: 'payments@farm.example', channels: ['mobile_money'] }));
    expect(initiated.providerMessage).toBe('Invalid Email Address Passed');
    const charged = await refusal(provider.chargeMobileMoney({ reference: `${RUN}-bad-email-c`, amountPesewas: 100n, email: 'payments@farm.example', phone: MTN_TEST_PHONE, network: 'MTN' }));
    expect(charged.retryable).toBe(false);
  });

  it('charges the MTN test number and the charge settles by lookup for exactly its amount', async () => {
    expect(testDomain).toBe(true);
    const charged = await raw('POST', '/charge', { reference: momo, amount: '25000', currency: 'GHS', email: EMAIL, mobile_money: { phone: MTN_TEST_PHONE, provider: 'mtn' } });
    expect(charged.json['status']).toBe(true);
    const found = await settled(momo);
    record('lookup(momo) settled', found);
    expect(found).toMatchObject({ reference: momo, amountPesewas: 25_000n, currency: 'GHS' });
  });

  it('charges the test number in E.164, as the counter sends it, through the adapter', async () => {
    expect(testDomain).toBe(true);
    const reference = `${RUN}-e164`;
    const answered = await adapter('chargeMobileMoney(e164)', provider.chargeMobileMoney({ reference, amountPesewas: 1_000n, email: EMAIL, phone: `+233${MTN_TEST_PHONE.slice(1)}`, network: 'MTN' }));
    await raw('GET', `/transaction/verify/${reference}`);
    const found = await settled(reference);
    record('lookup(e164) settled', { answered, found });
    expect(found.amountPesewas).toBe(1_000n);
  });

  it('answers a retry of a charge already sent, with our reference, as PENDING and never charges twice', async () => {
    expect(testDomain).toBe(true);
    await raw('POST', '/charge', { reference: momo, amount: '25000', currency: 'GHS', email: EMAIL, mobile_money: { phone: MTN_TEST_PHONE, provider: 'mtn' } });
    const again = await provider.chargeMobileMoney({ reference: momo, amountPesewas: 25_000n, email: EMAIL, phone: MTN_TEST_PHONE, network: 'MTN' });
    record('chargeMobileMoney(momo) again', again);
    expect(again.status).toBe('PENDING');
    const listed = await provider.listTransactions({ from: STARTED, to: new Date(Date.now() + 60_000), page: 1, perPage: 100 });
    expect(listed.transactions.filter((t) => t.reference === momo)).toHaveLength(1);
  });

  it('times out a charge the adapter gave up on, and the retry with the same reference charges once', async () => {
    expect(testDomain).toBe(true);
    const impatient = new PaystackPaymentProvider({ baseUrl: BASE_URL, secretKey: PLACEHOLDER, timeoutMs: 1 });
    const failed = await refusal(impatient.chargeMobileMoney({ reference: timedOut, amountPesewas: 15_000n, email: EMAIL, phone: MTN_TEST_PHONE, network: 'MTN' }));
    expect(failed.retryable).toBe(true);
    const retried = await provider.chargeMobileMoney({ reference: timedOut, amountPesewas: 15_000n, email: EMAIL, phone: MTN_TEST_PHONE, network: 'MTN' });
    record('chargeMobileMoney(timedOut) retry', retried);
    const found = await settled(timedOut);
    record('lookup(timedOut) settled', found);
    expect(found.amountPesewas).toBe(15_000n);
  });

  it('answers a reference it never saw as NOT_FOUND', async () => {
    expect(testDomain).toBe(true);
    const failed = await refusal(provider.lookup(`${RUN}-never-sent`));
    expect(failed.kind).toBe('NOT_FOUND');
  });

  it('lists the window the sweep reads, a page at a time, with every reference of this run once', async () => {
    expect(testDomain).toBe(true);
    const window = { from: STARTED, to: new Date(Date.now() + 60_000) };
    await raw('GET', `/transaction?from=${window.from.toISOString()}&to=${window.to.toISOString()}&page=1&perPage=2`);
    const references: string[] = [];
    for (let page = 1; ; page += 1) {
      const listed = await provider.listTransactions({ ...window, page, perPage: 2 });
      references.push(...listed.transactions.map((t) => t.reference));
      if (!listed.hasMore) break;
    }
    record('listTransactions references', references);
    for (const reference of [unpaid, momo, timedOut]) expect(references.filter((r) => r === reference)).toHaveLength(1);
  });

  it('makes two refunds when the same Idempotency-Key is sent twice raw: Paystack ignores the header (A-217)', async () => {
    expect(testDomain).toBe(true);
    const key = `${RUN}-raw-key`;
    const body = { transaction: timedOut, amount: '1000', merchant_note: `raw ${key}` };
    const first = await raw('POST', '/refund', body, key);
    const second = await raw('POST', '/refund', body, key);
    const ids = [first, second].map((answer) => (answer.json['data'] as { id: number }).id);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('refunds part of the settled charge once per idempotency key through the adapter, which finds the refund by its note', async () => {
    expect(testDomain).toBe(true);
    const key = `${RUN}-refund-1`;
    const first = await adapter('refund first', provider.refund({ reference: momo, amountPesewas: 5_000n, idempotencyKey: key }));
    const second = await adapter('refund same key', provider.refund({ reference: momo, amountPesewas: 5_000n, idempotencyKey: key }));
    expect(second.refundId).toBe(first.refundId);
    const status = await adapter('refundStatus', provider.refundStatus(first.refundId));
    expect(first.refundId).toMatch(/^\d+$/);
    expect(['PENDING', 'PROCESSED']).toContain(status.status);
    await raw('GET', `/refund/${first.refundId}`);
    await raw('GET', `/refund?transaction=${encodeURIComponent(momo)}`);
    const transactionId = (await provider.lookup(momo)).providerTransactionId;
    const listed = await raw('GET', `/refund?transaction=${transactionId}&perPage=10`);
    const notes = (listed.json['data'] as Array<{ merchant_note: string }>).map((refund) => refund.merchant_note);
    expect(notes).toEqual([`ref ${key}`]);
  });

  it('refuses a refund of more than is left, and of a transaction that was never paid', async () => {
    expect(testDomain).toBe(true);
    const tooMuch = await refusal(provider.refund({ reference: momo, amountPesewas: 25_000n, idempotencyKey: `${RUN}-refund-too-much` }));
    expect(tooMuch.retryable).toBe(false);
    const unpaidRefund = await refusal(provider.refund({ reference: unpaid, amountPesewas: 100n, idempotencyKey: `${RUN}-refund-unpaid` }));
    expect(unpaidRefund.retryable).toBe(false);
  });

  it('reads the Settlements API: the list, and the transactions inside the first settlement when there is one', async () => {
    expect(testDomain).toBe(true);
    const list = await raw('GET', '/settlement?perPage=5&page=1');
    expect(list.json['status']).toBe(true);
    const settlements = list.json['data'] as Array<Record<string, unknown>>;
    expect(Array.isArray(settlements)).toBe(true);
    record('settlement count', settlements.length);
    await raw('GET', '/settlement/1/transactions?perPage=5');
    const first = settlements[0];
    if (first !== undefined) {
      const inside = await raw('GET', `/settlement/${String(first['id'])}/transactions?perPage=5`);
      expect(inside.json['status']).toBe(true);
    }
  });
});
