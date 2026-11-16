import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { monthEnds, plusMonths } from './asset-months';
import {
  checkDisposal,
  checkEstimateChange,
  checkNewAsset,
  depreciationCharge,
  depreciationPostingAmounts,
  disposalAmounts,
  disposalPostingAmounts,
  judgeRunPost,
  statusFor,
  type DepreciationState,
} from './fixed-asset';

const pesewas = (n: number) => Money.ofPesewas(BigInt(n));
const asset = (over: Partial<DepreciationState> = {}): DepreciationState => ({
  cost: pesewas(1_200_000),
  residual: pesewas(0),
  usefulLifeMonths: 120,
  accumulated: pesewas(0),
  depreciatedMonths: 0,
  acquiredOn: '2026-01-05',
  status: 'IN_USE',
  ...over,
});
/** Runs every month from the first, as the farm would, and returns each month's charge. */
function everyMonth(state: DepreciationState, months: number): bigint[] {
  const charges: bigint[] = [];
  let current = state;
  for (const end of monthEnds('2026-01', months)) {
    const charge = depreciationCharge(current, end);
    charges.push(charge?.amount.pesewas ?? 0n);
    if (charge !== null) {
      current = { ...current, accumulated: current.accumulated.plus(charge.amount), depreciatedMonths: plusMonths(current.depreciatedMonths, charge.months) };
    }
  }
  return charges;
}

describe('a depreciation schedule spreads the depreciable amount exactly with allocate (FR-FIN-015)', () => {
  it('charges a cold room of 1,200,000 with no residual over 120 months exactly 10,000 a month', () => {
    const charges = everyMonth(asset(), 120);
    expect(new Set(charges)).toEqual(new Set([10_000n]));
    expect(charges.reduce((a, b) => a + b, 0n)).toBe(1_200_000n);
  });

  it('charges 1,000,001 over 3 months 333,334, 333,334 and 333,333', () => {
    expect(everyMonth(asset({ cost: pesewas(1_000_001), usefulLifeMonths: 3 }), 3)).toEqual([333_334n, 333_334n, 333_333n]);
  });

  it('charges a cold room of 4,500,000 less 500,000 residual over 36 months 111,112 for four months, then 111,111, to exactly 4,000,000', () => {
    const charges = everyMonth(asset({ cost: pesewas(4_500_000), residual: pesewas(500_000), usefulLifeMonths: 36 }), 36);
    expect(charges.slice(0, 4)).toEqual([111_112n, 111_112n, 111_112n, 111_112n]);
    expect(new Set(charges.slice(4))).toEqual(new Set([111_111n]));
    expect(charges.reduce((a, b) => a + b, 0n)).toBe(4_000_000n);
  });

  it('charges nothing after the last month, so the schedule never passes the depreciable amount', () => {
    const charges = everyMonth(asset({ cost: pesewas(1_000_001), usefulLifeMonths: 3 }), 6);
    expect(charges).toEqual([333_334n, 333_334n, 333_333n, 0n, 0n, 0n]);
  });

  it('catches up months no run charged in one line, and the months after it carry on the same schedule', () => {
    const charge = depreciationCharge(asset({ cost: pesewas(1_000_001), usefulLifeMonths: 3 }), '2026-02-28');
    expect(charge).toEqual({ fromMonth: 0, months: 2, amount: pesewas(666_668) });
    expect(depreciationCharge(asset({ cost: pesewas(1_000_001), usefulLifeMonths: 3, accumulated: pesewas(666_668), depreciatedMonths: 2 }), '2026-03-31')).toEqual({
      fromMonth: 2,
      months: 1,
      amount: pesewas(333_333),
    });
  });

  it('spreads what is left over the months left after a change of estimate, the leftover pesewas in the earliest of them', () => {
    // 10 months charged at 10,000; the life shortened to 60 months: 1,100,000 over 50 months.
    const shortened = asset({ accumulated: pesewas(100_000), depreciatedMonths: 10, usefulLifeMonths: 60 });
    expect(depreciationCharge(shortened, '2026-11-30')?.amount).toEqual(pesewas(22_000));
    // A residual of 1 set instead: 1,099,999 over 110 months, 109 months of 10,000 and one of 9,999.
    const residual = asset({ accumulated: pesewas(100_000), depreciatedMonths: 10, residual: pesewas(1) });
    expect(depreciationCharge(residual, '2026-11-30')?.amount).toEqual(pesewas(10_000));
    expect(depreciationCharge({ ...residual, accumulated: pesewas(1_190_000), depreciatedMonths: 119 }, '2035-12-31')?.amount).toEqual(pesewas(9_999));
  });

  it('charges nothing to an asset disposed of, fully depreciated, kept at its residual, or not yet acquired', () => {
    expect(depreciationCharge(asset({ status: 'DISPOSED' }), '2026-03-31')).toBeNull();
    expect(depreciationCharge(asset({ accumulated: pesewas(1_200_000), depreciatedMonths: 120, status: 'FULLY_DEPRECIATED' }), '2036-03-31')).toBeNull();
    expect(depreciationCharge(asset({ residual: pesewas(1_200_000) }), '2026-03-31')).toBeNull();
    expect(depreciationCharge(asset({ acquiredOn: '2026-04-01' }), '2026-03-31')).toBeNull();
  });
});

