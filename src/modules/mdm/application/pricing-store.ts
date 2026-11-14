import type { Transaction } from '../../../platform/database/unit-of-work';
import type { Channel, PriceEntry, PriceListRef, WeightBand } from '../domain/pricing-engine';

export interface PricingProduct {
  readonly id: string;
  readonly speciesId: string | null;
}

export interface GradeRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly speciesId: string;
}

/** A band as the engine needs it, plus the decimal strings the contract's `WeightBandRef` shows. */
export interface BandRow extends WeightBand {
  readonly speciesId: string;
  readonly minKg: string;
  readonly maxKg: string;
}

export interface PricingCustomer {
  readonly id: string;
  readonly tierId: string;
  /** The CUSTOMER list assigned at the pricing time (FR-MDM-021), or null. */
  readonly assignedListId: string | null;
}

/** A list that can take part in the walk, with the entries of its version in force, for the products asked about. */
export interface ListInForce {
  readonly list: PriceListRef;
  readonly branchId: string | null;
  readonly entries: ReadonlyArray<PriceEntry & { readonly productId: string }>;
}

export interface WalkSlots {
  readonly channel: Channel;
  readonly branchId: string;
  readonly tierId: string | null;
  readonly customerListId: string | null;
}

/** MDM's pricing reads, each in the caller's transaction. */
export interface PricingStore {
  branchExists(tx: Transaction, branchId: string): Promise<boolean>;
  products(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, PricingProduct>>;
  grades(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, GradeRow>>;
  bands(tx: Transaction, speciesIds: readonly string[]): Promise<readonly BandRow[]>;
  customer(tx: Transaction, id: string, at: Date): Promise<PricingCustomer | null>;
  /** Every list that fills one of the walk's slots, at this branch or every branch, with an ACTIVE version at `at`. */
  listsInForce(tx: Transaction, slots: WalkSlots, at: Date, productIds: readonly string[]): Promise<readonly ListInForce[]>;
}

export const PRICING_STORE = Symbol('PRICING_STORE');
