import { BUSINESS_TIME_ZONE, err, ok, type Result } from '@hakorem/kernel';
import type { Category, Channel } from './templates';

/**
 * Who may be sent what, by which channel, and when (FR-NTF-004 to FR-NTF-006, B11 continued 11, ADR-0097, A-376). Pure:
 * the facts (the trigger, the recipient's preferences, the opt-outs on the number, the adapters there are, the instant)
 * are read by the application and passed in.
 */

/**
 * An opt-out or a preference turned off reaches reminders and marketing only (FR-NTF-005): a transactional message the
 * law or the owner requires (a receipt, a dispatch, a delivery) and an operational one to staff are never suppressed by
 * them (A-376 (a)).
 */
export function suppressibleByOptOut(category: Category): boolean {
  return category === 'REMINDER' || category === 'MARKETING';
}

/**
 * Quiet hours delay reminders and marketing (FR-NTF-006); transactional and operational messages, among them every
 * delivery-day message and security code (SA-09, A-374 (e)), go at once (A-376 (b)).
 */
export function quietHoursApply(category: Category): boolean {
  return category === 'REMINDER' || category === 'MARKETING';
}

/** SA-09: quiet hours are 21:00 to 07:00 Africa/Accra unless the recipient set their own. */
export const DEFAULT_QUIET_HOURS = { from: '21:00', to: '07:00' } as const;
export interface QuietHours {
  readonly from: string;
  readonly to: string;
}

const MINUTES_IN_DAY = 1_440;
const accraClock = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** The minute of the day an instant falls on in Africa/Accra (00:00 is 0, 23:59 is 1439). */
export function localMinuteOfDay(instant: Date): number {
  const parts = accraClock.formatToParts(instant);
  const value = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return value('hour') * 60 + value('minute');
}

