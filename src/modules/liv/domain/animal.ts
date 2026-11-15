export type AnimalStatus = 'ALIVE' | 'SOLD' | 'SLAUGHTERED' | 'DEAD' | 'CULLED';

/** What each closing movement makes of the animal (FR-LIV-017). Anything written off that is not a death or cull is DEAD. */
const CLOSED_BY: Readonly<Record<string, AnimalStatus>> = {
  SALE_ISSUE: 'SOLD',
  SALE_ISSUE_OFFLINE: 'SOLD',
  SUPPLIER_RETURN: 'SOLD',
  PROCESS_CONSUME: 'SLAUGHTERED',
  MORTALITY: 'DEAD',
  CULL: 'CULLED',
  ADJUST_LOSS: 'DEAD',
  STOCKTAKE_LOSS: 'DEAD',
};

/**
 * The status an animal takes when inventory moves its stock unit (FR-LIV-017), or null when the movement neither
 * closes nor reopens it. A return from a customer, or the reversal of the movement that closed it, makes it ALIVE.
 */
export function statusAfterMovement(movementType: string, reversal: boolean): AnimalStatus | null {
  if (movementType === 'SALE_RETURN') return reversal ? null : 'ALIVE';
  const closed = CLOSED_BY[movementType];
  if (closed === undefined) return null;
  return reversal ? 'ALIVE' : closed;
}

/** An animal received from a supplier was bought; one received with no supplier is opening stock (FR-LIV-001). */
export function sourceOfArrival(supplierId: string | null): 'PURCHASE' | 'OPENING' {
  return supplierId === null ? 'OPENING' : 'PURCHASE';
}

export interface WeighingShape {
  readonly tracking: 'SERIAL' | 'LOT';
  readonly alive: boolean;
  readonly isLivestock: boolean;
  readonly headWeighed: number;
  readonly headOnHand: bigint;
  readonly measuredAt: Date;
  readonly now: Date;
}

/** A weighing is of a live animal (one head) or a sample of a live flock; a closed animal takes no more (FR-LIV-004). */
export function checkWeighing(shape: WeighingShape): Array<{ readonly rule: string }> {
  const broken: Array<{ readonly rule: string }> = [];
  if (!shape.isLivestock) broken.push({ rule: 'NOT_LIVESTOCK' });
  else if (!shape.alive) broken.push({ rule: 'ANIMAL_NOT_ALIVE' });
  else if (shape.tracking === 'SERIAL' && shape.headWeighed !== 1) broken.push({ rule: 'ONE_HEAD_FOR_AN_ANIMAL' });
  else if (shape.tracking === 'LOT' && BigInt(shape.headWeighed) > shape.headOnHand) broken.push({ rule: 'HEAD_ABOVE_FLOCK' });
  if (shape.measuredAt > shape.now) broken.push({ rule: 'IN_THE_FUTURE' });
  return broken;
}
