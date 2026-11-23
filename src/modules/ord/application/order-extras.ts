import { Money } from '@hakorem/kernel';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { MasterDataRefs } from '../../mdm';
import type { FulfilmentStore, OrderConsentRecord } from './fulfilment-store';

/** The contract's `OrderPendingConsent` (CR-053 point 2): what an order waits for its customer to answer. */
export interface OrderPendingConsentView {
  readonly id: string;
  readonly kind: OrderConsentRecord['kind'];
  readonly lineId: string;
  readonly proposed: { readonly productId: string; readonly productName: string; readonly quantity: string; readonly uom: string } | null;
  readonly proposedTotalPesewas: number | null;
  readonly weighedTotalPesewas: number | null;
  readonly askedAt: string;
}

export interface OrderFulfilmentExtras {
  readonly fulfilments: readonly { readonly id: string; readonly docType: 'FULFILMENT'; readonly number: string }[];
  readonly pendingConsent: OrderPendingConsentView | null;
}

const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();

/** The orders' pick lists (CR-053 point 1) and the question each waits for (point 2), for the order's own view. */
export async function orderFulfilmentExtrasIn(
  tx: Transaction,
  store: FulfilmentStore,
  refs: MasterDataRefs,
  orders: readonly { readonly id: string; readonly lines: readonly { readonly id: string; readonly productId: string }[] }[],
): Promise<Map<string, OrderFulfilmentExtras>> {
  const orderIds = orders.map((o) => o.id);
  const lists = await store.ofOrders(tx, orderIds);
  const consents = (await store.consentsOf(tx, orderIds)).filter((c) => c.status === 'PENDING');
  // A smaller quantity proposes the line's own product; a substitute names its own.
  const productOf = (c: OrderConsentRecord) => c.proposedProductId ?? orders.flatMap((o) => o.lines).find((l) => l.id === c.salesOrderLineId)?.productId ?? null;
  const products = await refs.productsIn(
    tx,
    consents.flatMap((c) => {
      const id = productOf(c);
      return id === null ? [] : [id];
    }),
  );
  const extras = new Map<string, OrderFulfilmentExtras>();
  for (const orderId of orderIds) {
    const c = consents.find((x) => x.salesOrderId === orderId);
    extras.set(orderId, {
      fulfilments: lists.filter((l) => l.salesOrderId === orderId).map((l) => ({ id: l.id, docType: 'FULFILMENT' as const, number: l.fulfilmentNo })),
      pendingConsent: c === undefined ? null : pendingView(c, productOf(c) ?? '', products.get(productOf(c) ?? '')?.name ?? ''),
    });
  }
  return extras;
}

function pendingView(c: OrderConsentRecord, productId: string, productName: string): OrderPendingConsentView {
  return {
    id: c.id,
    kind: c.kind,
    lineId: c.salesOrderLineId,
    proposed: c.kind === 'HIGHER_TOTAL' ? null : { productId, productName, quantity: c.proposedQty!, uom: c.proposedUom! },
    proposedTotalPesewas: c.proposedLineTotalPesewas === null ? null : json(c.proposedLineTotalPesewas),
    weighedTotalPesewas: c.weighedTotalPesewas === null ? null : json(c.weighedTotalPesewas),
    askedAt: c.askedAt.toISOString(),
  };
}
