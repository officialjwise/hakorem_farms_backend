import type { AnimalStatus } from './animal';
import type { LivRuleBroken } from './rules';

/** Locations that hold no animals: a whole site, stock on the road (A-158). Virtual and inactive ones are refused too. */
const NOT_A_PEN: ReadonlySet<string> = new Set(['IN_TRANSIT', 'SITE']);

export interface EditedAnimal {
  readonly status: AnimalStatus;
  readonly sex: 'MALE' | 'FEMALE' | 'UNKNOWN';
  readonly tagNo: string;
  /** Whether a breeding record names the animal as its dam. */
  readonly isDam: boolean;
}

export interface AnimalChange {
  readonly breed?: string | undefined;
  readonly sex?: 'MALE' | 'FEMALE' | 'UNKNOWN' | undefined;
  readonly purpose?: 'GROWING' | 'BREEDING' | undefined;
  readonly gradeId?: string | undefined;
  readonly tagNo?: string | undefined;
}

/**
 * What an edit of an animal may change (FR-LIV-002, A-159): breed, sex, purpose and grade, on a live animal only.
 * Species, product, branch, acquisition date, source and cost are not in the request at all, and the database refuses
 * them besides. Sex is fixed once the animal is the dam of a breeding record; the tag is the stock unit's identifier,
 * which inventory holds fixed, so only the tag it already has is accepted.
 */
export function checkAnimalEdit(animal: EditedAnimal, change: AnimalChange): LivRuleBroken[] {
  if (animal.status !== 'ALIVE') return [{ field: '/version', rule: 'ANIMAL_NOT_ALIVE' }];
  const broken: LivRuleBroken[] = [];
  if (change.sex !== undefined && change.sex !== animal.sex && animal.isDam) broken.push({ field: '/sex', rule: 'SEX_FIXED_AS_DAM' });
  if (change.tagNo !== undefined && change.tagNo !== animal.tagNo) broken.push({ field: '/tagNo', rule: 'TAG_NOT_EDITABLE' });
  return broken;
}

export interface MovedAnimal {
  readonly alive: boolean;
  readonly branchId: string;
  /** Where inventory says the animal stands now: a move always starts there. */
  readonly currentLocationId: string | null;
}

export interface MoveDestination {
  readonly id: string;
  readonly branchId: string;
  readonly kind: string;
  readonly isVirtual: boolean;
  readonly isLive: boolean;
}

/** Whether a location can hold animals: a live physical location that is neither a whole site nor stock on the road. */
export function holdsAnimals(location: Pick<MoveDestination, 'kind' | 'isVirtual' | 'isLive'>): boolean {
  return !location.isVirtual && location.isLive && !NOT_A_PEN.has(location.kind);
}

/**
 * A move between pens (FR-LIV-003): a live animal, from where it stands, to another physical location of its own
 * branch that can hold animals. A hold does not stop it; a move to another branch is a stock transfer, not this.
 */
export function checkMove(animal: MovedAnimal, to: MoveDestination): LivRuleBroken[] {
  const field = '/toLocationId';
  if (!animal.alive) return [{ field, rule: 'ANIMAL_NOT_ALIVE' }];
  if (animal.currentLocationId === null) return [{ field, rule: 'NOT_IN_ONE_PLACE' }];
  if (to.branchId !== animal.branchId) return [{ field, rule: 'OTHER_BRANCH' }];
  if (!holdsAnimals(to)) return [{ field, rule: 'NOT_A_PEN' }];
  if (to.id === animal.currentLocationId) return [{ field, rule: 'ALREADY_THERE' }];
  return [];
}

/**
 * Closing a batch (FR-LIV-006, A-159): only an active batch with no head left. The reason is always recorded; with
 * head still on hand the close is refused whatever the reason, since closing would hide stock that is still there.
 */
export function checkBatchClose(batch: { readonly status: 'ACTIVE' | 'CLOSED'; readonly currentHead: bigint }): LivRuleBroken[] {
  if (batch.status === 'CLOSED') return [{ field: '/reason', rule: 'BATCH_CLOSED' }];
  if (batch.currentHead > 0n) return [{ field: '/reason', rule: 'BATCH_NOT_EMPTY' }];
  return [];
}
