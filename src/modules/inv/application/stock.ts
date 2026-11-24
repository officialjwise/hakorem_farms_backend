import { Money, createUuidV7Generator, type Clock, type Quantity, type Weight } from '@hakorem/kernel';
import { databaseErrorOf, IsolationLevelError, type Transaction } from '../../../platform/database/unit-of-work';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { NegativeStockCosted, NegativeStockTrueUp, UpkeepExpensed } from '../events';
import { translateStockRefusal } from './errors';
import type { ConflictRow, CostElement, MovementRow, PostedRow, StockStore, WeightSource } from './stock-store';

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
  /** The sale issue a SALE_RETURN takes back; the database then sets its value and cost element (migration 0199). */
  readonly returnsMovementId?: string | null;
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

/** What is told when available stock of products may have changed, in the same transaction (FR-INV-015). */
export interface AvailabilityWatch {
  evaluateIn(tx: Transaction, actorId: string, productIds: readonly string[]): Promise<unknown>;
}

/**
 * INV's `Stock` interface (MODULE_BOUNDARIES, INV card): post movements for a document inside the caller's
 * transaction. The caller has authorised its own command; this checks only what a stock entry point must (ADR-0005):
 * that the transaction is serializable. Every invariant is the trigger's; a refusal comes back as the API error the
 * rule names. A movement whose type posts to the ledger publishes that event through the outbox, in the same
 * transaction, with the value the database decided. Every movement then has the product's reorder rules judged in
 * the same transaction, so a low-stock alert is raised once, when available stock crosses its level (FR-INV-015).
 */
/**
 * The events INV publishes that post to the ledger (◆ in docs/DOMAIN_MODEL.md section 5): the posting events of its
 * movement types (`inv.movement_type.posting_event`, migration 0044) and `inv.UpkeepExpensed`. Declared to the event bus
 * at module init, so FIN's boot assertion refuses to start without a handler and rules for each (ADR-0003).
 * `inv.StockTransferredBetweenBranches` is not published yet: no movement type carries it (A-184).
 */
export const INV_LEDGER_EVENTS = [
  'inv.GoodsReceived',
  'inv.ProductionReceived',
  'inv.OpeningStockLoaded',
  'inv.CostCapitalised',
  'inv.UpkeepExpensed',
  'inv.StockConsumedInProcessing',
  'inv.ProcessingOutputReceived',
  'inv.StockIssuedForSale',
  'inv.SaleReturnReceived',
  'inv.StockWrittenOff',
  'inv.StockGainRecorded',
  'inv.SupplierReturnIssued',
  'inv.NegativeStockCosted',
  'inv.NegativeStockTrueUp',
  // B12 continued 2 (migration 0363, ADR-0102): OVERHEAD_CAPITALISE, a share of labour or overhead posted by CST.
  'inv.OverheadAbsorbed',
] as const;

/** The true-up of stock sold ahead of receipt (ADR-0081, migration 0286): a nil lift before the arrival, a valued issue after. */
export const NEGATIVE_TRUE_UP_IN = 'NEGATIVE_TRUE_UP_IN';
export const NEGATIVE_TRUE_UP = 'NEGATIVE_TRUE_UP';
const NEGATIVE_STOCK_COSTED = 'inv.NegativeStockCosted';
const NEGATIVE_STOCK_TRUE_UP = 'inv.NegativeStockTrueUp';
/** Where a true-up's nil lift comes from and its issue goes: the branch's virtual adjustment location. */
export interface AdjustmentLocations {
  virtualLocationIn(tx: Transaction, branchId: string, kind: string): Promise<string | null>;
}

/** The kinds of stock exception an offline sale's stock may raise (ADR-0027 points 3 and 4, OFFLINE_SYNC 8). */
export type OfflineConflictKind = ConflictRow['kind'];

/** The movement an offline sale asks for, with what the till said was true when it sold (an exception's claim). */
export interface OfflineIssueRequest extends Omit<MovementRequest, 'movementType' | 'value' | 'costElement' | 'reasonCode' | 'reservationId' | 'reversesMovementId' | 'returnsMovementId'> {
  readonly claim: unknown;
}

/** An exception an offline sale's stock raised, with what the server holds (the other half of its `{claim, fact}`). */
export interface OfflineException {
  readonly id: string;
  readonly kind: string;
  readonly qty: string | null;
  readonly fact: Readonly<Record<string, unknown>>;
}

