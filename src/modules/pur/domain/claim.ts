import { allocate, err, halfUpDivide, Money, ok, Quantity, type Result } from '@hakorem/kernel';

/**
 * A claim raised from a posted goods receipt's rejected lines (the owner's decision 5, CR-036, ADR-0076). Pure: amounts
 * are integer pesewas, quantities exact thousandths in the product's base unit, as INV stored them (A-263).
 */

/** The allocate keys: a tie goes to the lower, so the accepted share is half-up (ADR-0075) and the claim the rest. */
const ACCEPTED = 1n;
const REJECTED = 2n;

export interface ClaimLineFacts {
  /** The order line's unit price, per the order line's unit. */
  readonly unitPrice: Money;
  /** The order line's own quantities, in its unit and in the base unit: the only conversion the claim uses. */
  readonly qtyOrdered: Quantity;
  readonly qtyOrderedBase: Quantity;
  readonly qtyAcceptedBase: Quantity;
  readonly qtyRejectedBase: Quantity;
}

export interface ClaimLineValue {
  /** The delivered quantity at the order price, rounded half-up once (ADR-0001's line anchor). */
  readonly lineValue: Money;
  readonly accepted: Money;
  readonly claimed: Money;
}

/**
 * The value of a delivered line and its exact split: `half_up(price x qtyOrdered x delivered / qtyOrderedBase)`, then
 * the kernel's `allocate` over the accepted and rejected base quantities, so accepted plus claimed is the line exactly.
 */
export function claimLineValue(facts: ClaimLineFacts): ClaimLineValue {
  const delivered = facts.qtyAcceptedBase.plus(facts.qtyRejectedBase);
  if (delivered.compareTo(Quantity.zero()) <= 0 || facts.qtyOrderedBase.compareTo(Quantity.zero()) <= 0) {
    throw new Error('a claim line values a delivery of something against an order line of something');
  }
  // price x (qtyOrdered / 1000) x (delivered / 1000) / (qtyOrderedBase / 1000), in exact integers.
  const lineValue = Money.ofPesewas(halfUpDivide(facts.unitPrice.pesewas * facts.qtyOrdered.thousandths * delivered.thousandths, facts.qtyOrderedBase.thousandths * 1000n));
  const split = allocate(lineValue, [
    { key: ACCEPTED, weight: facts.qtyAcceptedBase.thousandths },
    { key: REJECTED, weight: facts.qtyRejectedBase.thousandths },
  ]);
  if (!split.ok) throw split.error;
  return { lineValue, accepted: split.value[0]!, claimed: split.value[1]! };
}

/**
 * What an invoice line carrying a claimed quantity clears from 2010: its received part at the order price,
 * `half_up(price x qty x (qtyBase - claimed) / qtyBase)`. The claimed part was never booked to 2010 (ADR-0076).
 */
export function receivedPartValue(orderPrice: Money, qty: Quantity, qtyBase: Quantity, claimedBase: Quantity): Money {
  if (qtyBase.compareTo(Quantity.zero()) <= 0) throw new Error('an invoice line carries a quantity');
  const received = qtyBase.minus(claimedBase);
  return Money.ofPesewas(halfUpDivide(orderPrice.pesewas * qty.thousandths * received.thousandths, qtyBase.thousandths * 1000n));
}

/** The part of an invoice line beyond what was received: its positive quantity variance, at most the line itself. */
export function claimedPart(qtyVariance: Quantity | null, qtyBase: Quantity): Quantity {
  if (qtyVariance === null || qtyVariance.compareTo(Quantity.zero()) <= 0) return Quantity.zero();
  return qtyVariance.compareTo(qtyBase) > 0 ? qtyBase : qtyVariance;
}

/** One order line as a settlement judges it, in base units: received, invoiced by live invoices, already credited. */
export interface ClaimOrderLineFacts {
  readonly received: Quantity;
  readonly invoiced: Quantity;
  /** The rejected quantity of this order line's other claims settled, or being settled, by a credit note. */
  readonly creditedByOtherClaims: Quantity;
}

/** A credit note may carry the claim only when the supplier invoiced its eggs beyond what was received and credited. */
export function judgeClaimCredit(facts: ClaimOrderLineFacts & { readonly claimQty: Quantity }): Result<void, 'CLAIM_NOT_INVOICED'> {
  const chargedBeyond = facts.invoiced.minus(facts.received).minus(facts.creditedByOtherClaims);
  return chargedBeyond.compareTo(facts.claimQty) >= 0 ? ok(undefined) : err('CLAIM_NOT_INVOICED');
}

/** The invoice settles the claim on its own only when it left the rejected eggs out: never more than received and credited. */
export function judgeClaimSettledByInvoice(facts: ClaimOrderLineFacts): Result<void, 'CLAIM_INVOICED'> {
  return facts.invoiced.compareTo(facts.received.plus(facts.creditedByOtherClaims)) <= 0 ? ok(undefined) : err('CLAIM_INVOICED');
}

/**
 * Who may approve a credit note (ADR-0017): never whoever submitted or entered it, and for one drafted from a claim
 * never whoever raised the claim or posted the receipt that recorded the rejection (ADR-0076).
 */
export function judgeClaimCreditApprover(facts: {
  readonly creditMakerId: string;
  readonly requesterId: string;
  readonly claimMakerId: string | null;
  readonly receiverId: string | null;
  readonly approverId: string;
}): Result<void, 'MAKER_CANNOT_CHECK' | 'INVOICE_MAKER_CANNOT_APPROVE'> {
  if (facts.approverId === facts.requesterId) return err('MAKER_CANNOT_CHECK');
  if ([facts.creditMakerId, facts.claimMakerId, facts.receiverId].includes(facts.approverId)) return err('INVOICE_MAKER_CANNOT_APPROVE');
  return ok(undefined);
}
