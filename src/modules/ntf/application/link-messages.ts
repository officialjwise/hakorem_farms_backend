import { formatCedis } from '@hakorem/kernel';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { AsyncConsumer, EventEnvelope } from '../../../platform/events/domain-events';
import type { MasterDataRefs } from '../../mdm';
import type { Orders } from '../../ord';
import type { MessageQueue } from './message-queue';

/** The events whose message carries a link made at send (B11 continued 12). */
export const LINK_MESSAGE_EVENTS = ['ord.OrderPlaced', 'ord.OrderCompleted', 'shp.CartAbandoned'] as const;

/**
 * The messages that carry a link (B11 continued 12, ADR-0084, ADR-0074): NTF's consumer of the outbox, through the one
 * queue (`MessageQueue`). The guest's tracking SMS when an online order is placed (`ORDER_TRACKING`, its link ORD's
 * `OnlineOrders.reissueTrackingIn`); the receipt SMS when a counter sale a till made offline is synced (CR-033 point 3,
 * `SALE_RECEIPT`, its link POS's `ReceiptLinks.issueMessageLinkIn`); the abandoned-cart reminder (`CART_REMINDER`,
 * FR-SHP-015, marketing). An order's message goes to the order's own contact, read from
 * ORD (the number the buyer gave on the sale), never the event's; the facts are read from ORD's order, never the event's
 * copy. Once per event, template and order: a redelivered event, a replayed placement or a duplicate sync (which posts
 * nothing and publishes nothing) queues no second message. No token is made here: the stored text keeps `{{link}}`.
 */
export class LinkMessages {
  constructor(
    private readonly queue: MessageQueue,
    private readonly orders: Orders,
    private readonly refs: MasterDataRefs,
  ) {}

  readonly consumer: AsyncConsumer = {
    name: 'ntf.link-messages',
    eventTypes: LINK_MESSAGE_EVENTS,
    isolation: 'serializable',
    handle: async (tx, event) => {
      await this.queueIn(tx, event);
    },
  };

  /** Queues the event's message in the consumer's transaction; true when this call wrote it. */
  async queueIn(tx: Transaction, event: EventEnvelope): Promise<boolean> {
    const payload = event.payload as Readonly<Record<string, unknown>>;
    if (event.type === 'shp.CartAbandoned') return this.cartIn(tx, event, payload);
    const orderId = typeof payload['orderId'] === 'string' ? payload['orderId'] : null;
    if (orderId === null) return false;
    const contact = (await this.orders.messageContactsIn(tx, [orderId])).get(orderId);
    if (contact === undefined) return false;
    const order = await this.orders.viewOf(tx, orderId);
    const recipient = { kind: 'ORDER', orderId } as const;
    if (event.type === 'ord.OrderPlaced') {
      if (order.channel !== 'ONLINE') return false;
      return this.queue.queueIn(tx, { event, code: 'ORDER_TRACKING', recipient, data: { orderNo: contact.orderNo }, recordId: orderId, linkRecordId: orderId });
    }
    // A counter sale made at a till and synced: the only sale with a receipt link the buyer was shown (ADR-0083). The owner
    // chose a text for every till sale with the buyer's phone, live too (2026-11-24, A-396), but a live sale's till makes no
    // link, so it would only be NO_LINK: it waits for POS to make one (A-397 (d), BL-133).
    if (order.channel !== 'POS' || !order.isOffline || order.billingDocument === null || order.finalTotalPesewas === null) return false;
    return this.queue.queueIn(tx, {
      event,
      code: 'SALE_RECEIPT',
      recipient,
      data: { saleReference: contact.orderNo, receiptNo: order.billingDocument.number ?? '', total: formatCedis(BigInt(order.finalTotalPesewas)) },
      recordId: orderId,
      linkRecordId: orderId,
    });
  }

  /**
   * The abandoned-cart reminder (FR-SHP-015): marketing, to the cart's customer by their own number through MDM, with
   * nothing of what is in the cart; the queue refuses it without the customer's consent (`NO_CONSENT`), after a STOP
   * (`OPTED_OUT`) and waits out quiet hours. Its link is the shop's cart page, made at send only while the cart may still
   * be reminded.
   */
  private async cartIn(tx: Transaction, event: EventEnvelope, payload: Readonly<Record<string, unknown>>): Promise<boolean> {
    const cartId = typeof payload['cartId'] === 'string' ? payload['cartId'] : null;
    const customerId = typeof payload['customerId'] === 'string' ? payload['customerId'] : null;
    if (cartId === null || customerId === null || event.branchId === null) return false;
    const customer = (await this.refs.customerContactsIn(tx, [customerId])).get(customerId);
    if (customer === undefined) return false;
    const first = customer.name.trim().split(/\s+/)[0] ?? '';
    return this.queue.queueIn(tx, { event, code: 'CART_REMINDER', recipient: { kind: 'CUSTOMER', customerId, branchId: event.branchId }, data: { customerName: first }, recordId: cartId, linkRecordId: cartId });
  }
}
