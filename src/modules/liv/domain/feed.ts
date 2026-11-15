import { Quantity } from '@hakorem/kernel';

/** A pen's expected consumption: the ration per head per day times the head-days, exactly (FR-LIV-014). */
export function expectedConsumption(qtyPerHeadPerDay: Quantity, headDays: bigint): Quantity {
  return Quantity.ofThousandths(qtyPerHeadPerDay.thousandths * headDays);
}
