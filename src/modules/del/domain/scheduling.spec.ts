import { describe, expect, it } from 'vitest';
import { judgeBooking, judgeCancellation, judgeReassignment, type BookingFacts } from './scheduling';

const now = new Date('2026-11-24T10:30:00.000Z');
const slot = { deliveryZoneId: 'zone-1', slotDate: '2026-11-26', startsAt: '08:00', capacity: 2, booked: 1 };
const facts = (over: Partial<BookingFacts> = {}): BookingFacts => ({
  status: 'ASSIGNED',
  deliveryZoneId: 'zone-1',
  currentSlotId: null,
  slotId: 'slot-2',
  slot,
  cutoffTime: '14:00',
  runDate: null,
  now,
  ...over,
});

describe('reassigning a delivery (FR-DEL-004)', () => {
  it('takes a delivery waiting on the van or failed at the door, on no live run, to another driver or vehicle', () => {
    expect(judgeReassignment({ status: 'ASSIGNED', onLiveRun: false, sameDriver: false, sameVehicle: true })).toEqual([]);
    expect(judgeReassignment({ status: 'FAILED', onLiveRun: false, sameDriver: true, sameVehicle: false })).toEqual([]);
  });

  it('refuses one on its way or finished as a state refusal alone', () => {
    for (const status of ['OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED', 'WRITTEN_OFF', 'CANCELLED', 'SCHEDULED'] as const) {
      expect(judgeReassignment({ status, onLiveRun: true, sameDriver: true, sameVehicle: true })).toEqual([{ field: '', rule: 'INVALID_STATE_TRANSITION' }]);
    }
  });

  it('refuses one on a live run, which keeps its driver and vehicle, and a change that changes nothing', () => {
    expect(judgeReassignment({ status: 'ASSIGNED', onLiveRun: true, sameDriver: false, sameVehicle: false })).toEqual([{ field: '', rule: 'ON_A_RUN' }]);
    expect(judgeReassignment({ status: 'FAILED', onLiveRun: false, sameDriver: true, sameVehicle: true })).toEqual([{ field: '/driverId', rule: 'UNCHANGED' }]);
  });
});

