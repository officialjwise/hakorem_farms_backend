import { err, ok, type Quantity, type Result } from '@hakorem/kernel';
import type { Transaction } from '../../../platform/database/unit-of-work';
import { toBase, type UomFactor } from '../domain/unit-conversion';

/** What a higher module needs to know about a product it moves or shows: identity, how it is tracked, its unit. */
export interface ProductFacts {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly categoryId: string;
  /** The tax category its lines are taxed by (ADR-0020); purchasing reads it for an order line's levies (B7). */
  readonly taxCategoryId: string;
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
  /** The species of a live animal product (every serialised product has one); null for anything else. */
  readonly speciesId: string | null;
  /** Days a treated animal may not be sold or slaughtered after this medication (FR-LIV-008); null if none. */
  readonly withdrawalDays: number | null;
  /** The ledger group its stock, sales and cost of sales post to (ADR-0003); FIN reads it to choose the account (B8). */
  readonly glGroup: 'LIVE_ANIMALS' | 'MEAT' | 'OFFAL' | 'PRODUCE_EGGS' | 'FEED_MEDICATION' | 'SUPPLIES' | 'SERVICE';
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
  /** The supplier's public ID (B09q, ADR-0073): what the contract's `SupplierRef` shows. */
  readonly publicId: string;
  readonly name: string;
  /** ACTIVE, not archived and not blocked. */
  readonly isLive: boolean;
}

export interface SpeciesFacts {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** A weight band as the contract's `WeightBandRef` shows it (B10: a quote line's band). */
export interface WeightBandFacts {
  readonly id: string;
  readonly code: string;
  readonly minKg: string;
  readonly maxKg: string;
}

