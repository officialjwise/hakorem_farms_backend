import { formatCedis } from '@hakorem/kernel';
import type { TemplateCode } from './templates';

/** The statuses a message moves through (docs/data-model/ntf.md); DELIVERED and SUPPRESSED are final. */
export const MESSAGE_STATUSES = ['QUEUED', 'DEFERRED_QUIET_HOURS', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];
export type AttemptOutcome = 'ACCEPTED' | 'TEMPORARY_FAILURE' | 'PERMANENT_FAILURE';

/** Tries of one message before it shows as FAILED (FR-NTF-004: "fails 3 times"); a manager may retry it after. */
export const MAX_SEND_ATTEMPTS = 3;
/** The first wait after a temporary failure; each later one doubles, up to the ceiling (FR-NTF-007). */
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 900_000;
/** How long a sender holds a claimed message before another worker may take it over (a worker that died mid-send). */
export const CLAIM_LEASE_MS = 120_000;
/**
 * The most messages one recipient is queued in an hour (abuse case 58, a reminder storm): a fault that publishes the
 * same kind of event over and over reaches the customer this many times at most; the rest are SUPPRESSED, visible.
 */
export const RECIPIENT_HOURLY_LIMIT = 10;
export const RECIPIENT_WINDOW_MS = 3_600_000;

/** Why a message was not sent; shown in the log (FR-NTF-005, FR-NTF-007). */
export type SuppressedReason = 'NO_ADDRESS' | 'RATE_LIMITED';

/** The order and recipient facts a customer message is built on, read from ORD at queue time (never from the event). */
export interface OrderContact {
  readonly orderId: string;
  readonly orderNo: string;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly phoneE164: string | null;
}

/** A customer message decided from an event: which template, and the values of its merge fields. */
export interface CustomerMessage {
  readonly code: TemplateCode;
  readonly orderId: string;
  readonly data: Readonly<Record<string, string>>;
}

const money = (pesewas: unknown) => formatCedis(BigInt(Number.isSafeInteger(pesewas) ? (pesewas as number) : 0));
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** "2 x Eggs, big (crate of 30), 1.250 kg Goat meat": what left the farm, as the customer's message lists it. */
export function itemsLine(lines: readonly { readonly name: string; readonly quantity: string; readonly uom: string; readonly weightKg: string | null }[]): string {
  return lines
    .map((line) => {
      if (line.weightKg !== null) return `${line.weightKg} kg ${line.name}`;
      const whole = line.quantity.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
      return `${whole} ${line.name}`;
    })
    .join(', ');
}

