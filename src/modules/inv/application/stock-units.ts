import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { StockUnitFactsRecord, StockUnitStore } from './stock-unit-store';

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
      },
      actorId,
    );
    return id;
  }
}
