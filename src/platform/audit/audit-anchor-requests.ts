import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { Transaction } from '../database/unit-of-work';

/** Why a module asks for an anchor outside the daily one (ADR-0006: "at every shift close"). */
export type AnchorRequestReason = 'SHIFT_CLOSE';

export interface AnchorRequest {
  readonly reason: AnchorRequestReason;
  /** What was signed off, for example `Shift`. */
  readonly subjectType: string;
  readonly subjectId: string;
  readonly actorId: string;
}

/**
 * A module asks, in its own business transaction, for the audit chain to be anchored once that transaction's audit
 * events are sealed (ADR-0006 stage three, A-275). The worker answers (`AuditAnchor.answerRequests`): it signs the
 * chain head off the server and records which anchor covered the request. Written in the caller's transaction, so a
 * sign-off that rolls back asks for nothing.
 */
export class AuditAnchorRequests {
  private readonly nextId: () => string;

  constructor(private readonly clock: Clock) {
    this.nextId = createUuidV7Generator(clock);
  }

  async requestIn(tx: Transaction, request: AnchorRequest): Promise<void> {
    await tx.query(
      `INSERT INTO platform.audit_anchor_request (id, reason, subject_type, subject_id, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [this.nextId(), request.reason, request.subjectType, request.subjectId, this.clock.now(), request.actorId],
    );
  }
}