describe('the status an asset takes from its figures (FR-FIN-014)', () => {
  it('is fully depreciated exactly when the accumulated depreciation reaches cost less residual', () => {
    expect(statusFor(pesewas(1_000), pesewas(100), pesewas(900))).toBe('FULLY_DEPRECIATED');
    expect(statusFor(pesewas(1_000), pesewas(100), pesewas(899))).toBe('IN_USE');
  });
});

describe('disposal posts its exact gain or loss (FR-FIN-014)', () => {
  it('posts a loss of 153,330 when a scale costing 420,000 with 116,670 depreciated sells for 150,000', () => {
    expect(disposalAmounts(pesewas(420_000), pesewas(116_670), pesewas(150_000))).toEqual({ netBookValue: pesewas(303_330), gain: pesewas(0), loss: pesewas(153_330) });
  });

  it('posts a gain of 50,001 when proceeds pass the net book value by that much', () => {
    expect(disposalAmounts(pesewas(500_000), pesewas(400_000), pesewas(150_001))).toEqual({ netBookValue: pesewas(100_000), gain: pesewas(50_001), loss: pesewas(0) });
  });

  it('posts neither when the proceeds equal the net book value, nor for a fully depreciated asset scrapped for nothing', () => {
    expect(disposalAmounts(pesewas(500_000), pesewas(400_000), pesewas(100_000))).toEqual({ netBookValue: pesewas(100_000), gain: pesewas(0), loss: pesewas(0) });
    expect(disposalAmounts(pesewas(300_000), pesewas(300_000), pesewas(0))).toEqual({ netBookValue: pesewas(0), gain: pesewas(0), loss: pesewas(0) });
  });

  it('names its amounts by key and determinant: cost and depreciation by category, proceeds by how they came in with the bank account as party', () => {
    const bank = { kind: 'BANK_ACCOUNT' as const, refId: 'b1', displayName: 'GCB current account' };
    const amounts = disposalPostingAmounts(
      { fixedAssetId: 'a1', assetNo: 'FA-0004', category: 'EQUIPMENT', cost: pesewas(420_000), accumulated: pesewas(116_670), proceeds: pesewas(150_000) },
      { method: 'BANK', bankAccount: bank },
    );
    const common = { costObjectId: 'a1', memo: 'Disposal of FA-0004' };
    expect(amounts).toEqual([
      { key: 'cost', amount: pesewas(420_000), determinants: { ASSET_CATEGORY: 'EQUIPMENT' }, ...common },
      { key: 'accumulatedDepreciation', amount: pesewas(116_670), determinants: { ASSET_CATEGORY: 'EQUIPMENT' }, ...common },
      { key: 'proceeds', amount: pesewas(150_000), determinants: { PAYMENT_METHOD_KIND: 'BANK' }, subledgers: [bank], ...common },
      { key: 'gain', amount: pesewas(0), ...common },
      { key: 'loss', amount: pesewas(153_330), ...common },
    ]);
  });

  it('takes cash proceeds into the safe with no party', () => {
    const amounts = disposalPostingAmounts(
      { fixedAssetId: 'a1', assetNo: 'FA-0004', category: 'EQUIPMENT', cost: pesewas(500_000), accumulated: pesewas(400_000), proceeds: pesewas(150_001) },
      { method: 'CASH', bankAccount: null },
    );
    expect(amounts[2]).toEqual({ key: 'proceeds', amount: pesewas(150_001), determinants: { PAYMENT_METHOD_KIND: 'CASH' }, subledgers: [], costObjectId: 'a1', memo: 'Disposal of FA-0004' });
    expect(amounts[3]?.amount).toEqual(pesewas(50_001));
  });
});

describe('a run posts Dr 6500, Cr 1590 per asset (FR-FIN-015)', () => {
  it('names one depreciation amount per asset, by its category, with the asset as cost object', () => {
    expect(
      depreciationPostingAmounts([
        { fixedAssetId: 'a1', assetNo: 'FA-0001', category: 'VEHICLE', amount: pesewas(266_700) },
        { fixedAssetId: 'a2', assetNo: 'FA-0002', category: 'COLD_ROOM', amount: pesewas(100_000) },
      ]),
    ).toEqual([
      { key: 'depreciation', amount: pesewas(266_700), determinants: { ASSET_CATEGORY: 'VEHICLE' }, costObjectId: 'a1', memo: 'Depreciation of FA-0001' },
      { key: 'depreciation', amount: pesewas(100_000), determinants: { ASSET_CATEGORY: 'COLD_ROOM' }, costObjectId: 'a2', memo: 'Depreciation of FA-0002' },
    ]);
  });
});

