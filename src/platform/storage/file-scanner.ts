import { randomUUID } from 'node:crypto';
import type { Clock } from '@hakorem/kernel';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { AuditTrail } from '../audit/audit-trail';
import { runAsSystem } from '../context/request-context';
import type { UnitOfWork } from '../database/unit-of-work';
import { MalwareScannerUnavailableError, type MalwareScanner, type ScanVerdict } from './malware-scanner';
import type { ObjectStorage } from './object-storage';

/** The SYSTEM principal the scanner acts as (migration 0034). */
export const SCANNER_PRINCIPAL = { principalId: '01900000-0000-7000-8000-000000000005', displayName: 'Malware scanner' } as const;

export interface ScanRound {
  readonly clean: number;
  readonly infected: number;
  readonly failed: number;
  /** Left PENDING because the scanner or the store could not be reached; tried again next round. */
  readonly deferred: number;
}

const VERDICT_STATUS = { CLEAN: 'CLEAN', INFECTED: 'INFECTED', FAILED: 'FAILED' } as const;

function verdictText(verdict: ScanVerdict): string | null {
  switch (verdict.outcome) {
    case 'CLEAN':
      return null;
    case 'INFECTED':
      return verdict.signature;
    case 'FAILED':
      return verdict.reason;
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
  ) {}

  async scanPending(limit: number): Promise<ScanRound> {
    const { rows } = await this.pool.query<{ id: string; bucket: string; object_key: string }>(
      `SELECT id, bucket, object_key FROM platform.stored_file WHERE scan_status = 'PENDING' AND deleted_at IS NULL ORDER BY created_at LIMIT $1`,
      [limit],
    );
    const round = { clean: 0, infected: 0, failed: 0, deferred: 0 };
    for (const row of rows) {
      let verdict: ScanVerdict;
      try {
        verdict = await this.scanner.scan(await this.storage.get(row.bucket, row.object_key));
      } catch (error) {
        round.deferred += 1;
        const unavailable = error instanceof MalwareScannerUnavailableError;
        this.logger.error({ fileId: row.id, err: error }, unavailable ? 'malware scanner unavailable; the file stays PENDING' : 'could not read a file to scan; it stays PENDING');
        continue;
      }
      await this.record(row.id, verdict);
      if (verdict.outcome === 'CLEAN') round.clean += 1;
      else if (verdict.outcome === 'INFECTED') round.infected += 1;
      else round.failed += 1;
    }
    return round;
  }

  private async record(fileId: string, verdict: ScanVerdict): Promise<void> {
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
        await this.audit.record(tx, {
          module: 'platform',
          action: 'UPDATE',
          entityType: 'StoredFile',
          entityId: fileId,
          before: { scanStatus: 'PENDING' },
          after: { scanStatus: status, verdict: text },
        });
      }),
    );
    if (status === 'INFECTED') {
      this.logger.warn({ fileId, signature: text }, 'an uploaded file is infected; it is quarantined and never served');
    }
  }
}
