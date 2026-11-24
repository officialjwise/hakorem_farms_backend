import { describe, expect, it } from 'vitest';
import {
  afterAttempt,
  afterReport,
  customerMessageOf,
  itemsLine,
  judgeRetry,
  maskAddress,
  MAX_SEND_ATTEMPTS,
  messageKey,
  orderIdOf,
  RECIPIENT_HOURLY_LIMIT,
  retryDelayMs,
  slotLine,
  withinRecipientLimit,
} from './messages';

const ORDER = '019a7b15-03c8-795c-8e94-9e9769351775';

describe("the customer's message for each event (FR-ORD-011, FR-DEL-003, FR-DEL-012)", () => {
  it('dispatch names the goods with their weights, the final total, what is due at the door, the due date, a backorder and the slot', () => {
    const message = customerMessageOf(
      'ord.OrderDispatched',
      {
        orderId: ORDER,
        contactPhone: '+233200000001',
        deliveryNo: 'DLV-2026-000004',
        finalTotalPesewas: 94_000,
        codDuePesewas: 0,
        dueDate: '2026-12-24',
        backorderNo: 'SO-2026-000009',
        bookedSlotId: 'x',
        lines: [
          { name: 'Eggs, big (crate of 30)', quantity: '2.000', uom: 'CRATE', weightKg: null },
          { name: 'Goat meat', quantity: '1.000', uom: 'KG', weightKg: '1.250' },
          { name: 'Yam', quantity: '1.500', uom: 'TUBER', weightKg: null },
        ],
      },
      'SO-2026-000008',
      slotLine('2026-11-25', '08:00', '10:00'),
    );
    expect(message).toEqual({
      code: 'ORDER_DISPATCHED',
      orderId: ORDER,
      data: { orderNo: 'SO-2026-000008', deliveryNo: 'DLV-2026-000004', total: 'GHS 940.00', codDue: 'GHS 0.00', dueDate: '2026-12-24', items: '2 Eggs, big (crate of 30), 1.250 kg Goat meat, 1.5 Yam', backorderNo: 'SO-2026-000009', slot: '25 Nov, 08:00 to 10:00' },
    });
    expect(JSON.stringify(message)).not.toContain('+233200000001');
  });

  it('a dispatch with no slot booked, no lines and no backorder leaves those fields empty', () => {
    const message = customerMessageOf('ord.OrderDispatched', { orderId: ORDER, deliveryNo: 'D', finalTotalPesewas: 1, codDuePesewas: 1, dueDate: null, backorderNo: null, bookedSlotId: null }, 'SO-1');
    expect(message?.data).toMatchObject({ items: '', slot: '', dueDate: '', backorderNo: '', total: 'GHS 0.01' });
  });

  it('collection, on the way, rescheduled, cancelled, delivered and part delivered', () => {
    expect(customerMessageOf('ord.OrderCollected', { orderId: ORDER, billingDocumentNo: 'INV-1', finalTotalPesewas: 137_900, dueAtTillPesewas: 37_900, dueDate: null }, 'SO-1')).toEqual({
      code: 'ORDER_COLLECTED',
      orderId: ORDER,
      data: { orderNo: 'SO-1', documentNo: 'INV-1', total: 'GHS 1,379.00', dueAtTill: 'GHS 379.00', dueDate: '' },
    });
    expect(customerMessageOf('del.DeliveryOnTheWay', { orderDocumentId: ORDER, deliveryNo: 'D-1', etaMinutes: 25 }, 'SO-1')?.data).toEqual({ orderNo: 'SO-1', deliveryNo: 'D-1', eta: '25 minutes' });
    expect(customerMessageOf('del.DeliveryOnTheWay', { orderDocumentId: ORDER, deliveryNo: 'D-1', etaMinutes: null }, 'SO-1')?.data['eta']).toBe('');
    expect(customerMessageOf('del.DeliveryRescheduled', { orderDocumentId: ORDER, deliveryNo: 'D-1', slotDate: '2026-11-26', slotStartsAt: '14:00', slotEndsAt: '16:00' }, 'SO-1')).toEqual({
      code: 'DELIVERY_RESCHEDULED',
      orderId: ORDER,
      data: { orderNo: 'SO-1', deliveryNo: 'D-1', slotDate: '2026-11-26', slotStart: '14:00', slotEnd: '16:00' },
    });
    expect(customerMessageOf('del.DeliveryCancelled', { orderDocumentId: ORDER, deliveryNo: 'D-1' }, 'SO-1')?.code).toBe('DELIVERY_CANCELLED');
    expect(customerMessageOf('del.DeliveryCompleted', { orderDocumentId: ORDER, deliveryNo: 'D-1', codCollectedPesewas: 94_000, returnedLines: [] }, 'SO-1')).toEqual({
      code: 'DELIVERY_COMPLETED',
      orderId: ORDER,
      data: { orderNo: 'SO-1', deliveryNo: 'D-1', collected: 'GHS 940.00' },
    });
    expect(customerMessageOf('del.DeliveryCompleted', { orderDocumentId: ORDER, deliveryNo: 'D-1', codCollectedPesewas: 88_000, returnedLines: [{}], returnedCreditPesewas: 6_000 }, 'SO-1')).toEqual({
      code: 'DELIVERY_PART_COMPLETED',
      orderId: ORDER,
      data: { orderNo: 'SO-1', deliveryNo: 'D-1', collected: 'GHS 880.00', returnedCredit: 'GHS 60.00' },
    });
    expect(customerMessageOf('del.DeliveryFailed', { orderDocumentId: ORDER }, 'SO-1')).toBeNull();
    expect(customerMessageOf('del.DeliveryCompleted', { orderDocumentId: 7, codCollectedPesewas: 1.5 }, 'SO-1')).toMatchObject({ orderId: '', data: { deliveryNo: '', collected: 'GHS 0.00' } });
  });

  it('finds the order an event is about, ORD by orderId and DEL by orderDocumentId', () => {
    expect(orderIdOf('ord.OrderDispatched', { orderId: ORDER, orderDocumentId: 'no' })).toBe(ORDER);
    expect(orderIdOf('del.DeliveryOnTheWay', { orderId: 'no', orderDocumentId: ORDER })).toBe(ORDER);
    expect(orderIdOf('del.DeliveryOnTheWay', {})).toBeNull();
  });

  it('writes whole quantities without their zeros and keeps a fraction', () => {
    expect(itemsLine([{ name: 'A', quantity: '10.000', uom: 'X', weightKg: null }, { name: 'B', quantity: '0.250', uom: 'X', weightKg: null }])).toBe('10 A, 0.25 B');
    expect(slotLine('2026-01-05', '14:00', '16:00')).toBe('5 Jan, 14:00 to 16:00');
    expect(slotLine('2026-13-05', '14:00', '16:00')).toBe('5 , 14:00 to 16:00');
  });
});

