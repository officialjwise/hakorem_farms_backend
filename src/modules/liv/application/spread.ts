import { Quantity, type Money } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { Stock, StockUnits } from '../../inv';
import type { LocationFacts, MasterDataRefs } from '../../mdm';
import { headOf, spreadByHeadDays, treatmentOf } from '../domain/cost-spread';
import { LivestockRecordInvalidError } from './errors';
import { placesOf } from './support';
import type { BatchPurpose, HerdStore } from './herd-store';
import type { CostAllocationRecord, LivestockStore } from './livestock-store';

/** An animal or flock a feed issue or a treatment served, with the head-days it is weighted by. */
export interface ServedUnit {
  readonly id: string;
  readonly identifier: string;
  readonly productId: string;
  readonly tracking: 'SERIAL' | 'LOT';
  readonly branchId: string;
  readonly locationId: string;
  readonly headDays: bigint;
  /** An animal's purpose, or a flock's batch's: what decides whether its share is capitalised or expensed. */
  readonly purpose: BatchPurpose;
}

/** Locations that hold no animals to feed or treat: a whole site, stock on the road. Virtual ones are refused too. */
const NOT_A_PEN: ReadonlySet<string> = new Set(['IN_TRANSIT', 'SITE']);
/** One day of presence: a feed issue or a treatment is for the day it is recorded on (A-158). */
const DAYS_SERVED = 1n;

/**
 * The shared step of feed and veterinary cost (FR-LIV-009, FR-LIV-015, ADR-0018): which live animals and flocks a pen
 * holds now, and the spread of a cost across them by head-days through the domain's `spreadByHeadDays` (the kernel's
 * `allocate`). A growing animal or flock has its share capitalised by a value-only COST_CAPITALISE movement from the
 * branch's virtual CONSUMPTION location to where it stands; a breeding animal's share is expensed through
 * `Stock.expenseIn`. Every write is inventory's, in the caller's serializable transaction.
 */
export class CostSpreader {
  constructor(
    private readonly store: LivestockStore,
    private readonly herd: HerdStore,
    private readonly refs: MasterDataRefs,
    private readonly units: StockUnits,
    private readonly stock: Stock,
  ) {}

  /** The units named, each with the problem that keeps it from being fed or treated, or null. */
  async servedUnitsIn(tx: Transaction, ids: readonly string[], at: Date): Promise<{ found: ReadonlyMap<string, ServedUnit & { readonly problem: string | null }> }> {
    const facts = await this.units.factsIn(tx, ids, at);
    const products = await this.refs.productsIn(tx, [...facts.values()].map((u) => u.productId));
    const animals = new Map((await this.store.animals(tx, ids)).map((a) => [a.stockUnitId, a] as const));
    const places = await placesOf(tx, this.units, [...facts.values()]);
    const batches = await this.herd.batchesOfUnits(tx, [...facts.values()].filter((u) => u.tracking === 'LOT').map((u) => u.id));
    const found = new Map<string, ServedUnit & { readonly problem: string | null }>();
    for (const unit of facts.values()) {
      const animal = animals.get(unit.id);
      const livestock = products.get(unit.productId)!.speciesId !== null && (unit.tracking === 'LOT' || animal !== undefined);
      const alive = unit.tracking === 'SERIAL' ? animal?.status === 'ALIVE' : unit.status === 'ACTIVE';
      found.set(unit.id, {
        id: unit.id,
        identifier: unit.identifier,
        productId: unit.productId,
        tracking: unit.tracking,
        branchId: unit.branchId,
        locationId: places.get(unit.id) ?? '',
        headDays: headOf(unit.tracking, unit.poolQty) * DAYS_SERVED,
        // A flock takes its batch's purpose (A-159); one with no batch counts as growing stock (A-158).
        purpose: animal?.purpose ?? batches.get(unit.id)?.purpose ?? 'GROWING',
        problem: !livestock ? 'NOT_LIVESTOCK' : !alive ? 'ANIMAL_NOT_ALIVE' : places.get(unit.id) === null ? 'NOT_IN_ONE_PLACE' : null,
      });
    }
    return { found };
  }

