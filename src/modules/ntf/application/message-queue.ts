import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { DomainEvents, EventEnvelope } from '../../../platform/events/domain-events';
import { DISPATCHER_PRINCIPAL } from '../../../platform/events/outbox-dispatcher';
import type { MasterDataRefs } from '../../mdm';
import type { Orders } from '../../ord';
import { LINK_PLACEHOLDER, linkDataOf, linkKindOf } from '../domain/links';
import { maskAnyAddress, messageKey, normalisedAddress, RECIPIENT_WINDOW_MS, withinRecipientLimit, type SuppressedReason } from '../domain/messages';
import { quietHoursApply, quietUntil, routeMessage, type QuietHours } from '../domain/routing';
import { render, TEMPLATE_CODES, type Category, type Channel, type TemplateCode } from '../domain/templates';
import type { MessageSuppressed } from '../events';
import type { AddressHasher } from './customer-messages';
import type { NtfStore, PreferenceOwner, PreferenceRecord } from './ntf-store';
import { DEFAULT_LOCALE } from './templates';

export const MESSAGE_SUPPRESSED = 'ntf.MessageSuppressed';
/** Abuse case 58 (docs/security/THREAT_MODEL.md): a reminder or message storm. */
export const MESSAGE_STORM_ABUSE_CASE = 58;
/** Abuse case 60: a link sent by message to the wrong person or for the wrong record; a link refused is published. */
export const MESSAGE_LINK_ABUSE_CASE = 60;
/** Abuse case 61: a marketing message (an abandoned cart) to a customer who never consented. */
export const MARKETING_CONSENT_ABUSE_CASE = 61;
/** The suppressions the exception report is told of, with the abuse case each answers. */
export const PUBLISHED_SUPPRESSIONS: Readonly<Partial<Record<SuppressedReason, number>>> = { RATE_LIMITED: MESSAGE_STORM_ABUSE_CASE, NO_LINK: MESSAGE_LINK_ABUSE_CASE, NO_CONSENT: MARKETING_CONSENT_ABUSE_CASE };

/**
 * Who a message is for, named by the record it is about: its order's own contact, a customer's own number, or a member
 * of staff in the console. The address is always read here from the record's module, never taken from an event.
 */
export type MessageRecipient =
  | { readonly kind: 'ORDER'; readonly orderId: string }
  | { readonly kind: 'CUSTOMER'; readonly customerId: string; readonly branchId: string }
  | { readonly kind: 'SUPPLIER'; readonly supplierId: string; readonly branchId: string }
  | { readonly kind: 'PRINCIPAL'; readonly principalId: string; readonly branchId: string | null };

export interface MessageSpec {
  readonly event: EventEnvelope;
  readonly code: TemplateCode;
  readonly recipient: MessageRecipient;
  readonly data: Readonly<Record<string, string>>;
  /** The record the idempotency key names: the order, the dunning notice, the death report, a send, a remittance. */
  readonly recordId: string;
  /** Channels the source itself allows (a reminder level's), intersected with the trigger's; null for all. */
  readonly allowedChannels?: readonly Channel[] | null;
  /** Where an in-app notification takes its reader in the console. */
  readonly linkPath?: string | null;
  /**
   * The record a link-carrying message's link opens (B11 continued 12): its token is made by the record's own module when
   * the message is sent, never now (ADR-0074).
   */
  readonly linkRecordId?: string | null;
  /**
   * One message about the record ever, whatever event names it (B11 continued 13): a remittance advice goes once per
   * payment, so a second event for the same advice, forged or replayed, queues nothing.
   */
  readonly oncePerRecord?: boolean;
}

