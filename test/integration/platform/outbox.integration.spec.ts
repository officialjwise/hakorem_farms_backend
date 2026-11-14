import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { DomainEvents, SecretInEventError, type EventEnvelope } from '../../../src/platform/events/domain-events';
import { OutboxDispatcher, retryDelayMs } from '../../../src/platform/events/outbox-dispatcher';
import { deadLettersContributor, outboxBacklogContributor } from '../../../src/platform/health/health.service';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const SYSTEM = { principalId: '01900000-0000-7000-8000-000000000001', displayName: 'System' };
const silent = pino({ level: 'silent' });
let database: TestDatabase;
let appUow: UnitOfWork;
let workerUow: UnitOfWork;

beforeAll(async () => {
  database = await createTestDatabase();
  appUow = new UnitOfWork(database.pool('app'), silent);
  workerUow = new UnitOfWork(database.pool('worker'), silent);
  const admin = database.pool('admin');
  // A consumer's own table, standing in for a notification log or a projection.
  await admin.query('CREATE TABLE platform.outbox_probe_effect (message_id uuid NOT NULL, consumer text NOT NULL)');
  await admin.query('GRANT SELECT, INSERT ON platform.outbox_probe_effect TO hk_app, hk_worker');
});

afterAll(async () => {
  await database.drop();
});

const publish = (events: DomainEvents, subjectId: string, payload: object = { sku: 'LIV-GOAT' }) =>
  runAsSystem(SYSTEM, randomUUID(), () =>
    appUow.run({ isolation: 'serializable' }, (tx) => events.publish(tx, { type: 'mdm.ProductCreated', subjectType: 'Product', subjectId, payload })),
  );

async function effects(consumer: string): Promise<string[]> {
  const { rows } = await database.pool('admin').query<{ message_id: string }>('SELECT message_id FROM platform.outbox_probe_effect WHERE consumer = $1 ORDER BY message_id', [consumer]);
  return rows.map((row) => row.message_id);
}

function recordingConsumer(name: string, seen: EventEnvelope[] = []) {
  return {
    name,
    eventTypes: ['mdm.ProductCreated'],
    async handle(tx: Parameters<Parameters<UnitOfWork['run']>[1]>[0], event: EventEnvelope) {
      seen.push(event);
      await tx.query('INSERT INTO platform.outbox_probe_effect (message_id, consumer) VALUES ($1, $2)', [event.id, name]);
    },
  };
}

const settings = { maxAttempts: 3, backoffBaseMs: 1_000, backoffMaxMs: 60_000, batchSize: 50 };

