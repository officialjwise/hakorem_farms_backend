import type { Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { NumberSeries, SeriesGap } from '../../../platform/documents/number-series';
import type { Documents } from '../../doc';
import type { BillingStore } from './billing-store';

const BILLING_TYPES = ['PROFORMA', 'INVOICE', 'RECEIPT', 'CREDIT_NOTE', 'DEBIT_NOTE'] as const;
/** An issued document is rendered within seconds; one still without its archive after an hour is reported. */
export const ARCHIVE_GRACE_MS = 3_600_000;

export interface NumberingAuditReport {
  /** Billing series whose allocations are not exactly 1 to `next_value - 1`. */
  readonly gaps: readonly SeriesGap[];
  /** Numbers allocated to a document that is not an issued billing document with that number. */
  readonly orphans: readonly { readonly docType: string; readonly documentId: string; readonly documentNo: string }[];
  /** Issued documents still without their archived rendering after the grace period. */
  readonly unarchived: readonly { readonly id: string; readonly documentNo: string }[];
  /** Documents whose content hash is not the SHA-256 their archive holds. */
  readonly hashMismatches: readonly { readonly id: string; readonly documentNo: string }[];
  readonly clean: boolean;
}

/**
 * The nightly numbering audit (FR-BIL-003, ADR-0015): per billing series, the allocations are exactly 1 to
 * `next_value - 1` and every allocated number belongs to an issued document that carries it; every issued document
 * has its archived rendering and its content hash is the archive's SHA-256. It reports and alerts; it never repairs.
 */
export class BillingNumberingAudit {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: BillingStore,
    private readonly numbers: NumberSeries,
    private readonly archive: Documents,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async reportIn(tx: Transaction): Promise<NumberingAuditReport> {
    const gaps = (await this.numbers.gapsIn(tx)).filter((g) => (BILLING_TYPES as readonly string[]).includes(g.docType));
    const allocations = await this.numbers.allocationsOf(tx, BILLING_TYPES);
    const issued = await this.store.issuedForAudit(tx);
    const byId = new Map(issued.map((d) => [d.id, d] as const));
    const orphans = allocations.filter((a) => byId.get(a.documentId)?.documentNo !== a.formatted).map((a) => ({ docType: a.docType, documentId: a.documentId, documentNo: a.formatted }));
    const cutoff = this.clock.now().getTime() - ARCHIVE_GRACE_MS;
    const unarchived = issued.filter((d) => d.archivedDocumentId === null && d.issuedAt.getTime() < cutoff).map((d) => ({ id: d.id, documentNo: d.documentNo }));
    const linked = issued.filter((d) => d.archivedDocumentId !== null);
    const archives = new Map((await this.archive.archivedIn(tx, linked.map((d) => d.archivedDocumentId!))).map((a) => [a.id, a] as const));
    const hashMismatches = linked
      .filter((d) => {
        const archived = archives.get(d.archivedDocumentId!);
        return archived === undefined || archived.businessDocumentId !== d.id || !archived.sha256.equals(d.contentHash!);
      })
      .map((d) => ({ id: d.id, documentNo: d.documentNo }));
    return { gaps, orphans, unarchived, hashMismatches, clean: gaps.length + orphans.length + unarchived.length + hashMismatches.length === 0 };
  }

  run(system: Actor): Promise<NumberingAuditReport> {
    if (system.kind !== 'SYSTEM') throw new Error('the numbering audit runs as a SYSTEM principal only');
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const report = await this.reportIn(tx);
      if (!report.clean) {
        this.logger.error(
          { gaps: report.gaps.map((g) => g.seriesId), orphans: report.orphans.map((o) => o.documentNo), unarchived: report.unarchived.map((u) => u.documentNo), hashMismatches: report.hashMismatches.map((h) => h.documentNo) },
          'billing numbering audit found a gap, an orphan or an unarchived document',
        );
      }
      return report;
    });
  }
}
