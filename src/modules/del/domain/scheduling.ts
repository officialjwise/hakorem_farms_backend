import type { DeliveryStatus } from './deliveries';

/**
 * Assignment, reassignment and slot booking (FR-DEL-001 to FR-DEL-004, FR-DEL-011; A-362). A delivery is made at
 * dispatch with its goods loaded on the van, so it is reassigned or rescheduled only while those goods wait on the van
 * (ASSIGNED) or came back from a failed attempt (FAILED); one on its way is the driver's, one finished is frozen.
 */
export interface SchedulingRule {
  readonly field: string;
  readonly rule: string;
}

const MOVABLE: ReadonlySet<DeliveryStatus> = new Set(['ASSIGNED', 'FAILED']);
const state = (): SchedulingRule[] => [{ field: '', rule: 'INVALID_STATE_TRANSITION' }];

export interface ReassignmentFacts {
  readonly status: DeliveryStatus;
  /** The delivery is a stop of a run that is PLANNED or IN_PROGRESS: it keeps its driver and vehicle (`ck_delivery_route`). */
  readonly onLiveRun: boolean;
  readonly sameDriver: boolean;
  readonly sameVehicle: boolean;
}

/** A reassignment moves a delivery waiting on the van or failed, on no live run, to another driver or vehicle (or both). */
export function judgeReassignment(f: ReassignmentFacts): SchedulingRule[] {
  if (!MOVABLE.has(f.status)) return state();
  if (f.onLiveRun) return [{ field: '', rule: 'ON_A_RUN' }];
  if (f.sameDriver && f.sameVehicle) return [{ field: '/driverId', rule: 'UNCHANGED' }];
  return [];
}

/** A slot as the booking reads it, under its row lock. */
export interface BookedSlot {
  readonly deliveryZoneId: string;
  /** Africa/Accra calendar date. */
  readonly slotDate: string;
  /** Africa/Accra time of day, HH:MM. */
  readonly startsAt: string;
  readonly capacity: number;
  readonly booked: number;
}

export interface BookingFacts {
  readonly status: DeliveryStatus;
  readonly deliveryZoneId: string;
  readonly currentSlotId: string | null;
  readonly slotId: string;
  readonly slot: BookedSlot | 'MISSING';
  /** The zone's cut-off, HH:MM in Africa/Accra (FR-DEL-002). */
  readonly cutoffTime: string;
  /** The date of the live run the delivery is a stop of; null when it is on none. */
  readonly runDate: string | null;
  readonly now: Date;
}

const MS_PER_MINUTE = 60_000;

/** Minutes and seconds since midnight in Africa/Accra (UTC+0 all year, A-028). */
const secondsOfDay = (at: Date) => at.getUTCHours() * 3600 + at.getUTCMinutes() * 60 + at.getUTCSeconds() + at.getUTCMilliseconds() / 1000;
const secondsOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 3600 + Number(hhmm.slice(3, 5)) * 60;

/**
 * A booking names a slot of the delivery's own zone that has not started, with room in it (never more bookings than its
 * capacity; the database refuses the same, `ck_delivery_slot_booked`). Today's slots are offered only up to the zone's
 * cut-off: after it the earliest is tomorrow's (FR-DEL-002, in Africa/Accra). A delivery on a live run keeps its stop and
 * its van, so its slot falls on its run's day. Rebooking the same slot changes nothing and is refused, except for a
 * reattempt of a failed delivery, which keeps the booking it holds (no second unit taken). A state refusal is alone.
 */
export function judgeBooking(f: BookingFacts): SchedulingRule[] {
  if (!MOVABLE.has(f.status)) return state();
  if (f.slot === 'MISSING') return [{ field: '/slotId', rule: 'SLOT_UNKNOWN' }];
  const same = f.currentSlotId === f.slotId;
  if (same && f.status === 'ASSIGNED') return [{ field: '/slotId', rule: 'SAME_SLOT' }];
  const broken: SchedulingRule[] = [];
  if (f.slot.deliveryZoneId !== f.deliveryZoneId) broken.push({ field: '/slotId', rule: 'SLOT_OTHER_ZONE' });
  const startsAt = Date.parse(`${f.slot.slotDate}T${f.slot.startsAt}:00.000Z`);
  const today = f.now.toISOString().slice(0, 10);
  if (startsAt <= Math.floor(f.now.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE) broken.push({ field: '/slotId', rule: 'SLOT_STARTED' });
  else if (f.slot.slotDate === today && secondsOfDay(f.now) > secondsOf(f.cutoffTime)) broken.push({ field: '/slotId', rule: 'PAST_CUT_OFF' });
  if (f.runDate !== null && f.slot.slotDate !== f.runDate) broken.push({ field: '/slotId', rule: 'NOT_ON_RUN_DAY' });
  if (!same && f.slot.booked >= f.slot.capacity) broken.push({ field: '/slotId', rule: 'SLOT_FULL' });
  return broken;
}
