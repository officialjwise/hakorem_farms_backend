import { randomUUID } from 'node:crypto';
import { systemClock } from '@hakorem/kernel';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { Idempotency, IdempotencyKeyReusedError } from '../../../src/platform/idempotency/idempotency';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const PRINCIPAL = '01900000-0000-7000-8000-000000000001';
let database: TestDatabase;
let uow: UnitOfWork;
const idempotency = new Idempotency(systemClock);

beforeAll(async () => {
  database = await createTestDatabase();
  uow = new UnitOfWork(database.pool('app'), pino({ level: 'silent' }));
  await database.pool('admin').query('CREATE TABLE platform.idempotency_probe (id uuid PRIMARY KEY, key text NOT NULL)');
  await database.pool('admin').query('GRANT SELECT, INSERT ON platform.idempotency_probe TO hk_app');
});

afterAll(async () => {
  await database.drop();
});

/** A command as every state-changing handler is written: claim first, do the work, store the response. */
function createThing(key: string, request: object, beforeWork: () => Promise<void> = async () => {}) {
  return uow.run({ isolation: 'serializable' }, async (tx) => {
    const claim = await idempotency.claim(tx, { operationId: 'createThing', principalId: PRINCIPAL, key, request });
    if (claim.kind === 'REPLAY') {
      return claim.response;
    }
    await beforeWork();
    const id = randomUUID();
    await tx.query('INSERT INTO platform.idempotency_probe (id, key) VALUES ($1, $2)', [id, key]);
    const response = { status: 201, body: { id, ...request } };
    await idempotency.complete(tx, claim.id, response);
    return response;
  });
}

async function effectsFor(key: string): Promise<number> {
  return (await database.pool('admin').query('SELECT 1 FROM platform.idempotency_probe WHERE key = $1', [key])).rowCount ?? 0;
}

describe('idempotency keys (ADR-0014): the four outcomes', () => {
  it('processes a first request and stores its response with the key', async () => {
    const key = randomUUID();
    const response = await createThing(key, { sku: 'LIV-GOAT' });
    expect(response.status).toBe(201);
    const { rows } = await database.pool('admin').query<{ status: string; response_status: number }>(
      'SELECT status, response_status FROM platform.idempotency_key WHERE key = $1',
      [key],
    );
    expect(rows[0]).toEqual({ status: 'COMPLETED', response_status: 201 });
  });

  it('returns the stored response for the same key and the same request, with no second effect', async () => {
    const key = randomUUID();
    const first = await createThing(key, { sku: 'MEAT-BEEF-15KG' });
    const again = await createThing(key, { sku: 'MEAT-BEEF-15KG' });
    expect(again).toEqual(first);
    expect(await effectsFor(key)).toBe(1);
  });

  it('refuses the same key with a different request, with 409 IDEMPOTENCY_KEY_REUSED, and changes nothing', async () => {
    const key = randomUUID();
    await createThing(key, { sku: 'PRD-EGGS-BIG' });
    const reused = await createThing(key, { sku: 'PRD-YAM' }).catch((error: unknown) => error);
    expect(reused).toBeInstanceOf(IdempotencyKeyReusedError);
    expect((reused as IdempotencyKeyReusedError).status).toBe(409);
    expect(await effectsFor(key)).toBe(1);
  });

  it('makes a second concurrent request with the same key wait for the first and receive its result, with one effect', async () => {
    const key = randomUUID();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = createThing(key, { sku: 'LIV-SHEEP' }, () => held);
    // Give the first transaction time to insert its key and block in its work.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = createThing(key, { sku: 'LIV-SHEEP' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(b).toEqual(a);
    expect(await effectsFor(key)).toBe(1);
  });

  it('scopes keys by caller and operation, so two callers may use the same key', async () => {
    const key = randomUUID();
    await createThing(key, { sku: 'LIV-PIG' });
    const other = await uow.run({ isolation: 'serializable' }, (tx) =>
      idempotency.claim(tx, { operationId: 'createThing', principalId: '01900000-0000-7000-8000-000000000004', key, request: { sku: 'LIV-PIG' } }),
    );
    expect(other.kind).toBe('NEW');
  });
});
