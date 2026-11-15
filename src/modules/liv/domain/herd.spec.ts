import { describe, expect, it } from 'vitest';
import { checkAnimalEdit, checkBatchClose, checkMove, holdsAnimals } from './herd';

describe('an animal edit (FR-LIV-002)', () => {
  const alive = { status: 'ALIVE' as const, sex: 'FEMALE' as const, tagNo: 'D-017', isDam: false };

  it('accepts a change of breed, sex, purpose and grade on a live animal', () => {
    expect(checkAnimalEdit(alive, { breed: 'Sahelian', sex: 'MALE', purpose: 'BREEDING', gradeId: 'g' })).toEqual([]);
  });

  it('refuses any edit of an animal that is no longer alive', () => {
    expect(checkAnimalEdit({ ...alive, status: 'SOLD' }, { breed: 'Sahelian' })).toEqual([{ field: '/version', rule: 'ANIMAL_NOT_ALIVE' }]);
  });

  it('refuses a change of sex once the animal is the dam of a breeding record', () => {
    expect(checkAnimalEdit({ ...alive, isDam: true }, { sex: 'MALE' })).toEqual([{ field: '/sex', rule: 'SEX_FIXED_AS_DAM' }]);
    expect(checkAnimalEdit({ ...alive, isDam: true }, { sex: 'FEMALE' })).toEqual([]);
  });

  it('refuses a different tag, which is the stock unit identifier inventory holds fixed (A-159)', () => {
    expect(checkAnimalEdit(alive, { tagNo: 'D-018' })).toEqual([{ field: '/tagNo', rule: 'TAG_NOT_EDITABLE' }]);
    expect(checkAnimalEdit(alive, { tagNo: 'D-017' })).toEqual([]);
  });
});

describe('a move between pens (FR-LIV-003)', () => {
  const pen = { id: 'pen-2', branchId: 'ddw', kind: 'PEN', isVirtual: false, isLive: true };

  it('moves a live animal from where it stands to another physical location of its branch', () => {
    expect(checkMove({ alive: true, branchId: 'ddw', currentLocationId: 'pen-1' }, pen)).toEqual([]);
  });

  it('refuses a move to where the animal already is', () => {
    expect(checkMove({ alive: true, branchId: 'ddw', currentLocationId: 'pen-2' }, pen)).toEqual([{ field: '/toLocationId', rule: 'ALREADY_THERE' }]);
  });

  it('refuses a closed animal, and one standing nowhere', () => {
    expect(checkMove({ alive: false, branchId: 'ddw', currentLocationId: null }, pen)).toEqual([{ field: '/toLocationId', rule: 'ANIMAL_NOT_ALIVE' }]);
    expect(checkMove({ alive: true, branchId: 'ddw', currentLocationId: null }, pen)).toEqual([{ field: '/toLocationId', rule: 'NOT_IN_ONE_PLACE' }]);
  });

  it('refuses another branch, a virtual or inactive location, a site and stock in transit', () => {
    const animal = { alive: true, branchId: 'ddw', currentLocationId: 'pen-1' };
    expect(checkMove(animal, { ...pen, branchId: 'tst' })).toEqual([{ field: '/toLocationId', rule: 'OTHER_BRANCH' }]);
    for (const to of [{ ...pen, isVirtual: true }, { ...pen, isLive: false }, { ...pen, kind: 'SITE' }, { ...pen, kind: 'IN_TRANSIT' }]) {
      expect(checkMove(animal, to)).toEqual([{ field: '/toLocationId', rule: 'NOT_A_PEN' }]);
    }
  });
});

describe('where animals can be kept (FR-LIV-003, FR-LIV-006)', () => {
  it('keeps animals in a live pen and in any other live physical location but a site or the road', () => {
    expect(holdsAnimals({ kind: 'PEN', isVirtual: false, isLive: true })).toBe(true);
    expect(holdsAnimals({ kind: 'SHOP_FLOOR', isVirtual: false, isLive: true })).toBe(true);
    expect(holdsAnimals({ kind: 'SITE', isVirtual: false, isLive: true })).toBe(false);
    expect(holdsAnimals({ kind: 'PEN', isVirtual: true, isLive: true })).toBe(false);
  });
});

describe('closing a batch (FR-LIV-006)', () => {
  it('closes a batch with no head left', () => {
    expect(checkBatchClose({ status: 'ACTIVE', currentHead: 0n })).toEqual([]);
  });

  it('refuses a batch with 18 head left, whatever reason is given', () => {
    expect(checkBatchClose({ status: 'ACTIVE', currentHead: 18n })).toEqual([{ field: '/reason', rule: 'BATCH_NOT_EMPTY' }]);
  });

  it('refuses a batch already closed', () => {
    expect(checkBatchClose({ status: 'CLOSED', currentHead: 0n })).toEqual([{ field: '/reason', rule: 'BATCH_CLOSED' }]);
  });
});
