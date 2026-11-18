import { Money, Quantity } from '@hakorem/kernel';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { OrderLineValuation, OrderLineValueAnswer, OrderLineValueRequest } from '../../inv';
import { acceptedValueAtOrder } from '../domain/purchasing';
import type { PurchasingStore } from './purchasing-store';

/**
 * PUR's answer to INV's `OrderLineValuation` port (CR-040, ADR-0086): a goods receipt line that names its order line
 * and types no value is worth its accepted base quantity at the order line's price, rounded half-up once. Reads PUR's
 * own order in the receipt's transaction; authorises nothing (the receipt's handler did). Answers null for a document
 * that is not one of PUR's purchase orders.
 */
export class PurchaseOrderLineValues implements OrderLineValuation {
  constructor(private readonly store: PurchasingStore) {}

  async valueIn(tx: Transaction, request: OrderLineValueRequest): Promise<OrderLineValueAnswer | null> {
    const order = await this.store.order(tx, request.purchaseOrderId);
    if (order === null) return null;
    const line = order.lines.find((l) => l.id === request.purchaseOrderLineId);
    if (line === undefined) return { ok: false, refusal: 'ORDER_LINE_UNKNOWN' };
    if (line.productId !== request.productId) return { ok: false, refusal: 'ORDER_LINE_OTHER_PRODUCT' };
    return {
      ok: true,
      value: acceptedValueAtOrder({
        unitPrice: Money.ofPesewas(line.unitPricePesewas),
        qtyOrdered: Quantity.parse(line.qtyOrdered),
        qtyOrderedBase: Quantity.parse(line.qtyOrderedBase),
        qtyAcceptedBase: request.qtyAcceptedBase,
      }),
    };
  }
}
