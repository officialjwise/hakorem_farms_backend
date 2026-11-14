import { err, ok, Quantity, type Result } from '@hakorem/kernel';
import type { FieldRule } from '../product';
import type { Channel, PriceBasis, PriceListKind } from './pricing-engine';

/** Price lists, versions and entries (FR-MDM-015, ADR-0004, ADR-0036). Pure rules; the database repeats them. */

export interface PriceListSlot {
  readonly kind: PriceListKind;
  readonly channel: Channel | null;
  readonly customerTierId: string | null;
}

/**
 * A list's place in the resolution order: TIER needs a channel and a tier, CHANNEL a channel and no tier, BASE and
 * CUSTOMER neither (a customer's contract list applies on every channel).
 */
export function definePriceList(draft: { readonly kind: PriceListKind; readonly channel?: Channel | undefined; readonly customerTierId?: string | undefined }): Result<PriceListSlot, FieldRule[]> {
  const takesChannel = draft.kind === 'TIER' || draft.kind === 'CHANNEL';
  const takesTier = draft.kind === 'TIER';
  const problems: FieldRule[] = [];
  if (takesChannel !== (draft.channel !== undefined)) {
    problems.push({ field: '/channel', rule: takesChannel ? 'REQUIRED' : 'NOT_ALLOWED' });
  }
  if (takesTier !== (draft.customerTierId !== undefined)) {
    problems.push({ field: '/customerTierId', rule: takesTier ? 'REQUIRED' : 'NOT_ALLOWED' });
  }
  if (problems.length > 0) {
    return err(problems);
  }
  return ok({ kind: draft.kind, channel: draft.channel ?? null, customerTierId: draft.customerTierId ?? null });
}

export interface VersionWindow {
  readonly validFrom: Date;
  readonly validTo: Date | null;
}

export function defineVersionWindow(validFrom: Date, validTo: Date | null): Result<VersionWindow, FieldRule[]> {
  if (validTo !== null && validTo.getTime() <= validFrom.getTime()) {
    return err([{ field: '/validTo', rule: 'NOT_AFTER_VALID_FROM' }]);
  }
  return ok({ validFrom, validTo });
}

export interface EntryInput {
  readonly productId: string;
  readonly gradeId?: string | undefined;
  readonly weightBandId?: string | undefined;
  readonly basis: PriceBasis;
  readonly listPricePesewas: bigint;
  readonly floorPricePesewas: bigint;
  readonly ceilingPricePesewas: bigint;
  readonly quoteOnly?: boolean | undefined;
  readonly minQty?: string | undefined;
}

export interface EntryDefinition {
  readonly productId: string;
  readonly gradeId: string | null;
  readonly weightBandId: string | null;
  readonly basis: PriceBasis;
  readonly listPricePesewas: bigint;
  readonly floorPricePesewas: bigint;
  readonly ceilingPricePesewas: bigint;
  readonly quoteOnly: boolean;
  readonly minQty: Quantity;
}

/** What the entries refer to, looked up by the application: each product's species, each grade's and band's. */
export interface EntryReferences {
  readonly products: ReadonlyMap<string, { readonly speciesId: string | null }>;
  readonly grades: ReadonlyMap<string, { readonly speciesId: string }>;
  readonly bands: ReadonlyMap<string, { readonly speciesId: string }>;
}

function speciesRule(id: string | undefined, found: { readonly speciesId: string } | undefined, productSpecies: string | null | undefined): string | null {
  if (id === undefined) {
    return null;
  }
  if (found === undefined) {
    return 'UNKNOWN';
  }
  return productSpecies === undefined || found.speciesId === productSpecies ? null : 'OTHER_SPECIES';
}

/**
 * Validates the full set of entries of a draft version. A priced entry is a band with floor <= list <= ceiling and
 * a floor above zero (no sale can be agreed at nothing without approval); a quote-only entry carries no price.
 * A grade or band must belong to the product's species. No two entries share product, grade, band and break.
 */
