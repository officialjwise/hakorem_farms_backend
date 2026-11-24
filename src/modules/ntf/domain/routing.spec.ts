import { describe, expect, it } from 'vitest';
import {
  judgePreferences,
  judgeTriggerUpdate,
  localMinuteOfDay,
  quietHoursApply,
  quietUntil,
  readReply,
  routeMessage,
  suppressibleByOptOut,
  type PreferenceInput,
} from './routing';

const at = (iso: string) => new Date(iso);
const SMS_ONLY = new Set(['SMS'] as const);

describe('which categories an opt-out and quiet hours reach (FR-NTF-005, FR-NTF-006, A-376)', () => {
  it('reminders and marketing are suppressed by an opt-out and wait out quiet hours; transactional and operational never', () => {
    expect(['TRANSACTIONAL', 'REMINDER', 'MARKETING', 'OPERATIONAL'].map((c) => suppressibleByOptOut(c as never))).toEqual([false, true, true, false]);
    expect(['TRANSACTIONAL', 'REMINDER', 'MARKETING', 'OPERATIONAL'].map((c) => quietHoursApply(c as never))).toEqual([false, true, true, false]);
  });
});

describe('quiet hours in Africa/Accra (FR-NTF-006, SA-09: 21:00 to 07:00)', () => {
  it('reads the minute of the day in Accra', () => {
    expect(localMinuteOfDay(at('2026-11-24T22:30:00Z'))).toBe(22 * 60 + 30);
    expect(localMinuteOfDay(at('2026-11-24T00:00:59Z'))).toBe(0);
  });

  it('a reminder due at 22:30 waits until 07:00 the next day; one at 06:59 until 07:00; at 07:00 and at 20:59 it goes at once', () => {
    expect(quietUntil(at('2026-11-24T22:30:17Z'), null)).toEqual(at('2026-11-25T07:00:00Z'));
    expect(quietUntil(at('2026-11-25T06:59:00Z'), null)).toEqual(at('2026-11-25T07:00:00Z'));
    expect(quietUntil(at('2026-11-25T00:00:00Z'), null)).toEqual(at('2026-11-25T07:00:00Z'));
    expect(quietUntil(at('2026-11-24T21:00:00Z'), null)).toEqual(at('2026-11-25T07:00:00Z'));
    expect(quietUntil(at('2026-11-25T07:00:00Z'), null)).toBeNull();
    expect(quietUntil(at('2026-11-24T20:59:59Z'), null)).toBeNull();
  });

  it("a recipient's own quiet hours replace the default, across midnight or within a day", () => {
    expect(quietUntil(at('2026-11-24T20:15:00Z'), { from: '20:00', to: '06:30' })).toEqual(at('2026-11-25T06:30:00Z'));
    expect(quietUntil(at('2026-11-24T21:30:00Z'), { from: '22:00', to: '06:30' })).toBeNull();
    expect(quietUntil(at('2026-11-24T13:10:00Z'), { from: '12:00', to: '14:00' })).toEqual(at('2026-11-24T14:00:00Z'));
    expect(quietUntil(at('2026-11-24T14:00:00Z'), { from: '12:00', to: '14:00' })).toBeNull();
    expect(quietUntil(at('2026-11-24T11:59:00Z'), { from: '12:00', to: '14:00' })).toBeNull();
  });
});

describe('a reply from the recipient (FR-NTF-005: a STOP reply is an opt-out at once)', () => {
  it('STOP and its kin opt out, START opts back in, anything else is no instruction', () => {
    expect(['STOP', ' stop ', 'Stop please', 'STOPALL', 'UNSUBSCRIBE', 'cancel', 'END', 'quit'].map(readReply)).toEqual(Array(8).fill('OPT_OUT'));
    expect(['START', 'unstop', 'Start'].map(readReply)).toEqual(['OPT_IN', 'OPT_IN', 'OPT_IN']);
    expect(['Thank you', '', 'STOPPED', 'please stop', 'S T O P'].map(readReply)).toEqual([null, null, null, null, null]);
  });
});

