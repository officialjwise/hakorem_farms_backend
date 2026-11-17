import { err, ok, type Result } from '@hakorem/kernel';

/**
 * The business profile (FR-AUD-008): what the farm prints on its documents and what the shop shows anyone. Held as one
 * effective-dated `platform.setting` row under its own key, written only through AUD's audited administration. Pure.
 */
export const BUSINESS_PROFILE_KEY = 'aud.business_profile';
export const BUSINESS_PROFILE_DESCRIPTION = "The business profile printed on documents, and the shop's public contact details (FR-AUD-008, CR-028)";

export const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** One opening of one day, in Africa/Accra wall-clock time (`HH:MM`, 24 hours); a day with none is closed. */
export interface OpeningInterval {
  readonly day: Weekday;
  readonly opens: string;
  readonly closes: string;
}

/** The contract's `BusinessProfile` without its row fields (`version`, `updatedAt`). Each phone is E.164. */
export interface BusinessProfileValue {
  readonly legalName: string;
  readonly tradingName: string;
  readonly tin: string | null;
  readonly vatNumber: string | null;
  readonly address: string;
  readonly phone: string;
  readonly whatsapp: string | null;
  readonly email: string;
  readonly logoFileId: string | null;
  readonly directions: string | null;
  readonly openingHours: readonly OpeningInterval[];
}

/** The contract's `ShopProfile` (CR-028): the only part of the profile anyone may read without signing in. */
export interface ShopProfileValue {
  readonly tradingName: string;
  readonly phone: string;
  readonly whatsapp: string | null;
  readonly address: string;
  readonly directions: string | null;
  readonly openingHours: readonly OpeningInterval[];
}

/** The keys of the shop's shape, in its order. A field added to the profile is not shown to the shop unless named here. */
export const SHOP_PROFILE_KEYS = ['tradingName', 'phone', 'whatsapp', 'address', 'directions', 'openingHours'] as const satisfies readonly (keyof ShopProfileValue)[];

export interface HoursRefusal {
  readonly field: string;
  readonly code: 'CLOSES_BEFORE_OPENS' | 'HOURS_OVERLAP';
}

const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * Opening hours as stored: each interval closes after it opens, two intervals of one day never overlap (they may
 * meet), and the list is put in week order, each day by the time it opens. A refusal names the interval as sent.
 */
export function judgeOpeningHours(hours: readonly OpeningInterval[]): Result<OpeningInterval[], HoursRefusal> {
  for (const [index, interval] of hours.entries()) {
    if (minutes(interval.closes) <= minutes(interval.opens)) return err({ field: `/openingHours/${index}/closes`, code: 'CLOSES_BEFORE_OPENS' });
  }
  for (const [index, interval] of hours.entries()) {
    const clash = hours
      .slice(0, index)
      .some((earlier) => earlier.day === interval.day && minutes(earlier.opens) < minutes(interval.closes) && minutes(interval.opens) < minutes(earlier.closes));
    if (clash) return err({ field: `/openingHours/${index}`, code: 'HOURS_OVERLAP' });
  }
  const sorted = hours
    .map((interval) => ({ day: interval.day, opens: interval.opens, closes: interval.closes }))
    .sort((a, b) => WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day) || minutes(a.opens) - minutes(b.opens));
  return ok(sorted);
}

/** The shop's view of a profile: the named keys and nothing else, copied so it shares nothing with the profile. */
export function shopProfileOf(profile: BusinessProfileValue): ShopProfileValue {
  return {
    tradingName: profile.tradingName,
    phone: profile.phone,
    whatsapp: profile.whatsapp,
    address: profile.address,
    directions: profile.directions,
    openingHours: profile.openingHours.map((interval) => ({ day: interval.day, opens: interval.opens, closes: interval.closes })),
  };
}
