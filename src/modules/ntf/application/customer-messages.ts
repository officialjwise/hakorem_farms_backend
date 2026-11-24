import { createHmac } from 'node:crypto';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { AsyncConsumer, DomainEvents, EventEnvelope } from '../../../platform/events/domain-events';
import { DISPATCHER_PRINCIPAL } from '../../../platform/events/outbox-dispatcher';
import type { Slots } from '../../del';
import type { Orders } from '../../ord';
import { customerMessageOf, CUSTOMER_MESSAGE_EVENTS, maskAddress, messageKey, orderIdOf, RECIPIENT_WINDOW_MS, slotLine, withinRecipientLimit } from '../domain/messages';
import { render } from '../domain/templates';
import type { MessageSuppressed } from '../events';
import type { NtfStore } from './ntf-store';
import { DEFAULT_LOCALE } from './templates';

export const MESSAGE_SUPPRESSED = 'ntf.MessageSuppressed';
/** The channel the customer's messages go by until preferences arrive (B11 continued 11): the one with an adapter. */
export const CUSTOMER_CHANNEL = 'SMS' as const;
/** Abuse case 58 (docs/security/THREAT_MODEL.md): a reminder or message storm. */
export const MESSAGE_STORM_ABUSE_CASE = 58;

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
 * carries (A-374 (b)). The text is rendered here from the active version, which the message keeps; nothing is sent here:
 * `MessageSender` sends after commit, outside any business transaction.
 */
export class CustomerMessages {
  private readonly nextId: () => string;

  constructor(
    private readonly store: NtfStore,
    private readonly orders: Orders,
    private readonly slots: Slots,
    private readonly events: DomainEvents,
    private readonly hasher: AddressHasher,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

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
    const template = await this.store.activeTemplate(tx, message.code, CUSTOMER_CHANNEL, DEFAULT_LOCALE, false);
    if (template === null) return false;
    const at = this.clock.now();
    const phone = contact.phoneE164;
    const addressHash = phone === null ? null : this.hasher.hash(phone);
    const limited = addressHash !== null && !withinRecipientLimit(await this.store.queuedToAddressSince(tx, addressHash, new Date(at.getTime() - RECIPIENT_WINDOW_MS)));
    const suppressedReason = phone === null ? ('NO_ADDRESS' as const) : limited ? ('RATE_LIMITED' as const) : null;
    const id = this.nextId();
    const written = await this.store.insertMessage(tx, {
      id,
      idempotencyKey: messageKey(event.id, message.code, CUSTOMER_CHANNEL, orderId),
      sourceEventRef: event.id,
      sourceEventType: event.type,
      branchId: contact.branchId,
      salesOrderId: orderId,
      templateId: template.id,
      channel: CUSTOMER_CHANNEL,
      category: template.category,
      recipientKind: contact.customerId === null ? 'CONTACT' : 'CUSTOMER',
      customerId: contact.customerId,
      addressMasked: phone === null ? '' : maskAddress(phone),
      addressHash,
      renderedBody: render(template.body, message.data),
      status: suppressedReason === null ? 'QUEUED' : 'SUPPRESSED',
      suppressedReason,
      at,
      actorId: DISPATCHER_PRINCIPAL.principalId,
    });
    if (written && suppressedReason === 'RATE_LIMITED') {
      await this.events.publish<MessageSuppressed>(tx, {
        type: MESSAGE_SUPPRESSED,
        subjectType: 'NotificationMessage',
        subjectId: id,
        branchId: contact.branchId,
        causationId: event.id,
        payload: { messageId: id, templateCode: message.code, channel: CUSTOMER_CHANNEL, reason: 'RATE_LIMITED', salesOrderId: orderId, sourceEventType: event.type, abuseCases: [MESSAGE_STORM_ABUSE_CASE] },
      });
    }
    return written;
  }
}
