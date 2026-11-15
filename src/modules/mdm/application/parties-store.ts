import type { Transaction } from '../../../platform/database/unit-of-work';
import type { AssignmentWindow } from '../domain/parties';
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
  readonly customerNo: string;
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

/** The contract's `CustomerAddress`. The delivery zone is resolved once zones exist (B04d continued 3, A-112). */
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
  readonly deliveryZone: null;
  readonly isDefault: boolean;
  readonly version: number;
}

export interface CustomerWrite {
  readonly customerNo: string;
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
}

export interface CustomerFilters {
  readonly name?: string | undefined;
  readonly phoneHash?: Buffer | undefined;
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

  livePriceList(tx: Transaction, id: string): Promise<PriceListFacts | null>;
  liveAssignments(tx: Transaction, customerId: string): Promise<AssignmentWindow[]>;
  endAssignment(tx: Transaction, id: string, validTo: Date, actorId: string): Promise<void>;
  archiveAssignment(tx: Transaction, id: string, reason: string, actorId: string, now: Date): Promise<void>;
  insertAssignment(tx: Transaction, id: string, write: { readonly customerId: string; readonly priceListId: string; readonly validFrom: Date; readonly validTo: Date | null }, actorId: string): Promise<void>;
}

export const PARTIES_STORE = Symbol('PARTIES_STORE');
