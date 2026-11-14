import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import { currentRequestContext } from '../context/request-context';
import type { IsolationLevel, Transaction } from '../database/unit-of-work';
import { isSensitiveKey } from '../logging/log-scrubber';

/** What a module publishes (ADR-0010). The envelope's actor, correlation and times are filled in on publish. */
export interface DomainEvent<P extends object = Record<string, unknown>> {
  /** `<module>.<AggregatePastTense>`, for example `mdm.ProductCreated`. */
  readonly type: string;
  readonly version?: number;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly branchId?: string | null;
  readonly payload: P;
  /** Business time, when it differs from the moment of publishing. */
  readonly occurredAt?: Date;
  /** The event that caused this one, when a subscriber publishes. */
  readonly causationId?: string | null;
}

/** The event as stored in `platform.outbox_message` and handed to every subscriber. */
export interface EventEnvelope<P extends object = Record<string, unknown>> {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly actorId: string;
  readonly branchId: string | null;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly payload: P;
}

/** Runs inside the publisher's transaction; if it throws, the publisher rolls back. */
export type TransactionalSubscriber = (tx: Transaction, event: EventEnvelope) => Promise<void>;

/** Runs after commit, at least once, from the outbox; its effect and its inbox row commit together. */
export interface AsyncConsumer {
  /** `<module>.<name>`, stable: it keys the delivery and inbox rows. */
  readonly name: string;
  readonly eventTypes: readonly string[];
  readonly isolation?: IsolationLevel;
  handle(tx: Transaction, event: EventEnvelope): Promise<void>;
}

const EVENT_TYPE = /^[a-z]{3,8}\.[A-Z][A-Za-z]+$/;
const CONSUMER_NAME = /^[a-z]{3,8}\.[a-z][a-z0-9-]+$/;

/** An event payload must never carry a secret (ADR-0010); a field with a secret's name is refused at publish. */
export class SecretInEventError extends Error {
  constructor(type: string, field: string) {
    super(`event ${type} carries a field named ${field}; events never carry secrets`);
    this.name = 'SecretInEventError';
  }
}

function findSecretField(value: unknown, path: string): string | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      return `${path}${key}`;
    }
    const nested = findSecretField(item, `${path}${key}.`);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

/**
 * The in-process event bus with its outbox (ADR-0010). Publishing inside a transaction runs every transactional
 * subscriber, writes the event to `platform.outbox_message` and one `platform.outbox_delivery` row per asynchronous
 * consumer of that type, all in the caller's transaction. The worker's dispatcher delivers after commit.
 */
export class DomainEvents {
  private readonly transactional = new Map<string, TransactionalSubscriber[]>();
  private readonly consumers = new Map<string, AsyncConsumer>();
  private readonly nextId: () => string;

  constructor(private readonly clock: Clock) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** Only ledger posting, a module keeping its own aggregate consistent, and exact projections (ADR-0010). */
  subscribeInTransaction(eventType: string, subscriber: TransactionalSubscriber): void {
    if (!EVENT_TYPE.test(eventType)) {
      throw new Error(`"${eventType}" is not an event type (<module>.<Name>)`);
    }
    const list = this.transactional.get(eventType) ?? [];
    list.push(subscriber);
    this.transactional.set(eventType, list);
  }

  registerConsumer(consumer: AsyncConsumer): void {
    if (!CONSUMER_NAME.test(consumer.name)) {
      throw new Error(`"${consumer.name}" is not a consumer name (<module>.<name>)`);
    }
    if (this.consumers.has(consumer.name)) {
      throw new Error(`consumer ${consumer.name} is registered twice`);
    }
    for (const type of consumer.eventTypes) {
      if (!EVENT_TYPE.test(type)) {
        throw new Error(`consumer ${consumer.name}: "${type}" is not an event type`);
      }
    }
    this.consumers.set(consumer.name, consumer);
  }

  consumer(name: string): AsyncConsumer | undefined {
    return this.consumers.get(name);
  }

  consumerNames(): string[] {
    return [...this.consumers.keys()];
  }

  async publish<P extends object>(tx: Transaction, event: DomainEvent<P>): Promise<EventEnvelope<P>> {
    if (!EVENT_TYPE.test(event.type)) {
      throw new Error(`"${event.type}" is not an event type (<module>.<Name>)`);
    }
    const secret = findSecretField(event.payload, '');
    if (secret !== undefined) {
      throw new SecretInEventError(event.type, secret);
    }
    const context = currentRequestContext();
    const actorId = context?.actor?.principalId;
    if (context === undefined || actorId === undefined) {
      throw new Error(`event ${event.type}: no actor in the request or job context`);
    }
    const now = this.clock.now();
    const envelope: EventEnvelope<P> = {
      id: this.nextId(),
      type: event.type,
      version: event.version ?? 1,
      occurredAt: event.occurredAt ?? now,
      recordedAt: now,
      actorId,
      branchId: event.branchId ?? null,
      correlationId: context.correlationId,
      causationId: event.causationId ?? null,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      payload: event.payload,
    };
    for (const subscriber of this.transactional.get(event.type) ?? []) {
      await subscriber(tx, envelope as EventEnvelope);
    }
    await tx.query(
      `INSERT INTO platform.outbox_message (id, event_type, event_version, subject_type, subject_id, branch_id, actor_id,
                                            correlation_id, causation_id, payload, occurred_at, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        envelope.id,
        envelope.type,
        envelope.version,
        envelope.subjectType,
        envelope.subjectId,
        envelope.branchId,
        envelope.actorId,
        envelope.correlationId,
        envelope.causationId,
        envelope.payload,
        envelope.occurredAt,
        envelope.recordedAt,
      ],
    );
    const interested = [...this.consumers.values()].filter((consumer) => consumer.eventTypes.includes(event.type)).map((c) => c.name);
    if (interested.length > 0) {
      await tx.query(
        `INSERT INTO platform.outbox_delivery (message_id, consumer, subject_id, status, next_attempt_at)
         SELECT $1, consumer, $2, 'PENDING', $3 FROM unnest($4::text[]) AS consumer`,
        [envelope.id, envelope.subjectId, now, interested],
      );
    }
    return envelope;
  }
}
