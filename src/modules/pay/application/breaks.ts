import { createUuidV7Generator, Money, type Clock } from '@hakorem/kernel';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { ReconciliationBreakRaised } from '../events';
import type { NewBreak, PaymentStore } from './payment-store';

export const BREAK_RAISED = 'pay.ReconciliationBreakRaised';

/**
 * The reconciliation break queue (FR-PAY-017): reconciliation never corrects, it raises one of these for a person.
 * The same open break is raised once (the database's unique keys); a new one publishes `pay.ReconciliationBreakRaised`
 * for the daily exception report (B12).
 */
export class Breaks {
  private readonly nextId: () => string;

  constructor(
    private readonly store: PaymentStore,
    private readonly events: DomainEvents,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  async raiseIn(tx: Transaction, actorId: string, b: Omit<NewBreak, 'id' | 'raisedAt' | 'actorId'>): Promise<boolean> {
    const id = this.nextId();
    const raised = await this.store.raiseBreak(tx, { ...b, id, raisedAt: this.clock.now(), actorId });
    if (raised) {
      const payload: ReconciliationBreakRaised = {
        breakId: id,
        kind: b.kind,
        branchId: b.branchId,
        paymentId: b.paymentId,
        refundId: b.refundId,
        reference: b.reference,
        amountPesewas: b.amountPesewas === null ? null : Money.ofPesewas(b.amountPesewas).toJsonInteger(),
      };
      await this.events.publish(tx, { type: BREAK_RAISED, subjectType: 'ReconciliationBreak', subjectId: id, branchId: b.branchId, payload });
    }
    return raised;
  }
}
