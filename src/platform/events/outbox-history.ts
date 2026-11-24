import type { Transaction } from '../database/unit-of-work';
import type { EventEnvelope } from './domain-events';

/**
 * The outbox's history, read in the order it was written, for a projector that rebuilds itself by replaying events
 * (ADR-0023, ADR-0103). It reads only; the event types are the caller's.
 */
export class OutboxHistory {
  async messagesAfter(tx: Transaction, types: readonly string[], afterId: string | null, limit: number): Promise<EventEnvelope[]> {
    const { rows } = await tx.query<{
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
    }>(
      `SELECT id, event_type, event_version, occurred_at, recorded_at, actor_id, branch_id, correlation_id, causation_id, subject_type, subject_id, payload
         FROM platform.outbox_message
        WHERE event_type = ANY($1::text[]) AND ($2::uuid IS NULL OR id > $2::uuid)
        ORDER BY id
        LIMIT $3`,
      [[...types], afterId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      type: r.event_type,
      version: r.event_version,
      occurredAt: r.occurred_at,
      recordedAt: r.recorded_at,
      actorId: r.actor_id,
      branchId: r.branch_id,
      correlationId: r.correlation_id,
      causationId: r.causation_id,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      payload: r.payload,
    }));
  }

}
