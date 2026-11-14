import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { KeyObject } from 'node:crypto';
import type pg from 'pg';
import type { ObjectStorage } from '../storage/object-storage';
import { anchorMessage, signAnchor } from './audit-chain';

export type AnchorReason = 'DAILY' | 'SHIFT_CLOSE' | 'MANUAL';

export interface AnchorSettings {
  readonly keyId: string;
  readonly bucket: string;
  /** How long the off-box copy is write-once (object lock). Seven years, as the statutory records (A-063). */
  readonly retentionDays: number;
}

export interface AnchorRecord {
  readonly id: string;
  readonly seq: bigint;
  readonly chainHash: Buffer;
  readonly signature: Buffer;
  readonly storageUri: string;
  readonly anchoredAt: Date;
}

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * The audit anchor (ADR-0006, stage three). Signs the chain head with a key held outside the database, writes the
 * signed copy to object storage off the server under object lock, then records it in `platform.audit_anchor`.
 * Without the key and the off-box copy, someone who rewrote the events and recomputed the chain is still found.
 */
export class AuditAnchor {
  private readonly nextId: () => string;

  constructor(
    private readonly sealerPool: pg.Pool,
    private readonly storage: ObjectStorage,
    private readonly signingKey: KeyObject,
    private readonly clock: Clock,
    private readonly settings: AnchorSettings,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** Anchors the current head; null when nothing has been sealed yet. */
  async anchor(reason: AnchorReason): Promise<AnchorRecord | null> {
    const { rows } = await this.sealerPool.query<{ seq: string; chain_hash: Buffer }>('SELECT seq::text AS seq, chain_hash FROM platform.audit_chain ORDER BY seq DESC LIMIT 1');
    const head = rows[0];
    if (head === undefined) {
      return null;
    }
    const id = this.nextId();
    const seq = BigInt(head.seq);
    const anchoredAt = this.clock.now();
    const signature = signAnchor(this.signingKey, anchorMessage(seq, head.chain_hash, anchoredAt, this.settings.keyId));
    const day = anchoredAt.toISOString().slice(0, 10).replace(/-/g, '/');
    const key = `anchors/${day}/${head.seq.padStart(12, '0')}-${id}.json`;
    const document = {
      kind: 'hakorem-audit-anchor',
      version: 1,
      id,
      seq: head.seq,
      chainHash: head.chain_hash.toString('hex'),
      anchoredAt: anchoredAt.toISOString(),
      reason,
      signingKeyId: this.settings.keyId,
      signature: signature.toString('base64'),
    };
    await this.storage.put(this.settings.bucket, key, Buffer.from(JSON.stringify(document, null, 2), 'utf8'), {
      contentType: 'application/json',
      retainUntil: new Date(anchoredAt.getTime() + this.settings.retentionDays * MILLISECONDS_PER_DAY),
    });
    const storageUri = `s3://${this.settings.bucket}/${key}`;
    await this.sealerPool.query(
      `INSERT INTO platform.audit_anchor (id, seq, chain_hash, signature, signing_key_id, storage_uri, reason, anchored_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, head.seq, head.chain_hash, signature, this.settings.keyId, storageUri, reason, anchoredAt],
    );
    return { id, seq, chainHash: head.chain_hash, signature, storageUri, anchoredAt };
  }
}
