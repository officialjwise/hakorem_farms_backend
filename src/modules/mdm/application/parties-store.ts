import type { Transaction } from '../../../platform/database/unit-of-work';
import type { AssignmentWindow } from '../domain/parties';
import type { ZoneForMatch } from '../domain/reference-data';
import type { RowState } from './admin-kit';

export type CustomerKind = 'INDIVIDUAL' | 'BUSINESS';
export type CustomerStatus = 'ACTIVE' | 'BLOCKED' | 'ANONYMISED';

export interface TierView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** A customer row as stored; the application turns it into the contract's `Customer`. */
export interface CustomerRecord {
  readonly id: string;
  /** What people see and type for the customer (B09q, ADR-0073); the sequential `customer_no` stays internal. */
  readonly publicId: string;
  readonly kind: CustomerKind;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly tier: TierView;
  readonly hasLogin: boolean;
  readonly tinEnc: Buffer | null;
  readonly marketingConsentAt: string | null;
  readonly status: CustomerStatus;
  readonly priceList: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly defaultArea: string | null;
  readonly archived: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The contract's `CustomerAddress`. The delivery zone is the one the address was in when it was last saved (A-112). */
export interface AddressView {
  readonly id: string;
  readonly customerId: string;
  readonly label: string;
  readonly recipientName: string;
  readonly recipientPhone: string;
  readonly line1: string;
  readonly area: string;
  readonly city: string;
  readonly region: string;
  readonly digitalAddress: string | null;
  readonly directions: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly deliveryZone: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly isDefault: boolean;
  readonly version: number;
}

export interface CustomerWrite {
  /** The internal sequential number (`C-00001`), never shown from contract 2.0.0. */
  readonly customerNo: string;
  readonly publicId: string;
  readonly kind: CustomerKind;
  readonly name: string;
  readonly phone: string | null;
  readonly phoneHash: Buffer | null;
  readonly email: string | null;
  readonly tierId: string;
  readonly tinEnc: Buffer | null;
  readonly marketingConsentAt: Date | null;
}

export interface AddressWrite {
  readonly customerId: string;
  readonly label: string;
  readonly recipientName: string;
  readonly recipientPhone: string;
  readonly line1: string;
  readonly area: string;
  readonly city: string;
  readonly region: string;
  readonly digitalAddress: string | null;
  readonly directions: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly isDefault: boolean;
  readonly deliveryZoneId: string | null;
}

export interface CustomerFilters {
  readonly name?: string | undefined;
  readonly phoneHash?: Buffer | undefined;
  /** A public ID, in its one written form (`readPublicId`). */
  readonly publicId?: string | undefined;
  readonly kind?: CustomerKind | undefined;
  readonly tierId?: string | undefined;
  readonly status?: CustomerStatus | undefined;
}

export interface PriceListFacts {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
}

/** MDM's customer, tier, address and customer price list tables, each call in the caller's transaction. */
export interface PartiesStore {
  tiers(tx: Transaction, afterId: string | null, limit: number): Promise<TierView[]>;
  tier(tx: Transaction, id: string): Promise<TierView | null>;
  tierByCode(tx: Transaction, code: string): Promise<TierView | null>;
  insertTier(tx: Transaction, id: string, write: { readonly code: string; readonly name: string }, actorId: string): Promise<void>;

  nextCustomerNo(tx: Transaction): Promise<string>;
  lockCustomer(tx: Transaction, id: string): Promise<RowState | null>;
  customer(tx: Transaction, id: string, at: Date): Promise<CustomerRecord | null>;
  customers(tx: Transaction, filters: CustomerFilters, at: Date, afterId: string | null, limit: number): Promise<CustomerRecord[]>;
  /** Whether a live customer other than `exceptId` has this phone hash. */
  phoneTaken(tx: Transaction, phoneHash: Buffer, exceptId: string | null): Promise<boolean>;
  /** The live customer with this phone hash, if any. */
  customerByPhoneHash(tx: Transaction, phoneHash: Buffer): Promise<{ readonly id: string; readonly publicId: string } | null>;
  /** The live customer with this public ID, if any, with what an import needs to change it. */
  customerByPublicId(tx: Transaction, publicId: string): Promise<{ readonly id: string; readonly kind: CustomerKind; readonly status: CustomerStatus; readonly version: number } | null>;
  insertCustomer(tx: Transaction, id: string, write: CustomerWrite, actorId: string): Promise<void>;
  updateCustomer(tx: Transaction, id: string, expectedVersion: number, columns: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean>;
  archiveCustomer(tx: Transaction, id: string, expectedVersion: number, reason: string, actorId: string, now: Date): Promise<boolean>;

  lockAddress(tx: Transaction, id: string): Promise<RowState | null>;
  address(tx: Transaction, id: string): Promise<AddressView | null>;
  addresses(tx: Transaction, customerId: string, afterId: string | null, limit: number): Promise<AddressView[]>;
  insertAddress(tx: Transaction, id: string, write: AddressWrite, actorId: string): Promise<void>;
  updateAddress(tx: Transaction, id: string, expectedVersion: number, columns: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean>;
  archiveAddress(tx: Transaction, id: string, expectedVersion: number, reason: string, actorId: string, now: Date): Promise<boolean>;
  /** Clears the default flag on the customer's other live addresses. */
  clearDefaultAddress(tx: Transaction, customerId: string, exceptId: string | null, actorId: string): Promise<void>;
  /** The zones a saved address is matched against (FR-MDM-010). */
  deliverableZones(tx: Transaction): Promise<ZoneForMatch[]>;

  livePriceList(tx: Transaction, id: string): Promise<PriceListFacts | null>;
  liveAssignments(tx: Transaction, customerId: string): Promise<AssignmentWindow[]>;
  /** A customer's price list assignments in force at `at` or starting later, oldest first (CR-041); null for no live customer. */
  customerAssignments(tx: Transaction, customerId: string, at: Date): Promise<AssignmentRecord[] | null>;
  /** The live customers who hold a price list at `at` or later, by assignment id (CR-041). */
  priceListHolders(tx: Transaction, priceListId: string, at: Date, afterId: string | null, limit: number): Promise<AssignmentRecord[]>;
  priceListExists(tx: Transaction, priceListId: string): Promise<boolean>;
  endAssignment(tx: Transaction, id: string, validTo: Date, actorId: string): Promise<void>;
  archiveAssignment(tx: Transaction, id: string, reason: string, actorId: string, now: Date): Promise<void>;
  insertAssignment(tx: Transaction, id: string, write: { readonly customerId: string; readonly priceListId: string; readonly validFrom: Date; readonly validTo: Date | null }, actorId: string): Promise<void>;
}

export const PARTIES_STORE = Symbol('PARTIES_STORE');

/** One price list assignment as CR-041's reads answer it. */
export interface AssignmentRecord {
  readonly id: string;
  readonly customer: { readonly id: string; readonly publicId: string; readonly name: string };
  readonly priceList: { readonly id: string; readonly code: string; readonly name: string };
  readonly validFrom: Date;
  readonly validTo: Date | null;
}
