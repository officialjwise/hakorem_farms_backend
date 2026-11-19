/**
 * A standing order's schedule (FR-WHL-004, A-320): weekly on named days, fortnightly on named days, monthly on a day
 * of the month, or every n days from its start, between a start and an optional end. Business dates only
 * (`YYYY-MM-DD`, Africa/Accra); days, never amounts.
 */
export type Frequency = 'WEEKLY' | 'FORTNIGHTLY' | 'MONTHLY' | 'EVERY_N_DAYS';
export const FREQUENCIES: readonly Frequency[] = ['WEEKLY', 'FORTNIGHTLY', 'MONTHLY', 'EVERY_N_DAYS'];

export interface Schedule {
  readonly frequency: Frequency;
  /** ISO weekdays, 1 is Monday and 7 Sunday: WEEKLY and FORTNIGHTLY only. */
  readonly weekdays: readonly number[];
  /** 1 to 28, so every month has it: MONTHLY only. */
  readonly dayOfMonth: number | null;
  /** 1 to 365: EVERY_N_DAYS only. */
  readonly intervalDays: number | null;
  readonly startsOn: string;
  readonly endsOn: string | null;
}

export interface ScheduleRule {
  readonly field: string;
  readonly rule: string;
}

const DAY_MS = 86_400_000;
const MAX_DAY_OF_MONTH = 28;
const MAX_INTERVAL_DAYS = 365;
/** No schedule this module accepts goes longer than this between two occurrences (a fortnight's last weekday to the next is 13 days; a month 31). */
const SEARCH_DAYS = 400;

const dayNumber = (date: string): number => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
const dateOf = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);
/** ISO weekday of a day number: day 0 (1970-01-01) was a Thursday. */
const weekdayOf = (day: number): number => ((((day + 3) % 7) + 7) % 7) + 1;
const mondayOf = (day: number): number => day - (weekdayOf(day) - 1);

/** Whether the schedule makes an order on a date. */
export function occursOn(s: Schedule, date: string): boolean {
  if (date < s.startsOn || (s.endsOn !== null && date > s.endsOn)) return false;
  const day = dayNumber(date);
  switch (s.frequency) {
    case 'WEEKLY':
      return s.weekdays.includes(weekdayOf(day));
    case 'FORTNIGHTLY':
      return s.weekdays.includes(weekdayOf(day)) && ((mondayOf(day) - mondayOf(dayNumber(s.startsOn))) / 7) % 2 === 0;
    case 'MONTHLY':
      return Number(date.slice(8, 10)) === s.dayOfMonth;
    case 'EVERY_N_DAYS':
      return s.intervalDays !== null && (day - dayNumber(s.startsOn)) % s.intervalDays === 0;
  }
}

/** The first date on or after `from` the schedule makes an order on, or null when there is none (it has ended). */
export function nextOccurrence(s: Schedule, from: string): string | null {
  const first = dayNumber(from < s.startsOn ? s.startsOn : from);
  for (let day = first; day < first + SEARCH_DAYS; day += 1) {
    const date = dateOf(day);
    if (s.endsOn !== null && date > s.endsOn) return null;
    if (occursOn(s, date)) return date;
  }
  return null;
}

/** Every date from `from` to `to`, both included, the schedule makes an order on, in order. */
export function occurrencesBetween(s: Schedule, from: string, to: string): string[] {
  const dates: string[] = [];
  for (let day = dayNumber(from); day <= dayNumber(to); day += 1) {
    const date = dateOf(day);
    if (occursOn(s, date)) dates.push(date);
  }
  return dates;
}

/** What makes a schedule unusable, each field named: a frequency takes only its own fields, and it ends on or after it starts. */
export function judgeSchedule(s: Schedule): ScheduleRule[] {
  const broken: ScheduleRule[] = [];
  const byWeekday = s.frequency === 'WEEKLY' || s.frequency === 'FORTNIGHTLY';
  if (byWeekday) {
    if (s.weekdays.length === 0) broken.push({ field: '/weekdays', rule: 'WEEKDAYS_REQUIRED' });
    else if (s.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) broken.push({ field: '/weekdays', rule: 'WEEKDAY_OUT_OF_RANGE' });
    else if (new Set(s.weekdays).size !== s.weekdays.length) broken.push({ field: '/weekdays', rule: 'WEEKDAY_REPEATED' });
  } else if (s.weekdays.length > 0) broken.push({ field: '/weekdays', rule: 'NOT_FOR_FREQUENCY' });

  if (s.frequency === 'MONTHLY') {
    if (s.dayOfMonth === null) broken.push({ field: '/dayOfMonth', rule: 'DAY_OF_MONTH_REQUIRED' });
    else if (!Number.isInteger(s.dayOfMonth) || s.dayOfMonth < 1 || s.dayOfMonth > MAX_DAY_OF_MONTH) broken.push({ field: '/dayOfMonth', rule: 'DAY_OF_MONTH_OUT_OF_RANGE' });
  } else if (s.dayOfMonth !== null) broken.push({ field: '/dayOfMonth', rule: 'NOT_FOR_FREQUENCY' });

  if (s.frequency === 'EVERY_N_DAYS') {
    if (s.intervalDays === null) broken.push({ field: '/intervalDays', rule: 'INTERVAL_REQUIRED' });
    else if (!Number.isInteger(s.intervalDays) || s.intervalDays < 1 || s.intervalDays > MAX_INTERVAL_DAYS) broken.push({ field: '/intervalDays', rule: 'INTERVAL_OUT_OF_RANGE' });
  } else if (s.intervalDays !== null) broken.push({ field: '/intervalDays', rule: 'NOT_FOR_FREQUENCY' });

  if (s.endsOn !== null && s.endsOn < s.startsOn) broken.push({ field: '/endsOn', rule: 'ENDS_BEFORE_START' });
  return broken;
}
