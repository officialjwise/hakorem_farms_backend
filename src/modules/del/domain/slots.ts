import { err, ok, type Result } from '@hakorem/kernel';

/** The most days one generation covers: a quarter, so a typo in a year cannot write thousands of slots. */
export const MAX_GENERATION_DAYS = 92;
/** The most time windows one day of a zone has. */
export const MAX_SLOT_TIMES = 12;
/** The largest capacity a slot may have (migration 0118). */
export const MAX_SLOT_CAPACITY = 1_000;

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export interface SlotTime {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly capacity: number;
}

export interface SlotGeneration {
  readonly from: string;
  readonly to: string;
  /** ISO weekdays: 1 is Monday, 7 is Sunday. */
  readonly weekdays: readonly number[];
  readonly times: readonly SlotTime[];
}

export interface PlannedSlot {
  readonly slotDate: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly capacity: number;
}

export interface SlotRule {
  readonly field: string;
  readonly rule: string;
}

function dayNumber(date: string): number | null {
  if (!DATE.test(date)) return null;
  const at = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== date) return null;
  return at / MS_PER_DAY;
}

function isoWeekday(day: number): number {
  const sunday0 = new Date(day * MS_PER_DAY).getUTCDay();
  return sunday0 === 0 ? 7 : sunday0;
}

/**
 * The slots a generation asks for (FR-DEL-001 without its capacity rule, ADR-0026): every date from `from` to `to`
 * inclusive whose weekday is listed, once per time window. The range starts today or later and spans at most
 * `MAX_GENERATION_DAYS`; weekdays are 1 to 7 without repeats; windows end after they start, never overlap and have a
 * capacity from 1 to `MAX_SLOT_CAPACITY`. A slot that already exists is the database's to skip.
 */
export function planSlots(request: SlotGeneration, today: string): Result<PlannedSlot[], SlotRule[]> {
  const rules: SlotRule[] = [];
  const from = dayNumber(request.from);
  const to = dayNumber(request.to);
  const first = dayNumber(today)!;
  if (from === null) rules.push({ field: '/from', rule: 'INVALID_DATE' });
  if (to === null) rules.push({ field: '/to', rule: 'INVALID_DATE' });
  if (from !== null && from < first) rules.push({ field: '/from', rule: 'IN_THE_PAST' });
  if (from !== null && to !== null && to < from) rules.push({ field: '/to', rule: 'BEFORE_FROM' });
  if (from !== null && to !== null && to - from + 1 > MAX_GENERATION_DAYS) rules.push({ field: '/to', rule: 'RANGE_TOO_LONG' });
  if (request.weekdays.length === 0) rules.push({ field: '/weekdays', rule: 'REQUIRED' });
  request.weekdays.forEach((day, index) => {
    if (!Number.isInteger(day) || day < 1 || day > 7) rules.push({ field: `/weekdays/${index}`, rule: 'NOT_A_WEEKDAY' });
    else if (request.weekdays.indexOf(day) !== index) rules.push({ field: `/weekdays/${index}`, rule: 'DUPLICATE' });
  });
  if (request.times.length === 0) rules.push({ field: '/times', rule: 'REQUIRED' });
  if (request.times.length > MAX_SLOT_TIMES) rules.push({ field: '/times', rule: 'TOO_MANY' });
  request.times.forEach((time, index) => {
    if (!TIME.test(time.startsAt)) rules.push({ field: `/times/${index}/startsAt`, rule: 'INVALID_TIME' });
    if (!TIME.test(time.endsAt)) rules.push({ field: `/times/${index}/endsAt`, rule: 'INVALID_TIME' });
    else if (TIME.test(time.startsAt) && time.endsAt <= time.startsAt) rules.push({ field: `/times/${index}/endsAt`, rule: 'NOT_AFTER_START' });
    if (!Number.isInteger(time.capacity) || time.capacity < 1 || time.capacity > MAX_SLOT_CAPACITY) rules.push({ field: `/times/${index}/capacity`, rule: 'OUT_OF_RANGE' });
    const overlaps = request.times.some((other, j) => j < index && other.startsAt < time.endsAt && time.startsAt < other.endsAt);
    if (overlaps) rules.push({ field: `/times/${index}`, rule: 'OVERLAPS' });
  });
  if (rules.length > 0 || from === null || to === null) return err(rules);

  const wanted = new Set(request.weekdays);
  const times = [...request.times].sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
  const slots: PlannedSlot[] = [];
  for (let day = from; day <= to; day += 1) {
    if (!wanted.has(isoWeekday(day))) continue;
    const slotDate = new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
    for (const time of times) slots.push({ slotDate, startsAt: time.startsAt, endsAt: time.endsAt, capacity: time.capacity });
  }
  return ok(slots);
}

/**
 * A slot's new capacity (FR-DEL-001): from 1 to `MAX_SLOT_CAPACITY`, and never below what is already booked. The
 * database holds the same rule (`ck_delivery_slot_booked`), whoever writes.
 */
export function judgeCapacity(capacity: number, booked: number): 'OUT_OF_RANGE' | 'BELOW_BOOKED' | null {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_SLOT_CAPACITY) return 'OUT_OF_RANGE';
  return capacity < booked ? 'BELOW_BOOKED' : null;
}

/** What is still free in a slot; B11 books against it (SA-13). */
export function remaining(slot: { readonly capacity: number; readonly booked: number }): number {
  return Math.max(slot.capacity - slot.booked, 0);
}
