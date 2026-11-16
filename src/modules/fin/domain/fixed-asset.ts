import { allocate, err, Money, ok, type Result } from '@hakorem/kernel';
import { chargeableMonths, disposalFollowsCharges, monthsLeft } from './asset-months';
import type { PostingAmount, SubledgerRef } from './posting';

/** `fin.fixed_asset.category`: also the asset's ledger determinant (ADR-0003's 1510 to 1540, ADR-0059). */
export type AssetCategory = 'VEHICLE' | 'COLD_ROOM' | 'HOUSING' | 'EQUIPMENT';
export type AssetStatus = 'IN_USE' | 'FULLY_DEPRECIATED' | 'DISPOSED';
/** How disposal proceeds came in: the farm's own account of that kind, as a supplier payment's (A-199). */
export type ProceedsMethod = 'CASH' | 'BANK' | 'MOBILE_MONEY';

/** The longest useful life the register takes: fifty years, longer than any pen house or cold room lasts. */
export const MAX_LIFE_MONTHS = 600;

/** What depreciation needs to know of an asset. */
export interface DepreciationState {
  readonly cost: Money;
  readonly residual: Money;
  readonly usefulLifeMonths: number;
  readonly accumulated: Money;
  readonly depreciatedMonths: number;
  readonly acquiredOn: string;
  readonly status: AssetStatus;
}

/** One asset's charge in a run: the months it covers, from the first month not yet charged, and the exact amount. */
export interface DepreciationCharge {
  readonly fromMonth: number;
  readonly months: number;
  readonly amount: Money;
}

export interface FixedAssetRule {
  readonly field: string | null;
  readonly rule:
    | 'RESIDUAL_ABOVE_COST'
    | 'LIFE_OUT_OF_RANGE'
    | 'FUTURE_DATE'
    | 'LIFE_TOO_SHORT'
    | 'RESIDUAL_ABOVE_NET_BOOK_VALUE'
    | 'ASSET_DISPOSED'
    | 'BEFORE_ACQUISITION'
    | 'BEFORE_LAST_DEPRECIATION';
}

/**
 * Straight-line depreciation through `allocate` (FR-FIN-015, ADR-0001, A-199): what is left to depreciate (cost less
 * residual less what is already charged) is split equally over the months of the life not yet charged, the leftover
 * pesewas to the earliest of them (allocate's lowest key), and a run charges the first of those parts for every month
 * it covers. Run month by month, an asset's charges therefore sum to cost less residual exactly: 1,000,001 over three
 * months is 333,334, 333,334 and 333,333, and the last month takes whatever is left. A change of useful life or
 * residual spreads what is left over the months left from then on. Nothing for an asset disposed of, fully
 * depreciated, kept at its residual, or with no month to charge.
 */
export function depreciationCharge(state: DepreciationState, periodEnd: string): DepreciationCharge | null {
  if (state.status === 'DISPOSED') return null;
  const months = chargeableMonths(state, periodEnd);
  const remaining = state.cost.minus(state.residual).minus(state.accumulated);
  if (months === 0 || remaining.isZero()) return null;
  // The weights are all one and the keys distinct, so the kernel cannot refuse.
  const parts = allocate(
    remaining,
    Array.from({ length: monthsLeft(state) }, (_, index) => ({ key: BigInt(index), weight: 1n })),
  ) as { readonly ok: true; readonly value: Money[] };
  return { fromMonth: state.depreciatedMonths, months, amount: Money.sum(parts.value.slice(0, months)) };
}

/** IN_USE until the accumulated depreciation reaches cost less residual, then FULLY_DEPRECIATED (the database agrees). */
export function statusFor(cost: Money, residual: Money, accumulated: Money): 'IN_USE' | 'FULLY_DEPRECIATED' {
  return accumulated.equals(cost.minus(residual)) ? 'FULLY_DEPRECIATED' : 'IN_USE';
}

/** A disposal's net book value, and the gain or the loss: proceeds above or below it, exactly (FR-FIN-014). */
export function disposalAmounts(cost: Money, accumulated: Money, proceeds: Money): { readonly netBookValue: Money; readonly gain: Money; readonly loss: Money } {
  const netBookValue = cost.minus(accumulated);
  const above = proceeds.compareTo(netBookValue) > 0;
  return { netBookValue, gain: above ? proceeds.minus(netBookValue) : Money.zero(), loss: above ? Money.zero() : netBookValue.minus(proceeds) };
}

export interface DisposalFacts {
  readonly fixedAssetId: string;
  readonly assetNo: string;
  readonly category: AssetCategory;
  readonly cost: Money;
  readonly accumulated: Money;
  readonly proceeds: Money;
}

/**
 * The named amounts of `fin.FixedAssetDisposed` (ADR-0059): the cost out of the category's cost account, the
 * accumulated depreciation out of the category's accumulated depreciation account, the proceeds into the farm's own
 * account of the kind they came in by (with the bank account or wallet as party), and the gain or the loss. They
 * balance: cost = accumulated + proceeds + loss - gain.
 */
