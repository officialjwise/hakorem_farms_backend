import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { StockUnitFactsRecord, StockUnitStore, UnitOnHandRecord } from './stock-unit-store';

export type UnitOnHand = UnitOnHandRecord;

export type StockUnitFacts = StockUnitFactsRecord;

/** A lot a higher module's document creates: a processing output (B6). Its stock arrives by the caller's movement. */
export interface LotRegistration {
  readonly productId: string;
  readonly branchId: string;
  readonly identifier: string;
  readonly producedOn: string | null;
  readonly expiresOn: string | null;
  readonly storageTempClass: string | null;
  readonly sourceDocumentId: string;
  readonly weightKg: string | null;
  readonly weighedAt: Date | null;
}

/** An animal a higher module's document brings into being: a birth (LIV, B06 continued 2). Its BIRTH movement follows. */
export interface SerialRegistration {
  readonly productId: string;
  readonly branchId: string;
  readonly identifier: string;
  readonly sourceDocumentId: string;
  readonly weightKg: string | null;
  readonly weighedAt: Date | null;
}

/**
 * INV's `StockUnits` interface (MODULE_BOUNDARIES, INV card) for a higher module working inside its own transaction:
 * the facts a command checks before it moves a unit (status, where it is, its cost pool, the holds that cover a
 * time), the identifiers already active, and the registration of a new lot, which exists from then on with no
 * location and no stock until the caller's own movement brings it in through `Stock.postIn`. The caller has
 * authorised its command; the invariants stay the database's (migration 0044).
 */
export class StockUnits {
  private readonly nextId: () => string;

  constructor(
    private readonly store: StockUnitStore,
    clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  async factsIn(tx: Transaction, ids: readonly string[], at: Date): Promise<ReadonlyMap<string, StockUnitFacts>> {
    const rows = await this.store.facts(tx, [...new Set(ids)], at);
    return new Map(rows.map((row) => [row.id, row] as const));
  }

  activeIdentifiersIn(tx: Transaction, productId: string, identifiers: readonly string[]): Promise<string[]> {
    return this.store.activeIdentifiers(tx, productId, identifiers);
  }

  async registerLotIn(tx: Transaction, actorId: string, lot: LotRegistration): Promise<string> {
    const id = this.nextId();
    await this.store.insert(
      tx,
      {
        id,
        productId: lot.productId,
        tracking: 'LOT',
        branchId: lot.branchId,
        identifier: lot.identifier,
        producedOn: lot.producedOn,
        expiresOn: lot.expiresOn,
        storageTempClass: lot.storageTempClass,
        supplierId: null,
        sourceDocumentId: lot.sourceDocumentId,
        lastWeightKg: lot.weightKg,
        lastWeighedAt: lot.weighedAt,
        // A lot made by a higher module's document (a processing output) is not received from a delivery.
        receivedAt: null,
      },
      actorId,
    );
    return id;
  }

  /**
   * Registers a serialised unit for an animal born on the farm (FR-LIV-011): ACTIVE, with no location and no stock until
   * the caller's BIRTH movement brings it in at nil cost. No `inv.StockUnitRegistered` is published, since the caller
   * opens the animal's record itself, with its dam and its birth, in the same transaction.
   */
  async registerSerialIn(tx: Transaction, actorId: string, unit: SerialRegistration): Promise<string> {
    const id = this.nextId();
    await this.store.insert(
      tx,
      {
        id,
        productId: unit.productId,
        tracking: 'SERIAL',
        branchId: unit.branchId,
        identifier: unit.identifier,
        producedOn: null,
        expiresOn: null,
        storageTempClass: null,
        supplierId: null,
        sourceDocumentId: unit.sourceDocumentId,
        lastWeightKg: unit.weightKg,
        lastWeighedAt: unit.weighedAt,
        receivedAt: null,
      },
      actorId,
    );
    return id;
  }

  /** What each unit had at each physical location at an instant in the past, from its movements (FR-LIV-005). */
  onHandAsOfIn(tx: Transaction, stockUnitIds: readonly string[], at: Date): Promise<UnitOnHand[]> {
    return this.store.onHandAsOf(tx, [...new Set(stockUnitIds)], at);
  }

  /** Sets an active unit's grade (FR-LIV-002: an animal's grade is its unit's, which pricing reads); false if none. */
  setGradeIn(tx: Transaction, actorId: string, stockUnitId: string, gradeId: string | null): Promise<boolean> {
    return this.store.setGrade(tx, stockUnitId, gradeId, actorId);
  }

  /** Where each unit stands now with what it has there: one row per physical location holding some of it. */
  onHandOfIn(tx: Transaction, stockUnitIds: readonly string[]): Promise<UnitOnHand[]> {
    return this.store.onHandOf(tx, [...new Set(stockUnitIds)]);
  }

  /** The units standing at the locations now, with the quantity on hand of each: the animals and flocks in a pen. */
  onHandAtIn(tx: Transaction, locationIds: readonly string[]): Promise<UnitOnHand[]> {
    return this.store.onHandAt(tx, [...new Set(locationIds)]);
  }

  /**
   * Keeps a unit's last weight in step with the latest weighing a higher module records (LIV's weight records,
   * FR-LIV-004), so its label prints it (B05x). A weighing older than the one the unit holds changes nothing.
   */
  recordWeightIn(tx: Transaction, actorId: string, stockUnitId: string, weightKg: string, at: Date): Promise<boolean> {
    return this.store.recordWeight(tx, stockUnitId, weightKg, at, actorId);
  }
}