describe('booking a slot for a delivery (FR-DEL-001 to FR-DEL-003, FR-DEL-011)', () => {
  it('books a slot of the zone that has room, has not started and is not past its cut-off', () => {
    expect(judgeBooking(facts())).toEqual([]);
  });

  it('refuses a delivery on its way or finished as a state refusal alone', () => {
    for (const status of ['OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED', 'WRITTEN_OFF', 'CANCELLED'] as const) {
      expect(judgeBooking(facts({ status, slot: 'MISSING' }))).toEqual([{ field: '', rule: 'INVALID_STATE_TRANSITION' }]);
    }
  });

  it('refuses an unknown slot alone, and a slot of another zone', () => {
    expect(judgeBooking(facts({ slot: 'MISSING' }))).toEqual([{ field: '/slotId', rule: 'SLOT_UNKNOWN' }]);
    expect(judgeBooking(facts({ slot: { ...slot, deliveryZoneId: 'zone-2' } }))).toEqual([{ field: '/slotId', rule: 'SLOT_OTHER_ZONE' }]);
  });

  it('refuses a full slot: never more bookings than its capacity', () => {
    expect(judgeBooking(facts({ slot: { ...slot, booked: 2 } }))).toEqual([{ field: '/slotId', rule: 'SLOT_FULL' }]);
    expect(judgeBooking(facts({ slot: { ...slot, booked: 1, capacity: 1 } }))).toEqual([{ field: '/slotId', rule: 'SLOT_FULL' }]);
  });

  it('refuses a slot that has started, to the minute', () => {
    expect(judgeBooking(facts({ slot: { ...slot, slotDate: '2026-11-24', startsAt: '10:30' } }))).toEqual([{ field: '/slotId', rule: 'SLOT_STARTED' }]);
    expect(judgeBooking(facts({ slot: { ...slot, slotDate: '2026-11-23', startsAt: '16:00' } }))).toEqual([{ field: '/slotId', rule: 'SLOT_STARTED' }]);
    expect(judgeBooking(facts({ slot: { ...slot, slotDate: '2026-11-24', startsAt: '10:31' } }))).toEqual([]);
  });

  it("offers today's remaining slots before the zone's cut-off and none after it, in Africa/Accra (FR-DEL-002)", () => {
    const today = { ...slot, slotDate: '2026-11-24', startsAt: '16:00' };
    expect(judgeBooking(facts({ slot: today, now: new Date('2026-11-24T13:59:00.000Z') }))).toEqual([]);
    expect(judgeBooking(facts({ slot: today, now: new Date('2026-11-24T14:00:00.000Z') }))).toEqual([]);
    expect(judgeBooking(facts({ slot: today, now: new Date('2026-11-24T14:00:01.000Z') }))).toEqual([{ field: '/slotId', rule: 'PAST_CUT_OFF' }]);
    expect(judgeBooking(facts({ slot: today, now: new Date('2026-11-24T14:01:00.000Z') }))).toEqual([{ field: '/slotId', rule: 'PAST_CUT_OFF' }]);
    expect(judgeBooking(facts({ slot: { ...slot, slotDate: '2026-11-25' }, now: new Date('2026-11-24T14:01:00.000Z') }))).toEqual([]);
  });

  it("keeps a delivery on a run to its run's day: the stop and the van stay with that run", () => {
    expect(judgeBooking(facts({ runDate: '2026-11-25' }))).toEqual([{ field: '/slotId', rule: 'NOT_ON_RUN_DAY' }]);
    expect(judgeBooking(facts({ runDate: '2026-11-26' }))).toEqual([]);
  });

  it('refuses the same slot for a delivery waiting on the van, and takes it for a reattempt without a second booking', () => {
    expect(judgeBooking(facts({ currentSlotId: 'slot-2', slot: { ...slot, booked: 2 } }))).toEqual([{ field: '/slotId', rule: 'SAME_SLOT' }]);
    expect(judgeBooking(facts({ status: 'FAILED', currentSlotId: 'slot-2', slot: { ...slot, booked: 2 } }))).toEqual([]);
  });

  it('lists every rule a booking breaks at once', () => {
    expect(judgeBooking(facts({ slot: { ...slot, deliveryZoneId: 'zone-2', booked: 2, slotDate: '2026-11-24', startsAt: '09:00' }, runDate: '2026-11-25' }))).toEqual([
      { field: '/slotId', rule: 'SLOT_OTHER_ZONE' },
      { field: '/slotId', rule: 'SLOT_STARTED' },
      { field: '/slotId', rule: 'NOT_ON_RUN_DAY' },
      { field: '/slotId', rule: 'SLOT_FULL' },
    ]);
  });
});

describe('cancelling a dispatched delivery before it leaves (A-364 (a), FR-ORD-014)', () => {
  it('takes a delivery whose goods still wait on the van, on no live run', () => {
    expect(judgeCancellation({ status: 'ASSIGNED', onLiveRun: false })).toEqual([]);
    expect(judgeCancellation({ status: 'SCHEDULED', onLiveRun: false })).toEqual([]);
  });

  it('refuses one on its way, failed (its way out is the return to stock) or finished, and a stop of a live run', () => {
    for (const status of ['OUT_FOR_DELIVERY', 'FAILED', 'DELIVERED', 'RETURNED', 'WRITTEN_OFF', 'CANCELLED'] as const) {
      expect(judgeCancellation({ status, onLiveRun: false }), status).toEqual([{ field: '', rule: 'INVALID_STATE_TRANSITION' }]);
    }
    expect(judgeCancellation({ status: 'ASSIGNED', onLiveRun: true })).toEqual([{ field: '', rule: 'ON_A_RUN' }]);
  });
});