function minuteOf(time: string): number {
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/**
 * When a message due now may go, if now is inside the quiet hours (the recipient's own, else 21:00 to 07:00): the end
 * of the window, on the minute, in Africa/Accra; null when it may go now. The window includes its start and excludes
 * its end, and may cross midnight. Accra keeps UTC all year, so whole minutes added to the instant land on the hour asked.
 */
export function quietUntil(now: Date, own: QuietHours | null): Date | null {
  const window = own ?? DEFAULT_QUIET_HOURS;
  const from = minuteOf(window.from);
  const to = minuteOf(window.to);
  const minute = localMinuteOfDay(now);
  const inside = from < to ? minute >= from && minute < to : minute >= from || minute < to;
  if (!inside) return null;
  const wait = (to - minute + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const onTheMinute = Math.floor(now.getTime() / 60_000) * 60_000;
  return new Date(onTheMinute + wait * 60_000);
}

/** A recipient's reply as an instruction: the usual SMS keywords, the first word only, in any case (FR-NTF-005). */
const OPT_OUT_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const OPT_IN_WORDS = new Set(['START', 'UNSTOP']);
export type ReplyInstruction = 'OPT_OUT' | 'OPT_IN';

export function readReply(text: string): ReplyInstruction | null {
  const first = text.trim().split(/\s+/)[0]!.toUpperCase();
  if (OPT_OUT_WORDS.has(first)) return 'OPT_OUT';
  if (OPT_IN_WORDS.has(first)) return 'OPT_IN';
  return null;
}

/** One of the recipient's preferences for the message's category, in the order the recipient set them. */
export interface ChannelPreference {
  readonly channel: Channel;
  readonly isEnabled: boolean;
}

export interface RouteFacts {
  readonly category: Category;
  /** The trigger's channels, in its order (FR-NTF-002). */
  readonly triggerChannels: readonly Channel[];
  /** The recipient's preferences for this category, in their order; none means every channel is accepted. */
  readonly preferences: readonly ChannelPreference[];
  /** The channels the recipient's own address has opted out of (its latest instruction on each is OPT_OUT). */
  readonly optedOut: ReadonlySet<Channel>;
  /** The channels an adapter sends today (A-374 (d): SMS, and IN_APP to staff). */
  readonly available: ReadonlySet<Channel>;
}

export type Route = { readonly kind: 'SEND'; readonly channel: Channel } | { readonly kind: 'SUPPRESS'; readonly channel: Channel; readonly reason: 'OPTED_OUT' | 'PREFERENCE_OFF' };

/**
 * The channel a message goes by (FR-NTF-004, FR-NTF-005): the trigger's channels, the recipient's preferred ones first
 * in the recipient's order, less any the recipient turned off and, for a reminder or marketing, any the number opted out
 * of; then the first an adapter sends. A reminder or marketing message with nothing left is suppressed (OPTED_OUT when an
 * opt-out took a channel away, else PREFERENCE_OFF), on the trigger's first channel, so the log shows it. A transactional
 * or operational message is never suppressed: with nothing left it goes by the trigger's first channel with an adapter.
 * When no channel left has an adapter the first left is chosen, so the message fails visibly instead of vanishing.
 */
export function routeMessage(facts: RouteFacts): Route {
  const rank = (channel: Channel) => {
    const at = facts.preferences.findIndex((p) => p.channel === channel);
    return at === -1 ? facts.preferences.length : at;
  };
  const ordered = [...facts.triggerChannels].sort((a, b) => rank(a) - rank(b));
  const turnedOff = new Set(facts.preferences.filter((p) => !p.isEnabled).map((p) => p.channel));
  const suppressible = suppressibleByOptOut(facts.category);
  const left = ordered.filter((c) => !turnedOff.has(c) && !(suppressible && facts.optedOut.has(c)));
  const pick = (channels: readonly Channel[]) => channels.find((c) => facts.available.has(c)) ?? channels[0];
  const chosen = pick(left);
  if (chosen !== undefined) return { kind: 'SEND', channel: chosen };
  const first = facts.triggerChannels[0]!;
  if (!suppressible) return { kind: 'SEND', channel: pick(facts.triggerChannels)! };
  return { kind: 'SUPPRESS', channel: first, reason: facts.triggerChannels.some((c) => facts.optedOut.has(c)) ? 'OPTED_OUT' : 'PREFERENCE_OFF' };
}

export interface PreferenceInput {
  readonly category: Category;
  readonly channel: Channel;
  readonly isEnabled: boolean;
  readonly quietFrom: string | null;
  readonly quietTo: string | null;
}

export interface PreferenceRule {
  readonly field: string;
  readonly rule: 'DUPLICATE_PREFERENCE' | 'QUIET_HOURS_INCOMPLETE' | 'QUIET_HOURS_EMPTY' | 'QUIET_HOURS_NOT_DELAYED';
}

/**
 * A recipient's preferences (replaceMyNotificationPreferences): each category and channel once, in the order of
 * preference; quiet hours as both ends or neither, never an empty window, and only on reminders and marketing, the
 * messages quiet hours delay (a transactional message is never delayed, so quiet hours on it would mislead).
 */
export function judgePreferences(input: readonly PreferenceInput[]): Result<readonly PreferenceInput[], PreferenceRule[]> {
  const rules: PreferenceRule[] = [];
  const seen = new Set<string>();
  input.forEach((p, index) => {
    const at = `/preferences/${String(index)}`;
    const key = `${p.category}:${p.channel}`;
    if (seen.has(key)) rules.push({ field: at, rule: 'DUPLICATE_PREFERENCE' });
    seen.add(key);
    if ((p.quietFrom === null) !== (p.quietTo === null)) rules.push({ field: `${at}/quietTo`, rule: 'QUIET_HOURS_INCOMPLETE' });
    else if (p.quietFrom !== null && p.quietFrom === p.quietTo) rules.push({ field: `${at}/quietTo`, rule: 'QUIET_HOURS_EMPTY' });
    else if (p.quietFrom !== null && !quietHoursApply(p.category)) rules.push({ field: `${at}/quietFrom`, rule: 'QUIET_HOURS_NOT_DELAYED' });
  });
  return rules.length === 0 ? ok(input) : err(rules);
}

export type RecipientKind = 'CUSTOMER' | 'CONTACT_ON_EVENT' | 'ROLE' | 'PRINCIPAL_ON_EVENT';

export interface TriggerRuleRule {
  readonly field: string;
  readonly rule: 'NO_CHANNEL' | 'DUPLICATE_CHANNEL' | 'CHANNEL_NOT_FOR_RECIPIENT' | 'TEMPLATE_FIXED';
}

/** A customer is reached by phone or email, staff in the console (A-376 (d): staff SMS needs a staff number, not kept yet). */
const CHANNELS_FOR: Readonly<Record<RecipientKind, ReadonlySet<Channel>>> = {
  CUSTOMER: new Set(['SMS', 'WHATSAPP', 'EMAIL']),
  CONTACT_ON_EVENT: new Set(['SMS', 'WHATSAPP', 'EMAIL']),
  ROLE: new Set(['IN_APP']),
  PRINCIPAL_ON_EVENT: new Set(['IN_APP']),
};

/**
 * A change to a trigger (FR-NTF-002): its channels in order, at least one, each once, each one its recipient can have;
 * or turned off or on. Its template is its own: the code names the merge fields its event fills, so another code is
 * refused (a template's text is changed by a new version, FR-NTF-001).
 */
export function judgeTriggerUpdate(
  trigger: { readonly recipientKind: RecipientKind; readonly templateCode: string },
  update: { readonly channels?: readonly Channel[] | undefined; readonly isActive?: boolean | undefined; readonly templateCode?: string | undefined },
): TriggerRuleRule[] {
  const rules: TriggerRuleRule[] = [];
  if (update.channels !== undefined) {
    if (update.channels.length === 0) rules.push({ field: '/channels', rule: 'NO_CHANNEL' });
    else if (new Set(update.channels).size !== update.channels.length) rules.push({ field: '/channels', rule: 'DUPLICATE_CHANNEL' });
    else if (update.channels.some((c) => !CHANNELS_FOR[trigger.recipientKind].has(c))) rules.push({ field: '/channels', rule: 'CHANNEL_NOT_FOR_RECIPIENT' });
  }
  if (update.templateCode !== undefined && update.templateCode !== trigger.templateCode) rules.push({ field: '/templateCode', rule: 'TEMPLATE_FIXED' });
  return rules;
}
