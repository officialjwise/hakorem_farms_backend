import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type pg from 'pg';
import { currentRequestContext } from '../context/request-context';
import { canonicalJson } from '../crypto/canonical-json';
import { sealWithSubjectKey, type Subject, type SubjectKeys } from '../crypto/subject-keys';
import type { Transaction } from '../database/unit-of-work';
import { isSensitiveKey, REDACTED } from '../logging/log-scrubber';

type Json = Record<string, unknown>;

/** One audited action (ADR-0006). The actor, session, address and correlation id come from the request context. */
export interface AuditEntry {
  /** The module that acted, lower-case code. */
  readonly module: string;
  /** `CREATE`, `UPDATE`, `LOGIN`, `LOGIN_FAILED`, `LOGOUT`, `PERMISSION_CHANGE`, `APPROVAL`, `EXPORT`, `DECRYPT` and so on. */
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly branchId?: string | null;
  readonly before?: Json | null;
  readonly after?: Json | null;
  readonly metadata?: Json | null;
  /** Whose personal data `before` and `after` hold; required when `personalFields` is not empty. */
  readonly subject?: Subject;
  /** Top-level fields of `before` and `after` that are personal data, encrypted with the subject's key. */
  readonly personalFields?: readonly string[];
  readonly occurredAt?: Date;
  /**
   * Who acted, when it is not the authenticated actor of the request: the principal who just logged in, or null
   * for a failed login by an unknown account. Leave out to use the request's actor.
   */
  readonly actorId?: string | null;
  readonly sessionId?: string | null;
}

/** The marker an encrypted personal field is stored as inside canonical JSON. */
export interface EncryptedField {
  readonly $enc: string;
}

/** Where an encrypted audit field belongs, so a ciphertext copied into another event or field does not decrypt. */
export function auditFieldPlace(eventId: string, side: 'before' | 'after', field: string): string {
  return `audit:${eventId}:${side}:${field}`;
}

/** Replaces secrets by field name at every depth, so they never reach the audit log (ADR-0022). */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value === null || typeof value !== 'object' || value instanceof Date) {
    return value;
  }
  const out: Json = {};
  for (const [key, item] of Object.entries(value as Json)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactSecrets(item);
  }
  return out;
}

/** An audit row cannot be attributed: no actor in the request and none given. */
export class AuditActorMissingError extends Error {
  readonly code = 'AUDIT_ACTOR_MISSING';

  constructor(action: string) {
    super(`audit ${action}: no actor in the request context; pass actorId explicitly (null only for LOGIN_FAILED)`);
    this.name = 'AuditActorMissingError';
  }
}

/**
 * The audit writer (ADR-0006, stage one). Writes `platform.audit_event` in the caller's transaction, so a change
 * cannot commit without its audit row and an audit row cannot outlive a rolled-back change. The database trigger
 * sets the transaction id and content hash; the sealer chains the row shortly after commit.
 */
export class AuditTrail {
  private readonly nextId: () => string;

  constructor(
    private readonly subjectKeys: SubjectKeys,
    private readonly clock: Clock,
    private readonly pool: pg.Pool,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /**
   * Writes an event on its own connection, committed at once, for a fact that must survive the rollback of the
   * transaction around it: a refused authorisation or a detected token reuse. It may carry no personal fields.
   */
  async recordDetached(entry: AuditEntry): Promise<string> {
    if ((entry.personalFields ?? []).length > 0) {
      throw new Error(`audit ${entry.action}: a detached event cannot carry personal fields`);
    }
    return this.write((text, values) => this.pool.query(text, values as unknown[]), entry);
  }

  async record(tx: Transaction, entry: AuditEntry): Promise<string> {
    return this.write((text, values) => tx.query(text, values), entry, tx);
  }

  private async write(
    query: (text: string, values: readonly unknown[]) => Promise<unknown>,
    entry: AuditEntry,
    tx?: Transaction,
  ): Promise<string> {
    const context = currentRequestContext();
    const actorId = entry.actorId !== undefined ? entry.actorId : (context?.actor?.principalId ?? null);
    if (actorId === null && entry.action !== 'LOGIN_FAILED') {
      throw new AuditActorMissingError(entry.action);
    }
    if (context === undefined) {
      throw new Error('audit: no request or job context; run the work inside one');
    }
    const id = this.nextId();
    const personal = entry.personalFields ?? [];
    let subjectKeyId: string | null = null;
    let seal: ((side: 'before' | 'after', field: string, value: unknown) => EncryptedField) | undefined;
    if (personal.length > 0) {
      if (entry.subject === undefined || tx === undefined) {
        throw new Error(`audit ${entry.action}: personal fields need the subject they belong to and the business transaction`);
      }
      const key = await this.subjectKeys.keyFor(tx, entry.subject, actorId ?? entry.subject.id);
      subjectKeyId = key.id;
      seal = (side, field, value) => ({
        $enc: sealWithSubjectKey(key, canonicalJson(value), auditFieldPlace(id, side, field)).toString('base64'),
      });
    }
    const encode = (side: 'before' | 'after', value: Json | null | undefined): Buffer | null => {
      if (value === undefined || value === null) {
        return null;
      }
      const redacted = redactSecrets(value) as Json;
      if (seal !== undefined) {
        for (const field of personal) {
          if (redacted[field] !== undefined && redacted[field] !== null) {
            redacted[field] = seal(side, field, redacted[field]);
          }
        }
      }
      return Buffer.from(canonicalJson(redacted), 'utf8');
    };
    await query(
      `INSERT INTO platform.audit_event (id, occurred_at, actor_id, session_id, ip, user_agent, correlation_id, branch_id, module,
                                         action, entity_type, entity_id, "before", "after", metadata, subject_key_id, txid, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, '0', '\\x')`,
      [
        id,
        entry.occurredAt ?? this.clock.now(),
        actorId,
        entry.sessionId !== undefined ? entry.sessionId : (context.actor?.sessionId ?? null),
        context.ip,
        context.userAgent,
        context.correlationId,
        entry.branchId ?? null,
        entry.module,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        encode('before', entry.before),
        encode('after', entry.after),
        entry.metadata === undefined || entry.metadata === null ? null : (redactSecrets(entry.metadata) as Json),
        subjectKeyId,
      ],
    );
    return id;
  }
}