describe('the channel a message goes by (FR-NTF-004, FR-NTF-005, A-376)', () => {
  it("with no preferences, the trigger's first channel with an adapter", () => {
    expect(routeMessage({ category: 'TRANSACTIONAL', triggerChannels: ['WHATSAPP', 'SMS'], preferences: [], optedOut: new Set(), available: SMS_ONLY })).toEqual({ kind: 'SEND', channel: 'SMS' });
  });

  it("the recipient's own order comes first, then the trigger's; a channel turned off is skipped", () => {
    const both = new Set(['SMS', 'WHATSAPP'] as const);
    expect(routeMessage({ category: 'REMINDER', triggerChannels: ['SMS', 'WHATSAPP'], preferences: [{ channel: 'WHATSAPP', isEnabled: true }], optedOut: new Set(), available: both })).toEqual({ kind: 'SEND', channel: 'WHATSAPP' });
    expect(routeMessage({ category: 'REMINDER', triggerChannels: ['WHATSAPP', 'SMS'], preferences: [{ channel: 'WHATSAPP', isEnabled: false }], optedOut: new Set(), available: both })).toEqual({ kind: 'SEND', channel: 'SMS' });
    expect(routeMessage({ category: 'REMINDER', triggerChannels: ['SMS'], preferences: [{ channel: 'EMAIL', isEnabled: true }], optedOut: new Set(), available: both })).toEqual({ kind: 'SEND', channel: 'SMS' });
  });

  it('a reminder or a marketing message to an opted-out channel is suppressed OPTED_OUT; one turned off is PREFERENCE_OFF', () => {
    expect(routeMessage({ category: 'REMINDER', triggerChannels: ['SMS'], preferences: [], optedOut: new Set(['SMS']), available: SMS_ONLY })).toEqual({ kind: 'SUPPRESS', channel: 'SMS', reason: 'OPTED_OUT' });
    expect(routeMessage({ category: 'MARKETING', triggerChannels: ['SMS', 'EMAIL'], preferences: [{ channel: 'EMAIL', isEnabled: false }], optedOut: new Set(['SMS']), available: SMS_ONLY })).toEqual({ kind: 'SUPPRESS', channel: 'SMS', reason: 'OPTED_OUT' });
    expect(routeMessage({ category: 'REMINDER', triggerChannels: ['SMS'], preferences: [{ channel: 'SMS', isEnabled: false }], optedOut: new Set(), available: SMS_ONLY })).toEqual({ kind: 'SUPPRESS', channel: 'SMS', reason: 'PREFERENCE_OFF' });
  });

  it('a transactional or operational message is never suppressed: with every channel off or opted out it goes by the first with an adapter', () => {
    for (const category of ['TRANSACTIONAL', 'OPERATIONAL'] as const) {
      expect(routeMessage({ category, triggerChannels: ['SMS'], preferences: [{ channel: 'SMS', isEnabled: false }], optedOut: new Set(['SMS']), available: SMS_ONLY })).toEqual({ kind: 'SEND', channel: 'SMS' });
    }
  });

  it('a channel with no adapter yet is chosen only when none has one, so the message fails visibly rather than vanishing', () => {
    expect(routeMessage({ category: 'TRANSACTIONAL', triggerChannels: ['WHATSAPP', 'EMAIL'], preferences: [], optedOut: new Set(), available: SMS_ONLY })).toEqual({ kind: 'SEND', channel: 'WHATSAPP' });
    expect(routeMessage({ category: 'REMINDER', triggerChannels: ['WHATSAPP'], preferences: [], optedOut: new Set(), available: SMS_ONLY })).toEqual({ kind: 'SEND', channel: 'WHATSAPP' });
  });
});

