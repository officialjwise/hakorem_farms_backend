import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeleteObjectCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { GenericHttpSms, NotificationSendError } from '../../../src/platform/notifications/notification-channel';
import { OtelMetrics } from '../../../src/platform/observability/metrics';
import { PaymentProviderError, PaystackPaymentProvider } from '../../../src/platform/payments/payment-provider';
import { BullmqJobQueue } from '../../../src/platform/queue/job-queue';
import { S3ObjectStorage } from '../../../src/platform/storage/s3-object-storage';

const silent = pino({ level: 'silent' });

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/** A local HTTP server standing in for a provider: it records each request and answers with the next reply. */
async function fakeProvider(replies: Array<{ status: number; body: unknown }>): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const reply = replies.shift() ?? { status: 500, body: {} };
      res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, received, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

describe('the object storage port and its S3 adapter, against Versity Gateway (A-070)', () => {
  const store = inject('objectStore');
  const storage = new S3ObjectStorage({ ...store, region: 'us-east-1', forcePathStyle: true, timeoutMs: 5_000 });
  const bucket = `private-${randomBytes(4).toString('hex')}`;

  afterAll(() => storage.close());

  it('stores and reads an object, and issues a signed URL that works and expires', async () => {
    await storage.ensureBucket(bucket, { objectLock: true });
    await storage.put(bucket, 'proofs/pod-0001.json', Buffer.from('{"signedBy":"Ama Serwaa"}'), { contentType: 'application/json' });
    expect((await storage.get(bucket, 'proofs/pod-0001.json')).toString()).toBe('{"signedBy":"Ama Serwaa"}');
    const url = await storage.signedGetUrl(bucket, 'proofs/pod-0001.json', 60);
    expect(url).toContain('X-Amz-Expires=60');
    expect((await fetch(url)).status).toBe(200);
    const tampered = url.replace(/X-Amz-Signature=[0-9a-f]+/, `X-Amz-Signature=${'0'.repeat(64)}`);
    expect((await fetch(tampered)).status).toBe(403);
  });

  it('refuses to delete an object written with a retention date before that date', async () => {
    await storage.ensureBucket(bucket, { objectLock: true });
    await storage.put(bucket, 'locked/anchor.json', Buffer.from('{}'), { contentType: 'application/json', retainUntil: new Date(Date.now() + 86_400_000) });
    const raw = new S3Client({ endpoint: store.endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: store.accessKeyId, secretAccessKey: store.secretAccessKey } });
    const versions = await raw.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: 'locked/' }));
    const version = versions.Versions?.[0]?.VersionId;
    await expect(raw.send(new DeleteObjectCommand({ Bucket: bucket, Key: 'locked/anchor.json', VersionId: version }))).rejects.toMatchObject({ name: 'AccessDenied' });
    raw.destroy();
  });
});

describe('the queue port and its BullMQ adapter', () => {
  const url = new URL(inject('redisUrl'));
  const queue = new BullmqJobQueue({ host: url.hostname, port: Number(url.port) }, `tq${randomBytes(3).toString('hex')}`, silent);

  afterAll(() => queue.close());

  it('runs an added job once, even when the same job id is added twice', async () => {
    const seen: string[] = [];
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    queue.process('notify-probe', async (payload) => {
      seen.push(String(payload['orderId']));
      done();
    });
    await queue.add('notify-probe', { orderId: 'SO-2026-DDW-000412' }, { jobId: 'outbox-019a7b1d' });
    await queue.add('notify-probe', { orderId: 'SO-2026-DDW-000412' }, { jobId: 'outbox-019a7b1d' });
    await finished;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).toEqual(['SO-2026-DDW-000412']);
  });

  it('runs a scheduled job repeatedly', async () => {
    let runs = 0;
    queue.process('tick-probe', async () => {
      runs += 1;
    });
    await queue.schedule('tick-probe', { everyMs: 150 });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(runs).toBeGreaterThanOrEqual(2);
  });
});