describe('the rules of a new asset (FR-FIN-014, A-199)', () => {
  const today = '2026-11-16';
  const fine = { costPesewas: 640_000, residualPesewas: 0, usefulLifeMonths: 60, acquiredOn: '2026-11-10' };

  it('accepts a cost, a residual up to the cost, a life of 1 to 600 months and a date up to today', () => {
    expect(checkNewAsset(fine, today)).toEqual([]);
    expect(checkNewAsset({ ...fine, residualPesewas: 640_000, usefulLifeMonths: 1, acquiredOn: today }, today)).toEqual([]);
    expect(checkNewAsset({ ...fine, usefulLifeMonths: 600 }, today)).toEqual([]);
  });

  it('refuses a residual above the cost, a life outside 1 to 600 months and a date after today, naming each', () => {
    expect(checkNewAsset({ costPesewas: 640_000, residualPesewas: 640_001, usefulLifeMonths: 0, acquiredOn: '2026-11-17' }, today)).toEqual([
      { field: '/residualPesewas', rule: 'RESIDUAL_ABOVE_COST' },
      { field: '/usefulLifeMonths', rule: 'LIFE_OUT_OF_RANGE' },
      { field: '/acquiredOn', rule: 'FUTURE_DATE' },
    ]);
    expect(checkNewAsset({ ...fine, usefulLifeMonths: 601 }, today)).toEqual([{ field: '/usefulLifeMonths', rule: 'LIFE_OUT_OF_RANGE' }]);
  });
});

describe('a change of estimate (FR-FIN-014, A-199)', () => {
  const charged = asset({ accumulated: pesewas(100_000), depreciatedMonths: 10 });

  it('accepts a life no shorter than the months charged and a residual no higher than the net book value', () => {
    expect(checkEstimateChange(charged, { usefulLifeMonths: 11, residualPesewas: 1_099_999 })).toEqual([]);
    expect(checkEstimateChange(charged, { usefulLifeMonths: 10, residualPesewas: 1_100_000 })).toEqual([]);
  });

  it('refuses a life that leaves an amount to depreciate in no month, one out of range, and a residual above the net book value', () => {
    expect(checkEstimateChange(charged, { usefulLifeMonths: 10, residualPesewas: 0 })).toEqual([{ field: '/usefulLifeMonths', rule: 'LIFE_TOO_SHORT' }]);
    expect(checkEstimateChange(charged, { usefulLifeMonths: 9, residualPesewas: 1_100_000 })).toEqual([{ field: '/usefulLifeMonths', rule: 'LIFE_TOO_SHORT' }]);
    expect(checkEstimateChange(charged, { usefulLifeMonths: 601, residualPesewas: 0 })).toEqual([{ field: '/usefulLifeMonths', rule: 'LIFE_OUT_OF_RANGE' }]);
    expect(checkEstimateChange(charged, { usefulLifeMonths: 120, residualPesewas: 1_100_001 })).toEqual([{ field: '/residualPesewas', rule: 'RESIDUAL_ABOVE_NET_BOOK_VALUE' }]);
  });

  it('refuses any change to an asset disposed of', () => {
    expect(checkEstimateChange({ ...charged, status: 'DISPOSED' }, { usefulLifeMonths: 120, residualPesewas: 0 })).toEqual([{ field: null, rule: 'ASSET_DISPOSED' }]);
  });
});

describe('the rules of a disposal (FR-FIN-014, A-199)', () => {
  const charged = asset({ accumulated: pesewas(100_000), depreciatedMonths: 10, acquiredOn: '2026-01-05' });

  it('accepts a date from the last month charged up to today', () => {
    expect(checkDisposal(charged, '2026-10-01', '2026-11-16')).toEqual([]);
    expect(checkDisposal(charged, '2026-11-16', '2026-11-16')).toEqual([]);
  });

  it('refuses a date after today, before the acquisition, or before a month already charged, and an asset already disposed of', () => {
    expect(checkDisposal(charged, '2026-11-17', '2026-11-16')).toEqual([{ field: '/disposedOn', rule: 'FUTURE_DATE' }]);
    expect(checkDisposal(asset({ acquiredOn: '2026-03-10' }), '2026-03-09', '2026-11-16')).toEqual([{ field: '/disposedOn', rule: 'BEFORE_ACQUISITION' }]);
    expect(checkDisposal(charged, '2026-09-30', '2026-11-16')).toEqual([{ field: '/disposedOn', rule: 'BEFORE_LAST_DEPRECIATION' }]);
    expect(checkDisposal({ ...charged, status: 'DISPOSED' }, '2026-11-16', '2026-11-16')).toEqual([{ field: null, rule: 'ASSET_DISPOSED' }]);
  });
});

describe('who posts a depreciation run (FR-FIN-015, ADR-0017)', () => {
  it('is a different person from the one who calculated it, while it is a draft', () => {
    expect(judgeRunPost({ status: 'DRAFT', createdBy: 'accountant' }, 'owner')).toEqual({ ok: true, value: undefined });
    expect(judgeRunPost({ status: 'DRAFT', createdBy: 'accountant' }, 'accountant')).toEqual({ ok: false, error: 'MAKER_IS_CHECKER' });
    expect(judgeRunPost({ status: 'POSTED', createdBy: 'accountant' }, 'owner')).toEqual({ ok: false, error: 'NOT_DRAFT' });
  });
});
