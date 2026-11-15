import { randomUUID } from 'node:crypto';
import type { Clock } from '@hakorem/kernel';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { AuditTrail } from '../audit/audit-trail';
import { runAsSystem } from '../context/request-context';
import type { UnitOfWork } from '../database/unit-of-work';
import type { Transaction } from '../database/unit-of-work';
import type { ImageRenderer, RenderedVariant } from './image-renderer';
import { isPublishedImage, variantKey } from './image-variant-plan';
import { MalwareScannerUnavailableError, type MalwareScanner, type ScanVerdict } from './malware-scanner';
import type { ObjectStorage } from './object-storage';

/** How the worker publishes a clean public photograph (FR-DOC-005, ADR-0045). */
export interface VariantPublishing {
  readonly renderer: ImageRenderer;
  /** The public media bucket; null when it is not configured, and then a public photograph stays PENDING. */
  readonly publicBucket: string | null;
  /** Create the bucket, readable by anyone, on first use: development and test only. */
  readonly ensureBucket: boolean;
}

interface PublishedVariant {
  readonly rendered: RenderedVariant;
  readonly bucket: string;
  readonly objectKey: string;
}

/** A file read from storage could not be published; it stays PENDING and is tried again next round. */
class PublishDeferred extends Error {}

/** The SYSTEM principal the scanner acts as (migration 0034). */
export const SCANNER_PRINCIPAL = { principalId: '01900000-0000-7000-8000-000000000005', displayName: 'Malware scanner' } as const;

export interface ScanRound {
  readonly clean: number;
  readonly infected: number;
  readonly failed: number;
  /** Left PENDING because the scanner or the store could not be reached; tried again next round. */
  readonly deferred: number;
  /** Clean public photographs whose variants were published with the verdict. */
  readonly published: number;
}

const VERDICT_STATUS = { CLEAN: 'CLEAN', INFECTED: 'INFECTED', FAILED: 'FAILED' } as const;
/** `platform.stored_file.scan_verdict` holds at most 200 characters (migration 0033). */
const MAX_VERDICT_LENGTH = 200;

function verdictText(verdict: ScanVerdict): string | null {
  switch (verdict.outcome) {
    case 'CLEAN':
      return null;
    case 'INFECTED':
      return verdict.signature.slice(0, MAX_VERDICT_LENGTH);
    case 'FAILED':
      return verdict.reason.slice(0, MAX_VERDICT_LENGTH);
  }
}

/**
 * The worker's scan of every PENDING file (FR-DOC-006, A-057): read the object, send it to the scanner, and record
 * the verdict once, with its audit event, as the scanner principal. The bytes are read and scanned outside any
 * transaction; only the verdict is written in one. A file the scanner cannot reach stays PENDING, and PENDING is
 * never served. Running as `hk_worker` is what lets the row change: the database refuses a verdict from any other role.
 */
export class FileScanner {
  constructor(
    private readonly pool: pg.Pool,
    private readonly uow: UnitOfWork,
    private readonly storage: ObjectStorage,
    private readonly scanner: MalwareScanner,
    private readonly audit: AuditTrail,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly publishing: VariantPublishing | null = null,
  ) {}

  async scanPending(limit: number): Promise<ScanRound> {
    const { rows } = await this.pool.query<{ id: string; bucket: string; object_key: string; classification: string; content_type: string }>(
      `SELECT id, bucket, object_key, classification, content_type FROM platform.stored_file
        WHERE scan_status = 'PENDING' AND deleted_at IS NULL ORDER BY created_at LIMIT $1`,
      [limit],
    );
    const round = { clean: 0, infected: 0, failed: 0, deferred: 0, published: 0 };
    for (const row of rows) {
      let verdict: ScanVerdict;
      let content: Buffer;
      try {
        content = await this.storage.get(row.bucket, row.object_key);
        verdict = await this.scanner.scan(content);
      } catch (error) {
        round.deferred += 1;
        const unavailable = error instanceof MalwareScannerUnavailableError;
        this.logger.error({ fileId: row.id, err: error }, unavailable ? 'malware scanner unavailable; the file stays PENDING' : 'could not read a file to scan; it stays PENDING');
        continue;
      }
      let variants: readonly PublishedVariant[] = [];
      if (verdict.outcome === 'CLEAN' && isPublishedImage(row.classification, row.content_type)) {
        // Only a photograph the scanner passed is decoded, and it is CLEAN only once its variants are public.
        try {
          const published = await this.publish(row.id, content);
          if (published.ok) variants = published.variants;
          else verdict = { outcome: 'FAILED', reason: published.reason };
        } catch (error) {
          round.deferred += 1;
          this.logger.error({ fileId: row.id, err: error }, 'could not publish the variants of a photograph; it stays PENDING');
          continue;
        }
      }
      await this.record(row.id, verdict, variants);
      if (verdict.outcome === 'CLEAN') round.clean += 1;
      else if (verdict.outcome === 'INFECTED') round.infected += 1;
      else round.failed += 1;
      if (variants.length > 0) round.published += 1;
    }
    return round;
  }

