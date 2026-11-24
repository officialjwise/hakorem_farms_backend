import { createHmac, randomUUID } from 'node:crypto';
import type { Clock } from '@hakorem/kernel';
import type { INestApplication } from '@nestjs/common';
import pino from 'pino';
import { CustomerMessages } from '../../src/modules/ntf/application/customer-messages';
import { MessageLinks } from '../../src/modules/ntf/application/message-links';
import { RecipientFacts } from '../../src/modules/ntf/application/message-queue';
import { ReminderDeliveries } from '../../src/modules/ntf/application/reminders';
import { MessageSender } from '../../src/modules/ntf/application/message-sender';
import { NTF_STORE, type NtfStore } from '../../src/modules/ntf/application/ntf-store';
import { runAsSystem } from '../../src/platform/context/request-context';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { DomainEvents, type DomainEvent } from '../../src/platform/events/domain-events';
import { OutboxDispatcher } from '../../src/platform/events/outbox-dispatcher';
import { NotificationSendError, type NotificationChannel, type OutgoingMessage } from '../../src/platform/notifications/notification-channel';
import type { TestDatabase } from './test-database';

const silent = pino({ level: 'silent' });
export const SCHEDULER = { kind: 'SYSTEM', principalId: '01900000-0000-7000-8000-000000000004' } as const;
const SYSTEM = { principalId: '01900000-0000-7000-8000-000000000001', displayName: 'System' };

/**
 * The SMS provider's test double: the one channel NTF sends by, with no network and no key. It keeps every call, and
 * delivers a message to the phone once per idempotency key, as a provider that honours the key does (A-374 (f)). A
 * script of failures makes the next calls fail, temporarily or for good; `hold` makes the next call reach the provider
 * and then never answer, as a worker that died mid-send.
 */
export class FakeSms implements NotificationChannel {
  readonly channel = 'SMS' as const;
  readonly calls: OutgoingMessage[] = [];
  readonly delivered = new Map<string, OutgoingMessage>();
  private readonly script: Array<'TEMPORARY' | 'PERMANENT' | 'HOLD'> = [];
  private readonly held: Array<() => void> = [];

  failNext(kind: 'TEMPORARY' | 'PERMANENT', times = 1): void {
    for (let i = 0; i < times; i++) this.script.push(kind);
  }

  holdNext(): void {
    this.script.push('HOLD');
  }

  /** Lets every held call answer at last, as a worker that comes back after its claim was taken over. */
  release(): void {
    for (const answer of this.held.splice(0)) answer();
  }

  async send(message: OutgoingMessage): Promise<{ readonly providerReference: string }> {
    this.calls.push(message);
    const next = this.script.shift();
    if (next === 'TEMPORARY') throw new NotificationSendError('the SMS provider answered 503', true);
    if (next === 'PERMANENT') throw new NotificationSendError('the SMS provider answered 400: number not reachable', false);
    if (!this.delivered.has(message.idempotencyKey)) this.delivered.set(message.idempotencyKey, message);
    if (next === 'HOLD') await new Promise<void>((resolve) => this.held.push(resolve));
    return { providerReference: `fake-${message.idempotencyKey}` };
  }
}

/**
 * The email provider's test double (B11 continued 13): the adapter shape B13 fills with a real provider, with no
 * network and no key. It keeps every call, its subject and its attachments, and can be told to fail the next call.
 */
export class FakeEmail implements NotificationChannel {
  readonly channel = 'EMAIL' as const;
  readonly calls: OutgoingMessage[] = [];
  private failures = 0;

  failNext(times = 1): void {
    this.failures += times;
  }

  async send(message: OutgoingMessage): Promise<{ readonly providerReference: string }> {
    this.calls.push(message);
    if (this.failures > 0) {
      this.failures -= 1;
      throw new NotificationSendError('the email provider answered 503', true);
    }
    return { providerReference: `fake-email-${message.idempotencyKey}` };
  }
}

export interface NtfHarness {
  readonly store: NtfStore;
  readonly events: DomainEvents;
  readonly customerMessages: CustomerMessages;
  readonly workerUow: UnitOfWork;
  /** A sender over the worker's pool with its own channel, as each worker process builds one, run as the Scheduler. */
  sender(sms: NotificationChannel, random?: () => number, others?: readonly NotificationChannel[]): { run(system: typeof SCHEDULER): ReturnType<MessageSender['run']> };
  /** Delivers the outbox to every consumer until nothing is due, as the worker's dispatcher does. */
  dispatch(): Promise<void>;
  /** Publishes an event as ORD or DEL would, in its own committed transaction, and returns its id. */
  publish(event: DomainEvent): Promise<string>;
}

export function ntfHarness(app: INestApplication, database: TestDatabase, clock: Clock): NtfHarness {
  const events = app.get(DomainEvents);
  const store = app.get<NtfStore>(NTF_STORE);
  const workerUow = new UnitOfWork(database.pool('worker'), silent, undefined, clock);
  const appUow = app.get(UnitOfWork);
  const recipients = app.get(RecipientFacts);
  const dispatcher = new OutboxDispatcher(workerUow, events, clock, silent, { maxAttempts: 5, backoffBaseMs: 1_000, backoffMaxMs: 10_000, batchSize: 200 });
  return {
    store,
    events,
    customerMessages: app.get(CustomerMessages),
    workerUow,
    sender: (sms, random = () => 0, others = []) => {
      const channels = new Map<NotificationChannel['channel'], NotificationChannel>([['SMS', sms], ...others.map((c) => [c.channel, c] as const)]);
      const sender = new MessageSender(workerUow, store, recipients, channels, events, clock, silent, random, app.get(MessageLinks), app.get(ReminderDeliveries));
      return { run: (system) => runAsSystem({ principalId: system.principalId, displayName: 'Scheduler' }, randomUUID(), () => sender.run(system)) };
    },
    async dispatch() {
      for (let pass = 0; pass < 20; pass++) {
        const outcome = await runAsSystem(SYSTEM, randomUUID(), () => dispatcher.dispatchOnce());
        if (outcome.delivered + outcome.failed + outcome.dead === 0) return;
      }
    },
    async publish(event) {
      const envelope = await runAsSystem(SYSTEM, randomUUID(), () => appUow.run({ isolation: 'serializable' }, (tx) => events.publish(tx, event)));
      return envelope.id;
    },
  };
}


/** The provider's signature over a delivery report's raw body (receiveMessagingWebhook). */
export function signReport(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}
