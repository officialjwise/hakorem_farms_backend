import { err, ok, type Result } from '@hakorem/kernel';
import type { AnimalStatus } from './animal';
import type { LivRuleBroken } from './rules';

export type BreedingStatus = 'MATED' | 'CONFIRMED' | 'BORN' | 'FAILED';
type Sex = 'MALE' | 'FEMALE' | 'UNKNOWN';

const MS_PER_DAY = 86_400_000;
/** The mating day is day one of the gestation. */
const MATING_DAY = 1;
const CLOSED: ReadonlySet<BreedingStatus> = new Set(['BORN', 'FAILED']);
const ORDER: Readonly<Record<'MATED' | 'CONFIRMED', number>> = { MATED: 0, CONFIRMED: 1 };

/**
 * The expected birth date from the species' gestation days (FR-LIV-010; SA-19 seeds them as data), counting the mating
 * day as the first day of gestation, as the requirement's own example does: a goat (150 days) mated on 1 March 2027 is
 * expected on 28 July 2027 (A-159).
 */
export function expectedBirth(matedOn: string, gestationDays: number): string {
  return new Date(Date.parse(`${matedOn}T00:00:00Z`) + (gestationDays - MATING_DAY) * MS_PER_DAY).toISOString().slice(0, 10);
}

/** A dam is a live female of a species with a gestation period on record (FR-LIV-010). */
export function checkDam(dam: { readonly status: AnimalStatus; readonly sex: Sex; readonly gestationDays: number | null }): LivRuleBroken[] {
  const field = '/damId';
  if (dam.gestationDays === null) return [{ field, rule: 'NOT_A_BREEDING_SPECIES' }];
  if (dam.status !== 'ALIVE') return [{ field, rule: 'DAM_NOT_ALIVE' }];
  if (dam.sex !== 'FEMALE') return [{ field, rule: 'DAM_NOT_FEMALE' }];
  return [];
}

/** A sire, where known, is a male of the dam's species and not the dam herself. */
export function checkSire(sire: { readonly sex: Sex; readonly speciesId: string; readonly id?: string }, damSpeciesId: string, damId: string): LivRuleBroken[] {
  const field = '/sireId';
  if (sire.id === damId) return [{ field, rule: 'SIRE_IS_DAM' }];
  if (sire.speciesId !== damSpeciesId) return [{ field, rule: 'SIRE_OF_ANOTHER_SPECIES' }];
  if (sire.sex !== 'MALE') return [{ field, rule: 'SIRE_NOT_MALE' }];
  return [];
}

/** The status an update leaves a record in: a mating may be confirmed, never unconfirmed; a closed record never changes. */
export function nextBreedingStatus(current: BreedingStatus, requested: 'MATED' | 'CONFIRMED' | undefined): Result<BreedingStatus, 'RECORD_CLOSED' | 'STATUS_BACKWARDS'> {
  if (CLOSED.has(current)) return err('RECORD_CLOSED');
  if (requested === undefined) return ok(current);
  if (ORDER[requested] < ORDER[current as 'MATED' | 'CONFIRMED']) return err('STATUS_BACKWARDS');
  return ok(requested);
}

export interface BirthShape {
  readonly actualBirthOn: string;
  readonly litterSize: number;
  /** The tags of the live offspring; the rest of the litter was stillborn. */
  readonly tags: readonly string[];
}

/**
 * A birth (FR-LIV-011): on an open record, on or after the mating and not in the future, with no more live offspring
 * than the litter and no tag twice, by a dam who was female and alive on the birth date: a dam closed (sold, dead,
 * slaughtered) on a day before the birth could not have given it.
 */
export function checkBirth(
  record: { readonly status: BreedingStatus; readonly matedOn: string },
  birth: BirthShape,
  dam: { readonly sex: Sex; readonly status: AnimalStatus; readonly closedOn: string | null },
  today: string,
): LivRuleBroken[] {
  const field = '/actualBirthOn';
  if (CLOSED.has(record.status)) return [{ field, rule: 'RECORD_CLOSED' }];
  const broken: LivRuleBroken[] = [];
  if (birth.actualBirthOn < record.matedOn) broken.push({ field, rule: 'BIRTH_BEFORE_MATING' });
  else if (birth.actualBirthOn > today) broken.push({ field, rule: 'IN_THE_FUTURE' });
  else if (dam.sex !== 'FEMALE') broken.push({ field, rule: 'DAM_NOT_FEMALE' });
  else if (dam.status !== 'ALIVE' && dam.closedOn !== null && dam.closedOn < birth.actualBirthOn) broken.push({ field, rule: 'DAM_NOT_ALIVE_ON_BIRTH' });
  if (birth.tags.length > birth.litterSize) broken.push({ field: '/offspring', rule: 'LIVE_ABOVE_LITTER' });
  else if (new Set(birth.tags).size !== birth.tags.length) broken.push({ field: '/offspring', rule: 'TAG_REPEATED' });
  return broken;
}

/** The litter born dead: the litter less the live offspring registered (FR-LIV-011). */
export function stillbirthsOf(birth: BirthShape): number {
  return birth.litterSize - birth.tags.length;
}