describe('the message log, its attempts and its reports (FR-NTF-003, FR-NTF-007)', () => {
  it('masks a number as +23324*****56: the country code and two digits, a star a hidden digit, and the last two', () => {
    expect(maskAddress('+233244512856')).toBe('+23324*****56');
    expect(maskAddress('+2348031234567')).toBe('+23480******67');
    expect(() => maskAddress('0244512856')).toThrow(/E.164/);
  });

  it('keys a message by its event, template, channel and recipient', () => {
    expect(messageKey('e', 'ORDER_DISPATCHED', 'SMS', 'o')).toBe('e:ORDER_DISPATCHED:SMS:o');
  });

  it('holds a recipient to the hourly limit', () => {
    expect(withinRecipientLimit(RECIPIENT_HOURLY_LIMIT - 1)).toBe(true);
    expect(withinRecipientLimit(RECIPIENT_HOURLY_LIMIT)).toBe(false);
  });

  it('retries a temporary failure until the third attempt, fails a permanent one at once, and sends an accepted one', () => {
    expect(MAX_SEND_ATTEMPTS).toBe(3);
    expect(afterAttempt('ACCEPTED', 3)).toBe('SENT');
    expect(afterAttempt('TEMPORARY_FAILURE', 1)).toBe('QUEUED');
    expect(afterAttempt('TEMPORARY_FAILURE', 2)).toBe('QUEUED');
    expect(afterAttempt('TEMPORARY_FAILURE', 3)).toBe('FAILED');
    expect(afterAttempt('PERMANENT_FAILURE', 1)).toBe('FAILED');
  });

  it('backs off with jitter: half the capped delay plus up to the other half, doubling to the ceiling', () => {
    expect(retryDelayMs(1, 0)).toBe(30_000);
    expect(retryDelayMs(1, 1)).toBe(60_000);
    expect(retryDelayMs(2, 0)).toBe(60_000);
    expect(retryDelayMs(0, 0)).toBe(30_000);
    expect(retryDelayMs(10, 1)).toBe(900_000);
  });

  it('lets a report move only a SENT message, to DELIVERED or FAILED', () => {
    expect(afterReport('SENT', 'DELIVERED')).toBe('DELIVERED');
    expect(afterReport('SENT', 'FAILED')).toBe('FAILED');
    for (const status of ['QUEUED', 'DEFERRED_QUIET_HOURS', 'DELIVERED', 'FAILED', 'SUPPRESSED'] as const) {
      expect(afterReport(status, 'DELIVERED')).toBeNull();
      expect(afterReport(status, 'FAILED')).toBeNull();
    }
  });

  it('retries only a failed message, never a suppressed one', () => {
    expect(judgeRetry('FAILED')).toBe('OK');
    expect(judgeRetry('SUPPRESSED')).toBe('SUPPRESSED');
    expect(judgeRetry('SENT')).toBe('NOT_FAILED');
  });
});
