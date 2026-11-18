import type { Money, Quantity } from '@hakorem/kernel';
import type { Transaction } from '../../../platform/database/unit-of-work';

/** What INV asks of the order a receipt line names (CR-040, ADR-0086). */
export interface OrderLineValueRequest {
  /** The receipt's purchase order; the line must be one of its lines. */
  readonly purchaseOrderId: string;
  readonly purchaseOrderLineId: string;
  /** The receipt line's product; the order line must be for it. */
  readonly productId: string;
  /** The accepted quantity, in the product's base unit. */
  readonly qtyAcceptedBase: Quantity;
}

/** Why an order line cannot value a receipt line. */
export type OrderLineValueRefusal = 'ORDER_LINE_UNKNOWN' | 'ORDER_LINE_OTHER_PRODUCT';

export type OrderLineValueAnswer = { readonly ok: true; readonly value: Money } | { readonly ok: false; readonly refusal: OrderLineValueRefusal };

/**
 * The `OrderLineValuation` port (MODULE_BOUNDARIES section 6, ADR-0086): INV sits below PUR and never reads its tables,
 * so it asks the registered valuation, in the caller's transaction, what the accepted quantity of a receipt line is
 * worth at the order line's price. Answers null when the order is not one this valuation knows.
 */
export interface OrderLineValuation {
  valueIn(tx: Transaction, request: OrderLineValueRequest): Promise<OrderLineValueAnswer | null>;
}

/**
 * Where PUR registers its `OrderLineValuation`. Deny by default: with none registered, or none that knows the order,
 * a line that leaves out its value is refused `ORDER_LINE_UNKNOWN`, so INV never invents a cost.
 */
export class OrderLineValuationRegistry {
  private readonly valuations: OrderLineValuation[] = [];

  register(valuation: OrderLineValuation): void {
    this.valuations.push(valuation);
  }

  /** One valuation at a time on the one transaction: a pg client runs one query at a time. */
  async valueIn(tx: Transaction, request: OrderLineValueRequest): Promise<OrderLineValueAnswer> {
    for (const valuation of this.valuations) {
      const answer = await valuation.valueIn(tx, request);
      if (answer !== null) return answer;
    }
    return { ok: false, refusal: 'ORDER_LINE_UNKNOWN' };
  }
}
