import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { DomainEvents } from '../../../platform/events/domain-events';
import { jsonPesewas } from '../domain/balance';
import { CURRENT_EARNINGS_CODE, DISTRIBUTIONS_DECLARED_CODE, yearCloseAmounts, type YearEndBalance } from '../domain/year-close';
import type { YearClosed } from '../events';
import type { PeriodRow } from './chart-store';
import type { JournalStore } from './journal-store';
import type { StatementStore } from './statement-store';

export const YEAR_CLOSED = 'fin.YearClosed';
export const YEAR_CLOSE_DOCUMENT = 'YEAR_CLOSE';
/** The last monthly period of a fiscal year (A-028). */
export const LAST_PERIOD_NO = 12;

/** What one branch's year close posted. */
export interface BranchYearClose {
  readonly branchId: string;
  readonly yearCloseId: string;
  readonly journalEntryId: string;
  readonly earningsToRetainedPesewas: number;
  readonly lossToRetainedPesewas: number;
}

/**
 * The year close (FR-FIN-010, ADR-0003, ADR-0058). Run by `Periods.close` when the last period of a year closes, in that
 * serializable transaction and before the period's status changes: for each branch with a balance to close it registers
 * a `YEAR_CLOSE` document and publishes `fin.YearClosed`, which the ledger posts as that branch's CLOSING entry on the
 * last day of the year. The database admits that entry into the LOCKED period, refuses a second one, and refuses it at
 * commit unless the period closed with it. Every period of the year is already closed, so nothing else can post into it.
 */
export class YearClose {
  private readonly nextId: () => string;

  constructor(
    private readonly store: StatementStore,
    private readonly journals: JournalStore,
    private readonly events: DomainEvents,
    private readonly documents: DocumentRegistry,
    private readonly audit: AuditTrail,
    clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  async closeIn(tx: Transaction, period: PeriodRow, actorId: string): Promise<BranchYearClose[]> {
    const balances = await this.store.yearEndBalances(tx, period.endDate, [CURRENT_EARNINGS_CODE, DISTRIBUTIONS_DECLARED_CODE]);
    const byBranch = new Map<string, YearEndBalance[]>();
    for (const { branchId, ...balance } of balances) byBranch.set(branchId, [...(byBranch.get(branchId) ?? []), balance]);
    const closed: BranchYearClose[] = [];
    for (const [branchId, rows] of [...byBranch].sort(([a], [b]) => a.localeCompare(b))) {
      const amounts = yearCloseAmounts(rows);
      if (amounts.length === 0) continue;
      const yearCloseId = this.nextId();
      await this.documents.register(tx, { id: yearCloseId, docType: YEAR_CLOSE_DOCUMENT, ownerModule: 'fin', branchId, actorId });
      await this.events.publish<YearClosed>(tx, {
        type: YEAR_CLOSED,
        subjectType: 'YearClose',
        subjectId: yearCloseId,
        branchId,
        payload: {
          yearCloseId,
          fiscalYear: period.fiscalYear,
          periodId: period.id,
          postingDate: period.endDate,
          amounts: amounts.map((a) => ({ key: a.key, accountId: a.closedAccountId ?? null, subledger: a.subledgers?.[0] ?? null, amountPesewas: a.amount.toJsonInteger() })),
        },
      });
      const journalEntryId = await this.journals.entryOfSubject(tx, yearCloseId);
      if (journalEntryId === null) throw new Error(`year close ${period.fiscalYear} of branch ${branchId} was published but the ledger posted no entry`);
      const moved = (key: string) => jsonPesewas(amounts.filter((a) => a.key === key).reduce((sum, a) => sum + a.amount.pesewas, 0n));
      const result = { branchId, yearCloseId, journalEntryId, earningsToRetainedPesewas: moved('earningsToRetained'), lossToRetainedPesewas: moved('lossToRetained') };
      await this.audit.record(tx, {
        module: 'fin',
        action: 'CLOSE_YEAR',
        entityType: 'AccountingPeriod',
        entityId: period.id,
        branchId,
        before: { status: period.status, fiscalYear: period.fiscalYear },
        after: { fiscalYear: period.fiscalYear, yearCloseId, journalEntryId, earningsToRetainedPesewas: result.earningsToRetainedPesewas, lossToRetainedPesewas: result.lossToRetainedPesewas },
      });
      closed.push(result);
    }
    return closed;
  }
}