/** A recipient's address and identity as read now, with what its preferences are kept under. */
export interface ResolvedRecipient {
  readonly kind: 'CUSTOMER' | 'CONTACT' | 'STAFF' | 'SUPPLIER';
  readonly branchId: string | null;
  readonly salesOrderId: string | null;
  readonly customerId: string | null;
  readonly principalId: string | null;
  readonly supplierId: string | null;
  readonly phoneE164: string | null;
  /** The party's own email (a customer's or a supplier's, B11 continued 13); an order's contact has none. */
  readonly email: string | null;
  readonly owner: PreferenceOwner | null;
}

/** The channels with an adapter (A-374 (d)): SMS, and the console's in-app notifications, which NTF writes itself. */
export function availableChannels(adapters: Iterable<Channel>): ReadonlySet<Channel> {
  return new Set<Channel>([...adapters, 'IN_APP']);
}

/**
 * The recipient's facts and the gates on a send (FR-NTF-004 to FR-NTF-006), read through the record's own module and
 * NTF's own tables, used when a message is queued and again when it is sent: the address, the opt-outs on it, the
 * preferences and the recipient's own quiet hours.
 */
export class RecipientFacts {
  constructor(
    private readonly store: NtfStore,
    private readonly orders: Orders,
    private readonly refs: MasterDataRefs,
    private readonly hasher: AddressHasher,
  ) {}

  /** The recipient as it is now, or null when its record does not exist (an event naming no order sends nothing). */
  async resolveIn(tx: Transaction, recipient: MessageRecipient): Promise<ResolvedRecipient | null> {
    if (recipient.kind === 'ORDER') {
      const contact = (await this.orders.messageContactsIn(tx, [recipient.orderId])).get(recipient.orderId);
      if (contact === undefined) return null;
      return {
        kind: contact.customerId === null ? 'CONTACT' : 'CUSTOMER',
        branchId: contact.branchId,
        salesOrderId: contact.orderId,
        customerId: contact.customerId,
        principalId: null,
        supplierId: null,
        phoneE164: contact.phoneE164,
        email: null,
        owner: contact.customerId === null ? null : { customerId: contact.customerId },
      };
    }
    if (recipient.kind === 'CUSTOMER') {
      const customer = (await this.refs.partyAddressesIn(tx, 'CUSTOMER', [recipient.customerId])).get(recipient.customerId);
      if (customer === undefined) return null;
      return { kind: 'CUSTOMER', branchId: recipient.branchId, salesOrderId: null, customerId: customer.id, principalId: null, supplierId: null, phoneE164: customer.phoneE164, email: customer.email, owner: { customerId: customer.id } };
    }
    if (recipient.kind === 'SUPPLIER') {
      // A supplier keeps no preferences in NTF: its remittance advice is transactional, by the trigger's channels.
      const supplier = (await this.refs.partyAddressesIn(tx, 'SUPPLIER', [recipient.supplierId])).get(recipient.supplierId);
      if (supplier === undefined) return null;
      return { kind: 'SUPPLIER', branchId: recipient.branchId, salesOrderId: null, customerId: null, principalId: null, supplierId: supplier.id, phoneE164: supplier.phoneE164, email: supplier.email, owner: null };
    }
    return { kind: 'STAFF', branchId: recipient.branchId, salesOrderId: null, customerId: null, principalId: recipient.principalId, supplierId: null, phoneE164: null, email: null, owner: { principalId: recipient.principalId } };
  }

  /** The address a channel reaches the recipient at: an email for EMAIL, else the phone number; null for the console. */
  addressFor(recipient: Pick<ResolvedRecipient, 'phoneE164' | 'email'>, channel: Channel): string | null {
    if (channel === 'IN_APP') return null;
    return channel === 'EMAIL' ? recipient.email : recipient.phoneE164;
  }

