import { halfUpDivide, Quantity, Weight } from '@hakorem/kernel';

/** One weighing of an animal or a flock: kilograms per head (a flock's sample average), on a business date. */
export interface GrowthWeighing {
  readonly at: Date;
  /** The calendar date in Africa/Accra the weighing was taken on. */
  readonly day: string;
  readonly kg: string;
}

/** An animal or flock in a group for the whole window, with its head and its weighings inside the window. */
export interface GrowthMember {
  readonly head: bigint;
  readonly weighings: readonly GrowthWeighing[];
}

/** One animal's gain over the window: its first and last weighing on different days, in grams per head. */
export interface MemberGain {
  readonly firstGrams: bigint;
  readonly lastGrams: bigint;
  readonly days: bigint;
}

/** The figures of one pen or batch over a window (FR-LIV-005, FR-LIV-016, SA-21). */
export interface GroupGrowth {
  readonly head: bigint;
  readonly startAverageKg: string | null;
  readonly endAverageKg: string | null;
  readonly averageDailyGainKg: string | null;
  /** Kilograms gained by the weighed head, the denominator of feed conversion; null with nobody weighed twice. */
  readonly gainKg: string | null;
  readonly feedConversionRatio: string | null;
  readonly mortalityPercent: string;
}

const MS_PER_DAY = 86_400_000;
/** Feed conversion is stated to three places (FR-LIV-016): thousandths of a kilogram of feed per kilogram gained. */
const RATIO_SCALE = 1_000n;
/** A percentage to two places, as hundredths of a percent. */
const PERCENT_HUNDREDTHS = 10_000n;

/** Whole calendar days from one business date to another (`YYYY-MM-DD`), as the SRS counts the days between weights. */
export function daysBetween(from: string, to: string): bigint {
  return BigInt(Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY));
}

/**
 * An animal's gain over the window (FR-LIV-005): its last weight minus its first, over the calendar days between them.
 * Null when it was not weighed on two different days inside the window, so no gain can be stated.
 */
export function gainOf(weighings: readonly GrowthWeighing[]): MemberGain | null {
  if (weighings.length < 2) return null;
  const ordered = [...weighings].sort((a, b) => a.at.getTime() - b.at.getTime());
  const first = ordered[0]!;
  const last = ordered.at(-1)!;
  const days = daysBetween(first.day, last.day);
  if (days <= 0n) return null;
  return { firstGrams: Weight.parseKg(first.kg).grams, lastGrams: Weight.parseKg(last.kg).grams, days };
}

/** Kilograms to three places from a non-negative ratio of grams, rounded half-up once. */
function kgOf(numeratorGrams: bigint, denominator: bigint): string {
  return Weight.ofGrams(halfUpDivide(numeratorGrams, denominator)).toKgString();
}

/** A percentage to two places, half-up once: `part` of `whole`; nothing out of nothing is 0.00. */
export function percentOf(part: bigint, whole: bigint): string {
  if (whole <= 0n) return '0.00';
  const hundredths = halfUpDivide(part * PERCENT_HUNDREDTHS, whole);
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}

/**
 * Feed conversion (FR-LIV-016): kilograms of feed issued over kilograms gained, to three places, half-up once. Null
 * when nothing was gained (or weight was lost), since no ratio of feed to gain exists then.
 */
export function feedConversion(feedQty: string, gainGrams: bigint): string | null {
  if (gainGrams <= 0n) return null;
  // Both are thousandths of a kilogram, so their ratio is the ratio of the two kilogram figures.
  return Quantity.ofThousandths(halfUpDivide(Quantity.parse(feedQty).thousandths * RATIO_SCALE, gainGrams)).toDecimalString();
}

/**
 * A pen's or batch's growth over a window (FR-LIV-005, FR-LIV-016, A-159), from the members present for the whole
 * window only. The averages are per head, each member weighted by its head (one for an animal, the flock's head for
 * a flock), over the members weighed on two days; average daily gain is the head's total gain over their total days
 * between weighings, so two goats of 18.000 to 24.600 kg over 30 days give 0.220 kg. A loss of weight has no
 * non-negative gain to show, so the gain, the daily gain and the conversion are then null. Mortality is the deaths
 * in the window over the head at its start. Each figure is rounded half-up once, from exact integers.
 */
export function groupGrowth(members: readonly GrowthMember[], feedQty: string | null, deaths: bigint, headAtStart: bigint): GroupGrowth {
  const head = members.reduce((sum, m) => sum + m.head, 0n);
  let weighedHead = 0n;
  let firstTotal = 0n;
  let lastTotal = 0n;
  let headDays = 0n;
  for (const member of members) {
    const gain = gainOf(member.weighings);
    if (gain === null) continue;
    weighedHead += member.head;
    firstTotal += member.head * gain.firstGrams;
    lastTotal += member.head * gain.lastGrams;
    headDays += member.head * gain.days;
  }
  const mortalityPercent = percentOf(deaths, headAtStart);
  if (weighedHead === 0n) {
    return { head, startAverageKg: null, endAverageKg: null, averageDailyGainKg: null, gainKg: null, feedConversionRatio: null, mortalityPercent };
  }
  const gainGrams = lastTotal - firstTotal;
  const gained = gainGrams >= 0n;
  return {
    head,
    startAverageKg: kgOf(firstTotal, weighedHead),
    endAverageKg: kgOf(lastTotal, weighedHead),
    averageDailyGainKg: gained ? kgOf(gainGrams, headDays) : null,
    gainKg: gained ? Weight.ofGrams(gainGrams).toKgString() : null,
    feedConversionRatio: feedQty === null ? null : feedConversion(feedQty, gainGrams),
    mortalityPercent,
  };
}

/** One animal's average daily gain, as its timeline states it: null without two weighings on different days. */
export function averageDailyGain(weighings: readonly GrowthWeighing[]): string | null {
  const gain = gainOf(weighings);
  if (gain === null || gain.lastGrams < gain.firstGrams) return null;
  return kgOf(gain.lastGrams - gain.firstGrams, gain.days);
}

function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b);
}

/**
 * A group's share of the feed issued over a window (FR-LIV-016): each issue's quantity times the group's head-days in
 * it over all the head-days it was spread over, summed exactly as a fraction and rounded half-up once, to the gram. A
 * pen fed alone takes the whole of every issue.
 */
export function feedShare(issues: ReadonlyArray<{ readonly qty: string; readonly share: bigint; readonly total: bigint }>): string {
  let numerator = 0n;
  let denominator = 1n;
  for (const issue of issues) {
    numerator = numerator * issue.total + Quantity.parse(issue.qty).thousandths * issue.share * denominator;
    denominator *= issue.total;
    const common = gcd(numerator, denominator);
    numerator /= common;
    denominator /= common;
  }
  return Quantity.ofThousandths(halfUpDivide(numerator, denominator)).toDecimalString();
}
