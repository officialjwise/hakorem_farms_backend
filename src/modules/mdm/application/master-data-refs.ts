import type { Transaction } from '../../../platform/database/unit-of-work';

/** What a higher module needs to know about a product it moves or shows: identity, how it is tracked, its unit. */
export interface ProductFacts {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly categoryId: string;
  readonly stockPolicy: 'SERIALISED' | 'CATCH_WEIGHT' | 'COUNTABLE' | 'NON_STOCK';
  readonly tracking: 'SERIAL' | 'LOT' | 'NONE';
  readonly baseUom: string;
  /** Decimal places a quantity in the base unit is shown with (CR-003). */
  readonly uomDisplayDecimals: number;
  readonly shelfLifeDays: number | null;
  readonly storageTempClass: 'AMBIENT' | 'CHILLED' | 'FROZEN' | null;
  readonly isPurchasable: boolean;
  /** ACTIVE, not archived. */
  readonly isLive: boolean;
}

export interface LocationFacts {
  readonly id: string;
  readonly branchId: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly isVirtual: boolean;
  readonly isLive: boolean;
}

export interface SupplierFacts {
  readonly id: string;
  readonly supplierNo: string;
  readonly name: string;
  /** ACTIVE, not archived and not blocked. */
  readonly isLive: boolean;
}

export interface GradeFacts {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export const MASTER_DATA_REFS_STORE = Symbol('MASTER_DATA_REFS_STORE');

export interface MasterDataRefsStore {
  products(tx: Transaction, ids: readonly string[]): Promise<ProductFacts[]>;
  locations(tx: Transaction, ids: readonly string[]): Promise<LocationFacts[]>;
  virtualLocation(tx: Transaction, branchId: string, kind: string): Promise<string | null>;
  suppliers(tx: Transaction, ids: readonly string[]): Promise<SupplierFacts[]>;
  grades(tx: Transaction, ids: readonly string[]): Promise<GradeFacts[]>;
}

function byId<T extends { readonly id: string }>(rows: readonly T[]): ReadonlyMap<string, T> {
  return new Map(rows.map((row) => [row.id, row] as const));
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * The read side of MDM's `Catalogue`, `Parties` and `Locations` interfaces for a higher module working inside its
 * own transaction (MODULE_BOUNDARIES, MDM card): products, locations, suppliers and grades by id, as facts and the
 * contract's `ProductRef`, `LocationRef`, `SupplierRef` and `GradeRef`. It authorises nothing: the caller's command
 * has authorised its own operation, and these are names and rules, never another module's records to change.
 */
export class MasterDataRefs {
  constructor(private readonly store: MasterDataRefsStore) {}

  async productsIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, ProductFacts>> {
    return ids.length === 0 ? new Map() : byId(await this.store.products(tx, unique(ids)));
  }

  async locationsIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, LocationFacts>> {
    return ids.length === 0 ? new Map() : byId(await this.store.locations(tx, unique(ids)));
  }

  /** The branch's virtual location of a kind (`SUPPLIER`, `PRODUCTION`, `OPENING` and so on), created with the branch. */
  virtualLocationIn(tx: Transaction, branchId: string, kind: string): Promise<string | null> {
    return this.store.virtualLocation(tx, branchId, kind);
  }

  async suppliersIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, SupplierFacts>> {
    return ids.length === 0 ? new Map() : byId(await this.store.suppliers(tx, unique(ids)));
  }

  async gradesIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, GradeFacts>> {
    return ids.length === 0 ? new Map() : byId(await this.store.grades(tx, unique(ids)));
  }
}