describe('preferences as a recipient sets them (replaceMyNotificationPreferences)', () => {
  const pref = (p: Partial<PreferenceInput>): PreferenceInput => ({ category: 'REMINDER', channel: 'SMS', isEnabled: true, quietFrom: null, quietTo: null, ...p });

  it('accepts each category and channel once, with quiet hours on reminders and marketing', () => {
    expect(judgePreferences([pref({}), pref({ channel: 'WHATSAPP' }), pref({ category: 'MARKETING', quietFrom: '20:00', quietTo: '08:00' }), pref({ category: 'TRANSACTIONAL' })])).toEqual({ ok: true, value: expect.any(Array) });
    expect(judgePreferences([])).toEqual({ ok: true, value: [] });
  });

  it('refuses a repeated category and channel, half a quiet window, an empty one, and quiet hours on a message that is never delayed', () => {
    const rules = (input: PreferenceInput[]) => {
      const verdict = judgePreferences(input);
      return verdict.ok ? [] : verdict.error;
    };
    expect(rules([pref({}), pref({ isEnabled: false })])).toEqual([{ field: '/preferences/1', rule: 'DUPLICATE_PREFERENCE' }]);
    expect(rules([pref({ quietFrom: '21:00' })])).toEqual([{ field: '/preferences/0/quietTo', rule: 'QUIET_HOURS_INCOMPLETE' }]);
    expect(rules([pref({ quietTo: '07:00' })])).toEqual([{ field: '/preferences/0/quietTo', rule: 'QUIET_HOURS_INCOMPLETE' }]);
    expect(rules([pref({ quietFrom: '07:00', quietTo: '07:00' })])).toEqual([{ field: '/preferences/0/quietTo', rule: 'QUIET_HOURS_EMPTY' }]);
    expect(rules([pref({ category: 'TRANSACTIONAL', quietFrom: '21:00', quietTo: '07:00' })])).toEqual([{ field: '/preferences/0/quietFrom', rule: 'QUIET_HOURS_NOT_DELAYED' }]);
  });
});

describe('a change to a trigger (updateNotificationTrigger, FR-NTF-002)', () => {
  const customer = { recipientKind: 'CONTACT_ON_EVENT' as const, templateCode: 'ORDER_DISPATCHED' };
  const staff = { recipientKind: 'PRINCIPAL_ON_EVENT' as const, templateCode: 'MORTALITY_RETURNED' };

  it('changes the channels in order or turns it off; its template stays its own', () => {
    expect(judgeTriggerUpdate(customer, { channels: ['WHATSAPP', 'SMS'] })).toEqual([]);
    expect(judgeTriggerUpdate(customer, { isActive: false, templateCode: 'ORDER_DISPATCHED' })).toEqual([]);
    expect(judgeTriggerUpdate(staff, { channels: ['IN_APP'] })).toEqual([]);
  });

  it('refuses no channel, a channel twice, a channel its recipient cannot have, and another template', () => {
    expect(judgeTriggerUpdate(customer, { channels: [] })).toEqual([{ field: '/channels', rule: 'NO_CHANNEL' }]);
    expect(judgeTriggerUpdate(customer, { channels: ['SMS', 'SMS'] })).toEqual([{ field: '/channels', rule: 'DUPLICATE_CHANNEL' }]);
    expect(judgeTriggerUpdate(customer, { channels: ['IN_APP'] })).toEqual([{ field: '/channels', rule: 'CHANNEL_NOT_FOR_RECIPIENT' }]);
    expect(judgeTriggerUpdate(staff, { channels: ['SMS'] })).toEqual([{ field: '/channels', rule: 'CHANNEL_NOT_FOR_RECIPIENT' }]);
    expect(judgeTriggerUpdate(customer, { templateCode: 'DELIVERY_COMPLETED' })).toEqual([{ field: '/templateCode', rule: 'TEMPLATE_FIXED' }]);
  });
});