describe('the notification channel port and its generic-http SMS adapter', () => {
  it('posts the message with the sender id, a bearer key and the idempotency key as the reference', async () => {
    const provider = await fakeProvider([{ status: 200, body: { id: 'msg-88231' } }]);
    try {
      const sms = new GenericHttpSms({ mode: 'live', baseUrl: provider.url, apiKey: 'test-key-not-secret', senderId: 'HaKorem', timeoutMs: 2_000 }, silent);
      const key = randomUUID();
      const sent = await sms.send({ to: '+233244512876', text: 'Your receipt R-DDW-000981: GHS 459.00. Thank you.', idempotencyKey: key });
      expect(sent).toEqual({ providerReference: 'msg-88231' });
      const request = provider.received[0]!;
      expect(request).toMatchObject({ method: 'POST', url: '/messages' });
      expect(request.headers['authorization']).toBe('Bearer test-key-not-secret');
      expect(request.headers['idempotency-key']).toBe(key);
      expect(JSON.parse(request.body)).toEqual({ to: '+233244512876', from: 'HaKorem', text: 'Your receipt R-DDW-000981: GHS 459.00. Thank you.', reference: key });
    } finally {
      await provider.close();
    }
  });

  it('treats a 4xx as permanent and a 5xx as retryable, and refuses a number that is not E.164', async () => {
    const provider = await fakeProvider([{ status: 422, body: {} }, { status: 503, body: {} }]);
    try {
      const sms = new GenericHttpSms({ mode: 'live', baseUrl: provider.url, apiKey: 'k', senderId: 'HaKorem', timeoutMs: 2_000 }, silent);
      await expect(sms.send({ to: '+233244512876', text: 'x', idempotencyKey: randomUUID() })).rejects.toMatchObject({ retryable: false });
      await expect(sms.send({ to: '+233244512876', text: 'x', idempotencyKey: randomUUID() })).rejects.toMatchObject({ retryable: true });
      await expect(sms.send({ to: '0244512876', text: 'x', idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(NotificationSendError);
    } finally {
      await provider.close();
    }
  });

  it('sends nothing in capture mode and logs only the last three digits', async () => {
    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(line) });
    const sms = new GenericHttpSms({ mode: 'capture', baseUrl: undefined, apiKey: undefined, senderId: 'HaKorem', timeoutMs: 2_000 }, logger);
    const sent = await sms.send({ to: '+233244512876', text: 'Your code is 481205', idempotencyKey: 'otp-1' });
    expect(sent.providerReference).toBe('captured:otp-1');
    expect(lines.join('')).not.toContain('244512876');
    expect(lines.join('')).not.toContain('481205');
  });
});

describe('the payment provider port and its Paystack adapter (A-047)', () => {
  const secretKey = `sk_test_${randomBytes(12).toString('hex')}`;

  it('initialises a charge in pesewas with our reference and reads the authorization URL', async () => {
    const provider = await fakeProvider([{ status: 200, body: { status: true, data: { authorization_url: 'https://checkout.paystack.com/abc', access_code: 'abc' } } }]);
    try {
      const paystack = new PaystackPaymentProvider({ baseUrl: provider.url, secretKey, timeoutMs: 2_000 });
      const started = await paystack.initiate({ reference: 'PAY-DDW-000231', amountPesewas: 45_900n, email: 'ama.serwaa@example.com', channels: ['mobile_money'] });
      expect(started).toEqual({ authorizationUrl: 'https://checkout.paystack.com/abc', accessCode: 'abc' });
      expect(provider.received[0]!.url).toBe('/transaction/initialize');
      expect(JSON.parse(provider.received[0]!.body)).toMatchObject({ reference: 'PAY-DDW-000231', amount: '45900', currency: 'GHS', channels: ['mobile_money'] });
      expect(provider.received[0]!.headers['authorization']).toBe(`Bearer ${secretKey}`);
    } finally {
      await provider.close();
    }
  });

  it('reads the amount and status from the server-to-server lookup, and refuses an answer for another reference', async () => {
    const provider = await fakeProvider([
      { status: 200, body: { status: true, data: { id: 4_099_260_516, reference: 'PAY-DDW-000231', status: 'success', amount: 45_900, currency: 'GHS', paid_at: '2026-11-14T10:05:00.000Z' } } },
      { status: 200, body: { status: true, data: { id: 1, reference: 'PAY-DDW-999999', status: 'success', amount: 100, currency: 'GHS' } } },
      { status: 502, body: {} },
    ]);
    try {
      const paystack = new PaystackPaymentProvider({ baseUrl: provider.url, secretKey, timeoutMs: 2_000 });
      expect(await paystack.lookup('PAY-DDW-000231')).toEqual({
        reference: 'PAY-DDW-000231',
        status: 'SUCCESS',
        amountPesewas: 45_900n,
        currency: 'GHS',
        paidAt: new Date('2026-11-14T10:05:00.000Z'),
        providerTransactionId: '4099260516',
      });
      await expect(paystack.lookup('PAY-DDW-000231')).rejects.toBeInstanceOf(PaymentProviderError);
      await expect(paystack.lookup('PAY-DDW-000231')).rejects.toMatchObject({ retryable: true });
    } finally {
      await provider.close();
    }
  });

  it('accepts a webhook signed over the raw body with the secret key, and refuses any other', () => {
    const paystack = new PaystackPaymentProvider({ baseUrl: 'http://127.0.0.1:1', secretKey, timeoutMs: 1_000 });
    const raw = Buffer.from('{"event":"charge.success","data":{"reference":"PAY-DDW-000231","amount":45900}}');
    const signature = createHmac('sha512', secretKey).update(raw).digest('hex');
    expect(paystack.webhookSignatureValid(raw, signature)).toBe(true);
    expect(paystack.webhookSignatureValid(Buffer.from(raw.toString().replace('45900', '4590000')), signature)).toBe(false);
    expect(paystack.webhookSignatureValid(raw, undefined)).toBe(false);
    expect(paystack.webhookSignatureValid(raw, 'not-hex')).toBe(false);
  });

  it('sends a refund with the idempotency key, so a retried refund cannot pay twice', async () => {
    const provider = await fakeProvider([{ status: 200, body: { status: true, data: { id: 3_018_284, status: 'pending' } } }]);
    try {
      const paystack = new PaystackPaymentProvider({ baseUrl: provider.url, secretKey, timeoutMs: 2_000 });
      expect(await paystack.refund({ reference: 'PAY-DDW-000231', amountPesewas: 4_000n, idempotencyKey: 'outbox-019a7b2c' })).toEqual({ refundId: '3018284', status: 'pending' });
      expect(provider.received[0]!.headers['idempotency-key']).toBe('outbox-019a7b2c');
      expect(JSON.parse(provider.received[0]!.body)).toMatchObject({ transaction: 'PAY-DDW-000231', amount: '4000' });
    } finally {
      await provider.close();
    }
  });
});

describe('the metrics port and its OpenTelemetry Prometheus adapter', () => {
  let metrics: OtelMetrics;
  const port = 40_000 + Math.floor(Math.random() * 20_000);

  beforeAll(() => {
    metrics = new OtelMetrics({ enabled: true, port, serviceName: 'hakorem-test' });
  });

  afterAll(() => metrics.shutdown());

  it('exposes a counter and a histogram in the Prometheus text format', async () => {
    metrics.counter('hk_outbox_delivered_total', 'Outbox deliveries').add(3, { consumer: 'ntf.receipts' });
    metrics.histogram('hk_request_duration_ms', 'Request duration', 'ms').record(42, { route: '/v1/products' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    expect(text).toMatch(/hk_outbox_delivered_total\{consumer="ntf\.receipts"[^}]*\} 3/);
    expect(text).toContain('hk_request_duration_ms');
  });
});
