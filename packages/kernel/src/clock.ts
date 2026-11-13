/** Business dates are calendar dates in this zone; instants are stored in UTC (shared brief). */
export const BUSINESS_TIME_ZONE = 'Africa/Accra';

/**
 * The only source of the current time. Domain and application code take a Clock and never call
 * `new Date()` or `Date.now()`, so tests control time (ENGINEERING_STANDARDS section 8).
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock that moves only when told to: for tests, replays and simulations. */
export class ManualClock implements Clock {
  private current: number;

  constructor(start: Date) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advanceBy(milliseconds: number): void {
    this.current += milliseconds;
  }

  set(instant: Date): void {
    this.current = instant.getTime();
  }
}

const businessDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The calendar date of an instant in Africa/Accra, as `YYYY-MM-DD`. */
export function toBusinessDate(instant: Date): string {
  return businessDateFormat.format(instant);
}
