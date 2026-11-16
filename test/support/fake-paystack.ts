import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for Paystack's documented API (A-210): the sandbox needs a test secret key this repository never
 * holds, so the integration tests run the real adapter against this instead, and never reach a live endpoint. It
 * implements the calls the adapter makes, `POST /charge`, `GET /transaction/verify/:reference`, `GET /transaction`,
 * `POST /refund` and `GET /refund/:id`, with Paystack's envelope `{ status, message, data }`, and signs webhooks the
 * way Paystack does (`X-Paystack-Signature`: HMAC-SHA512 of the raw body with the secret key).
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
  transaction: string;
  amount: number;
  status: 'pending' | 'processed' | 'failed';
}

export interface FakePaystack {
  readonly url: string;
  readonly secretKey: string;
  readonly transactions: Map<string, FakeTransaction>;
  readonly refunds: Map<number, FakeRefund>;
  /** Every request received: method and path. */
  readonly calls: Array<{ method: string; path: string; idempotencyKey: string | undefined }>;
  /** What the next charges do: answer at once, or charge the customer and answer only after `delayMs`. */
  chargeBehaviour: { delayMs: number; beforeAnswer?: (t: FakeTransaction) => Promise<void> };
  /** What the next refund requests do. */
  refundBehaviour: 'pending' | 'processed' | 'reject' | 'down';
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
  const refundKeys = new Map<string, number>();
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
        if (transactions.has(reference)) return send(res, 400, { status: false, message: 'Duplicate Transaction Reference' });
        const t: FakeTransaction = { id: (nextId += 1), reference, amount: Number(body['amount']), currency: String(body['currency']), status: 'ongoing', createdAt: now(), paidAt: null };
        transactions.set(reference, t);
        await fake.chargeBehaviour.beforeAnswer?.(t);
        if (fake.chargeBehaviour.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, fake.chargeBehaviour.delayMs));
        return send(res, 200, { status: true, message: 'Charge attempted', data: { reference, status: 'pay_offline', display_text: 'Please complete authorization process on your mobile phone' } });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/transaction/verify/')) {
        const t = transactions.get(decodeURIComponent(url.pathname.slice('/transaction/verify/'.length)));
        if (t === undefined) return send(res, 400, { status: false, message: 'Transaction reference not found' });
        return send(res, 200, { status: true, message: 'Verification successful', data: asJson(t) });
      }
      if (req.method === 'GET' && url.pathname === '/transaction') {
        const from = new Date(url.searchParams.get('from')!);
        const to = new Date(url.searchParams.get('to')!);
        const page = Number(url.searchParams.get('page') ?? '1');
        const perPage = Number(url.searchParams.get('perPage') ?? '50');
        const all = [...transactions.values()].filter((t) => t.createdAt >= from && t.createdAt < to).sort((a, b) => a.id - b.id);
        return send(res, 200, { status: true, message: 'Transactions retrieved', data: all.slice((page - 1) * perPage, page * perPage).map(asJson), meta: { total: all.length, page, perPage, pageCount: Math.max(1, Math.ceil(all.length / perPage)) } });
      }
      if (req.method === 'POST' && url.pathname === '/refund') {
        const key = req.headers['idempotency-key'] as string | undefined;
        if (fake.refundBehaviour === 'down') return send(res, 500, { status: false, message: 'Internal error' });
        if (fake.refundBehaviour === 'reject') return send(res, 400, { status: false, message: 'Transaction has been fully reversed' });
        const existing = key === undefined ? undefined : refundKeys.get(key);
        if (existing !== undefined) return send(res, 200, { status: true, message: 'Refund has been queued for processing', data: refunds.get(existing) });
        const refund: FakeRefund = { id: (nextId += 1), transaction: String(body['transaction']), amount: Number(body['amount']), status: fake.refundBehaviour === 'processed' ? 'processed' : 'pending' };
        refunds.set(refund.id, refund);
        if (key !== undefined) refundKeys.set(key, refund.id);
        return send(res, 200, { status: true, message: 'Refund has been queued for processing', data: refund });
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
  return { PAYSTACK_BASE_URL: fake.url, PAYSTACK_SECRET_KEY: fake.secretKey, PAYSTACK_TIMEOUT_MS: String(timeoutMs), PAYSTACK_PAYER_EMAIL: 'payments@farm.example' };
}
