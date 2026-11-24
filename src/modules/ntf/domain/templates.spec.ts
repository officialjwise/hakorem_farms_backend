import { describe, expect, it } from 'vitest';
import { isTemplateCode, judgeTemplate, mergeFieldsOf, preview, render, smsSegments, TEMPLATE_CODES, type TemplateDraft } from './templates';

const draft = (overrides: Partial<TemplateDraft> = {}): TemplateDraft => ({
  code: 'ORDER_DISPATCHED',
  channel: 'SMS',
  category: 'TRANSACTIONAL',
  subject: null,
  body: 'HaKorem Farms: order {{orderNo}} has left the farm. Total {{total}}, to pay on delivery {{codDue}}.',
  providerTemplateRef: null,
  ...overrides,
});
const rules = (d: TemplateDraft) => {
  const judged = judgeTemplate(d);
  return judged.ok ? [] : judged.error.map((r) => `${r.field}:${r.rule}`);
};

describe('a message template (FR-NTF-001)', () => {
  it('accepts a known code in its category naming only its own merge fields', () => {
    expect(rules(draft())).toEqual([]);
    expect(mergeFieldsOf(draft().body)).toEqual(['orderNo', 'total', 'codDue']);
    expect(mergeFieldsOf('{{orderNo}} {{orderNo}}')).toEqual(['orderNo']);
  });

  it('refuses a misspelt merge field ({{totl}}), an unknown code and a code in another category', () => {
    expect(rules(draft({ body: 'Order {{orderNo}}: {{totl}}' }))).toEqual(['/body:UNKNOWN_MERGE_FIELD']);
    expect(rules(draft({ body: 'Order {{ orderNo }} for {{}}' }))).toEqual(['/body:UNKNOWN_MERGE_FIELD']);
    expect(rules(draft({ code: 'ORDER_TELEPORTED' }))).toEqual(['/code:UNKNOWN_TEMPLATE_CODE']);
    expect(rules(draft({ category: 'MARKETING' }))).toEqual(['/category:CATEGORY_MISMATCH']);
    expect(isTemplateCode('constructor')).toBe(false);
  });

  it('refuses a link typed into the text, the phishing template of abuse case 57, in any spelling', () => {
    for (const body of ['Pay at https://hakorem-pay.example now', 'Pay at http://x.example', 'See www.hakorem.example', 'Visit hakorem-farms.gh/pay', 'Go to bit.ly/abc', 'track.click/x']) {
      expect(rules(draft({ body })), body).toEqual(['/body:LINK_NOT_ALLOWED']);
    }
    expect(rules(draft({ channel: 'EMAIL', subject: 'Order at www.x.example', body: 'Order {{orderNo}}' }))).toEqual(['/subject:LINK_NOT_ALLOWED']);
    expect(rules(draft({ body: 'Order {{orderNo}} costs GHS 1,379.00. Thank you.' }))).toEqual([]);
  });

  it('a subject is for email only, and email needs one; an empty or overlong body is refused', () => {
    expect(rules(draft({ subject: 'Your order' }))).toEqual(['/subject:SUBJECT_EMAIL_ONLY']);
    expect(rules(draft({ channel: 'EMAIL', subject: null }))).toEqual(['/subject:SUBJECT_REQUIRED']);
    expect(rules(draft({ channel: 'EMAIL', subject: '  ' }))).toEqual(['/subject:SUBJECT_REQUIRED']);
    expect(rules(draft({ channel: 'EMAIL', subject: 'Order {{orderNo}} {{nope}}' }))).toEqual(['/subject:UNKNOWN_MERGE_FIELD']);
    expect(rules(draft({ channel: 'EMAIL', subject: 'x'.repeat(201) }))).toEqual(['/subject:TOO_LONG']);
    expect(rules(draft({ body: '   ' }))).toEqual(['/body:EMPTY_BODY']);
  });

  it('an in-app notification has a title, as an email its subject (B11 continued 11); a reminder is a REMINDER', () => {
    const returned = { code: 'MORTALITY_RETURNED', channel: 'IN_APP' as const, category: 'OPERATIONAL' as const, body: 'The death report of {{tagNo}} came back: {{reason}}.' };
    expect(rules(draft({ ...returned, subject: 'Death report sent back' }))).toEqual([]);
    expect(rules(draft({ ...returned, subject: null }))).toEqual(['/subject:SUBJECT_REQUIRED']);
    expect(rules(draft({ code: 'PAYMENT_REMINDER_2', category: 'REMINDER', body: '{{documentNo}}: {{outstanding}} is {{daysPastDue}} days late, {{customerName}}.' }))).toEqual([]);
    expect(rules(draft({ code: 'PAYMENT_REMINDER_1', category: 'TRANSACTIONAL', body: '{{documentNo}}' }))).toEqual(['/category:CATEGORY_MISMATCH']);
    expect(rules(draft({ body: 'x'.repeat(1_001) }))).toEqual(['/body:TOO_LONG']);
  });

  it('renders each field, an absent one as nothing, never as its name', () => {
    expect(render('{{orderNo}} / {{total}}', { orderNo: 'SO-1' })).toBe('SO-1 / ');
  });

  it('previews with the code\'s samples under the caller\'s data, "GHS 940.00" for the total, and refuses an unknown sample key', () => {
    const shown = preview('ORDER_COLLECTED', null, 'Total {{total}} for {{orderNo}}', { orderNo: 'SO-2026-000007' });
    expect(shown).toEqual({ ok: true, value: { subject: null, body: 'Total GHS 940.00 for SO-2026-000007', characterCount: 35, smsSegments: 1 } });
    expect(preview('ORDER_COLLECTED', 'S {{orderNo}}', 'x', {})).toMatchObject({ ok: true, value: { subject: 'S SO-2026-000142' } });
    expect(preview('ORDER_COLLECTED', null, 'x', { totl: '1' })).toEqual({ ok: false, error: [{ field: '/data', rule: 'UNKNOWN_MERGE_FIELD' }] });
    expect(TEMPLATE_CODES.ORDER_DISPATCHED.fields.total).toBe('GHS 940.00');
  });

  it('counts SMS parts: 160 GSM characters in one, 161 in two of 153, the extended ones twice, UCS-2 at 70 and 67', () => {
    expect(smsSegments('')).toBe(0);
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments('a'.repeat(306))).toBe(2);
    expect(smsSegments('a'.repeat(307))).toBe(3);
    expect(smsSegments('€'.repeat(80))).toBe(1);
    expect(smsSegments('€'.repeat(81))).toBe(2);
    expect(smsSegments('₵'.repeat(70))).toBe(1);
    expect(smsSegments('₵'.repeat(71))).toBe(2);
    expect(smsSegments('₵'.repeat(134))).toBe(2);
    expect(smsSegments('₵'.repeat(135))).toBe(3);
  });
});