export function defineEntries(inputs: readonly EntryInput[], refs: EntryReferences): Result<EntryDefinition[], FieldRule[]> {
  const problems: FieldRule[] = [];
  const seen = new Set<string>();
  const entries = inputs.map((input, index): EntryDefinition => {
    const at = `/entries/${index}`;
    const product = refs.products.get(input.productId);
    if (product === undefined) {
      problems.push({ field: `${at}/productId`, rule: 'UNKNOWN' });
    }
    const gradeRule = speciesRule(input.gradeId, input.gradeId === undefined ? undefined : refs.grades.get(input.gradeId), product?.speciesId);
    if (gradeRule !== null) {
      problems.push({ field: `${at}/gradeId`, rule: gradeRule });
    }
    const bandRule = speciesRule(input.weightBandId, input.weightBandId === undefined ? undefined : refs.bands.get(input.weightBandId), product?.speciesId);
    if (bandRule !== null) {
      problems.push({ field: `${at}/weightBandId`, rule: bandRule });
    }
    const quoteOnly = input.quoteOnly ?? false;
    if (input.floorPricePesewas > input.listPricePesewas) {
      problems.push({ field: `${at}/floorPricePesewas`, rule: 'ABOVE_LIST' });
    } else if (input.ceilingPricePesewas < input.listPricePesewas) {
      problems.push({ field: `${at}/ceilingPricePesewas`, rule: 'BELOW_LIST' });
    } else if (!quoteOnly && input.floorPricePesewas === 0n) {
      problems.push({ field: `${at}/floorPricePesewas`, rule: 'ZERO_PRICE' });
    }
    const minQty = Quantity.parse(input.minQty ?? '0.000');
    const key = [input.productId, input.gradeId ?? '-', input.weightBandId ?? '-', minQty.toDecimalString()].join('|');
    if (seen.has(key)) {
      problems.push({ field: at, rule: 'DUPLICATE_ENTRY' });
    }
    seen.add(key);
    return {
      productId: input.productId,
      gradeId: input.gradeId ?? null,
      weightBandId: input.weightBandId ?? null,
      basis: input.basis,
      listPricePesewas: input.listPricePesewas,
      floorPricePesewas: input.floorPricePesewas,
      ceilingPricePesewas: input.ceilingPricePesewas,
      quoteOnly,
      minQty,
    };
  });
  return problems.length > 0 ? err(problems) : ok(entries);
}

/**
 * The window a version is activated with: from its valid-from, or from the moment of approval if that is later, so
 * a late approval never reprices sales already made. A version whose whole window passed before approval cannot
 * be activated; the maker drafts a new one (ADR-0036).
 */
export function activationWindow(window: VersionWindow, now: Date): Result<VersionWindow, 'WINDOW_PASSED'> {
  if (window.validTo !== null && window.validTo.getTime() <= now.getTime()) {
    return err('WINDOW_PASSED');
  }
  return ok(window.validFrom.getTime() >= now.getTime() ? window : { validFrom: now, validTo: window.validTo });
}

export interface ActiveWindow extends VersionWindow {
  readonly id: string;
}

export type ActivationStep = { readonly id: string; readonly action: 'END'; readonly validTo: Date } | { readonly id: string; readonly action: 'SUPERSEDE' };

const FOREVER = Number.POSITIVE_INFINITY;

/**
 * What activating a version does to the list's active versions, so that no two overlap (the database exclusion
 * constraint is the backstop). An active version that started earlier is ended where the new one starts, keeping
 * its history; one that starts at or after the new one's start and overlaps it is superseded. A new version with
 * an end date does not revive anything after it: the list then has no price until another version is activated,
 * and the walk goes on to the next list (ADR-0036).
 */
export function planActivation(next: VersionWindow, actives: readonly ActiveWindow[]): ActivationStep[] {
  const nextFrom = next.validFrom.getTime();
  const nextTo = next.validTo?.getTime() ?? FOREVER;
  const steps: ActivationStep[] = [];
  for (const active of actives) {
    const from = active.validFrom.getTime();
    const to = active.validTo?.getTime() ?? FOREVER;
    if (from >= nextTo || to <= nextFrom) {
      continue;
    }
    steps.push(from < nextFrom ? { id: active.id, action: 'END', validTo: next.validFrom } : { id: active.id, action: 'SUPERSEDE' });
  }
  return steps;
}