describe('the outbox (ADR-0010)', () => {
  it('commits an event and its deliveries with the business change, or neither', async () => {
    const events = new DomainEvents(new ManualClock(new Date()));
    events.registerConsumer(recordingConsumer('rpt.atomic-probe'));
    const kept = randomUUID();
    await publish(events, kept);
    const lost = randomUUID();
    await expect(
      runAsSystem(SYSTEM, randomUUID(), () =>
        appUow.run({ isolation: 'serializable' }, async (tx) => {
          await events.publish(tx, { type: 'mdm.ProductCreated', subjectType: 'Product', subjectId: lost, payload: {} });
          throw new Error('rolled back');
        }),
      ),
    ).rejects.toThrow('rolled back');
    const admin = database.pool('admin');
    const count = async (subject: string) =>
      (await admin.query('SELECT 1 FROM platform.outbox_message m JOIN platform.outbox_delivery d ON d.message_id = m.id WHERE m.subject_id = $1', [subject])).rowCount;
    expect(await count(kept)).toBe(1);
    expect(await count(lost)).toBe(0);
  });

  it('runs a transactional subscriber inside the publisher\'s transaction, so its failure rolls the publisher back', async () => {
    const events = new DomainEvents(new ManualClock(new Date()));
    events.subscribeInTransaction('mdm.ProductCreated', async () => {
      throw new Error('ledger posting failed');
    });
    const subject = randomUUID();
    await expect(publish(events, subject)).rejects.toThrow('ledger posting failed');
    expect((await database.pool('admin').query('SELECT 1 FROM platform.outbox_message WHERE subject_id = $1', [subject])).rowCount).toBe(0);
  });

  it('refuses an event that carries a secret', async () => {
    const events = new DomainEvents(new ManualClock(new Date()));
    await expect(publish(events, randomUUID(), { sku: 'LIV-GOAT', resetToken: 'abc' })).rejects.toBeInstanceOf(SecretInEventError);
  });

  it('delivers after commit, as the worker role, and a redelivered message has no second effect', async () => {
    const clock = new ManualClock(new Date());
    const events = new DomainEvents(clock);
    const seen: EventEnvelope[] = [];
    events.registerConsumer(recordingConsumer('ntf.redelivery-probe', seen));
    const subject = randomUUID();
    const envelope = await publish(events, subject);
    const dispatcher = new OutboxDispatcher(workerUow, events, clock, silent, settings);
    expect(await runAsSystem(SYSTEM, randomUUID(), () => dispatcher.dispatchOnce())).toEqual({ delivered: 1, failed: 0, dead: 0 });
    expect(seen[0]).toMatchObject({ id: envelope.id, type: 'mdm.ProductCreated', subjectId: subject, actorId: SYSTEM.principalId, payload: { sku: 'LIV-GOAT' } });

    // Simulate a redelivery: the delivery is put back to PENDING, as after a crash between effect and acknowledgement.
    await database
      .pool('admin')
      .query("UPDATE platform.outbox_delivery SET status = 'PENDING', next_attempt_at = now() - interval '1 second', delivered_at = NULL WHERE message_id = $1", [envelope.id]);
    expect((await runAsSystem(SYSTEM, randomUUID(), () => dispatcher.dispatchOnce())).delivered).toBe(1);
    expect(seen).toHaveLength(1);
    expect(await effects('ntf.redelivery-probe')).toEqual([envelope.id]);
  });

  it('delivers one subject\'s events to a consumer in order, holding later ones while an earlier one waits to retry', async () => {
    const clock = new ManualClock(new Date());
    const events = new DomainEvents(clock);
    let failFirst = true;
    const order: string[] = [];
    events.registerConsumer({
      name: 'rpt.order-probe',
      eventTypes: ['mdm.ProductCreated'],
      async handle(_tx, event) {
        if (failFirst) {
          failFirst = false;
          throw new Error('projection briefly unavailable');
        }
        order.push(String((event.payload as { n: number }).n));
      },
    });
    const subject = randomUUID();
    await publish(events, subject, { n: 1 });
    clock.advanceBy(5);
    await publish(events, subject, { n: 2 });
    const dispatcher = new OutboxDispatcher(workerUow, events, clock, silent, settings, () => 0);
    expect(await runAsSystem(SYSTEM, randomUUID(), () => dispatcher.dispatchOnce())).toEqual({ delivered: 0, failed: 1, dead: 0 });
    expect(order).toEqual([]);
    clock.advanceBy(1_000);
    expect((await runAsSystem(SYSTEM, randomUUID(), () => dispatcher.dispatchOnce())).delivered).toBe(1);
    expect((await runAsSystem(SYSTEM, randomUUID(), () => dispatcher.dispatchOnce())).delivered).toBe(1);
    expect(order).toEqual(['1', '2']);
  });

  it('retries a failing consumer with growing delays, ends in DEAD after the configured attempts, and the health report shows it', async () => {
    const clock = new ManualClock(new Date());
    const events = new DomainEvents(clock);
    events.registerConsumer({
      name: 'ntf.always-fails',
      eventTypes: ['mdm.ProductCreated'],
      async handle() {
        throw new Error('SMS gateway refused +233244512876');
      },
    });
    const envelope = await publish(events, randomUUID());
    const dispatcher = new OutboxDispatcher(workerUow, events, clock, silent, settings, () => 1);
    const state = async () =>
      (
        await database
          .pool('admin')
          .query<{ status: string; attempts: number; next_attempt_at: Date | null; last_error: string }>(
            "SELECT status, attempts, next_attempt_at, last_error FROM platform.outbox_delivery WHERE message_id = $1 AND consumer = 'ntf.always-fails'",
            [envelope.id],
          )
      ).rows[0]!;

    await runAsSystem(SYSTEM, randomUUID(), () => dispatcher.dispatchOnce());
    const first = await state();
    expect(first).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(first.next_attempt_at!.getTime() - clock.now().getTime()).toBe(retryDelayMs(1, settings, () => 1));
    expect(first.last_error).toContain('***876');
    expect(first.last_error).not.toContain('244512876');

    // Not due yet: nothing happens.
    expect((await runAsSystem(SYSTEM, randomUUID(), () => dispatcher.dispatchOnce())).failed).toBe(0);
    clock.advanceBy(retryDelayMs(1, settings, () => 1));
    await runAsSystem(SYSTEM, randomUUID(), () => dispatcher.dispatchOnce());
    const second = await state();
    expect(second).toMatchObject({ status: 'FAILED', attempts: 2 });
    expect(second.next_attempt_at!.getTime() - clock.now().getTime()).toBe(2_000);

    clock.advanceBy(2_000);
    expect((await runAsSystem(SYSTEM, randomUUID(), () => dispatcher.dispatchOnce())).dead).toBe(1);
    expect(await state()).toMatchObject({ status: 'DEAD', attempts: 3, next_attempt_at: null });

    const dead = await deadLettersContributor(database.pool('app')).check();
    expect(dead.status).toBe('DEGRADED');
    expect(Number(dead.observed)).toBeGreaterThanOrEqual(1);
    const backlog = await outboxBacklogContributor(database.pool('app')).check();
    expect(backlog.status).toBe('OK');
  });

  it('doubles the retry delay up to the ceiling, with jitter only in its upper half', () => {
    expect([1, 2, 3, 4].map((attempt) => retryDelayMs(attempt, settings, () => 1))).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(retryDelayMs(1, settings, () => 0)).toBe(500);
    expect(retryDelayMs(20, settings, () => 1)).toBe(60_000);
  });
});