  /**
   * Re-encodes a clean photograph and puts each variant in the public bucket, outside any transaction. A photograph
   * that cannot be re-encoded within its budgets is refused with the reason; storage that cannot be reached defers it.
   */
  private async publish(fileId: string, content: Buffer): Promise<{ ok: true; variants: readonly PublishedVariant[] } | { ok: false; reason: string }> {
    const publishing = this.publishing;
    if (publishing === null || publishing.publicBucket === null) {
      throw new PublishDeferred('no public media bucket is configured (S3_BUCKET_PUBLIC_MEDIA)');
    }
    const bucket = publishing.publicBucket;
    const rendered = await publishing.renderer.render(content);
    if (!rendered.ok) return rendered;
    if (publishing.ensureBucket && !this.publicBucketReady) {
      await this.storage.ensureBucket(bucket, { objectLock: false, publicRead: true });
      this.publicBucketReady = true;
    }
    const variants: PublishedVariant[] = [];
    for (const variant of rendered.variants) {
      const objectKey = variantKey(fileId, variant.variant, variant);
      await this.storage.put(bucket, objectKey, variant.content, { contentType: variant.contentType });
      variants.push({ rendered: variant, bucket, objectKey });
    }
    return { ok: true, variants };
  }

  private publicBucketReady = false;

  private async record(fileId: string, verdict: ScanVerdict, variants: readonly PublishedVariant[]): Promise<void> {
    const status = VERDICT_STATUS[verdict.outcome];
    const text = verdictText(verdict);
    await runAsSystem(SCANNER_PRINCIPAL, randomUUID(), () =>
      this.uow.run({ isolation: 'read committed' }, async (tx) => {
        const { rowCount } = await tx.query(
          `UPDATE platform.stored_file SET scan_status = $2, scanned_at = $3, scan_verdict = $4, updated_by = $5, version = version + 1
            WHERE id = $1 AND scan_status = 'PENDING'`,
          [fileId, status, this.clock.now(), text, SCANNER_PRINCIPAL.principalId],
        );
        if (rowCount === 0) return;
        await this.recordVariants(tx, fileId, variants);
        await this.audit.record(tx, {
          module: 'platform',
          action: 'UPDATE',
          entityType: 'StoredFile',
          entityId: fileId,
          before: { scanStatus: 'PENDING' },
          after: { scanStatus: status, verdict: text, ...(variants.length === 0 ? {} : { variants: variants.map((v) => ({ key: v.objectKey, width: v.rendered.width, sizeBytes: v.rendered.content.length })) }) },
        });
      }),
    );
    if (status === 'FAILED' && text !== null && text.startsWith('image ')) {
      this.logger.warn({ fileId, reason: text }, 'a photograph could not be re-encoded; it is refused and never served');
    }
    if (status === 'INFECTED') {
      this.logger.warn({ fileId, signature: text }, 'an uploaded file is infected; it is quarantined and never served');
    }
  }

  private async recordVariants(tx: Transaction, fileId: string, variants: readonly PublishedVariant[]): Promise<void> {
    for (const { rendered, bucket, objectKey } of variants) {
      await tx.query(
        `INSERT INTO platform.stored_file_variant (file_id, variant, content_type, bucket, object_key, width, height, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [fileId, rendered.variant, rendered.contentType, bucket, objectKey, rendered.width, rendered.height, rendered.content.length],
      );
    }
  }
}