export function disposalPostingAmounts(facts: DisposalFacts, proceeds: { readonly method: ProceedsMethod; readonly bankAccount: SubledgerRef | null }): PostingAmount[] {
  const { gain, loss } = disposalAmounts(facts.cost, facts.accumulated, facts.proceeds);
  const common = { costObjectId: facts.fixedAssetId, memo: `Disposal of ${facts.assetNo}` };
  const byCategory = { ASSET_CATEGORY: facts.category };
  return [
    { key: 'cost', amount: facts.cost, determinants: byCategory, ...common },
    { key: 'accumulatedDepreciation', amount: facts.accumulated, determinants: byCategory, ...common },
    { key: 'proceeds', amount: facts.proceeds, determinants: { PAYMENT_METHOD_KIND: proceeds.method }, subledgers: proceeds.bankAccount === null ? [] : [proceeds.bankAccount], ...common },
    { key: 'gain', amount: gain, ...common },
    { key: 'loss', amount: loss, ...common },
  ];
}

/** The named amounts of `fin.DepreciationRun`: one `depreciation` per asset, by its category, the asset its cost object. */
export function depreciationPostingAmounts(lines: readonly { readonly fixedAssetId: string; readonly assetNo: string; readonly category: AssetCategory; readonly amount: Money }[]): PostingAmount[] {
  return lines.map((line) => ({
    key: 'depreciation',
    amount: line.amount,
    determinants: { ASSET_CATEGORY: line.category },
    costObjectId: line.fixedAssetId,
    memo: `Depreciation of ${line.assetNo}`,
  }));
}

function lifeInRange(months: number): boolean {
  return months >= 1 && months <= MAX_LIFE_MONTHS;
}

/** A new asset: a residual no higher than its cost, a life of 1 to 600 months, acquired today or earlier. */
export function checkNewAsset(input: { readonly costPesewas: number; readonly residualPesewas: number; readonly usefulLifeMonths: number; readonly acquiredOn: string }, today: string): FixedAssetRule[] {
  const rules: FixedAssetRule[] = [];
  if (input.residualPesewas > input.costPesewas) rules.push({ field: '/residualPesewas', rule: 'RESIDUAL_ABOVE_COST' });
  if (!lifeInRange(input.usefulLifeMonths)) rules.push({ field: '/usefulLifeMonths', rule: 'LIFE_OUT_OF_RANGE' });
  if (input.acquiredOn > today) rules.push({ field: '/acquiredOn', rule: 'FUTURE_DATE' });
  return rules;
}

/**
 * A change of estimate (FR-FIN-014): prospective, never touching what is charged. The residual may not exceed the net
 * book value, and the life may not end before the months already charged, nor at them while anything is left to
 * depreciate. Nothing changes on an asset disposed of.
 */
export function checkEstimateChange(state: DepreciationState, change: { readonly usefulLifeMonths: number; readonly residualPesewas: number }): FixedAssetRule[] {
  if (state.status === 'DISPOSED') return [{ field: null, rule: 'ASSET_DISPOSED' }];
  const rules: FixedAssetRule[] = [];
  const netBookValue = state.cost.minus(state.accumulated);
  const residual = Money.fromJsonInteger(change.residualPesewas);
  const residualFits = residual.compareTo(netBookValue) <= 0;
  if (!lifeInRange(change.usefulLifeMonths)) {
    rules.push({ field: '/usefulLifeMonths', rule: 'LIFE_OUT_OF_RANGE' });
  } else if (change.usefulLifeMonths < state.depreciatedMonths || (change.usefulLifeMonths === state.depreciatedMonths && residualFits && !netBookValue.minus(residual).isZero())) {
    rules.push({ field: '/usefulLifeMonths', rule: 'LIFE_TOO_SHORT' });
  }
  if (!residualFits) rules.push({ field: '/residualPesewas', rule: 'RESIDUAL_ABOVE_NET_BOOK_VALUE' });
  return rules;
}

/** A disposal is dated today or earlier, not before the asset was acquired nor before a month already depreciated. */
export function checkDisposal(state: DepreciationState, disposedOn: string, today: string): FixedAssetRule[] {
  if (state.status === 'DISPOSED') return [{ field: null, rule: 'ASSET_DISPOSED' }];
  if (disposedOn > today) return [{ field: '/disposedOn', rule: 'FUTURE_DATE' }];
  if (disposedOn < state.acquiredOn) return [{ field: '/disposedOn', rule: 'BEFORE_ACQUISITION' }];
  if (!disposalFollowsCharges(state, disposedOn)) return [{ field: '/disposedOn', rule: 'BEFORE_LAST_DEPRECIATION' }];
  return [];
}

/** Maker and checker (ADR-0017, FR-FIN-015): a draft run is posted only by someone other than the person who calculated it. */
export function judgeRunPost(run: { readonly status: 'DRAFT' | 'POSTED'; readonly createdBy: string }, actorId: string): Result<void, 'NOT_DRAFT' | 'MAKER_IS_CHECKER'> {
  if (run.status !== 'DRAFT') return err('NOT_DRAFT');
  if (run.createdBy === actorId) return err('MAKER_IS_CHECKER');
  return ok(undefined);
}