/** "25 Nov, 08:00 to 10:00": a booked slot, from the dates DEL publishes (calendar date and local times). */
export function slotLine(date: string, startsAt: string, endsAt: string): string {
  const [, month, day] = date.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(day)} ${months[Number(month) - 1] ?? ''}, ${startsAt} to ${endsAt}`;
}

/**
 * The customer's message for an event (FR-ORD-011, FR-DEL-003, FR-DEL-012): one per event, from the facts the event
 * carries about the goods and the money, never its phone number; null for an event that sends nothing. The recipient is
 * always the order's own contact, read from ORD by `orderId` (A-374 (b)). `bookedSlot` is the slot dispatch booked, as
 * `slotLine` writes it, read from DEL by the event's `bookedSlotId`.
 */
export function customerMessageOf(eventType: string, payload: Readonly<Record<string, unknown>>, orderNo: string, bookedSlot: string | null = null): CustomerMessage | null {
  switch (eventType) {
    case 'ord.OrderDispatched': {
      const lines = Array.isArray(payload['lines']) ? (payload['lines'] as { name: string; quantity: string; uom: string; weightKg: string | null }[]) : [];
      return {
        code: 'ORDER_DISPATCHED',
        orderId: text(payload['orderId']),
        data: {
          orderNo,
          deliveryNo: text(payload['deliveryNo']),
          total: money(payload['finalTotalPesewas']),
          codDue: money(payload['codDuePesewas']),
          dueDate: text(payload['dueDate']),
          items: itemsLine(lines),
          backorderNo: text(payload['backorderNo']),
          slot: bookedSlot ?? '',
        },
      };
    }
    case 'ord.OrderCollected':
      return {
        code: 'ORDER_COLLECTED',
        orderId: text(payload['orderId']),
        data: { orderNo, documentNo: text(payload['billingDocumentNo']), total: money(payload['finalTotalPesewas']), dueAtTill: money(payload['dueAtTillPesewas']), dueDate: text(payload['dueDate']) },
      };
    case 'del.DeliveryOnTheWay': {
      const eta = payload['etaMinutes'];
      return {
        code: 'DELIVERY_ON_THE_WAY',
        orderId: text(payload['orderDocumentId']),
        data: { orderNo, deliveryNo: text(payload['deliveryNo']), eta: typeof eta === 'number' ? `${String(eta)} minutes` : '' },
      };
    }
    case 'del.DeliveryRescheduled':
      return {
        code: 'DELIVERY_RESCHEDULED',
        orderId: text(payload['orderDocumentId']),
        data: { orderNo, deliveryNo: text(payload['deliveryNo']), slotDate: text(payload['slotDate']), slotStart: text(payload['slotStartsAt']), slotEnd: text(payload['slotEndsAt']) },
      };
    case 'del.DeliveryCancelled':
      return { code: 'DELIVERY_CANCELLED', orderId: text(payload['orderDocumentId']), data: { orderNo, deliveryNo: text(payload['deliveryNo']) } };
    case 'del.DeliveryCompleted': {
      const returned = Array.isArray(payload['returnedLines']) && payload['returnedLines'].length > 0;
      const base = { orderNo, deliveryNo: text(payload['deliveryNo']), collected: money(payload['codCollectedPesewas']) };
      return returned
        ? { code: 'DELIVERY_PART_COMPLETED', orderId: text(payload['orderDocumentId']), data: { ...base, returnedCredit: money(payload['returnedCreditPesewas']) } }
        : { code: 'DELIVERY_COMPLETED', orderId: text(payload['orderDocumentId']), data: base };
    }
    default:
      return null;
  }
}

/** The events whose customer message NTF sends (the B11 continued 10 gate). */
export const CUSTOMER_MESSAGE_EVENTS = ['ord.OrderDispatched', 'ord.OrderCollected', 'del.DeliveryOnTheWay', 'del.DeliveryRescheduled', 'del.DeliveryCancelled', 'del.DeliveryCompleted'] as const;

/** The order a customer message event is about: ORD's `orderId`, DEL's `orderDocumentId` (the same id, ADR-0011). */
export function orderIdOf(eventType: string, payload: Readonly<Record<string, unknown>>): string | null {
  const id = eventType.startsWith('ord.') ? payload['orderId'] : payload['orderDocumentId'];
  return typeof id === 'string' ? id : null;
}

/**
 * The number as the log shows it (FR-NTF-007: `+23324*****56`): the country code and the first two digits of the
 * subscriber number, then one star for each digit hidden, then the last two. Nothing else of it is kept in the log.
 */
export function maskAddress(e164: string): string {
  if (!/^\+[1-9][0-9]{7,14}$/.test(e164)) throw new RangeError('not an E.164 phone number');
  const shown = 6;
  const tail = 2;
  return `${e164.slice(0, shown)}${'*'.repeat(e164.length - shown - tail)}${e164.slice(-tail)}`;
}

/** The idempotency key that makes a message exist at most once: its source event, its template and its channel (FR-NTF-003). */
export function messageKey(sourceEventId: string, code: string, channel: string, recipient: string): string {
  return `${sourceEventId}:${code}:${channel}:${recipient}`;
}

/** Whether a recipient may be queued another message: under the hourly limit (abuse case 58). */
export function withinRecipientLimit(queuedInWindow: number): boolean {
  return queuedInWindow < RECIPIENT_HOURLY_LIMIT;
}

/** Exponential backoff with equal jitter: half the capped delay, plus a random part of the other half (FR-NTF-007). */
export function retryDelayMs(attempts: number, random: number): number {
  const capped = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(capped / 2 + (random * capped) / 2);
}

/** What an attempt leaves the message as: SENT, QUEUED to retry, or FAILED once permanent or out of attempts. */
export function afterAttempt(outcome: AttemptOutcome, attempts: number): 'SENT' | 'QUEUED' | 'FAILED' {
  if (outcome === 'ACCEPTED') return 'SENT';
  if (outcome === 'TEMPORARY_FAILURE' && attempts < MAX_SEND_ATTEMPTS) return 'QUEUED';
  return 'FAILED';
}

/** A provider's delivery report as NTF reads it: only whether the message reached the phone. */
export type ReportedStatus = 'DELIVERED' | 'FAILED';

/**
 * What a delivery report may change (abuse case 57: a forged or replayed report): a SENT message becomes DELIVERED or
 * FAILED; a DELIVERED one stays delivered; nothing else moves. Null means the report changes nothing.
 */
export function afterReport(current: MessageStatus, reported: ReportedStatus): 'DELIVERED' | 'FAILED' | null {
  if (current !== 'SENT') return null;
  return reported;
}

/** A failed message may be queued again by a manager (`retryNotificationMessage`); a suppressed one never is. */
export function judgeRetry(current: MessageStatus): 'OK' | 'SUPPRESSED' | 'NOT_FAILED' {
  if (current === 'SUPPRESSED') return 'SUPPRESSED';
  return current === 'FAILED' ? 'OK' : 'NOT_FAILED';
}