export interface GradeFacts {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** A tax category as the contract's `TaxCategoryRef` shows it (B7). */
export interface TaxCategoryFacts {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** A customer as a selling or billing module names it (B08 continued 2): the contract's `CustomerRef`, and the kind. */
export interface CustomerFacts {
  readonly id: string;
  /** The customer's public ID (B09q, ADR-0073): what the contract's `CustomerRef` shows. */
  readonly publicId: string;
  readonly name: string;
  readonly kind: 'INDIVIDUAL' | 'BUSINESS';
  /** Live, not archived. */
  readonly isLive: boolean;
  /** Whether a phone number is held for the customer (the number itself is never read here). */
  readonly hasPhone: boolean;
}

/**
 * A customer's own number, for a message sent to the customer (NTF, B11 continued 11, additive): read when the message is
 * queued and again when it is sent, never kept by the caller (ADR-0096).
 */
export interface CustomerContactFacts {
  readonly id: string;
  readonly name: string;
  readonly isLive: boolean;
  readonly phoneE164: string | null;
}

/**
 * A customer's saved delivery address (FR-MDM-008), as a staff delivery order snapshots it (B11 continued 8): who it is
 * for, where, and the zone it was filed under (null when none was; the order then matches one by area and city).
 */
export interface CustomerAddressFacts {
  readonly id: string;
  readonly customerId: string;
  readonly recipientName: string;
  readonly recipientPhone: string;
  readonly line1: string;
  readonly area: string;
  readonly city: string;
  readonly region: string;
  readonly digitalAddress: string | null;
  readonly directions: string | null;
  readonly deliveryZoneId: string | null;
  /** Not archived. */
  readonly isLive: boolean;
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
  /** Which loss account a write-off with this reason posts to (ADR-0003); null for none. */
  readonly lossAccountGroup: 'MORTALITY' | 'SHRINKAGE' | 'WASTAGE' | null;
}

/** A reason from the fixed list as the contract's `ReasonCode` shows it (B09b continued 2: the offline pack carries them). */
export interface ReasonCodeView extends ReasonCodeFacts {
  readonly description: string;
}

/** A payment method as a module taking a tender reads it (B9a, FR-PAY-001): its kind decides its clearing behaviour. */
export interface PaymentMethodFacts {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: 'CASH' | 'MOBILE_MONEY' | 'CARD' | 'BANK_TRANSFER' | 'CHEQUE' | 'STORE_CREDIT';
  readonly requiresProviderVerification: boolean;
  readonly allowedOffline: boolean;
  readonly channels: readonly ('POS' | 'ONLINE' | 'WHOLESALE' | 'QUOTE')[];
  /** Enabled and not archived. */
  readonly isLive: boolean;
}

export const MASTER_DATA_REFS_STORE = Symbol('MASTER_DATA_REFS_STORE');

/** A unit of measure's names as `Uom` gives them (B09u, A-303), for a screen that works from a cache (CR-051). */
export interface UomFacts {
  readonly code: string;
  readonly name: string;
  readonly singularName: string;
  readonly pluralName: string;
  readonly displayDecimals: number;
}

export interface MasterDataRefsStore {
  products(tx: Transaction, ids: readonly string[]): Promise<ProductFacts[]>;
  locations(tx: Transaction, ids: readonly string[]): Promise<LocationFacts[]>;
  virtualLocation(tx: Transaction, branchId: string, kind: string): Promise<string | null>;
  suppliers(tx: Transaction, ids: readonly string[]): Promise<SupplierFacts[]>;
  grades(tx: Transaction, ids: readonly string[]): Promise<GradeFacts[]>;
  weightBands(tx: Transaction, ids: readonly string[]): Promise<WeightBandFacts[]>;
  species(tx: Transaction, ids: readonly string[]): Promise<SpeciesFacts[]>;
  branches(tx: Transaction, ids: readonly string[]): Promise<BranchFacts[]>;
  taxCategories(tx: Transaction, ids: readonly string[]): Promise<TaxCategoryFacts[]>;
  customers(tx: Transaction, ids: readonly string[]): Promise<CustomerFacts[]>;
  customerContacts(tx: Transaction, ids: readonly string[]): Promise<CustomerContactFacts[]>;
  customerOfPrincipal(tx: Transaction, principalId: string): Promise<CustomerFacts | null>;
  customerAddress(tx: Transaction, id: string): Promise<CustomerAddressFacts | null>;
  reasonCodes(tx: Transaction, codes: readonly string[]): Promise<ReasonCodeFacts[]>;
  units(tx: Transaction, codes: readonly string[]): Promise<UomFacts[]>;
  paymentMethodsByCode(tx: Transaction, codes: readonly string[]): Promise<PaymentMethodFacts[]>;
  paymentMethods(tx: Transaction, ids: readonly string[]): Promise<PaymentMethodFacts[]>;
  /** Every reason of these domains, by domain and code. */
  reasonCodesOfDomains(tx: Transaction, domains: readonly string[]): Promise<ReasonCodeView[]>;
  /** Every payment method, live or not, by code. */
  allPaymentMethods(tx: Transaction): Promise<PaymentMethodFacts[]>;
  physicalLocationOfKind(tx: Transaction, branchId: string, kind: string): Promise<string | null>;
  /** Ids of live records by their codes, for a higher module's import sheet (ADR-0050). */
  /** The first live, non-test branch registered: where farm-wide records are held (the same rule as MDM's imports). */
  headOfficeBranchId(tx: Transaction): Promise<string | null>;
  branchIdByCode(tx: Transaction, code: string): Promise<string | null>;
  locationIdByCode(tx: Transaction, branchId: string, code: string): Promise<string | null>;
  productIdBySku(tx: Transaction, sku: string): Promise<string | null>;
  /** Ids of the live products of a species, in SKU order (LIV's hatch, B06 continued 2). */
  productIdsOfSpecies(tx: Transaction, speciesId: string): Promise<string[]>;
  /** Ids of every product filed under a category, archived or not (INV's sorted stock on hand, CR-019). */
  productIdsInCategory(tx: Transaction, categoryId: string): Promise<string[]>;
  /** A product's base unit and the live factor of its alternative unit `uom` (null if none); null for no such product (B06u). */
  uomFactor(tx: Transaction, productId: string, uom: string): Promise<{ readonly baseUom: string; readonly factor: UomFactor | null } | null>;
}

/** Why a quantity could not be put in a product's base unit (B06u, FR-MDM-003). */
export type ToBaseRefusal = 'NO_PRODUCT' | 'NO_CONVERSION' | 'INEXACT_QUANTITY';

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

  /** Weight bands by id, as the contract's `WeightBandRef` (B10). */
  async weightBandsIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, WeightBandFacts>> {
    return ids.length === 0 ? new Map() : byId(await this.store.weightBands(tx, unique(ids)));
  }

  /** Species by id, as the contract's `SpeciesRef` (B06 continued). */
  async speciesIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, SpeciesFacts>> {
    return ids.length === 0 ? new Map() : byId(await this.store.species(tx, unique(ids)));
  }

  async taxCategoriesIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, TaxCategoryFacts>> {
    return byId(await this.store.taxCategories(tx, unique(ids)));
  }

  /** Customers by id, for a billing document's party and its `CustomerRef` (B08 continued 2). */
  async customersIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, CustomerFacts>> {
    if (ids.length === 0) return new Map();
    return byId(await this.store.customers(tx, unique(ids)));
  }

  /** Customers' own numbers by id (NTF's reminders, B11 continued 11): the customer's name, whether live, and its number. */
  async customerContactsIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, CustomerContactFacts>> {
    if (ids.length === 0) return new Map();
    return byId(await this.store.customerContacts(tx, unique(ids)));
  }

