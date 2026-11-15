import { describe, expect, it } from 'vitest';
import { checkBirth, checkDam, checkSire, expectedBirth, nextBreedingStatus, stillbirthsOf } from './breeding';

describe('a mating (FR-LIV-010)', () => {
  it('expects a goat mated on 1 March 2027 to kid on 28 July 2027, 150 days on', () => {
    expect(expectedBirth('2027-03-01', 150)).toBe('2027-07-28');
  });

  it('counts a sheep, a pig and a rabbit from their own gestation days, the mating day being day one', () => {
    expect(expectedBirth('2027-03-01', 147)).toBe('2027-07-25');
    expect(expectedBirth('2026-12-31', 114)).toBe('2027-04-23');
    // 2028 is a leap year: 1 February plus 30 days is 2 March.
    expect(expectedBirth('2028-02-01', 31)).toBe('2028-03-02');
  });

  it('accepts a live female of a breeding species as dam', () => {
    expect(checkDam({ status: 'ALIVE', sex: 'FEMALE', gestationDays: 150 })).toEqual([]);
  });

  it('refuses a male dam, a dead dam and a species with no gestation period', () => {
    expect(checkDam({ status: 'ALIVE', sex: 'MALE', gestationDays: 150 })).toEqual([{ field: '/damId', rule: 'DAM_NOT_FEMALE' }]);
    expect(checkDam({ status: 'DEAD', sex: 'FEMALE', gestationDays: 150 })).toEqual([{ field: '/damId', rule: 'DAM_NOT_ALIVE' }]);
    expect(checkDam({ status: 'ALIVE', sex: 'FEMALE', gestationDays: null })).toEqual([{ field: '/damId', rule: 'NOT_A_BREEDING_SPECIES' }]);
  });

  it('accepts a male sire of the same species and refuses any other', () => {
    expect(checkSire({ sex: 'MALE', speciesId: 'goat' }, 'goat', 'dam')).toEqual([]);
    expect(checkSire({ sex: 'FEMALE', speciesId: 'goat' }, 'goat', 'dam')).toEqual([{ field: '/sireId', rule: 'SIRE_NOT_MALE' }]);
    expect(checkSire({ sex: 'MALE', speciesId: 'sheep' }, 'goat', 'dam')).toEqual([{ field: '/sireId', rule: 'SIRE_OF_ANOTHER_SPECIES' }]);
  });

  it('refuses the dam as her own sire', () => {
    expect(checkSire({ sex: 'MALE', speciesId: 'goat', id: 'dam' }, 'goat', 'dam')).toEqual([{ field: '/sireId', rule: 'SIRE_IS_DAM' }]);
  });
});

describe('the status of a breeding record (FR-LIV-010)', () => {
  it('confirms a mating, and keeps a status that does not change', () => {
    expect(nextBreedingStatus('MATED', 'CONFIRMED')).toEqual({ ok: true, value: 'CONFIRMED' });
    expect(nextBreedingStatus('CONFIRMED', 'CONFIRMED')).toEqual({ ok: true, value: 'CONFIRMED' });
    expect(nextBreedingStatus('MATED', undefined)).toEqual({ ok: true, value: 'MATED' });
  });

  it('never takes a confirmed pregnancy back to mated', () => {
    expect(nextBreedingStatus('CONFIRMED', 'MATED')).toEqual({ ok: false, error: 'STATUS_BACKWARDS' });
  });

  it('refuses any change once born or failed', () => {
    expect(nextBreedingStatus('BORN', 'CONFIRMED')).toEqual({ ok: false, error: 'RECORD_CLOSED' });
    expect(nextBreedingStatus('FAILED', undefined)).toEqual({ ok: false, error: 'RECORD_CLOSED' });
  });
});

describe('a birth (FR-LIV-011)', () => {
  const record = { status: 'MATED' as const, matedOn: '2027-03-01' };
  const dam = { sex: 'FEMALE' as const, status: 'ALIVE' as const, closedOn: null };
  const today = '2027-08-01';

  it('accepts a litter of 3 live kids and 1 stillborn on a live dam', () => {
    expect(checkBirth(record, { actualBirthOn: '2027-07-28', litterSize: 4, tags: ['K-1', 'K-2', 'K-3'] }, dam, today)).toEqual([]);
    expect(stillbirthsOf({ actualBirthOn: '2027-07-28', litterSize: 4, tags: ['K-1', 'K-2', 'K-3'] })).toBe(1);
  });

  it('accepts a birth on or before the day the dam later died, and refuses one after it', () => {
    const died = { ...dam, status: 'DEAD' as const, closedOn: '2027-07-28' };
    expect(checkBirth(record, { actualBirthOn: '2027-07-28', litterSize: 1, tags: ['K-1'] }, died, today)).toEqual([]);
    expect(checkBirth(record, { actualBirthOn: '2027-07-29', litterSize: 1, tags: ['K-1'] }, died, today)).toEqual([{ field: '/actualBirthOn', rule: 'DAM_NOT_ALIVE_ON_BIRTH' }]);
  });

  it('refuses a dam who is not female', () => {
    expect(checkBirth(record, { actualBirthOn: '2027-07-28', litterSize: 1, tags: ['K-1'] }, { ...dam, sex: 'UNKNOWN' }, today)).toEqual([{ field: '/actualBirthOn', rule: 'DAM_NOT_FEMALE' }]);
  });

  it('refuses more live offspring than the litter, a repeated tag, a date before mating and a date to come', () => {
    expect(checkBirth(record, { actualBirthOn: '2027-07-28', litterSize: 1, tags: ['K-1', 'K-2'] }, dam, today)).toEqual([{ field: '/offspring', rule: 'LIVE_ABOVE_LITTER' }]);
    expect(checkBirth(record, { actualBirthOn: '2027-07-28', litterSize: 2, tags: ['K-1', 'K-1'] }, dam, today)).toEqual([{ field: '/offspring', rule: 'TAG_REPEATED' }]);
    expect(checkBirth(record, { actualBirthOn: '2027-02-28', litterSize: 1, tags: ['K-1'] }, dam, today)).toEqual([{ field: '/actualBirthOn', rule: 'BIRTH_BEFORE_MATING' }]);
    expect(checkBirth(record, { actualBirthOn: '2027-08-02', litterSize: 1, tags: ['K-1'] }, dam, today)).toEqual([{ field: '/actualBirthOn', rule: 'IN_THE_FUTURE' }]);
  });

  it('accepts a litter that was all stillborn, and refuses a record already closed', () => {
    expect(checkBirth(record, { actualBirthOn: '2027-07-28', litterSize: 2, tags: [] }, dam, today)).toEqual([]);
    expect(checkBirth({ ...record, status: 'FAILED' }, { actualBirthOn: '2027-07-28', litterSize: 1, tags: ['K-1'] }, dam, today)).toEqual([{ field: '/actualBirthOn', rule: 'RECORD_CLOSED' }]);
  });
});
