import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DomainEvents } from '../../../platform/events/domain-events';
import { jsonPesewas as json } from '../domain/tender';
import type { UnverifiedPaymentOverdue } from '../events';
import { UNVERIFIED_PAYMENT_OVERDUE } from './payments';
import type { ReconciliationStore } from './reconciliation-store';

/** How many overdue tenders one run raises; the next run takes the rest. */
const OVERDUE_BATCH = 200;
/** A forged mobile money confirmation (THREAT_MODEL abuse case 4). */
const ABUSE_FORGED_CONFIRMATION = 4;

/**
 * The verification that never comes (OFFLINE_SYNC 9.9, A-282 (e), BL-086 for this kind): an unverified offline mobile
 * money tender still waiting in 1115 once its `pay.unverified_window_days` have passed (the break's `urgentFrom`) is
 * raised URGENT, once per break (`pay.unverified_overdue`), by ◆-less `pay.UnverifiedPaymentOverdue` for the daily
 * exception report's source. Nothing posts and nothing resolves: the money stays in clearing until it is verified or
 * reversed as never received. It runs as the scheduler's SYSTEM principal only; the time is the clock's (ADR-0067).
 */
export class UnverifiedOverdue {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ReconciliationStore,
    private readonly events: DomainEvents,
    private readonly audit: AuditTrail,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  run(system: Pick<Actor, 'kind' | 'principalId'>): Promise<readonly string[]> {
    if (system.kind !== 'SYSTEM') throw new Error('the unverified tender sweep runs as a SYSTEM principal only');
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const now = this.clock.now();
      const raised: string[] = [];
      for (const due of await this.store.overdueUnverified(tx, now, OVERDUE_BATCH)) {
        const first = await this.store.insertOverdue(tx, { id: this.nextId(), breakId: due.breakId, paymentId: due.paymentId, branchId: due.branchId, amountPesewas: due.amountPesewas, urgentFrom: due.urgentFrom, recordedAt: now, actorId: system.principalId });
        if (!first) continue;
        const payload: UnverifiedPaymentOverdue = {
          breakId: due.breakId,
          paymentId: due.paymentId,
          branchId: due.branchId,
          amountPesewas: json(due.amountPesewas),
          reference: due.reference,
          urgentFrom: due.urgentFrom.toISOString(),
          exceptionKind: 'UNMATCHED_PAYMENT',
          severity: 'URGENT',
          abuseCases: [ABUSE_FORGED_CONFIRMATION],
          details: { ...due.details, overdueSince: due.urgentFrom.toISOString(), stillIn: '1115' },
        };
        await this.events.publish(tx, { type: UNVERIFIED_PAYMENT_OVERDUE, subjectType: 'ReconciliationBreak', subjectId: due.breakId, branchId: due.branchId, payload });
        await this.audit.record(tx, { module: 'pay', action: 'RAISE', entityType: 'ReconciliationBreak', entityId: due.breakId, branchId: due.branchId, before: null, after: { severity: 'URGENT', overdueSince: due.urgentFrom.toISOString(), paymentId: due.paymentId } });
        raised.push(due.breakId);
      }
      return raised;
    });
  }
}
