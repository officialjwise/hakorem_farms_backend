import type { Logger } from 'pino';
import type { Actor } from '../../../platform/context/request-context';
import type { UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { DriftRow, StockStore } from './stock-store';

export interface DriftFound extends DriftRow {
  readonly exceptionId: string;
}

/**
 * The nightly recompute (FR-INV-003, ADR-0002): every balance and cost pool is summed afresh from the ledger and
 * compared with its projection. Each difference raises one `BALANCE_DRIFT` stock exception with both figures and an
 * `inv.BalanceDriftDetected` event, and is logged as an alert. Nothing is corrected: the projection stays as found,
 * for a person to investigate. Read committed: it only reads the ledger and writes exceptions.
 */
export class BalanceReconciliation {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: StockStore,
    private readonly events: DomainEvents,
    private readonly logger: Logger,
  ) {}

  run(system: Actor): Promise<readonly DriftFound[]> {
    if (system.kind !== 'SYSTEM') {
      throw new Error('the balance recompute runs as a SYSTEM principal only');
    }
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const found: DriftFound[] = [];
      for (const row of await this.store.drift(tx)) {
        const exceptionId = await this.store.raiseDrift(tx, row);
        await this.events.publish(tx, {
          type: 'inv.BalanceDriftDetected',
          subjectType: 'StockException',
          subjectId: exceptionId,
          branchId: row.branchId,
          payload: {
            projection: row.kind,
            productId: row.productId,
            stockUnitId: row.stockUnitId,
            locationId: row.locationId,
            projectedQty: row.projectedQty,
            ledgerQty: row.ledgerQty,
            projectedValuePesewas: row.projectedValuePesewas === null ? null : Number(row.projectedValuePesewas),
            ledgerValuePesewas: row.ledgerValuePesewas === null ? null : Number(row.ledgerValuePesewas),
          },
        });
        found.push({ ...row, exceptionId });
      }
      if (found.length > 0) {
        this.logger.error({ drift: found.length, exceptions: found.map((f) => f.exceptionId) }, 'stock balance drift detected; nothing was corrected');
      }
      return found;
    });
  }
}
