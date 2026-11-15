import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { Authoriser } from '../../iam';
import type { CostElement, LinkType, StockStore, UnitLink, UnitMovement } from './stock-store';

/** Movement types that issue stock to a customer: the forward trace's sales. */
const SALE_TYPES: ReadonlySet<string> = new Set(['SALE_ISSUE', 'SALE_ISSUE_OFFLINE']);

export interface TracedUnit extends UnitLink {
  /** Value that entered this unit's pool, by cost element (purchase, feed, veterinary and so on), reversals netted. */
  readonly costByElement: Readonly<Partial<Record<CostElement, number>>>;
  readonly movements: readonly UnitMovement[];
}

export interface Trace {
  readonly unit: TracedUnit;
  /** What this unit came from, nearest first: the processing order, the input animals, their suppliers and receipts. */
  readonly backward: readonly TracedUnit[];
  /** What came from this unit, nearest first. */
  readonly forward: readonly TracedUnit[];
  /** Every sale of this unit or of anything that came from it, with its source document (the order). */
  readonly sales: readonly UnitMovement[];
}

function costByElement(movements: readonly UnitMovement[]): Partial<Record<CostElement, number>> {
  const totals: Partial<Record<CostElement, bigint>> = {};
  const reversed = new Set(movements.filter((m) => m.reversesMovementId !== null).flatMap((m) => [m.id, m.reversesMovementId!]));
  for (const m of movements) {
    if (m.costElement !== null && !reversed.has(m.id)) {
      totals[m.costElement] = (totals[m.costElement] ?? 0n) + m.valuePesewas;
    }
  }
  return Object.fromEntries(Object.entries(totals).map(([element, value]) => [element, Number(value)]));
}

/**
 * Lot genealogy (FR-INV-006, ADR-0018): processing, splits, repacks and births write which unit came from which in
 * the caller's transaction; `trace` answers both directions in one call, with each unit's cost by element and the
 * sales downstream, so a sold meat lot reaches its animal and supplier in one request.
 */
export class Lineage {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: StockStore,
    private readonly authoriser: Authoriser,
  ) {}

  /** Records that `childUnitId` came from each parent. The caller's command has authorised the document. */
  async linkIn(tx: Transaction, actorId: string, childUnitId: string, parentUnitIds: readonly string[], linkType: LinkType, sourceDocumentId: string): Promise<void> {
    for (const parent of new Set(parentUnitIds)) {
      await this.store.insertLineage(tx, childUnitId, parent, linkType, sourceDocumentId, actorId);
    }
  }

  trace(actor: Actor | undefined, unitId: string): Promise<Trace> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const backward = await this.store.lineage(tx, unitId, 'BACKWARD');
      const self = backward[0];
      await this.authoriser.authorise(tx, actor, 'inv.trace.read', { branchId: self?.branchId ?? null });
      if (self === undefined) {
        throw new NotFoundError(`no stock unit ${unitId}`);
      }
      const forward = await this.store.lineage(tx, unitId, 'FORWARD');
      const units = [...backward, ...forward.slice(1)];
      const movements = await this.store.movementsOf(tx, units.map((u) => u.unitId));
      const traced = (link: UnitLink): TracedUnit => {
        const own = movements.filter((m) => m.stockUnitId === link.unitId);
        return { ...link, costByElement: costByElement(own), movements: own };
      };
      const downstream = new Set(forward.map((u) => u.unitId));
      const reversedSales = new Set(movements.filter((m) => m.reversesMovementId !== null).map((m) => m.reversesMovementId!));
      return {
        unit: traced(self),
        backward: backward.slice(1).map(traced),
        forward: forward.slice(1).map(traced),
        sales: movements.filter((m) => downstream.has(m.stockUnitId) && SALE_TYPES.has(m.movementType) && m.reversesMovementId === null && !reversedSales.has(m.id)),
      };
    });
  }
}
