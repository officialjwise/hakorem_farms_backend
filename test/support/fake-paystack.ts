import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for Paystack's API (A-210): the integration tests run the real adapter against this, and never
 * reach a live endpoint. It implements the calls the adapter makes, `POST /charge`, `GET /transaction/verify/:reference`,
 * `GET /transaction`, `POST /refund`, `GET /refund` and `GET /refund/:id`, with Paystack's envelope `{ status, message,
 * data }`, and signs webhooks the way Paystack documents (`X-Paystack-Signature`: HMAC-SHA512 of the raw body with the
 * secret key). It answers the way Paystack's test mode answered on 2026-11-16 (`test/sandbox/paystack.sandbox.spec.ts`,
 * A-218), where that differs from the documentation:
 * - a payer email on the reserved `.example` domain is refused with 400 `Invalid Email Address Passed`;
 * - a charge to the MTN test number, local or E.164, answers `success` at once, already paid; any other number answers
 *   `pay_offline`, as the documentation describes a live charge waiting for the customer's phone;
 * - a second charge with a reference already used is 400 `Duplicate Transaction Reference`, code `duplicate_reference`;
 * - the transaction list is newest first, and an empty one has `pageCount` 0;
 * - `POST /refund` ignores an `Idempotency-Key` header: the same key twice makes two refunds; `GET /refund?transaction=`
 *   takes the transaction's numeric id and lists its refunds with their `merchant_note`;
 * - a refund beyond what is left of the transaction is 400, and so is a refund of a transaction never paid.
 */
export interface FakeTransaction {
  id: number;
  reference: string;
  amount: number;
  currency: string;
  status: 'ongoing' | 'pending' | 'success' | 'failed' | 'abandoned';
  createdAt: Date;
  paidAt: Date | null;
}

export interface FakeRefund {
  id: number;
  /** The transaction's numeric id, as Paystack answers it. */
  transaction: number;
  transaction_reference: string;
  amount: number;
  merchant_note: string | null;
  status: 'pending' | 'processed' | 'failed';
}

/** Paystack's Ghana test number for MTN mobile money: in test mode a charge to it is paid at once. */
export const PAYSTACK_MTN_TEST_PHONE = '0551234987';

export interface FakePaystack {
  readonly url: string;
  readonly secretKey: string;
  readonly transactions: Map<string, FakeTransaction>;
  readonly refunds: Map<number, FakeRefund>;
  /** Every request received: method and path. */
  readonly calls: Array<{ method: string; path: string; idempotencyKey: string | undefined }>;
  /** What the next charges do: answer at once, or charge the customer and answer only after `delayMs`. */
  chargeBehaviour: { delayMs: number; beforeAnswer?: (t: FakeTransaction) => Promise<void> };
  /**
   * What the next refund requests do. `timeout`: Paystack creates the refund but answers only after `refundDelayMs`,
   * after the adapter has given up.
   */
  refundBehaviour: 'pending' | 'processed' | 'reject' | 'down' | 'timeout';
  refundDelayMs: number;
  /** When false, every call answers 503. */
  available: boolean;
  /** The customer approves the charge on their phone: Paystack records it as paid, for `amount` if given. */
  approve(reference: string, options?: { amount?: number; paidAt?: Date }): FakeTransaction;
  /** A transaction Paystack holds that this system never initiated. */
  addForeign(reference: string, amount: number, at: Date): FakeTransaction;
  /** A webhook body for a transaction and its signature, as Paystack would send them. */
  webhook(t: FakeTransaction, overrides?: { event?: string; amount?: number; paidAt?: string | null }): { body: string; signature: string };
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
}

function asJson(t: FakeTransaction) {
  return { id: t.id, reference: t.reference, amount: t.amount, currency: t.currency, status: t.status, created_at: t.createdAt.toISOString(), paid_at: t.paidAt?.toISOString() ?? null, channel: 'mobile_money' };
}

export async function startFakePaystack(now: () => Date): Promise<FakePaystack> {
  const secretKey = `sk_test_${randomBytes(16).toString('hex')}`;
  const transactions = new Map<string, FakeTransaction>();
  const refunds = new Map<number, FakeRefund>();
  const calls: FakePaystack['calls'] = [];
  let nextId = 4_099_260_000;
  const fake: FakePaystack = {
    url: '',
    secretKey,
    transactions,
    refunds,
    calls,
    chargeBehaviour: { delayMs: 0 },
    refundBehaviour: 'pending',
    refundDelayMs: 1_500,
    available: true,
    approve(reference, options = {}) {
      const t = transactions.get(reference)!;
      t.status = 'success';
      t.amount = options.amount ?? t.amount;
      t.paidAt = options.paidAt ?? now();
      return t;
    },
    addForeign(reference, amount, at) {
      const t: FakeTransaction = { id: (nextId += 1), reference, amount, currency: 'GHS', status: 'success', createdAt: at, paidAt: at };
      transactions.set(reference, t);
      return t;
    },
    webhook(t, overrides = {}) {
      const data = { ...asJson(t), amount: overrides.amount ?? t.amount, paid_at: overrides.paidAt === undefined ? (t.paidAt?.toISOString() ?? null) : overrides.paidAt };
      const body = JSON.stringify({ event: overrides.event ?? 'charge.success', data: { ...data, customer: { email: 'payments@farm.example', phone: '+233244512876' }, authorization: { mobile_money_number: '0244512876' } } });
      return { body, signature: createHmac('sha512', secretKey).update(body).digest('hex') };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      calls.push({ method: req.method ?? '', path: url.pathname, idempotencyKey: req.headers['idempotency-key'] as string | undefined });
      if (req.headers['authorization'] !== `Bearer ${secretKey}`) return send(res, 401, { status: false, message: 'Invalid key' });
      if (!fake.available) return send(res, 503, { status: false, message: 'Service unavailable' });
      const body = req.method === 'POST' ? await readBody(req) : {};
      if (req.method === 'POST' && url.pathname === '/charge') {
        const reference = String(body['reference']);
        if (/\.example$/i.test(String(body['email']))) return send(res, 400, { status: false, message: 'Invalid Email Address Passed' });
        if (transactions.has(reference)) {
          return send(res, 400, { status: false, message: 'Duplicate Transaction Reference', meta: { nextStep: 'Try and create the Transaction or Charge with a new reference' }, type: 'validation_error', code: 'duplicate_reference' });
        }
        // Paystack reads +233 numbers as their local form: the sandbox answered an E.164 test number as 0551234987.
        const phone = String((body['mobile_money'] as { phone?: unknown } | undefined)?.phone ?? '').replace(/^\+233/, '0');
        const t: FakeTransaction = { id: (nextId += 1), reference, amount: Number(body['amount']), currency: String(body['currency']), status: 'ongoing', createdAt: now(), paidAt: null };
        transactions.set(reference, t);
        if (phone === PAYSTACK_MTN_TEST_PHONE) {
          t.status = 'success';
          t.paidAt = now();
        }
        await fake.chargeBehaviour.beforeAnswer?.(t);
        if (fake.chargeBehaviour.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, fake.chargeBehaviour.delayMs));
        if (t.status === 'success' && phone === PAYSTACK_MTN_TEST_PHONE) return send(res, 200, { status: true, message: 'Charge attempted', data: { ...asJson(t), domain: 'test', gateway_response: 'Approved' } });
        return send(res, 200, { status: true, message: 'Charge attempted', data: { reference, status: 'pay_offline', display_text: 'Please complete authorization process on your mobile phone' } });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/transaction/verify/')) {
        const t = transactions.get(decodeURIComponent(url.pathname.slice('/transaction/verify/'.length)));
        if (t === undefined) return send(res, 400, { status: false, message: 'Transaction reference not found.' });
        return send(res, 200, { status: true, message: 'Verification successful', data: asJson(t) });
      }
      if (req.method === 'GET' && url.pathname === '/transaction') {
        const from = new Date(url.searchParams.get('from')!);
        const to = new Date(url.searchParams.get('to')!);
        const page = Number(url.searchParams.get('page') ?? '1');
        const perPage = Number(url.searchParams.get('perPage') ?? '50');
        const all = [...transactions.values()].filter((t) => t.createdAt >= from && t.createdAt < to).sort((a, b) => b.id - a.id);
        return send(res, 200, { status: true, message: 'Transactions retrieved', data: all.slice((page - 1) * perPage, page * perPage).map(asJson), meta: { total: all.length, skipped: 0, perPage, page, pageCount: Math.ceil(all.length / perPage) } });
      }
      if (req.method === 'POST' && url.pathname === '/refund') {
        if (fake.refundBehaviour === 'down') return send(res, 500, { status: false, message: 'Internal error' });
        if (fake.refundBehaviour === 'reject') return send(res, 400, { status: false, message: 'Transaction has been fully reversed' });
        const original = transactions.get(String(body['transaction']));
        if (original === undefined) return send(res, 400, { status: false, message: 'Transaction not found' });
        if (original.status !== 'success') return send(res, 400, { status: false, message: 'This transaction failed' });
        const amount = body['amount'] === undefined ? original.amount : Number(body['amount']);
        const already = [...refunds.values()].filter((r) => r.transaction === original.id && r.status !== 'failed').reduce((sum, r) => sum + r.amount, 0);
        if (already + amount > original.amount) return send(res, 400, { status: false, message: 'Total refund amount cannot exceed original transaction amount' });
        const merchantNote = typeof body['merchant_note'] === 'string' ? body['merchant_note'] : null;
        const refund: FakeRefund = { id: (nextId += 1), transaction: original.id, transaction_reference: original.reference, amount, merchant_note: merchantNote, status: fake.refundBehaviour === 'processed' ? 'processed' : 'pending' };
        refunds.set(refund.id, refund);
        if (fake.refundBehaviour === 'timeout') await new Promise((resolve) => setTimeout(resolve, fake.refundDelayMs));
        return send(res, 200, { status: true, message: 'Refund has been queued for processing', data: refund });
      }
      if (req.method === 'GET' && url.pathname === '/refund') {
        const transaction = Number(url.searchParams.get('transaction'));
        const page = Number(url.searchParams.get('page') ?? '1');
        const perPage = Number(url.searchParams.get('perPage') ?? '50');
        const all = [...refunds.values()].filter((r) => r.transaction === transaction).sort((a, b) => b.id - a.id);
        return send(res, 200, { status: true, message: 'Refunds retrieved', data: all.slice((page - 1) * perPage, page * perPage), meta: { total: all.length, skipped: 0, perPage, page, pageCount: Math.ceil(all.length / perPage) } });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/refund/')) {
        const refund = refunds.get(Number(url.pathname.slice('/refund/'.length)));
        if (refund === undefined) return send(res, 404, { status: false, message: 'Refund not found' });
        return send(res, 200, { status: true, message: 'Refund retrieved', data: refund });
      }
      return send(res, 404, { status: false, message: 'Not found' });
    })().catch((error: unknown) => send(res, 500, { status: false, message: error instanceof Error ? error.message : 'error' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  (fake as { url: string }).url = `http://127.0.0.1:${port}`;
  return fake;
}

/** The test application's settings for the fake: its address, its key, a short timeout so a delayed answer times out. */
export function paystackEnvironment(fake: FakePaystack, timeoutMs = 1_000): Record<string, string> {
  return { PAYSTACK_BASE_URL: fake.url, PAYSTACK_SECRET_KEY: fake.secretKey, PAYSTACK_TIMEOUT_MS: String(timeoutMs), PAYSTACK_PAYER_EMAIL: 'payments@example.com' };
}
