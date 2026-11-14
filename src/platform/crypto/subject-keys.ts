import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { Transaction } from '../database/unit-of-work';
import { decrypt, encrypt, newDataKey } from './envelope-cipher';
import type { KeyRing } from './key-ring';

/** The kinds of data subject a key is held for (platform.subject_key.subject_type). */
export type SubjectType = 'CUSTOMER' | 'SUPPLIER' | 'INVESTOR' | 'STAFF';

export interface Subject {
  readonly type: SubjectType;
  readonly id: string;
}

/** Personal data cannot be written for a subject whose key was destroyed by a deletion request. */
export class SubjectErasedError extends Error {
  readonly code = 'SUBJECT_ERASED';

  constructor(subject: Subject) {
    super(`the data subject ${subject.type} ${subject.id} has been erased; no new personal data may be stored for it`);
    this.name = 'SubjectErasedError';
  }
}

interface SubjectKeyRow {
  id: string;
  wrapped_key: Buffer | null;
  kek_version: number;
}

/** A subject's data key, unwrapped, with the id of the row it lives in. */
export interface SubjectKey {
  readonly id: string;
  readonly key: Buffer;
}

/**
 * One data-encryption key per data subject (ADR-0022). Personal data written to an immutable store is encrypted
 * with it; destroying the key makes every such value unreadable without changing a stored byte. Keys are wrapped
 * by the key-encryption key and bound to their own row.
 */
export class SubjectKeys {
  private readonly nextId: () => string;

  constructor(
    private readonly keyRing: KeyRing,
    clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** The subject's key, created on first use. Refuses an erased subject. */
  async keyFor(tx: Transaction, subject: Subject, actorId: string): Promise<SubjectKey> {
    const existing = await this.find(tx, subject);
    if (existing !== undefined) {
      return this.unwrapLive(existing, subject);
    }
    const id = this.nextId();
    const { wrapped, version } = this.keyRing.wrap(newDataKey(), `subject_key:${id}`);
    await tx.query(
      `INSERT INTO platform.subject_key (id, subject_type, subject_id, wrapped_key, kek_version, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (subject_type, subject_id) DO NOTHING`,
      [id, subject.type, subject.id, wrapped, version, actorId],
    );
    const row = await this.find(tx, subject);
    if (row === undefined) {
      throw new Error('the subject key was neither found nor created');
    }
    return this.unwrapLive(row, subject);
  }

  /** The key stored in a row, or null when it has been destroyed. */
  async keyById(tx: Transaction, keyId: string): Promise<Buffer | null> {
    const { rows } = await tx.query<SubjectKeyRow>('SELECT id, wrapped_key, kek_version FROM platform.subject_key WHERE id = $1', [keyId]);
    const row = rows[0];
    if (row === undefined || row.wrapped_key === null) {
      return null;
    }
    return this.keyRing.unwrap(row.wrapped_key, row.kek_version, `subject_key:${row.id}`);
  }

  /** Destroys the subject's key. Every value encrypted with it becomes permanently unreadable. */
  async destroy(tx: Transaction, subject: Subject, actorId: string, reason: string): Promise<void> {
    await tx.query(
      `UPDATE platform.subject_key
          SET wrapped_key = NULL, destroyed_at = now(), destroyed_by = $3, destroy_reason = $4, updated_by = $3, version = version + 1
        WHERE subject_type = $1 AND subject_id = $2 AND destroyed_at IS NULL`,
      [subject.type, subject.id, actorId, reason],
    );
  }

  private async find(tx: Transaction, subject: Subject): Promise<SubjectKeyRow | undefined> {
    const { rows } = await tx.query<SubjectKeyRow>(
      'SELECT id, wrapped_key, kek_version FROM platform.subject_key WHERE subject_type = $1 AND subject_id = $2',
      [subject.type, subject.id],
    );
    return rows[0];
  }

  private unwrapLive(row: SubjectKeyRow, subject: Subject): SubjectKey {
    if (row.wrapped_key === null) {
      throw new SubjectErasedError(subject);
    }
    return { id: row.id, key: this.keyRing.unwrap(row.wrapped_key, row.kek_version, `subject_key:${row.id}`) };
  }
}

/** Encrypts one value with a subject key, bound to its place, for a restricted `*_enc` column or an audit field. */
export function sealWithSubjectKey(key: SubjectKey, plaintext: string, place: string): Buffer {
  return encrypt(key.key, Buffer.from(plaintext, 'utf8'), place);
}

export function openWithSubjectKey(key: Buffer, stored: Buffer, place: string): string {
  return decrypt(key, stored, place).toString('utf8');
}
