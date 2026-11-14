import type { Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import { runAsSystem } from '../context/request-context';
import type { UnitOfWork } from '../database/unit-of-work';
import { scrubString } from '../logging/log-scrubber';
import type { DomainEvents, EventEnvelope } from './domain-events';

/** The SYSTEM principal the dispatcher acts as (migration 0002). */
export const DISPATCHER_PRINCIPAL = { principalId: '01900000-0000-7000-8000-000000000003', displayName: 'Outbox dispatcher' } as const;

export interface DispatcherSettings {
  /** Attempts before a delivery is DEAD, the dead letter queue (OUTBOX_MAX_ATTEMPTS). */
  readonly maxAttempts: number;
  /** First retry delay; each later one doubles, up to the ceiling. */
  readonly backoffBaseMs: number;
  /** OUTBOX_BACKOFF_MAX_MS. */
  readonly backoffMaxMs: number;
  /** Deliveries claimed per pass. */
  readonly batchSize: number;
}

export interface DispatchOutcome {
  readonly delivered: number;
  readonly failed: number;
  readonly dead: number;
}

interface Candidate {
  message_id: string;
  consumer: string;
}

interface DeliveryRow {
  attempts: number;
  id: string;
  event_type: string;
  event_version: number;
  occurred_at: Date;
  recorded_at: Date;
  actor_id: string;
  branch_id: string | null;
  correlation_id: string;
  causation_id: string | null;
  subject_type: string;
  subject_id: string;
  payload: Record<string, unknown>;
}

const MAX_ERROR_LENGTH = 500;

/** Exponential backoff with equal jitter: half the capped delay, plus a random part of the other half. */
export function retryDelayMs(attempts: number, settings: DispatcherSettings, random: () => number): number {
  const capped = Math.min(settings.backoffMaxMs, settings.backoffBaseMs * 2 ** Math.max(0, attempts - 1));
  return Math.round(capped / 2 + (random() * capped) / 2);
}

function describe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return scrubString(text).slice(0, MAX_ERROR_LENGTH);
}

/**
 * Delivers outbox messages to asynchronous consumers after commit, at least once (ADR-0010). Each consumer sees
 * one subject's events in order: a delivery waits while an earlier one for the same subject and consumer is still
 * pending or failed. The consumer's effect, its inbox row and the delivered mark commit together, so a redelivery
 * finds the inbox row and does nothing. A failure is retried with backoff until it is DEAD.
 */
export class OutboxDispatcher {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly events: DomainEvents,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly settings: DispatcherSettings,
    private readonly random: () => number = Math.random,
  ) {}

  async dispatchOnce(): Promise<DispatchOutcome> {
    const consumers = this.events.consumerNames();
    if (consumers.length === 0) {
      return { delivered: 0, failed: 0, dead: 0 };
    }
    const candidates = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const { rows } = await tx.query<Candidate>(
        `SELECT d.message_id, d.consumer
           FROM platform.outbox_delivery d
          WHERE d.status IN ('PENDING', 'FAILED') AND d.next_attempt_at <= $1 AND d.consumer = ANY ($2::text[])
            AND NOT EXISTS (
              SELECT 1 FROM platform.outbox_delivery e
               WHERE e.consumer = d.consumer AND e.subject_id = d.subject_id
                 AND e.status IN ('PENDING', 'FAILED') AND e.message_id < d.message_id)
          ORDER BY d.message_id
          LIMIT $3`,
        [this.clock.now(), consumers, this.settings.batchSize],
      );
      return rows;
    });
    let delivered = 0;
    let failed = 0;
    let dead = 0;
    for (const candidate of candidates) {
      const outcome = await this.deliver(candidate);
      if (outcome === 'DELIVERED') delivered += 1;
      if (outcome === 'FAILED') failed += 1;
      if (outcome === 'DEAD') dead += 1;
    }
    return { delivered, failed, dead };
  }

  private async deliver(candidate: Candidate): Promise<'DELIVERED' | 'FAILED' | 'DEAD' | 'SKIPPED'> {
    const consumer = this.events.consumer(candidate.consumer);
    if (consumer === undefined) {
      return 'SKIPPED';
    }
    try {
      return await this.uow.run({ isolation: consumer.isolation ?? 'serializable' }, async (tx) => {
        const { rows } = await tx.query<DeliveryRow>(
          `SELECT d.attempts, m.id, m.event_type, m.event_version, m.occurred_at, m.recorded_at, m.actor_id, m.branch_id,
                  m.correlation_id, m.causation_id, m.subject_type, m.subject_id, m.payload
             FROM platform.outbox_delivery d JOIN platform.outbox_message m ON m.id = d.message_id
            WHERE d.message_id = $1 AND d.consumer = $2 AND d.status IN ('PENDING', 'FAILED')
            FOR UPDATE OF d SKIP LOCKED`,
          [candidate.message_id, candidate.consumer],
        );
        const row = rows[0];
        if (row === undefined) {
          return 'SKIPPED' as const;
        }
        const first = await tx.query(
          'INSERT INTO platform.inbox_message (consumer, message_id, actor_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING message_id',
          [candidate.consumer, candidate.message_id, DISPATCHER_PRINCIPAL.principalId],
        );
        if (first.rowCount === 1) {
          const envelope: EventEnvelope = {
            id: row.id,
            type: row.event_type,
            version: row.event_version,
            occurredAt: row.occurred_at,
            recordedAt: row.recorded_at,
            actorId: row.actor_id,
            branchId: row.branch_id,
            correlationId: row.correlation_id,
            causationId: row.causation_id,
            subjectType: row.subject_type,
            subjectId: row.subject_id,
            payload: row.payload,
          };
          await runAsSystem(DISPATCHER_PRINCIPAL, row.correlation_id, () => consumer.handle(tx, envelope));
        }
        await tx.query(
          `UPDATE platform.outbox_delivery SET status = 'DELIVERED', attempts = attempts + 1, delivered_at = $3, next_attempt_at = NULL, last_error = NULL
            WHERE message_id = $1 AND consumer = $2`,
          [candidate.message_id, candidate.consumer, this.clock.now()],
        );
        return 'DELIVERED' as const;
      });
    } catch (error) {
      return this.recordFailure(candidate, error);
    }
  }

  private async recordFailure(candidate: Candidate, error: unknown): Promise<'FAILED' | 'DEAD'> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const { rows } = await tx.query<{ attempts: number }>(
        'SELECT attempts FROM platform.outbox_delivery WHERE message_id = $1 AND consumer = $2 FOR UPDATE',
        [candidate.message_id, candidate.consumer],
      );
      const attempts = (rows[0]?.attempts ?? 0) + 1;
      const isDead = attempts >= this.settings.maxAttempts;
      const next = isDead ? null : new Date(this.clock.now().getTime() + retryDelayMs(attempts, this.settings, this.random));
      await tx.query(
        `UPDATE platform.outbox_delivery SET attempts = $3, status = $4, next_attempt_at = $5, last_error = $6
          WHERE message_id = $1 AND consumer = $2`,
        [candidate.message_id, candidate.consumer, attempts, isDead ? 'DEAD' : 'FAILED', next, describe(error)],
      );
      const fields = { consumer: candidate.consumer, messageId: candidate.message_id, attempts, err: error };
      if (isDead) {
        this.logger.error(fields, 'outbox delivery is dead');
      } else {
        this.logger.warn(fields, 'outbox delivery failed; will retry');
      }
      return isDead ? 'DEAD' : 'FAILED';
    });
  }
}