/** What became of an offline sale's stock: it moved (perhaps with exceptions the trigger raised), or an exception stands in its place. */
export type OfflineIssueOutcome =
  | { readonly kind: 'MOVED'; readonly movement: PostedMovement; readonly exceptions: readonly OfflineException[] }
  | { readonly kind: 'NOT_MOVED'; readonly exception: OfflineException };

/** The offline sale's movement type: it may take countable stock below zero, raising an exception (migration 0044). */
export const SALE_ISSUE_OFFLINE = 'SALE_ISSUE_OFFLINE';

/** A refusal of the trigger, by the rule it names, as the conflict an offline sale records in the movement's place. */
const CONFLICT_BY_RULE: Readonly<Record<string, OfflineConflictKind>> = {
  ck_stock_serial_location: 'SERIAL_CONFLICT',
  ck_stock_unit_inactive: 'SERIAL_CONFLICT',
  ck_stock_in_transit: 'SERIAL_CONFLICT',
  ck_stock_on_hold: 'HOLD_CONFLICT',
  // A lot past its expiry is withheld from sale as a hold withholds it (A-278 (g)).
  ck_stock_expired: 'HOLD_CONFLICT',
  ck_stock_reserved: 'RESERVATION_CONFLICT',
  ck_stock_reservation_use: 'RESERVATION_CONFLICT',
  ck_stock_negative: 'NEGATIVE_STOCK',
  ck_stock_held: 'NEGATIVE_STOCK',
};

export class Stock {
  private readonly nextId: () => string;

