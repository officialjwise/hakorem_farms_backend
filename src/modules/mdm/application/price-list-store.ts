import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ActiveWindow, EntryDefinition, EntryReferences, EntryInput, PriceListSlot, VersionWindow } from '../domain/pricing/price-list';
import type { Channel, PriceListKind } from '../domain/pricing/pricing-engine';

export type VersionStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'ACTIVE' | 'SUPERSEDED' | 'REJECTED';

export interface PriceListRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: PriceListKind;
  readonly channel: Channel | null;
  readonly customerTier: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly branch: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly taxInclusive: boolean;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface VersionRow {
  readonly id: string;
  readonly priceListId: string;
  readonly versionNo: number;
  readonly status: VersionStatus;
  readonly validFrom: Date;
  readonly validTo: Date | null;
  readonly approvalRequestId: string | null;
  readonly activatedAt: Date | null;
  readonly activatedBy: string | null;
  readonly notes: string | null;
  readonly branchId: string;
  readonly entryCount: number;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
}

export interface NewPriceList extends PriceListSlot {
  readonly code: string;
  readonly name: string;
  readonly branchId: string | null;
  readonly taxInclusive: boolean;
}

/** The entries of a version, in a stable order, as the approval payload hash covers them. */
export interface EntrySnapshot {
  readonly id: string;
  readonly productId: string;
  readonly gradeId: string | null;
  readonly weightBandId: string | null;
  readonly basis: string;
  readonly listPricePesewas: bigint;
  readonly floorPricePesewas: bigint;
  readonly ceilingPricePesewas: bigint;
  readonly quoteOnly: boolean;
  readonly minQty: string;
}

/** MDM's price list tables, each call in the caller's transaction. */
export interface PriceListStore {
  tierExists(tx: Transaction, id: string): Promise<boolean>;
  branchExists(tx: Transaction, id: string): Promise<boolean>;
  /** The branch a list that applies everywhere registers its versions under: the farm's first branch (A-090). */
  firstBranchId(tx: Transaction): Promise<string>;
  insertList(tx: Transaction, id: string, list: NewPriceList, actorId: string): Promise<void>;
  list(tx: Transaction, id: string): Promise<PriceListRow | null>;
  /** The version in force now and the open draft or submitted version of a list. */
  versionsOfInterest(tx: Transaction, listId: string, now: Date): Promise<{ readonly active: VersionRow | null; readonly draftId: string | null }>;
  nextVersionNo(tx: Transaction, listId: string): Promise<number>;
  /** The id is already registered as a business document (DocumentRegistry). */
  insertVersion(tx: Transaction, version: { id: string; listId: string; versionNo: number; window: VersionWindow; notes: string | null; branchId: string }, actorId: string): Promise<void>;
  version(tx: Transaction, id: string, lock: boolean): Promise<VersionRow | null>;
  entryReferences(tx: Transaction, inputs: readonly EntryInput[]): Promise<EntryReferences>;
  entries(tx: Transaction, versionId: string): Promise<readonly EntrySnapshot[]>;
  copyEntries(tx: Transaction, fromVersionId: string, toVersionId: string, actorId: string, newId: () => string): Promise<void>;
  replaceEntries(tx: Transaction, versionId: string, entries: readonly EntryDefinition[], actorId: string, newId: () => string): Promise<void>;
  /** Bumps the version row's optimistic lock after its entries changed. */
  touchVersion(tx: Transaction, versionId: string, expectedVersion: number, actorId: string): Promise<boolean>;
  markPending(tx: Transaction, versionId: string, approvalRequestId: string, actorId: string): Promise<void>;
  activeWindows(tx: Transaction, listId: string): Promise<readonly ActiveWindow[]>;
  endVersion(tx: Transaction, versionId: string, validTo: Date, actorId: string): Promise<void>;
  supersede(tx: Transaction, versionId: string, actorId: string): Promise<void>;
  activate(tx: Transaction, versionId: string, validFrom: Date, activatedBy: string, now: Date): Promise<void>;
  reject(tx: Transaction, versionId: string, actorId: string): Promise<void>;
}

export const PRICE_LIST_STORE = Symbol('PRICE_LIST_STORE');
