import { createHash } from 'node:crypto';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import { canonicalJson } from '../crypto/canonical-json';
import type { Transaction } from '../database/unit-of-work';
import { ApiError } from '../errors/api-error';

/** Keys are kept at least this long, longer than any offline window (ADR-0014). */
export const IDEMPOTENCY_RETENTION_HOURS = 72;
const MILLISECONDS_PER_HOUR = 3_600_000;

/** 409: the key was used before by this caller for this operation with a different request. */
export class IdempotencyKeyReusedError extends ApiError {
  readonly status = 409;
  readonly code = 'IDEMPOTENCY_KEY_REUSED';
  readonly messageKey = 'error.idempotency_key_reused';
}

/** The response a state-changing command produced, stored with its key so a retry gets it again. */
export interface StoredResponse<B = unknown> {
  readonly status: number;
  readonly body: B;
}

export type IdempotencyClaim =
  | { readonly kind: 'NEW'; readonly id: string }
  | { readonly kind: 'REPLAY'; readonly response: StoredResponse };

export interface IdempotentRequest {
  /** The operation, so one key cannot collide across endpoints. */
  readonly operationId: string;
  readonly principalId: string;
  /** The client's `Idempotency-Key`, or the client id of an offline record. */
  readonly key: string;
  /** Everything that makes the request what it is: path parameters and body. */
  readonly request: unknown;
}

interface KeyRow {
  request_hash: Buffer;
  status: 'IN_PROGRESS' | 'COMPLETED';
  response_status: number | null;
  response_body: unknown;
}

export function requestHash(request: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(request), 'utf8').digest();
}

/**
 * The idempotency key store (ADR-0014). `claim` is the first write of the business transaction: a new key proceeds;
 * a completed key with the same request returns the stored response; a different request is a 409. Two concurrent
 * requests with one key meet at the unique key: the second waits for the first transaction, its insert finds the
 * committed row invisible to its snapshot, PostgreSQL reports a serialization failure, and the unit of work re-runs
 * it, so it then sees and returns the first result.
 */
export class Idempotency {
  private readonly nextId: () => string;

  constructor(private readonly clock: Clock) {
    this.nextId = createUuidV7Generator(clock);
  }

  async claim(tx: Transaction, request: IdempotentRequest): Promise<IdempotencyClaim> {
    const scope = `${request.principalId}:${request.operationId}`;
    const hash = requestHash(request.request);
    const id = this.nextId();
    const now = this.clock.now();
    const inserted = await tx.query(
      `INSERT INTO platform.idempotency_key (id, scope, key, principal_id, request_hash, status, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', $6, $7)
       ON CONFLICT (scope, key) DO NOTHING
       RETURNING id`,
      [id, scope, request.key, request.principalId, hash, now, new Date(now.getTime() + IDEMPOTENCY_RETENTION_HOURS * MILLISECONDS_PER_HOUR)],
    );
    if (inserted.rowCount === 1) {
      return { kind: 'NEW', id };
    }
    const { rows } = await tx.query<KeyRow>(
      'SELECT request_hash, status, response_status, response_body FROM platform.idempotency_key WHERE scope = $1 AND key = $2',
      [scope, request.key],
    );
    const existing = rows[0];
    if (existing === undefined || existing.status !== 'COMPLETED' || existing.response_status === null) {
      // Only reachable if the first request's transaction is still open in this snapshot, which PostgreSQL turns into
      // a serialization failure before we get here; refuse rather than run the command twice.
      throw new IdempotencyKeyReusedError('the key is held by a request that has not completed');
    }
    if (!existing.request_hash.equals(hash)) {
      throw new IdempotencyKeyReusedError('the key was used before with a different request');
    }
    return { kind: 'REPLAY', response: { status: existing.response_status, body: existing.response_body } };
  }

  async complete(tx: Transaction, id: string, response: StoredResponse): Promise<void> {
    await tx.query(
      "UPDATE platform.idempotency_key SET status = 'COMPLETED', response_status = $2, response_body = $3 WHERE id = $1",
      [id, response.status, JSON.stringify(response.body ?? null)],
    );
  }
}
