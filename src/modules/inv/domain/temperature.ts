/**
 * Cold chain readings (FR-INV-007, FR-INV-008). A reading is judged against the permitted range of its location, a
 * cold room or a vehicle, which master data holds; the bounds themselves are in range. Temperatures are compared in
 * whole tenths of a degree, never as floating point numbers.
 */
export interface TemperatureRange {
  /** The lowest permitted reading, one decimal place, as master data stores it. */
  readonly minC: string;
  readonly maxC: string;
}

export interface ReadingRuleBroken {
  readonly field: string;
  readonly rule: string;
}

/** How far ahead of the server's clock a reading may be dated: a phone or a sensor whose clock runs a little fast. */
const READING_CLOCK_SKEW_MS = 5 * 60_000;
const CELSIUS = /^(-?)(\d{1,3})(?:\.(\d))?$/;

/** A temperature in tenths of a degree: `-18.5` is -185, `4` is 40. */
export function tenths(celsius: string): bigint {
  const match = CELSIUS.exec(celsius.trim());
  if (match === null) throw new Error(`not a temperature: ${celsius}`);
  const magnitude = BigInt(match[2]!) * 10n + BigInt(match[3] ?? '0');
  return match[1] === '-' ? -magnitude : magnitude;
}

/** Outside the range: below its minimum or above its maximum. */
export function isExcursion(readingC: string, range: TemperatureRange): boolean {
  const value = tenths(readingC);
  return value < tenths(range.minC) || value > tenths(range.maxC);
}

/** What a reading needs before it is recorded: a location that has a permitted range, and a time that has happened. */
export function checkReading(input: { readonly range: TemperatureRange | null; readonly measuredAt: Date; readonly now: Date }): ReadingRuleBroken[] {
  const broken: ReadingRuleBroken[] = [];
  if (input.range === null) broken.push({ field: '/locationId', rule: 'NO_TEMPERATURE_RANGE' });
  if (input.measuredAt.getTime() > input.now.getTime() + READING_CLOCK_SKEW_MS) broken.push({ field: '/measuredAt', rule: 'IN_THE_FUTURE' });
  return broken;
}

/**
 * When an excursion's quarantine starts: when the reading was taken, so a sale recorded later from an offline queue
 * for a time after it is refused too, and never later than now.
 */
export function quarantineStart(measuredAt: Date, now: Date): Date {
  return measuredAt.getTime() < now.getTime() ? measuredAt : now;
}

/** The note an excursion's quarantine hold and exception carry. */
export function excursionNote(readingC: string, range: TemperatureRange, locationCode: string): string {
  return `Temperature excursion: ${readingC} °C at ${locationCode}, outside ${range.minC} to ${range.maxC} °C`;
}