  constructor(
    private readonly store: StockStore,
    private readonly events: DomainEvents,
    clock: Clock,
    private readonly watch: AvailabilityWatch,
    private readonly locations: AdjustmentLocations,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  async postIn(tx: Transaction, actorId: string, request: MovementRequest): Promise<PostedMovement> {
    if (tx.isolation !== 'serializable') {
      throw new IsolationLevelError(tx.isolation);
    }
    const row = this.rowOf(actorId, request);
    const owed = row.movementType === SALE_ISSUE_OFFLINE || Number(row.qtyBase) <= 0 ? null : await this.store.arrivalOwed(tx, row);
    if (owed !== null) return this.trueUpIn(tx, actorId, row, owed);
    const posted = await this.store.insertMovement(tx, row).catch(translateStockRefusal);
    return { id: row.id, value: await this.afterPosting(tx, actorId, row, posted) };
  }

  /**
   * An arrival into a pool that owes stock sold ahead of receipt (the owner's decision 2 of 2026-11-18, ADR-0081, A-283):
   * the owed quantity is lifted in at nil value from the branch's ADJUSTMENT location before the arrival, so the pool is
   * never left with value and no quantity (ck_cost_pool_empty), and issued back out after it, valued by the pool's own
   * rule (ADR-0018): exactly the arrival's cost of what it covers. The pair nets to nothing; the settlement takes the
   * oldest uncovered rows first and never more than is uncovered; ◆ `inv.NegativeStockTrueUp` clears their last known
   * cost from 1335 and takes the true cost out of inventory. Insert-only, in the arrival's own transaction.
   */
  private async trueUpIn(tx: Transaction, actorId: string, arrival: MovementRow, owed: { readonly toBranchId: string; readonly owedQty: string }): Promise<PostedMovement> {
    const adjustment = await this.locations.virtualLocationIn(tx, owed.toBranchId, 'ADJUSTMENT');
    if (adjustment === null) throw new Error(`branch ${owed.toBranchId} has no ADJUSTMENT location for a true-up`);
    const pair = { productId: arrival.productId, stockUnitId: arrival.stockUnitId, branchId: owed.toBranchId, qtyBase: owed.owedQty, sourceDocumentId: arrival.sourceDocumentId, occurredAt: arrival.occurredAt };
    const lift: MovementRow = { ...this.blankRow(actorId, pair), movementType: NEGATIVE_TRUE_UP_IN, fromLocationId: adjustment, toLocationId: arrival.toLocationId };
    await this.store.insertMovement(tx, lift).catch(translateStockRefusal);
    const posted = await this.store.insertMovement(tx, arrival).catch(translateStockRefusal);
    const value = await this.afterPosting(tx, actorId, arrival, posted);
    const issue: MovementRow = { ...this.blankRow(actorId, pair), movementType: NEGATIVE_TRUE_UP, fromLocationId: arrival.toLocationId, toLocationId: adjustment };
    await this.store.insertMovement(tx, issue).catch(translateStockRefusal);
    const settled = await this.store.settleNegativeStock(tx, lift.id, arrival.id, issue.id, actorId);
    const payload: NegativeStockTrueUp = {
      trueUpMovementId: issue.id,
      liftMovementId: lift.id,
      arrivalMovementId: arrival.id,
      productId: arrival.productId,
      stockUnitId: arrival.stockUnitId,
      branchId: owed.toBranchId,
      settledQty: settled.settledQty,
      clearedPesewas: Money.ofPesewas(settled.clearedPesewas).toJsonInteger(),
      trueUpPesewas: Money.ofPesewas(settled.trueUpPesewas).toJsonInteger(),
      sourceDocumentId: arrival.sourceDocumentId,
    };
    await this.events.publish<NegativeStockTrueUp>(tx, { type: NEGATIVE_STOCK_TRUE_UP, subjectType: 'StockMovement', subjectId: issue.id, branchId: owed.toBranchId, occurredAt: arrival.occurredAt, payload });
    return { id: arrival.id, value };
  }

  private blankRow(actorId: string, f: { readonly productId: string; readonly stockUnitId: string | null; readonly branchId: string; readonly qtyBase: string; readonly sourceDocumentId: string; readonly occurredAt: Date }): Omit<MovementRow, 'movementType' | 'fromLocationId' | 'toLocationId'> {
    return {
      id: this.nextId(),
      productId: f.productId,
      stockUnitId: f.stockUnitId,
      branchId: f.branchId,
      qtyBase: f.qtyBase,
      weightKg: null,
      weightSource: null,
      packCount: null,
      valuePesewas: 0n,
      costElement: null,
      reasonCode: null,
      sourceDocumentId: f.sourceDocumentId,
      sourceLineRef: null,
      reservationId: null,
      reversesMovementId: null,
      returnsMovementId: null,
      occurredAt: f.occurredAt,
      actorId,
    };
  }

  /**
   * An offline sale's stock (ADR-0027 points 3 and 4, OFFLINE_SYNC 7.1 step 5, B09b continued 2b): a `SALE_ISSUE_OFFLINE`
   * movement posted inside a savepoint. Countable and lot stock may go below zero, and the trigger raises its
   * NEGATIVE_STOCK (or RESERVATION_CONFLICT) exception beside the movement. A movement the trigger refuses (an animal
   * sold elsewhere or no longer where the sale says, under a hold or past its expiry, reserved for another order) is
   * rolled back to the savepoint and an exception is raised in its place, naming the till's claim and the server's
   * fact: the sale is never refused for its stock. Any other failure is the caller's. It authorises nothing.
   */
  async postOfflineIssueIn(tx: Transaction, actorId: string, request: OfflineIssueRequest, raisedAt: Date): Promise<OfflineIssueOutcome> {
    if (tx.isolation !== 'serializable') throw new IsolationLevelError(tx.isolation);
    const row = this.rowOf(actorId, { ...request, movementType: SALE_ISSUE_OFFLINE });
    await tx.query('SAVEPOINT offline_issue');
    let posted: PostedRow;
    try {
      posted = await this.store.insertMovement(tx, row);
    } catch (error) {
      const failure = databaseErrorOf(error);
      const kind = failure?.code === 'HK010' && failure.constraint !== undefined ? CONFLICT_BY_RULE[failure.constraint] : undefined;
      if (kind === undefined) throw error;
      await tx.query('ROLLBACK TO SAVEPOINT offline_issue');
      const standing = row.stockUnitId === null ? null : await this.store.unitStanding(tx, row.stockUnitId, row.occurredAt);
      const fact = {
        rule: failure!.constraint!,
        refusal: failure!.message ?? failure!.constraint!,
        ...(standing === null ? {} : { stockUnit: standing.identifier, status: standing.status, currentLocationId: standing.currentLocationId, holds: standing.holds }),
      };
      const id = await this.raiseConflictIn(
        tx,
        { kind, branchId: row.branchId, productId: row.productId, stockUnitId: row.stockUnitId, locationId: row.fromLocationId, sourceDocumentId: row.sourceDocumentId, qty: row.qtyBase, claim: request.claim, fact },
        raisedAt,
      );
      return { kind: 'NOT_MOVED', exception: { id, kind, qty: row.qtyBase, fact } };
    }
    await tx.query('RELEASE SAVEPOINT offline_issue');
    const value = await this.afterPosting(tx, actorId, row, posted);
    const raised = await this.store.exceptionsOfMovement(tx, row.id);
    // Beyond what the branch's pool held: costed at the last known cost by the database (ADR-0081), posted here.
    const uncovered = await this.store.negativeCostOf(tx, row.id);
    if (uncovered !== null) {
      await this.events.publish<NegativeStockCosted>(tx, {
        type: NEGATIVE_STOCK_COSTED,
        subjectType: 'StockMovement',
        subjectId: row.id,
        branchId: uncovered.branchId,
        occurredAt: row.occurredAt,
        payload: {
          negativeStockCostId: uncovered.id,
          movementId: row.id,
          productId: row.productId,
          stockUnitId: row.stockUnitId,
          branchId: uncovered.branchId,
          locationId: uncovered.locationId,
          uncoveredQty: uncovered.uncoveredQty,
          costKnown: uncovered.costKnown,
          valuePesewas: Money.ofPesewas(uncovered.valuePesewas).toJsonInteger(),
          sourceDocumentId: row.sourceDocumentId,
        },
      });
    }
    const countTaskId = raised.some((e) => e.kind === 'NEGATIVE_STOCK') ? await this.store.openCountTask(tx, row.fromLocationId, row.productId, row.stockUnitId) : null;
    const negativeFact = {
      countTaskId,
      uncoveredQty: uncovered?.uncoveredQty ?? null,
      costKnown: uncovered === null ? true : uncovered.costKnown,
      valuedAtLastKnownCostPesewas: uncovered === null ? null : Money.ofPesewas(uncovered.valuePesewas).toJsonInteger(),
    };
    return { kind: 'MOVED', movement: { id: row.id, value }, exceptions: raised.map((e) => ({ ...e, fact: e.kind === 'NEGATIVE_STOCK' ? { movementId: row.id, ...negativeFact } : { movementId: row.id } })) };
  }

  /**
   * An exception raised in the place of an offline sale's movement that could not even be attempted (a lot-tracked line
   * with no lot at the till's location to issue from, A-278 (f)): the sale is recorded, the stock is not moved.
   */
  async raiseConflictIn(tx: Transaction, c: Omit<ConflictRow, 'details' | 'raisedAt'> & { readonly claim: unknown; readonly fact: unknown }, raisedAt: Date): Promise<string> {
    const { claim, fact, ...row } = c;
    return this.store.raiseConflict(tx, { ...row, details: { claim, fact }, raisedAt });
  }

  private rowOf(actorId: string, request: MovementRequest): MovementRow {
    return {
      id: this.nextId(),
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
      returnsMovementId: request.returnsMovementId ?? null,
      occurredAt: request.occurredAt,
      actorId,
    };
  }

  /** The movement's ledger event with the value the database decided, then the reorder rules judged (FR-INV-015). */
  private async afterPosting(tx: Transaction, actorId: string, row: MovementRow, posted: PostedRow): Promise<Money> {
    const value = Money.ofPesewas(posted.valuePesewas);
    if (posted.postingEvent !== null) {
      await this.events.publish<StockPostingPayload>(tx, {
        type: posted.postingEvent,
        subjectType: 'StockMovement',
        subjectId: row.id,
        branchId: row.branchId,
        occurredAt: row.occurredAt,
        payload: {
          movementId: row.id,
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
    await this.watch.evaluateIn(tx, actorId, [row.productId]);
    return value;
  }

  /**
   * Records feed or veterinary cost spent on a breeding animal or flock (ADR-0018: expensed, not capitalised): no pool
   * changes, so no movement is written; the ledger event is published in the caller's transaction for B8 to post.
   */
  async expenseIn(
    tx: Transaction,
    request: { readonly stockUnitId: string; readonly productId: string; readonly branchId: string; readonly locationId: string; readonly value: Money; readonly costElement: 'FEED' | 'VETERINARY'; readonly sourceDocumentId: string; readonly sourceLineRef?: string | null; readonly occurredAt: Date },
  ): Promise<void> {
    if (tx.isolation !== 'serializable') {
      throw new IsolationLevelError(tx.isolation);
    }
    await this.events.publish<UpkeepExpensed>(tx, {
      type: 'inv.UpkeepExpensed',
      subjectType: 'StockUnit',
      subjectId: request.stockUnitId,
      branchId: request.branchId,
      occurredAt: request.occurredAt,
      payload: {
        stockUnitId: request.stockUnitId,
        productId: request.productId,
        branchId: request.branchId,
        locationId: request.locationId,
        valuePesewas: request.value.toJsonInteger(),
        costElement: request.costElement,
        sourceDocumentId: request.sourceDocumentId,
        sourceLineRef: request.sourceLineRef ?? null,
      },
    });
  }

  /** Reservations and holds change what is available without a movement; they tell the watch through here. */
  availabilityChangedIn(tx: Transaction, actorId: string, productIds: readonly string[]): Promise<unknown> {
    return this.watch.evaluateIn(tx, actorId, productIds);
  }
}
