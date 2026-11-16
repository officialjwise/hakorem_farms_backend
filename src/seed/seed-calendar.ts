import type { INestApplicationContext } from '@nestjs/common';
import { toBusinessDate, type Clock } from '@hakorem/kernel';
import { CLOCK } from '../platform/platform.module';

const MS_PER_DAY = 86_400_000;

/**
 * Every date the seeded farm carries, built from the seed's clock (B09t2, ADR-0067's second rule, A-220): the seed
 * runs "today" at whatever date its clock says, and its history sits the same number of days before it, so no seeded
 * expiry, best-before or valid-to date is ever passed by real time and no test that reads one breaks on a calendar
 * day. Africa/Accra is UTC all year (no daylight saving), so a business date at a UTC time of day is that Accra time.
 *
 * The offsets keep the farm the B5 to B09 sessions seeded on 2026-11-16: prices and tax from fifteen days before,
 * at 06:00; the stock delivered six days before, a morning delivery at 07:00, weighed and logged in the cold room an
 * hour later; eggs good for 21 days from delivery and the frozen meat for 90; the welcome offer for 135 days and the
 * Christmas meat offer for 51, each to the last second of its day.
 */
export interface SeedCalendar {
  /** The seed's business date: when the billing documents, the requisition and the delivery slots are dated. */
  readonly today: string;
  /** When the seeded price lists, the tax scheme, the caterer's contract list and the promotions take effect. */
  readonly pricesFrom: Date;
  /** When the seeded stock arrived at Dodowa. */
  readonly stockReceivedAt: Date;
  /** The stock's business date: the seeded day the receipts post on. */
  readonly stockReceivedOn: string;
  /** When the seeded animals were first weighed, an hour after they came off the lorry. */
  readonly weighedAt: Date;
  /** The two cold room readings after the delivery. */
  readonly coldRoomReadings: readonly [Date, Date];
  /** The egg lot's expiry (EGG-BIG-2026-1110). */
  readonly eggsExpireOn: string;
  /** The beef and goat meat lots' expiry (LOT-BEEF-2026-1110, LOT-GOAT-0001). */
  readonly meatExpiresOn: string;
  /** The end of WELCOME10. */
  readonly welcomeOfferEnds: Date;
  /** The end of XMAS-MEAT-5. */
  readonly christmasOfferEnds: Date;
}

/** The business date `days` after `date` (before it when negative). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

const at = (date: string, time: string): Date => new Date(`${date}T${time}Z`);

/** The seeded farm's calendar for a seed run whose clock reads `now`. */
export function seedCalendar(now: Date): SeedCalendar {
  const today = toBusinessDate(now);
  const stockReceivedOn = addDays(today, -6);
  return {
    today,
    pricesFrom: at(addDays(today, -15), '06:00:00'),
    stockReceivedAt: at(stockReceivedOn, '07:00:00'),
    stockReceivedOn,
    weighedAt: at(stockReceivedOn, '08:00:00'),
    coldRoomReadings: [at(stockReceivedOn, '08:00:00'), at(stockReceivedOn, '12:00:00')],
    eggsExpireOn: addDays(stockReceivedOn, 21),
    meatExpiresOn: addDays(stockReceivedOn, 90),
    welcomeOfferEnds: at(addDays(today, 135), '23:59:59'),
    christmasOfferEnds: at(addDays(today, 51), '23:59:59'),
  };
}

/**
 * One calendar for one seed run: the first unit that asks reads the application's clock, and every later unit gets
 * the same dates, so a run that crosses midnight on a real clock still seeds one coherent farm.
 */
export function seedRunCalendar(): (app: INestApplicationContext) => SeedCalendar {
  let calendar: SeedCalendar | undefined;
  return (app) => (calendar ??= seedCalendar(app.get<Clock>(CLOCK).now()));
}
