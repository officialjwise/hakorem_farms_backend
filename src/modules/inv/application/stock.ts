import { Money, createUuidV7Generator, type Clock, type Quantity, type Weight } from '@hakorem/kernel';
import { IsolationLevelError, type Transaction } from '../../../platform/database/unit-of-work';
import type { DomainEvents } from '../../../platform/events/domain-events';
import { translateStockRefusal } from './errors';
import type { CostElement, StockStore, WeightSource } from './stock-store';

/** A movement a command posts. The value of anything leaving a physical location is the database's, from the pool. */
export interface MovementRequest {
  readonly movementType: string;
  readonly productId: string;
  readonly stockUnitId?: string | null;
  readonly branchId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly qty: Quantity;
  readonly weight?: { readonly kg: Weight; readonly source: WeightSource } | null;
  readonly packCount?: number | null;
  /** The value a receipt or a value-only movement brings in; ignored for an issue or a reversal. */
  readonly value?: Money;
  readonly costElement?: CostElement | null;
  readonly reasonCode?: string | null;
  readonly sourceDocumentId: string;
  readonly sourceLineRef?: string | null;
  readonly reservationId?: string | null;
  readonly reversesMovementId?: string | null;
  readonly occurredAt: Date;
}

export interface PostedMovement {
  readonly id: string;
  /** What the movement carried, as the trigger decided it (ADR-0018). */
  readonly value: Money;
}

/** The ledger posting event's payload: named amounts and determinants, never an account (ADR-0003). */
export interface StockPostingPayload {
  readonly movementId: string;
  readonly movementType: string;
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly qty: string;
  readonly valuePesewas: number;
  readonly costElement: CostElement | null;
  readonly reasonCode: string | null;
  readonly sourceDocumentId: string;
  readonly reversesMovementId: string | null;
}

/**
 * INV's `Stock` interface (MODULE_BOUNDARIES, INV card): post movements for a document inside the caller's
 * transaction. The caller has authorised its own command; this checks only what a stock entry point must (ADR-0005):
 * that the transaction is serializable. Every invariant is the trigger's; a refusal comes back as the API error the
 * rule names. A movement whose type posts to the ledger publishes that event through the outbox, in the same
 * transaction, with the value the database decided.
 */
export class Stock {
  private readonly nextId: () => string;

  constructor(
    private readonly store: StockStore,
    private readonly events: DomainEvents,
    clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  async postIn(tx: Transaction, actorId: string, request: MovementRequest): Promise<PostedMovement> {
    if (tx.isolation !== 'serializable') {
      throw new IsolationLevelError(tx.isolation);
    }
    const id = this.nextId();
    const row = {
      id,
      movementType: request.movementType,
      productId: request.productId,
      stockUnitId: request.stockUnitId ?? null,
      branchId: request.branchId,
      fromLocationId: request.fromLocationId,
      toLocationId: request.toLocationId,
      qtyBase: request.qty.toDecimalString(),
      weightKg: request.weight?.kg.toKgString() ?? null,
      weightSource: request.weight?.source ?? null,
      packCount: request.packCount ?? null,
      valuePesewas: request.value?.pesewas ?? 0n,
      costElement: request.costElement ?? null,
      reasonCode: request.reasonCode ?? null,
      sourceDocumentId: request.sourceDocumentId,
      sourceLineRef: request.sourceLineRef ?? null,
      reservationId: request.reservationId ?? null,
      reversesMovementId: request.reversesMovementId ?? null,
      occurredAt: request.occurredAt,
      actorId,
    };
    const posted = await this.store.insertMovement(tx, row).catch(translateStockRefusal);
    const value = Money.ofPesewas(posted.valuePesewas);
    if (posted.postingEvent !== null) {
      await this.events.publish<StockPostingPayload>(tx, {
        type: posted.postingEvent,
        subjectType: 'StockMovement',
        subjectId: id,
        branchId: request.branchId,
        occurredAt: request.occurredAt,
        payload: {
          movementId: id,
          movementType: row.movementType,
          productId: row.productId,
          stockUnitId: row.stockUnitId,
          fromLocationId: row.fromLocationId,
          toLocationId: row.toLocationId,
          qty: row.qtyBase,
          valuePesewas: value.toJsonInteger(),
          costElement: row.costElement,
          reasonCode: row.reasonCode,
          sourceDocumentId: row.sourceDocumentId,
          reversesMovementId: row.reversesMovementId,
        },
      });
    }
    return { id, value };
  }
}
