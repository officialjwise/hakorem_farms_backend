/**
 * The object storage port (ADR-0009, "File store"): S3-compatible storage behind one small interface, so production
 * can use any provider that speaks the S3 API (A-070, A-067). No business rule lives here: what to store, who may
 * read it and for how long are decided by the caller.
 */
export interface PutOptions {
  readonly contentType: string;
  /** Write-once retention (S3 object lock, compliance mode): the object cannot be deleted or overwritten before. */
  readonly retainUntil?: Date;
}

export interface ObjectStorage {
  put(bucket: string, key: string, body: Buffer, options: PutOptions): Promise<void>;
  get(bucket: string, key: string): Promise<Buffer>;
  /** A signed, expiring GET URL for a private object (security architecture section 5, file uploads). */
  signedGetUrl(bucket: string, key: string, ttlSeconds: number): Promise<string>;
  /** Development and test only: creates a bucket if it is missing, with object lock when asked. */
  ensureBucket(bucket: string, options: { readonly objectLock: boolean }): Promise<void>;
}

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

/** A storage call failed; the message names the operation and bucket, never credentials. */
export class ObjectStorageError extends Error {
  readonly code = 'OBJECT_STORAGE_FAILED';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ObjectStorageError';
  }
}
