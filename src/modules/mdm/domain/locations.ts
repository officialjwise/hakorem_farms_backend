import { err, ok, type Result } from '@hakorem/kernel';
import type { CatalogueRule } from './catalogue';

/** Where stock can be (ADR-0002, ADR-0007). The last eight are virtual: stock is never physically there. */
export type LocationKind =
  | 'SITE'
  | 'PEN'
  | 'COLD_ROOM'
  | 'STORE'
  | 'SHOP_FLOOR'
  | 'VEHICLE'
  | 'RETURNS_HOLD'
  | 'QUARANTINE'
  | 'IN_TRANSIT'
  | VirtualKind;

export const VIRTUAL_KINDS = ['SUPPLIER', 'CUSTOMER', 'PRODUCTION', 'PROCESSING', 'CONSUMPTION', 'LOSS', 'ADJUSTMENT', 'OPENING'] as const;
export type VirtualKind = (typeof VIRTUAL_KINDS)[number];
export type TempClass = 'AMBIENT' | 'CHILLED' | 'FROZEN';

export function isVirtualKind(kind: LocationKind): kind is VirtualKind {
  return (VIRTUAL_KINDS as readonly string[]).includes(kind);
}

/** What the application found about a proposed parent. */
export interface ParentFacts {
  readonly sameBranch: boolean;
  readonly isVirtual: boolean;
}

export interface LocationInput {
  readonly kind: LocationKind;
  readonly parent: ParentFacts | null;
  readonly tempClass: TempClass | undefined;
  readonly tempMinC: string | undefined;
  readonly tempMaxC: string | undefined;
}

function parentRules(parent: ParentFacts | null): CatalogueRule[] {
  if (parent === null) return [];
  if (!parent.sameBranch) return [{ field: '/parentId', rule: 'PARENT_IN_OTHER_BRANCH' }];
  if (parent.isVirtual) return [{ field: '/parentId', rule: 'PARENT_IS_VIRTUAL' }];
  return [];
}

/** Celsius strings to one place (the contract's `Celsius`) compare as numbers. */
function rangeRules(min: string | null | undefined, max: string | null | undefined): CatalogueRule[] {
  if (min === null || min === undefined || max === null || max === undefined) return [];
  return Number(max) > Number(min) ? [] : [{ field: '/tempMaxC', rule: 'NOT_ABOVE_MIN' }];
}

/**
 * A new physical location (FR-MDM-006). Its parent is a physical location of the same branch (the database's
 * trigger refuses another branch too). Virtual locations are given to a branch when it is created and are never
 * created one by one. A cold room carries a chilled or frozen class and the range its excursions are measured
 * against.
 */
export function planLocation(input: LocationInput): Result<{ readonly tempClass: TempClass | null }, CatalogueRule[]> {
  if (isVirtualKind(input.kind)) return err([{ field: '/kind', rule: 'VIRTUAL_KIND_FIXED' }]);
  const rules = parentRules(input.parent);
  if (input.kind === 'COLD_ROOM') {
    if (input.tempClass !== 'CHILLED' && input.tempClass !== 'FROZEN') rules.push({ field: '/tempClass', rule: 'COLD_ROOM_NEEDS_TEMPERATURE' });
    if (input.tempMinC === undefined) rules.push({ field: '/tempMinC', rule: 'COLD_ROOM_NEEDS_TEMPERATURE' });
    if (input.tempMaxC === undefined) rules.push({ field: '/tempMaxC', rule: 'COLD_ROOM_NEEDS_TEMPERATURE' });
  }
  rules.push(...rangeRules(input.tempMinC, input.tempMaxC));
  return rules.length > 0 ? err(rules) : ok({ tempClass: input.tempClass ?? null });
}

export interface LocationState {
  readonly isVirtual: boolean;
  readonly kind: LocationKind;
  readonly tempMinC: string | null;
  readonly tempMaxC: string | null;
}

export interface LocationChange {
  readonly parent?: (ParentFacts & { readonly isSelfOrBelow: boolean }) | undefined;
  readonly tempMinC?: string | undefined;
  readonly tempMaxC?: string | undefined;
}

/** A change to a location: never to a virtual one; a new parent obeys the create rules and is not the location or below it. */
export function planLocationChange(state: LocationState, change: LocationChange): Result<void, CatalogueRule[]> {
  if (state.isVirtual) return err([{ field: null, rule: 'VIRTUAL_LOCATION_FIXED' }]);
  const rules = change.parent === undefined ? [] : parentRules(change.parent);
  if (rules.length === 0 && change.parent?.isSelfOrBelow === true) rules.push({ field: '/parentId', rule: 'PARENT_IS_SELF_OR_BELOW' });
  rules.push(...rangeRules(change.tempMinC ?? state.tempMinC, change.tempMaxC ?? state.tempMaxC));
  return rules.length > 0 ? err(rules) : ok(undefined);
}

/**
 * Archiving a location (FR-MDM-006): never a virtual one, and not while live locations sit below it. The stock
 * check ("a location with stock cannot be archived") arrives with inventory in B5 (A-111).
 */
export function planLocationArchive(usage: { readonly isVirtual: boolean; readonly liveChildren: number }): Result<void, CatalogueRule[]> {
  if (usage.isVirtual) return err([{ field: null, rule: 'VIRTUAL_LOCATION_FIXED' }]);
  return usage.liveChildren > 0 ? err([{ field: null, rule: 'HAS_LIVE_CHILDREN' }]) : ok(undefined);
}