  /**
   * The address as it is now for a message being sent (A-374 (b)): its order's contact, else its customer's or its
   * supplier's own, by the message's channel (an email for EMAIL, B11 continued 13).
   */
  async addressIn(tx: Transaction, message: { readonly salesOrderId: string | null; readonly customerId: string | null; readonly supplierId: string | null; readonly channel: Channel }): Promise<string | null> {
    if (message.channel !== 'EMAIL' && message.salesOrderId !== null) return (await this.orders.messageContactsIn(tx, [message.salesOrderId])).get(message.salesOrderId)?.phoneE164 ?? null;
    const party = message.customerId !== null ? (await this.refs.partyAddressesIn(tx, 'CUSTOMER', [message.customerId])).get(message.customerId) : message.supplierId !== null ? (await this.refs.partyAddressesIn(tx, 'SUPPLIER', [message.supplierId])).get(message.supplierId) : undefined;
    return party === undefined ? null : this.addressFor(party, message.channel);
  }

  async optedOutIn(tx: Transaction, address: string | null): Promise<ReadonlySet<Channel>> {
    return address === null ? new Set() : this.store.optedOutChannels(tx, this.hash(address));
  }

  async preferencesIn(tx: Transaction, owner: PreferenceOwner | null, category: Category): Promise<PreferenceRecord[]> {
    return owner === null ? [] : (await this.store.preferencesOf(tx, owner)).filter((p) => p.category === category);
  }

  /** The recipient's own quiet hours for the category and channel, or null for the default (SA-09). */
  ownQuietHours(preferences: readonly PreferenceRecord[], channel: Channel): QuietHours | null {
    const own = preferences.find((p) => p.channel === channel && p.quietFrom !== null && p.quietTo !== null);
    return own === undefined ? null : { from: own.quietFrom!, to: own.quietTo! };
  }

  /** Whether a marketing message may go: only to a live customer whose own record holds marketing consent. */
  async consentedIn(tx: Transaction, customerId: string | null): Promise<boolean> {
    return customerId !== null && (await this.refs.marketingConsentsIn(tx, [customerId])).has(customerId);
  }

  hash(address: string): Buffer {
    return this.hasher.hash(normalisedAddress(address));
  }
}

/**
 * Queues one message in an outbox consumer's transaction (ADR-0096's first step, ADR-0097): the trigger for its event and
 * template must be live (FR-NTF-002); the recipient is read through the record's own module; the channel is routed by the
 * trigger, the recipient's preferences and the opt-outs on the number (FR-NTF-004, FR-NTF-005); a reminder or marketing
 * message due in quiet hours waits until they end (FR-NTF-006); the hourly limit per number holds (abuse case 58). One
 * message per source event, template and record, on whichever channel (FR-NTF-003): the idempotency key, and a check for
 * the same source on another channel, in the consumer's serializable transaction.
 */
export class MessageQueue {
  private readonly nextId: () => string;

