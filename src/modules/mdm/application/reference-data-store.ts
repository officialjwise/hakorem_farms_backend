import type { Transaction } from '../../../platform/database/unit-of-work';
import type { PaymentMethodKind, ZoneForMatch } from '../domain/reference-data';
import type { Channel } from '../domain/pricing/pricing-engine';
import type { RowState } from './admin-kit';

export type SupplierStatus = 'ACTIVE' | 'BLOCKED';

interface Ref {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** A supplier row as stored; the application turns it into the contract's `Supplier`. */
export interface SupplierRecord {
  readonly id: string;
  /** What people see and type for the supplier (B09q, ADR-0073); the sequential `supplier_no` stays internal. */
  readonly publicId: string;
  readonly name: string;
  readonly contactName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly tinEnc: Buffer | null;
  readonly status: SupplierStatus;
  readonly categories: readonly Ref[];
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SupplierWrite {
  /** The internal sequential number (`S-0001`), never shown from contract 2.0.0. */
  readonly supplierNo: string;
  readonly publicId: string;
  readonly name: string;
  readonly contactName: string | null;
  readonly phone: string | null;
  readonly phoneHash: Buffer | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly tinEnc: Buffer | null;
}

export interface SupplierFilters {
  readonly name?: string | undefined;
  readonly phoneHash?: Buffer | undefined;
  /** A public ID, in its one written form (`readPublicId`). */
  readonly publicId?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly status?: SupplierStatus | undefined;
}

/** The contract's `PaymentMethod`. */
export interface PaymentMethodView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: PaymentMethodKind;
  readonly requiresProviderVerification: boolean;
  readonly allowedOffline: boolean;
  readonly channels: readonly Channel[];
  readonly isEnabled: boolean;
  readonly version: number;
}

/** A delivery zone as stored, money as bigint pesewas. */
export interface ZoneRecord extends ZoneForMatch {
  readonly branch: Ref;
  readonly isActive: boolean;
  readonly version: number;
}

export interface ZoneWrite {
  readonly branchId: string;
  readonly code: string;
  readonly name: string;
  readonly areas: readonly string[];
  readonly feePesewas: bigint;
  readonly freeOverPesewas: bigint | null;
  readonly cutoffTime: string;
}

/** The contract's `ReasonCode`. */
export interface ReasonCodeView {
  readonly code: string;
  readonly domain: string;
  readonly description: string;
  readonly requiresNote: boolean;
  readonly lossAccountGroup: 'MORTALITY' | 'SHRINKAGE' | 'WASTAGE' | null;
}

/** MDM's supplier, payment method, delivery zone and reason code tables, each call in the caller's transaction. */
export interface ReferenceDataStore {
  nextSupplierNo(tx: Transaction): Promise<string>;
  lockSupplier(tx: Transaction, id: string): Promise<RowState | null>;
  supplier(tx: Transaction, id: string): Promise<SupplierRecord | null>;
  suppliers(tx: Transaction, filters: SupplierFilters, afterId: string | null, limit: number): Promise<SupplierRecord[]>;
  /** Whether a live supplier other than `exceptId` has this phone hash. */
  supplierPhoneTaken(tx: Transaction, phoneHash: Buffer, exceptId: string | null): Promise<boolean>;
  /** Which of these ids name no live category. */
  unknownCategories(tx: Transaction, ids: readonly string[]): Promise<string[]>;
  insertSupplier(tx: Transaction, id: string, write: SupplierWrite, actorId: string): Promise<void>;
  updateSupplier(tx: Transaction, id: string, expectedVersion: number, columns: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean>;
  archiveSupplier(tx: Transaction, id: string, expectedVersion: number, reason: string, actorId: string, now: Date): Promise<boolean>;
  /** Makes the supplier's live categories exactly `categoryIds`: new ones inserted, dropped ones archived. */
  setSupplierCategories(tx: Transaction, supplierId: string, categoryIds: readonly string[], actorId: string, now: Date, newId: () => string): Promise<void>;

  paymentMethods(tx: Transaction, includeDisabled: boolean, afterId: string | null, limit: number): Promise<PaymentMethodView[]>;
  lockPaymentMethod(tx: Transaction, id: string): Promise<RowState | null>;
  paymentMethod(tx: Transaction, id: string): Promise<PaymentMethodView | null>;
  updatePaymentMethod(tx: Transaction, id: string, expectedVersion: number, columns: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean>;

  branchExists(tx: Transaction, id: string): Promise<boolean>;
  lockZone(tx: Transaction, id: string): Promise<RowState | null>;
  zone(tx: Transaction, id: string): Promise<ZoneRecord | null>;
  zones(tx: Transaction, branchId: string | null, afterId: string | null, limit: number): Promise<ZoneRecord[]>;
  zoneCodeTaken(tx: Transaction, branchId: string, code: string): Promise<boolean>;
  /** Live, active zones of open, non-test branches: the zones an address can be delivered from. */
  deliverableZones(tx: Transaction): Promise<ZoneRecord[]>;
  /** Live, active zones other than `exceptId`, of every branch, for the one-zone-per-area rule. */
  otherActiveZones(tx: Transaction, exceptId: string | null): Promise<ZoneRecord[]>;
  insertZone(tx: Transaction, id: string, write: ZoneWrite, actorId: string): Promise<void>;
  updateZone(tx: Transaction, id: string, expectedVersion: number, columns: Readonly<Record<string, unknown>>, actorId: string): Promise<boolean>;

  reasonCodes(tx: Transaction, domain: string | null, afterCode: string | null, limit: number): Promise<ReasonCodeView[]>;
}

export const REFERENCE_DATA_STORE = Symbol('REFERENCE_DATA_STORE');
