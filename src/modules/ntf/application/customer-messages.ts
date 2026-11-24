import { createHmac } from 'node:crypto';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { AsyncConsumer, EventEnvelope } from '../../../platform/events/domain-events';
import type { Slots } from '../../del';
import type { Orders } from '../../ord';
import { customerMessageOf, CUSTOMER_MESSAGE_EVENTS, orderIdOf, slotLine } from '../domain/messages';
import type { MessageQueue } from './message-queue';

export { MESSAGE_STORM_ABUSE_CASE, MESSAGE_SUPPRESSED } from './message-queue';

/**
 * The keyed hash of a recipient's number (A-374 (b)): HMAC-SHA256 under a key of its own derived from the lookup key, so
 * the log can count what one number was sent without keeping the number, and a database reader cannot reverse it.
 */
export class AddressHasher {
  private readonly key: Buffer;

  constructor(lookupKey: Buffer) {
    this.key = createHmac('sha256', lookupKey).update('hk-ntf-address-v1').digest();
  }

  hash(e164: string): Buffer {
    return createHmac('sha256', this.key).update(e164).digest();
  }
}

/**
 * The customer's messages (FR-ORD-011, FR-DEL-003, FR-DEL-012, FR-NTF-003; the B11 continued 10 gate): NTF's consumer
 * of the outbox, never a transactional subscriber, so a message exists exactly when the business change committed. One
 * message per event, keyed by the event, its template, its channel and its order (`uq_message_idempotency`), written in
 * the same transaction as the consumer's inbox row, so a redelivered or replayed event queues nothing more. The recipient
 * is the order's own contact, read from ORD by the order's id (`Orders.messageContactsIn`), never a number an event
 * carries (A-374 (b)). The text is rendered from the active version, which the message keeps; the trigger, the
 * customer's preferences and the opt-outs route it (B11 continued 11, `MessageQueue`); nothing is sent here:
 * `MessageSender` sends after commit, outside any business transaction.
 */
export class CustomerMessages {
  constructor(
    private readonly queue: MessageQueue,
    private readonly orders: Orders,
    private readonly slots: Slots,
  ) {}

  readonly consumer: AsyncConsumer = {
    name: 'ntf.customer-messages',
    eventTypes: CUSTOMER_MESSAGE_EVENTS,
    isolation: 'serializable',
    handle: async (tx, event) => {
      await this.queueIn(tx, event);
    },
  };

  /** Queues the event's customer message in the consumer's transaction; true when this call wrote it. */
  async queueIn(tx: Transaction, event: EventEnvelope): Promise<boolean> {
    const payload = event.payload as Readonly<Record<string, unknown>>;
    const orderId = orderIdOf(event.type, payload);
    if (orderId === null) return false;
    const contact = (await this.orders.messageContactsIn(tx, [orderId])).get(orderId);
    if (contact === undefined) return false;
    const slotId = event.type === 'ord.OrderDispatched' && typeof payload['bookedSlotId'] === 'string' ? payload['bookedSlotId'] : null;
    const slot = slotId === null ? null : await this.slots.slotIn(tx, slotId);
    const message = customerMessageOf(event.type, payload, contact.orderNo, slot === null ? null : slotLine(slot.option.date, slot.option.startsAt, slot.option.endsAt));
    if (message === null) return false;
    return this.queue.queueIn(tx, { event, code: message.code, recipient: { kind: 'ORDER', orderId }, data: message.data, recordId: orderId });
  }
}
