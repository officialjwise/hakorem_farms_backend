import type { Transaction } from '../database/unit-of-work';

/** One audit event as a reader of findings sees it: who, what, where and the after image (sealed fields stay sealed). */
export interface AuditFinding {
  readonly id: string;
  readonly occurredAt: Date;
  readonly actorId: string | null;
  readonly branchId: string | null;
  readonly module: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
}

/** One run of a scheduled job as `platform.job_run` records it. */
export interface JobRunFinding {
  readonly id: string;
  readonly finishedAt: Date;
  readonly outcome: string;
  readonly summary: Readonly<Record<string, unknown>>;
}

interface AuditRow {
  id: string;
  occurred_at: Date;
  actor_id: string | null;
  branch_id: string | null;
  module: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
  after_text: string | null;
}

function parsed(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    // An after image that is not a JSON object (never written by AuditTrail) is read as having none.
    return null;
  }
}

/**
 * The read side of the audit trail and the job log for a module that reports on them (RPT's daily exception report,
 * ADR-0103): the events of given actions in a time range, and the runs of a job that did not succeed. It reads only;
 * the actions and the job are the caller's, so no business rule lives here.
 */
export class AuditFindings {
  async eventsBetween(tx: Transaction, range: { readonly from: Date; readonly to: Date }, actions: readonly string[]): Promise<AuditFinding[]> {
    const { rows } = await tx.query<AuditRow>(
      `SELECT id, occurred_at, actor_id, branch_id, module, action, entity_type, entity_id, metadata, convert_from("after", 'UTF8') AS after_text
         FROM platform.audit_event
        WHERE occurred_at >= $1 AND occurred_at < $2 AND action = ANY($3::text[])
        ORDER BY occurred_at, id`,
      [range.from, range.to, [...actions]],
    );
    return rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      actorId: r.actor_id,
      branchId: r.branch_id,
      module: r.module,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      metadata: r.metadata,
      after: parsed(r.after_text),
    }));
  }

  async unsuccessfulRunsBetween(tx: Transaction, jobName: string, range: { readonly from: Date; readonly to: Date }): Promise<JobRunFinding[]> {
    const { rows } = await tx.query<{ id: string; finished_at: Date; outcome: string; summary: Record<string, unknown> }>(
      `SELECT id, finished_at, outcome, summary FROM platform.job_run
        WHERE job_name = $1 AND outcome <> 'SUCCESS' AND finished_at >= $2 AND finished_at < $3
        ORDER BY finished_at, id`,
      [jobName, range.from, range.to],
    );
    return rows.map((r) => ({ id: r.id, finishedAt: r.finished_at, outcome: r.outcome, summary: r.summary }));
  }
}
