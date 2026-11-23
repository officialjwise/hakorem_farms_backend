import { createHash } from 'node:crypto';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../audit/audit-trail';
import { currentRequestContext } from '../context/request-context';
import type { Transaction } from '../database/unit-of-work';
import { ServiceUnavailableError } from '../errors/api-error';
import type { ObjectStorage } from './object-storage';

export type ScanStatus = 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED';
export type Classification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

/** A row of `platform.stored_file`. */
export interface StoredFileRecord {
  readonly id: string;
  readonly bucket: string;
  readonly objectKey: string;
  readonly originalName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: Buffer;
  readonly purpose: string;
  readonly classification: Classification;
  readonly scanStatus: ScanStatus;
  readonly ownerModule: string;
  readonly createdAt: Date;
  readonly createdBy: string;
}

/** An object written to the private bucket, not yet registered. */
export interface PutFile {
  readonly id: string;
  readonly bucket: string;
  readonly objectKey: string;
  readonly sizeBytes: number;
  readonly sha256: Buffer;
}

export interface NewStoredFile {
  readonly object: PutFile;
  readonly originalName: string;
  readonly contentType: string;
  readonly purpose: string;
  readonly classification: Classification;
  readonly ownerModule: string;
  readonly actorId: string;
}

export interface SignedLink {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface FileStoreSettings {
  /** The private bucket every upload goes to first; null when object storage is not configured. */
  readonly privateBucket: string | null;
  /** Create the bucket on first use: development and test only. */
  readonly ensureBucket: boolean;
  /**
   * Where the public variants of a photograph are read from (ADR-0045): the media origin, which serves the public
   * bucket and nothing else. Null when there is none, and then no variant is shown.
   */
  readonly publicBaseUrl?: string | null;
}

/** A public rendition of a photograph, as the catalogue shows it (FR-DOC-005). */
export interface PublicVariant {
  readonly variant: 'thumb' | 'card' | 'full';
  readonly contentType: 'image/webp' | 'image/jpeg';
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
}

const MILLISECONDS_PER_SECOND = 1_000;
/** The longest a stored original name may be; longer names keep their end, where the extension is. */
const MAX_NAME_LENGTH = 255;
// Path separators and control characters never reach the stored name; it is shown on download only (SC-12).
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARACTERS = /[\u0000-\u001f\u007f/\\]/g;

/** A name a person gave a file, made safe to show: no path, no control characters, at most 255 characters. */
export function safeOriginalName(name: string): string {
  const cleaned = name.replace(UNSAFE_NAME_CHARACTERS, '_').trim();
  const named = cleaned.length === 0 ? 'file' : cleaned;
  return named.length <= MAX_NAME_LENGTH ? named : named.slice(named.length - MAX_NAME_LENGTH);
}

interface StoredFileRow {
  id: string;
  bucket: string;
  object_key: string;
  original_name: string;
  content_type: string;
  size_bytes: string;
  sha256: Buffer;
  purpose: string;
  classification: Classification;
  scan_status: ScanStatus;
  owner_module: string;
  created_at: Date;
  created_by: string;
}

const COLUMNS = 'id, bucket, object_key, original_name, content_type, size_bytes, sha256, purpose, classification, scan_status, owner_module, created_at, created_by';

function record(row: StoredFileRow): StoredFileRecord {
  return {
    id: row.id,
    bucket: row.bucket,
    objectKey: row.object_key,
    originalName: row.original_name,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    purpose: row.purpose,
    classification: row.classification,
    scanStatus: row.scan_status,
    ownerModule: row.owner_module,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

/**
 * The file store mechanism (ADR-0009, ADR-0044): writes an object under a random key in the private bucket, keeps
 * its metadata in `platform.stored_file` with scan status PENDING, issues signed expiring links and logs each issue
 * in `platform.file_access_log`. It holds no business rule: which uses exist, what they accept, how large and who
 * may read are the DOC module's. The object is written before the transaction that registers it, never inside one;
 * an object whose registration rolls back is never referenced and never served.
 */
export class FileStore {
  private readonly nextId: () => string;
  private bucketReady = false;

  constructor(
    private readonly storage: ObjectStorage | null,
    private readonly settings: FileStoreSettings,
    private readonly audit: AuditTrail,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** Writes the content under `<prefix>/<random id>` in the private bucket. Call outside any transaction. */
  async put(prefix: string, content: Buffer, contentType: string): Promise<PutFile> {
    const { storage, bucket } = this.configured();
    if (this.settings.ensureBucket && !this.bucketReady) {
      await storage.ensureBucket(bucket, { objectLock: false });
      this.bucketReady = true;
    }
    const id = this.nextId();
    const objectKey = `${prefix}/${id}`;
    await storage.put(bucket, objectKey, content, { contentType });
    return { id, bucket, objectKey, sizeBytes: content.length, sha256: createHash('sha256').update(content).digest() };
  }

  /** Registers a put object as PENDING, with its CREATE audit event, in the caller's transaction. */
  async register(tx: Transaction, file: NewStoredFile): Promise<StoredFileRecord> {
    const { rows } = await tx.query<StoredFileRow>(
      `INSERT INTO platform.stored_file (id, bucket, object_key, original_name, content_type, size_bytes, sha256, purpose, classification, owner_module, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
       RETURNING ${COLUMNS}`,
      [file.object.id, file.object.bucket, file.object.objectKey, safeOriginalName(file.originalName), file.contentType, file.object.sizeBytes, file.object.sha256, file.purpose, file.classification, file.ownerModule, file.actorId],
    );
    const stored = record(rows[0]!);
    await this.audit.record(tx, {
      module: 'platform',
      action: 'CREATE',
      entityType: 'StoredFile',
      entityId: stored.id,
      after: { purpose: stored.purpose, contentType: stored.contentType, sizeBytes: stored.sizeBytes, classification: stored.classification, scanStatus: stored.scanStatus, sha256: stored.sha256.toString('hex') },
    });
    return stored;
  }

  async find(tx: Transaction, id: string): Promise<StoredFileRecord | null> {
    const { rows } = await tx.query<StoredFileRow>(`SELECT ${COLUMNS} FROM platform.stored_file WHERE id = $1 AND deleted_at IS NULL`, [id]);
    return rows.length === 0 ? null : record(rows[0]!);
  }

  /**
   * The content of a CLEAN file, for a module that reads what was uploaded (an import, ADR-0046). Call outside any
   * transaction. A file the scanner has not passed is never read.
   */
  async content(file: StoredFileRecord): Promise<Buffer> {
    if (file.scanStatus !== 'CLEAN') {
      throw new Error(`file ${file.id} is ${file.scanStatus}; only a CLEAN file is read`);
    }
    return this.configured().storage.get(file.bucket, file.objectKey);
  }

  /**
   * The public variants of each file, in the order thumb, card, full and WebP before JPEG, with their URLs on the media
   * origin. A file with none, or with no origin configured, maps to an empty list. The original is never among them.
   */
  async publicVariants(tx: Transaction, fileIds: readonly string[]): Promise<ReadonlyMap<string, readonly PublicVariant[]>> {
    const variants = new Map<string, PublicVariant[]>(fileIds.map((id) => [id, []]));
    const base = this.settings.publicBaseUrl ?? null;
    if (fileIds.length === 0 || base === null) return variants;
    const { rows } = await tx.query<{ file_id: string; variant: PublicVariant['variant']; content_type: PublicVariant['contentType']; object_key: string; width: number; height: number; size_bytes: string }>(
      `SELECT file_id, variant, content_type, object_key, width, height, size_bytes FROM platform.stored_file_variant
        WHERE file_id = ANY($1::uuid[])
        ORDER BY file_id, array_position(ARRAY['thumb', 'card', 'full'], variant), content_type DESC`,
      [fileIds],
    );
    const origin = base.replace(/\/+$/, '');
    for (const row of rows) {
      variants.get(row.file_id)!.push({
        variant: row.variant,
        contentType: row.content_type,
        url: `${origin}/${row.object_key}`,
        width: row.width,
        height: row.height,
        sizeBytes: Number(row.size_bytes),
      });
    }
    return variants;
  }

  /**
   * A signed GET link valid for `ttlSeconds` from now, and its row in the access log with the actor and address of
   * the request, in the caller's transaction. Signing is local: no call leaves the process.
   */
  async signedLink(tx: Transaction, file: StoredFileRecord, purpose: string, ttlSeconds: number, onBehalfOf?: string): Promise<SignedLink> {
    const { storage } = this.configured();
    const context = currentRequestContext();
    // A public caller (a buyer by a link's token) has no actor on the request; the module that authorised them names
    // the principal the access is logged under (the Storefront's).
    const actorId = onBehalfOf ?? context?.actor?.principalId;
    if (actorId === undefined) {
      throw new Error(`signed link for ${file.id}: no actor in the request context`);
    }
    const signedAt = this.clock.now();
    const expiresAt = new Date(signedAt.getTime() + ttlSeconds * MILLISECONDS_PER_SECOND);
    const url = await storage.signedGetUrl(file.bucket, file.objectKey, ttlSeconds, signedAt);
    await tx.query(
      'INSERT INTO platform.file_access_log (id, file_id, purpose, url_expires_at, ip, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [this.nextId(), file.id, purpose, expiresAt, context?.ip ?? null, signedAt, actorId],
    );
    return { url, expiresAt };
  }

  private configured(): { storage: ObjectStorage; bucket: string } {
    if (this.storage === null || this.settings.privateBucket === null) {
      throw new ServiceUnavailableError('object storage is not configured (S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_BUCKET_PRIVATE)');
    }
    return { storage: this.storage, bucket: this.settings.privateBucket };
  }
}
