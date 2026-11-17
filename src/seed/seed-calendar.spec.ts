import { ManualClock } from '@hakorem/kernel';
import type { INestApplicationContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CLOCK } from '../platform/platform.module';
import { addDays, seedCalendar, seedRunCalendar } from './seed-calendar';

describe('the seeded farm’s calendar is built from the seed’s clock (B09t2, ADR-0067)', () => {
  it('keeps the farm the earlier sessions seeded on 16 November 2026, to the second', () => {
    expect(seedCalendar(new Date('2026-11-16T22:30:00Z'))).toEqual({
      today: '2026-11-16',
      pricesFrom: new Date('2026-11-01T06:00:00Z'),
      stockReceivedAt: new Date('2026-11-10T07:00:00Z'),
      stockReceivedOn: '2026-11-10',
      weighedAt: new Date('2026-11-10T08:00:00Z'),
      coldRoomReadings: [new Date('2026-11-10T08:00:00Z'), new Date('2026-11-10T12:00:00Z')],
      eggsExpireOn: '2026-12-01',
      meatExpiresOn: '2027-02-08',
      welcomeOfferEnds: new Date('2027-03-31T23:59:59Z'),
      christmasOfferEnds: new Date('2027-01-06T23:59:59Z'),
    });
  });

  it('moves every date with the clock, across a year end and a leap day, so none is ever behind the seed', () => {
    const calendar = seedCalendar(new Date('2028-03-01T00:00:00Z'));
    expect(calendar).toMatchObject({ today: '2028-03-01', stockReceivedOn: '2028-02-24', eggsExpireOn: '2028-03-16', meatExpiresOn: '2028-05-24' });
    expect(calendar.pricesFrom).toEqual(new Date('2028-02-15T06:00:00Z'));
    const newYear = seedCalendar(new Date('2026-12-31T23:59:59Z'));
    expect([newYear.today, newYear.stockReceivedOn, newYear.eggsExpireOn]).toEqual(['2026-12-31', '2026-12-25', '2027-01-15']);
    for (const c of [calendar, newYear]) {
      expect(c.eggsExpireOn > c.today && c.meatExpiresOn > c.eggsExpireOn).toBe(true);
      expect(c.welcomeOfferEnds.getTime()).toBeGreaterThan(c.christmasOfferEnds.getTime());
      expect(c.pricesFrom.getTime()).toBeLessThan(c.stockReceivedAt.getTime());
    }
  });

  it('counts days on the calendar, either way, across month and year ends', () => {
    expect([addDays('2026-11-30', 1), addDays('2027-01-01', -1), addDays('2028-02-28', 1), addDays('2026-11-16', 0)]).toEqual(['2026-12-01', '2026-12-31', '2028-02-29', '2026-11-16']);
  });

  it('reads the clock once per seed run, so a run across midnight seeds one coherent farm', () => {
    const clock = new ManualClock(new Date('2026-12-31T23:59:59Z'));
    const app = { get: (token: unknown) => (token === CLOCK ? clock : undefined) } as unknown as INestApplicationContext;
    const calendarOf = seedRunCalendar();
    const first = calendarOf(app);
    clock.advanceBy(2_000);
    expect(calendarOf(app)).toBe(first);
    expect(first.today).toBe('2026-12-31');
    expect(seedRunCalendar()(app).today, 'a new run reads the clock again').toBe('2027-01-01');
  });
});
