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
  /** The cold chain class and permitted range of a cold room or vehicle (FR-INV-007), one decimal place; null if none. */
  readonly tempClass: 'AMBIENT' | 'CHILLED' | 'FROZEN' | null;
  readonly tempRange: { readonly minC: string; readonly maxC: string } | null;
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

export interface BranchFacts {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** A reason from the fixed list (FR-MDM-011): its domain, and whether it needs a note beside it. */
export interface ReasonCodeFacts {
  readonly code: string;
  readonly domain: string;
  readonly requiresNote: boolean;
}

export const MASTER_DATA_REFS_STORE = Symbol('MASTER_DATA_REFS_STORE');

export interface MasterDataRefsStore {
  products(tx: Transaction, ids: readonly string[]): Promise<ProductFacts[]>;
  locations(tx: Transaction, ids: readonly string[]): Promise<LocationFacts[]>;
  virtualLocation(tx: Transaction, branchId: string, kind: string): Promise<string | null>;
  suppliers(tx: Transaction, ids: readonly string[]): Promise<SupplierFacts[]>;
  grades(tx: Transaction, ids: readonly string[]): Promise<GradeFacts[]>;
  branches(tx: Transaction, ids: readonly string[]): Promise<BranchFacts[]>;
  reasonCodes(tx: Transaction, codes: readonly string[]): Promise<ReasonCodeFacts[]>;
  physicalLocationOfKind(tx: Transaction, branchId: string, kind: string): Promise<string | null>;
  /** Ids of live records by their codes, for a higher module's import sheet (ADR-0050). */
  branchIdByCode(tx: Transaction, code: string): Promise<string | null>;
  locationIdByCode(tx: Transaction, branchId: string, code: string): Promise<string | null>;
  productIdBySku(tx: Transaction, sku: string): Promise<string | null>;
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
 * contract's `ProductRef`, `LocationRef`, `SupplierRef`, `GradeRef` and `BranchRef`, and reasons from the fixed list. It authorises nothing: the caller's command
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

  async branchesIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, BranchFacts>> {
    return ids.length === 0 ? new Map() : byId(await this.store.branches(tx, unique(ids)));
  }

  /** Reasons from the fixed list by code; an unknown code is simply absent. */
  async reasonCodesIn(tx: Transaction, codes: readonly string[]): Promise<ReadonlyMap<string, ReasonCodeFacts>> {
    if (codes.length === 0) return new Map();
    return new Map((await this.store.reasonCodes(tx, unique(codes))).map((row) => [row.code, row] as const));
  }

  /** The branch's live physical location of a kind (its in-transit location, for a transfer), or null if it has none. */
  physicalLocationOfKindIn(tx: Transaction, branchId: string, kind: string): Promise<string | null> {
    return this.store.physicalLocationOfKind(tx, branchId, kind);
  }

  /** A live branch by its code, for an import sheet a higher module owns (ADR-0050); null if there is none. */
  async branchByCodeIn(tx: Transaction, code: string): Promise<BranchFacts | null> {
    const id = await this.store.branchIdByCode(tx, code);
    return id === null ? null : ((await this.branchesIn(tx, [id])).get(id) ?? null);
  }

  /** A live location of a branch by its code; null if there is none. */
  async locationByCodeIn(tx: Transaction, branchId: string, code: string): Promise<LocationFacts | null> {
    const id = await this.store.locationIdByCode(tx, branchId, code);
    return id === null ? null : ((await this.locationsIn(tx, [id])).get(id) ?? null);
  }

  /** A live product by its SKU; null if there is none. */
  async productBySkuIn(tx: Transaction, sku: string): Promise<ProductFacts | null> {
    const id = await this.store.productIdBySku(tx, sku);
    return id === null ? null : ((await this.productsIn(tx, [id])).get(id) ?? null);
  }
}
