import { Quantity } from '@hakorem/kernel';

/**
 * Comparing a price list version with the version in force (CR-009, previewPriceListVersion). Lines are paired by
 * the identity the engine resolves on: product, grade, weight band and quantity break, the columns of the unique
 * key on `mdm.price_list_entry` (ADR-0004). Pure: nothing here reads a clock or a table.
 */

export type PreviewKind = 'ADDED' | 'CHANGED' | 'REMOVED' | 'UNCHANGED';

/** What the comparison reads of an entry: its identity and the prices the engine would answer with. */
export interface PreviewEntry {
  readonly productId: string;
  readonly gradeId: string | null;
  readonly weightBandId: string | null;
  /** The quantity break, a decimal string of at most three places. */
  readonly minQty: string;
  readonly basis: string;
  readonly listPricePesewas: bigint;
  readonly floorPricePesewas: bigint;
  readonly ceilingPricePesewas: bigint;
  readonly quoteOnly: boolean;
  /** The selling unit the entry prices (B09e); null or absent for the base unit. */
  readonly uom?: string | null | undefined;
}

export interface PreviewLine<E extends PreviewEntry> {
  /** The entry identity: sorts in the published order and is what a cursor carries. */
  readonly key: string;
  readonly kind: PreviewKind;
  readonly current: E | null;
  readonly proposed: E | null;
}

export interface PreviewCounts {
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly unchanged: number;
}

export interface VersionComparison<E extends PreviewEntry> {
  readonly lines: readonly PreviewLine<E>[];
  readonly counts: PreviewCounts;
}

/** Sorts before every hexadecimal digit, so a missing grade or band comes before any grade or band. */
const NONE = '-';
/** Thousandths of a quantity break, zero-padded so the text sorts as the number does (`qty` is NUMERIC(14,3)). */
const QTY_KEY_DIGITS = 20;
const SEPARATOR = '|';

/**
 * The engine's identity of an entry, as sortable text: product, grade, band, quantity break, and the selling unit when it
 * is not the base unit (B09e), so an entry in the base unit keeps the identity, and a cursor, it had before.
 */
export function entryIdentity(entry: PreviewEntry): string {
  const breakAt = Quantity.parse(entry.minQty).thousandths.toString().padStart(QTY_KEY_DIGITS, '0');
  const parts = [entry.productId, entry.gradeId ?? NONE, entry.weightBandId ?? NONE, breakAt];
  return (entry.uom === undefined || entry.uom === null ? parts : [...parts, entry.uom]).join(SEPARATOR);
}

/** Whether a buyer would be priced differently: the basis, any of the three prices, or quote-only. */
function samePrices(a: PreviewEntry, b: PreviewEntry): boolean {
  return (
    a.basis === b.basis &&
    a.listPricePesewas === b.listPricePesewas &&
    a.floorPricePesewas === b.floorPricePesewas &&
    a.ceilingPricePesewas === b.ceilingPricePesewas &&
    a.quoteOnly === b.quoteOnly
  );
}

function byIdentity<E extends PreviewEntry>(entries: readonly E[]): Map<string, E> {
  const keyed = new Map<string, E>();
  for (const entry of entries) {
    const key = entryIdentity(entry);
    if (keyed.has(key)) {
      throw new Error(`two entries of one version share the identity ${key}; uq_price_list_entry should have refused it`);
    }
    keyed.set(key, entry);
  }
  return keyed;
}

/**
 * Every line of the two versions, paired by identity and sorted by it, with the counts of each kind over the whole
 * comparison. `current` is null when no version is in force: every proposed line is then ADDED.
 */
export function comparePriceListVersions<E extends PreviewEntry>(current: readonly E[] | null, proposed: readonly E[]): VersionComparison<E> {
  const before = byIdentity(current ?? []);
  const after = byIdentity(proposed);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort((x, y) => (x < y ? -1 : 1));
  const counts = { added: 0, changed: 0, removed: 0, unchanged: 0 };
  const lines = keys.map((key): PreviewLine<E> => {
    const was = before.get(key) ?? null;
    const will = after.get(key) ?? null;
    const kind: PreviewKind = was === null ? 'ADDED' : will === null ? 'REMOVED' : samePrices(was, will) ? 'UNCHANGED' : 'CHANGED';
    counts[kind.toLowerCase() as keyof PreviewCounts] += 1;
    return { key, kind, current: was, proposed: will };
  });
  return { lines, counts };
}

/** The lines after a cursor's identity, or from the first when there is no cursor. */
export function linesAfter<E extends PreviewEntry>(lines: readonly PreviewLine<E>[], afterKey: string | null): readonly PreviewLine<E>[] {
  return afterKey === null ? lines : lines.filter((line) => line.key > afterKey);
}

/**
 * The moment a version is compared at: when it would take effect. Activation never starts a version before its
 * approval (ADR-0036 decision 3), so a validFrom already past is compared at now.
 */
export function previewInstant(validFrom: Date, now: Date): Date {
  return validFrom.getTime() > now.getTime() ? validFrom : now;
}

/** A preview is of a version not yet in force: DRAFT or PENDING_APPROVAL. Otherwise the status that refuses it. */
export function previewRefusal<S extends string>(status: S): S | null {
  return status === 'DRAFT' || status === 'PENDING_APPROVAL' ? null : status;
}