  /** Every live animal and flock standing in the pen now, with its head there; refused if there is none. */
  async atPenIn(tx: Transaction, location: LocationFacts, at: Date): Promise<ServedUnit[]> {
    if (location.isVirtual || NOT_A_PEN.has(location.kind)) throw new LivestockRecordInvalidError([{ field: '/locationId', rule: 'NOT_A_PEN' }]);
    const here = await this.units.onHandAtIn(tx, [location.id]);
    const { found } = await this.servedUnitsIn(tx, here.map((u) => u.id), at);
    const served = here.flatMap((u) => {
      const unit = found.get(u.id);
      if (unit === undefined || unit.problem !== null) return [];
      const head = headOf(u.tracking, Quantity.parse(u.onHandQty).toDecimalString());
      return head === 0n ? [] : [{ ...unit, locationId: location.id, headDays: head * DAYS_SERVED }];
    });
    if (served.length === 0) throw new LivestockRecordInvalidError([{ field: '/locationId', rule: 'NO_ANIMALS_HERE' }]);
    return served;
  }

  async virtualOf(tx: Transaction, branchId: string, kind: 'CONSUMPTION'): Promise<string> {
    const id = await this.refs.virtualLocationIn(tx, branchId, kind);
    if (id === null) throw new Error(`branch ${branchId} has no virtual ${kind} location; every branch is created with one (ADR-0042)`);
    return id;
  }

  /** Spreads `total` across the units served and writes each share through inventory; returns the allocation rows. */
  async spreadIn(
    tx: Transaction,
    actor: Actor,
    request: { readonly total: Money; readonly served: readonly ServedUnit[]; readonly branchId: string; readonly costElement: 'FEED' | 'VETERINARY'; readonly sourceDocumentId: string; readonly occurredAt: Date },
  ): Promise<CostAllocationRecord[]> {
    const parts = spreadByHeadDays(
      request.total,
      request.served.map((u) => ({ stockUnitId: u.id, identifier: u.identifier, headDays: u.headDays })),
    );
    if (!parts.ok) throw new LivestockRecordInvalidError([{ field: '/locationId', rule: parts.error }]);
    const consumption = await this.virtualOf(tx, request.branchId, 'CONSUMPTION');
    const byId = new Map(request.served.map((u) => [u.id, u] as const));
    const rows: CostAllocationRecord[] = [];
    for (const part of parts.value) {
      const unit = byId.get(part.stockUnitId)!;
      const treatment = treatmentOf(unit.purpose);
      let movementId: string | null = null;
      if (!part.amount.isZero() && treatment === 'CAPITALISED') {
        movementId = (
          await this.stock.postIn(tx, actor.principalId, {
            movementType: 'COST_CAPITALISE',
            productId: unit.productId,
            stockUnitId: unit.id,
            branchId: unit.branchId,
            fromLocationId: consumption,
            toLocationId: unit.locationId,
            qty: Quantity.zero(),
            value: part.amount,
            costElement: request.costElement,
            sourceDocumentId: request.sourceDocumentId,
            sourceLineRef: unit.id,
            occurredAt: request.occurredAt,
          })
        ).id;
      } else if (!part.amount.isZero()) {
        await this.stock.expenseIn(tx, {
          stockUnitId: unit.id,
          productId: unit.productId,
          branchId: unit.branchId,
          locationId: unit.locationId,
          value: part.amount,
          costElement: request.costElement,
          sourceDocumentId: request.sourceDocumentId,
          sourceLineRef: unit.id,
          occurredAt: request.occurredAt,
        });
      }
      rows.push({ stockUnitId: unit.id, headDays: part.headDays, amountPesewas: part.amount.pesewas, treatment, movementId });
    }
    return rows;
  }
}