  constructor(
    private readonly store: NtfStore,
    private readonly recipients: RecipientFacts,
    private readonly available: ReadonlySet<Channel>,
    private readonly events: DomainEvents,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** True when this call wrote the message. */
  async queueIn(tx: Transaction, spec: MessageSpec): Promise<boolean> {
    const trigger = await this.store.triggerFor(tx, spec.event.type, spec.code);
    if (trigger === null || !trigger.isActive) return false;
    const recipient = await this.recipients.resolveIn(tx, spec.recipient);
    if (recipient === null) return false;
    if (await this.store.messageExistsFor(tx, spec.event.id, spec.code, spec.recordId)) return false;
    if (spec.oncePerRecord === true && (await this.store.messageExistsForRecord(tx, spec.code, spec.recordId))) return false;
    const category = TEMPLATE_CODES[spec.code].category;
    const triggerChannels = spec.allowedChannels == null ? trigger.channels : trigger.channels.filter((c) => spec.allowedChannels!.includes(c));
    if (triggerChannels.length === 0) return false;
    const preferences = await this.recipients.preferencesIn(tx, recipient.owner, category);
    const optedOut = await this.recipients.optedOutIn(tx, recipient.phoneE164);
    const route = routeMessage({ category, triggerChannels, preferences, optedOut, available: this.available });
    const template = await this.store.activeTemplate(tx, spec.code, route.channel, DEFAULT_LOCALE, false);
    if (template === null) {
      this.logger.warn({ code: spec.code, channel: route.channel, eventType: spec.event.type }, 'no active template for a triggered message');
      return false;
    }
    const at = this.clock.now();
    const phone = this.recipients.addressFor(recipient, route.channel);
    const addressHash = phone === null ? null : this.recipients.hash(phone);
    let suppressedReason: SuppressedReason | null = route.kind === 'SUPPRESS' ? route.reason : null;
    if (suppressedReason === null && category === 'MARKETING' && !(await this.recipients.consentedIn(tx, recipient.customerId))) suppressedReason = 'NO_CONSENT';
    // A channel with no adapter yet fails visibly when it is sent (ADR-0097), whatever address it lacks.
    if (suppressedReason === null && route.channel !== 'IN_APP' && phone === null && this.available.has(route.channel)) suppressedReason = 'NO_ADDRESS';
    if (suppressedReason === null && route.channel === 'IN_APP' && recipient.principalId === null) suppressedReason = 'NO_ADDRESS';
    if (suppressedReason === null && addressHash !== null && !withinRecipientLimit(await this.store.queuedToAddressSince(tx, addressHash, new Date(at.getTime() - RECIPIENT_WINDOW_MS)))) suppressedReason = 'RATE_LIMITED';
    const sendAfter = suppressedReason === null && quietHoursApply(category) ? quietUntil(at, this.recipients.ownQuietHours(preferences, route.channel)) : null;
    const id = this.nextId();
    // A link is made at send by the record's own module; the stored text keeps its placeholder, and a message naming no
    // record (or a version whose text has no link) carries none.
    const linkable = spec.linkRecordId != null && linkKindOf(spec.code) !== null;
    const renderedBody = render(template.body, linkable ? linkDataOf(spec.code, spec.data) : spec.data);
    const linkKind = linkable && renderedBody.includes(LINK_PLACEHOLDER) ? linkKindOf(spec.code) : null;
    const written = await this.store.insertMessage(tx, {
      id,
      idempotencyKey: messageKey(spec.event.id, spec.code, route.channel, spec.recordId),
      sourceEventRef: spec.event.id,
      sourceEventType: spec.event.type,
      branchId: recipient.branchId,
      salesOrderId: recipient.salesOrderId,
      templateId: template.id,
      channel: route.channel,
      category: template.category,
      recipientKind: recipient.kind,
      customerId: recipient.customerId,
      principalId: recipient.principalId,
      supplierId: recipient.supplierId,
      recordId: spec.recordId,
      addressMasked: phone === null ? '' : maskAnyAddress(phone),
      addressHash,
      renderedBody,
      renderedSubject: template.subject === null ? null : render(template.subject, spec.data),
      linkPath: spec.linkPath ?? null,
      linkKind,
      linkRecordId: linkKind === null ? null : spec.linkRecordId!,
      status: suppressedReason !== null ? 'SUPPRESSED' : sendAfter !== null ? 'DEFERRED_QUIET_HOURS' : 'QUEUED',
      suppressedReason,
      sendAfter,
      at,
      actorId: DISPATCHER_PRINCIPAL.principalId,
    });
    const abuseCase = suppressedReason === null ? undefined : PUBLISHED_SUPPRESSIONS[suppressedReason];
    if (written && abuseCase !== undefined && (suppressedReason === 'RATE_LIMITED' || suppressedReason === 'NO_CONSENT')) {
      await this.events.publish<MessageSuppressed>(tx, {
        type: MESSAGE_SUPPRESSED,
        subjectType: 'NotificationMessage',
        subjectId: id,
        branchId: recipient.branchId,
        causationId: spec.event.id,
        payload: { messageId: id, templateCode: spec.code, channel: route.channel, reason: suppressedReason, salesOrderId: recipient.salesOrderId, sourceEventType: spec.event.type, abuseCases: [abuseCase] },
      });
    }
    return written;
  }
}