  /** The customer a customer-realm sign-in belongs to (`mdm.customer.principal_id`), or null if none is linked. */
  async customerOfPrincipalIn(tx: Transaction, principalId: string): Promise<CustomerFacts | null> {
    return this.store.customerOfPrincipal(tx, principalId);
  }

  /** A customer's saved delivery address by id, archived or not, or null (B11 continued 8: a staff delivery order). */
  customerAddressIn(tx: Transaction, id: string): Promise<CustomerAddressFacts | null> {
    return this.store.customerAddress(tx, id);
  }

  async branchesIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, BranchFacts>> {
    return ids.length === 0 ? new Map() : byId(await this.store.branches(tx, unique(ids)));
  }

  /** Reasons from the fixed list by code; an unknown code is simply absent. */
  async reasonCodesIn(tx: Transaction, codes: readonly string[]): Promise<ReadonlyMap<string, ReasonCodeFacts>> {
    if (codes.length === 0) return new Map();
    return new Map((await this.store.reasonCodes(tx, unique(codes))).map((row) => [row.code, row] as const));
  }

  /** Payment methods by code (B9a); an unknown code is simply absent. */
  /** The named units with their singular and plural names, in code order (CR-051: the offline pack names its units). */
  async unitsIn(tx: Transaction, codes: readonly string[]): Promise<UomFacts[]> {
    return codes.length === 0 ? [] : this.store.units(tx, unique(codes));
  }

  async paymentMethodsByCodeIn(tx: Transaction, codes: readonly string[]): Promise<ReadonlyMap<string, PaymentMethodFacts>> {
    if (codes.length === 0) return new Map();
    return new Map((await this.store.paymentMethodsByCode(tx, unique(codes))).map((row) => [row.code, row] as const));
  }

  /** Payment methods by id (B9a); an unknown id is simply absent. */
  async paymentMethodsIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, PaymentMethodFacts>> {
    return ids.length === 0 ? new Map() : byId(await this.store.paymentMethods(tx, unique(ids)));
  }

  /** Every reason of these domains from the fixed list, by domain and code, with its description (B09b continued 2). */
  reasonCodesOfDomainsIn(tx: Transaction, domains: readonly string[]): Promise<ReasonCodeView[]> {
    return domains.length === 0 ? Promise.resolve([]) : this.store.reasonCodesOfDomains(tx, unique(domains));
  }

  /** The live payment methods a channel takes, by code (B09b continued 2: the offline pack's methods). */
  async livePaymentMethodsOfChannelIn(tx: Transaction, channel: 'POS' | 'ONLINE' | 'WHOLESALE' | 'QUOTE'): Promise<PaymentMethodFacts[]> {
    return (await this.store.allPaymentMethods(tx)).filter((m) => m.isLive && m.channels.includes(channel));
  }

  /** The branch's live physical location of a kind (its in-transit location, for a transfer), or null if it has none. */
  physicalLocationOfKindIn(tx: Transaction, branchId: string, kind: string): Promise<string | null> {
    return this.store.physicalLocationOfKind(tx, branchId, kind);
  }

  /**
   * The head office: the first live, non-test branch registered, where a farm-wide record that belongs to no branch is
   * held and approved (a supplier's payout change, A-166), by the same rule as MDM's own imports. Null with no branch.
   */
  headOfficeBranchIn(tx: Transaction): Promise<string | null> {
    return this.store.headOfficeBranchId(tx);
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

  /** The live products of a species, in SKU order: what a flock of it hatched on the farm can be held as. */
  async productsOfSpeciesIn(tx: Transaction, speciesId: string): Promise<ProductFacts[]> {
    const ids = await this.store.productIdsOfSpecies(tx, speciesId);
    const facts = await this.productsIn(tx, ids);
    return ids.map((id) => facts.get(id)!);
  }

  /**
   * Every product filed directly under a category, archived or not, in id order: the products a list filtered by
   * `categoryId` keeps, as the facts of `productsIn` would keep them (INV's sorted stock on hand, CR-019).
   */
  productIdsInCategoryIn(tx: Transaction, categoryId: string): Promise<string[]> {
    return this.store.productIdsInCategory(tx, categoryId);
  }

  /**
   * A quantity of a product in `uom`, in the product's base unit (FR-MDM-003, B06u): the base unit passes through, an
   * alternative unit converts by its live exact factor (a crate of 30: 3 crates are 90.000), and a result that would
   * need a fourth decimal place is refused, never rounded. A catch-weight product has no conversion (A-157).
   */
  async toBaseIn(tx: Transaction, productId: string, uom: string, quantity: Quantity): Promise<Result<Quantity, ToBaseRefusal>> {
    const found = await this.store.uomFactor(tx, productId, uom);
    if (found === null) return err('NO_PRODUCT');
    if (uom === found.baseUom) return ok(quantity);
    if (found.factor === null) return err('NO_CONVERSION');
    return toBase(quantity, found.factor);
  }
}
