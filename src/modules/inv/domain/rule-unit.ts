import { Quantity } from '@hakorem/kernel';

/**
 * How a reorder rule entered in a selling unit (30 crates) relates to its stored base unit (900 eggs): one of its levels
 * as entered and as stored. The rule's own pair is its scale, so a conversion archived and replaced later (A-163 (c))
 * never changes what an earlier rule's levels mean.
 */
export interface RuleScale {
  /** A level as entered, in the rule's selling unit; above zero. */
  readonly uomQty: Quantity;
  /** The same level in the product's base unit; above zero. */
  readonly baseQty: Quantity;
}

const THOUSANDTHS = 1_000n;

function checked(scale: RuleScale): { readonly units: bigint; readonly base: bigint } {
  if (scale.uomQty.thousandths <= 0n || scale.baseQty.thousandths <= 0n) throw new Error('a rule scale needs levels above zero');
  return { units: scale.uomQty.thousandths, base: scale.baseQty.thousandths };
}

/**
 * A base quantity in the rule's selling unit, exactly (B09e continued, the owner's decision 6): the whole selling units
 * it holds and what is left over in the base unit. 905 eggs are 30 crates and 5 eggs, never a rounded 30.167 crates.
 * A negative balance counts toward zero, the loose part carrying the sign (-35 eggs are -1 crate and -5 eggs).
 */
export function inRuleUnit(base: Quantity, scale: RuleScale): { readonly whole: Quantity; readonly loose: Quantity } {
  const { units, base: perLevel } = checked(scale);
  // Whole selling units: base x units / (perLevel x 1,000), truncated toward zero by bigint division.
  const whole = (base.thousandths * units) / (perLevel * THOUSANDTHS);
  return { whole: Quantity.ofUnits(whole), loose: Quantity.ofThousandths(base.thousandths - (whole * perLevel * THOUSANDTHS) / units) };
}

/**
 * The whole selling units an order needs to bring a shortfall in the base unit up to the maximum: rounded up, so 1,495
 * eggs short of the maximum is 50 crates (1,500 eggs), never 49 that leave it short. Nothing short is nothing.
 */
export function wholeUnitsToReach(shortBase: Quantity, scale: RuleScale): Quantity {
  const { units, base: perLevel } = checked(scale);
  const divisor = perLevel * THOUSANDTHS;
  return Quantity.ofUnits((shortBase.thousandths * units + divisor - 1n) / divisor);
}

/**
 * A base quantity in the rule's selling unit when it is exactly a quantity of that unit to three places (a level entered
 * as 30.5 crates is 915 eggs, and back), else null: never rounded.
 */
export function exactlyInRuleUnit(base: Quantity, scale: RuleScale): Quantity | null {
  const { units, base: perLevel } = checked(scale);
  const product = base.thousandths * units;
  return product % perLevel === 0n ? Quantity.ofThousandths(product / perLevel) : null;
}
