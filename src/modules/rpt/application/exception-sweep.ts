import { toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditFindings } from '../../../platform/audit/audit-findings';
import type { UnitOfWork } from '../../../platform/database/unit-of-work';
import type { MasterDataRefs } from '../../mdm';
import type { PurchaseOrders } from '../../pur';
import { breakFromView, type ExceptionDraft } from '../domain/classify';
import { AUDIT_FINDING_ACTIONS, auditFinding, orderSplitting, stockException, verificationFailure } from '../domain/sweep';
import type { ExceptionProjector } from './exception-projector';
import type { ExceptionStore } from './exception-store';

const DAY_MS = 86_400_000;
/** The nightly audit verification's job name in `platform.job_run` (ADR-0006). */
const AUDIT_VERIFY_JOB = 'audit-verify';

export interface SweepReport {
  readonly date: string;
  readonly found: number;
  readonly raised: number;
}

/**
 * The exception report's sweep (ADR-0103): the sources that are records, not events, read for one Africa/Accra day
 * (Africa/Accra keeps UTC all year, so a day is 00:00 to 24:00 UTC): the audit trail's refusals and exports, the audit
 * verification's runs that did not succeed, inventory's stock exception queue (`inv.pub_stock_exception`), the
 * reconciliation breaks (`pay.pub_reconciliation_break`, for any the event did not bring) and PUR's order splitting
 * rule (`PurchaseOrders.splitSuspectsIn`). One item per record; an item an event raised is never replaced by its
 * record, and a second sweep of a day raises nothing new. The worker runs it for today and yesterday every quarter hour.
 */
export class ExceptionSweep {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ExceptionStore,
    private readonly projector: ExceptionProjector,
    private readonly audit: AuditFindings,
    private readonly purchaseOrders: PurchaseOrders,
    private readonly refs: MasterDataRefs,
    private readonly clock: Clock,
  ) {}

  sweepDay(date: string): Promise<SweepReport> {
    const from = new Date(`${date}T00:00:00Z`);
    const to = new Date(from.getTime() + DAY_MS);
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const headOffice = await this.refs.headOfficeBranchIn(tx);
      const drafts: ExceptionDraft[] = [];
      for (const row of await this.audit.eventsBetween(tx, { from, to }, AUDIT_FINDING_ACTIONS)) {
        const draft = auditFinding(row);
        if (draft !== null) drafts.push(draft);
      }
      for (const run of await this.audit.unsuccessfulRunsBetween(tx, AUDIT_VERIFY_JOB, { from, to })) drafts.push(verificationFailure(run, headOffice));
      for (const row of await this.store.stockExceptionsBetween(tx, from, to)) drafts.push(stockException(row));
      for (const row of await this.store.breaksBetween(tx, from, to)) drafts.push(breakFromView(row));
      for (const suspect of await this.purchaseOrders.splitSuspectsIn(tx, from, to)) drafts.push(orderSplitting(suspect, headOffice));
      const raised = await this.projector.putIn(tx, drafts, null, false);
      return { date, found: drafts.length, raised };
    });
  }

  /** The job: today and yesterday, so a record written just before midnight is swept on its own day. */
  async run(): Promise<{ readonly days: readonly SweepReport[] }> {
    const today = toBusinessDate(this.clock.now());
    const yesterday = toBusinessDate(new Date(this.clock.now().getTime() - DAY_MS));
    return { days: [await this.sweepDay(yesterday), await this.sweepDay(today)] };
  }
}
