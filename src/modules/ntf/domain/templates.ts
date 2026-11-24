import { err, ok, type Result } from '@hakorem/kernel';
import type { LinkKind } from './links';

/** The channels a template may be written for (docs/data-model/ntf.md). Only SMS has an adapter yet (A-374 (d)). */
export const CHANNELS = ['SMS', 'WHATSAPP', 'EMAIL', 'IN_APP'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CATEGORIES = ['TRANSACTIONAL', 'REMINDER', 'MARKETING', 'OPERATIONAL'] as const;
export type Category = (typeof CATEGORIES)[number];
export const TEMPLATE_STATUSES = ['DRAFT', 'ACTIVE', 'RETIRED'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

/** The longest body a template may carry: a WhatsApp or email body; an SMS this long goes out in many parts. */
export const MAX_BODY_LENGTH = 1_000;
export const MAX_SUBJECT_LENGTH = 200;
/** One SMS part in the GSM 7-bit alphabet, and each part of a longer one (the user data header takes 7 characters). */
const GSM_SINGLE = 160;
const GSM_PART = 153;
/** The same in UCS-2, which any character outside the GSM alphabet forces. */
const UCS2_SINGLE = 70;
const UCS2_PART = 67;
/** The GSM 03.38 basic alphabet, and the extension characters that take two places each. */
const GSM_BASIC = new Set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà");
const GSM_EXTENDED = new Set('^{}\\[~]|€');

/** A named merge field: `{{orderNo}}`. Letters and digits, starting with a lower-case letter. */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const FIELD_NAME = /^[a-z][A-Za-z0-9]{0,39}$/;
/**
 * A link written into a template's text (abuse case 57, A-374 (c)): a template edited to carry a phishing link. A link
 * a message needs is filled in by the server through a merge field, never typed into the template.
 */
const WRITTEN_LINK = /(https?:|www\.|\b[a-z0-9-]+\.(?:com|net|org|gh|io|ly|co|me|info|biz|xyz|app|link|site|online|top|click)\b)/i;

/**
 * The messages NTF knows how to send, each with the merge fields its sender fills and a sample to preview with. A
 * template's code must be one of these, and its body may name only these fields (FR-NTF-001).
 */
export const TEMPLATE_CODES = {
  ORDER_DISPATCHED: {
    category: 'TRANSACTIONAL',
    fields: { orderNo: 'SO-2026-000142', deliveryNo: 'DLV-2026-000311', total: 'GHS 940.00', codDue: 'GHS 940.00', dueDate: '2026-12-24', items: '1 Eggs, big (crate of 30)', backorderNo: 'SO-2026-000143', slot: '25 Nov, 08:00 to 10:00' },
  },
  ORDER_COLLECTED: {
    category: 'TRANSACTIONAL',
    fields: { orderNo: 'SO-2026-000142', documentNo: 'INV-2026-DDW-000088', total: 'GHS 940.00', dueAtTill: 'GHS 0.00', dueDate: '2026-12-24' },
  },
  DELIVERY_ON_THE_WAY: {
    category: 'TRANSACTIONAL',
    fields: { orderNo: 'SO-2026-000142', deliveryNo: 'DLV-2026-000311', eta: '30 minutes' },
  },
  DELIVERY_RESCHEDULED: {
    category: 'TRANSACTIONAL',
    fields: { orderNo: 'SO-2026-000142', deliveryNo: 'DLV-2026-000311', slotDate: '2026-11-26', slotStart: '14:00', slotEnd: '16:00' },
  },
  DELIVERY_CANCELLED: {
    category: 'TRANSACTIONAL',
    fields: { orderNo: 'SO-2026-000142', deliveryNo: 'DLV-2026-000311' },
  },
  DELIVERY_COMPLETED: {
    category: 'TRANSACTIONAL',
    fields: { orderNo: 'SO-2026-000142', deliveryNo: 'DLV-2026-000311', collected: 'GHS 940.00' },
  },
  DELIVERY_PART_COMPLETED: {
    category: 'TRANSACTIONAL',
    fields: { orderNo: 'SO-2026-000142', deliveryNo: 'DLV-2026-000311', collected: 'GHS 880.00', returnedCredit: 'GHS 60.00' },
  },
  // B11 continued 11 (A-376): WHL's reminder levels send these (whl.DunningNoticeDue); a level names one of them.
  PAYMENT_REMINDER_1: {
    category: 'REMINDER',
    fields: { customerName: 'Asantewaa Chop Bar', documentNo: 'INV-2026-DDW-000088', outstanding: 'GHS 1,275.00', daysPastDue: '7' },
  },
  PAYMENT_REMINDER_2: {
    category: 'REMINDER',
    fields: { customerName: 'Asantewaa Chop Bar', documentNo: 'INV-2026-DDW-000088', outstanding: 'GHS 1,275.00', daysPastDue: '30' },
  },
  PAYMENT_REMINDER_3: {
    category: 'REMINDER',
    fields: { customerName: 'Asantewaa Chop Bar', documentNo: 'INV-2026-DDW-000088', outstanding: 'GHS 1,275.00', daysPastDue: '60' },
  },
  // B11 continued 11 (A-376 (e), B06r, A-175): a death report sent back to its reporter because its photograph failed the scan.
  MORTALITY_RETURNED: {
    category: 'OPERATIONAL',
    fields: { tagNo: 'G-0171', reason: 'the photograph did not pass the virus scan' },
  },
  // B11 continued 12: the messages that carry a link, each made by the record's own module when the message is sent
  // (`link`, ADR-0074); the stored text keeps `{{link}}` unfilled. The cart reminder names nothing that was in the cart.
  ORDER_TRACKING: {
    category: 'TRANSACTIONAL',
    link: 'TRACKING',
    fields: { orderNo: 'SO-2026-000142', link: 'https://shop.example/track/trk_EXAMPLE-not-a-real-token' },
  },
  SALE_RECEIPT: {
    category: 'TRANSACTIONAL',
    link: 'RECEIPT',
    fields: { saleReference: 'SO-2026-000150', receiptNo: 'RCT-2026-DDW-000231', total: 'GHS 94.00', link: 'https://shop.example/r/EXAMPLE-not-a-real-token' },
  },
  CART_REMINDER: {
    category: 'MARKETING',
    link: 'CART',
    fields: { customerName: 'Akua', link: 'https://shop.example/cart' },
  },
  DOCUMENT_SENT: {
    category: 'TRANSACTIONAL',
    link: 'DOCUMENT',
    fields: { documentNo: 'INV-2026-DDW-000088', documentType: 'invoice', total: 'GHS 940.00', link: 'https://shop.example/d/doc_EXAMPLE-not-a-real-token' },
  },
  REMITTANCE_ADVICE: {
    category: 'TRANSACTIONAL',
    link: 'DOCUMENT',
    fields: { supplierName: 'Abokobi Feeds', amount: 'GHS 4,800.00', paidOn: '2026-11-24', link: 'https://shop.example/d/doc_EXAMPLE-not-a-real-token' },
  },
} as const satisfies Record<string, { readonly category: Category; readonly link?: LinkKind; readonly fields: Readonly<Record<string, string>> }>;

export type TemplateCode = keyof typeof TEMPLATE_CODES;

export function isTemplateCode(code: string): code is TemplateCode {
  return Object.hasOwn(TEMPLATE_CODES, code);
}

export interface TemplateDraft {
  readonly code: string;
  readonly channel: Channel;
  readonly category: Category;
  readonly subject: string | null;
  readonly body: string;
  readonly providerTemplateRef: string | null;
}

export interface TemplateRule {
  readonly field: string;
  readonly rule: 'UNKNOWN_TEMPLATE_CODE' | 'CATEGORY_MISMATCH' | 'UNKNOWN_MERGE_FIELD' | 'LINK_NOT_ALLOWED' | 'SUBJECT_EMAIL_ONLY' | 'SUBJECT_REQUIRED' | 'EMPTY_BODY' | 'TOO_LONG';
}

/** The merge fields a text names, in order of first use. */
export function mergeFieldsOf(text: string): string[] {
  const seen: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1] as string;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

function textRules(text: string, where: string, code: TemplateCode | null): TemplateRule[] {
  const rules: TemplateRule[] = [];
  // An unknown code has no fields to check against: its own rule says so once.
  if (code !== null && mergeFieldsOf(text).some((name) => !FIELD_NAME.test(name) || !Object.hasOwn(TEMPLATE_CODES[code].fields, name))) rules.push({ field: where, rule: 'UNKNOWN_MERGE_FIELD' });
  if (WRITTEN_LINK.test(text.replace(PLACEHOLDER, ''))) rules.push({ field: where, rule: 'LINK_NOT_ALLOWED' });
  return rules;
}

/** An email's subject, and an in-app notification's title (B11 continued 11): the channels whose message has a heading. */
export function titled(channel: Channel): boolean {
  return channel === 'EMAIL' || channel === 'IN_APP';
}

/**
 * Whether a template may be drafted (FR-NTF-001): a known code in its own category; a body (and an email's subject or an
 * in-app title) naming only that code's merge fields and carrying no link of its own; a subject on email and in-app
 * only (`SUBJECT_EMAIL_ONLY` keeps its name: an in-app title is the one other heading, B11 continued 11).
 */
export function judgeTemplate(draft: TemplateDraft): Result<TemplateDraft, TemplateRule[]> {
  const rules: TemplateRule[] = [];
  const code = isTemplateCode(draft.code) ? draft.code : null;
  if (code === null) rules.push({ field: '/code', rule: 'UNKNOWN_TEMPLATE_CODE' });
  else if (TEMPLATE_CODES[code].category !== draft.category) rules.push({ field: '/category', rule: 'CATEGORY_MISMATCH' });
  if (draft.body.trim().length === 0) rules.push({ field: '/body', rule: 'EMPTY_BODY' });
  if (draft.body.length > MAX_BODY_LENGTH) rules.push({ field: '/body', rule: 'TOO_LONG' });
  rules.push(...textRules(draft.body, '/body', code));
  if (titled(draft.channel) && (draft.subject === null || draft.subject.trim().length === 0)) rules.push({ field: '/subject', rule: 'SUBJECT_REQUIRED' });
  if (!titled(draft.channel) && draft.subject !== null) rules.push({ field: '/subject', rule: 'SUBJECT_EMAIL_ONLY' });
  if (draft.subject !== null) {
    if (draft.subject.length > MAX_SUBJECT_LENGTH) rules.push({ field: '/subject', rule: 'TOO_LONG' });
    rules.push(...textRules(draft.subject, '/subject', code));
  }
  return rules.length === 0 ? ok(draft) : err(rules);
}

/** Fills each merge field with its value; a field with no value is left empty, never left as its name. */
export function render(text: string, data: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (_whole, name: string) => (Object.hasOwn(data, name) ? (data[name] as string) : ''));
}

/** How many SMS parts a text takes: GSM 7-bit (160, then 153 a part) unless a character forces UCS-2 (70, then 67). */
export function smsSegments(text: string): number {
  const characters = [...text];
  if (characters.length === 0) return 0;
  const gsm = characters.every((c) => GSM_BASIC.has(c) || GSM_EXTENDED.has(c));
  if (gsm) {
    const length = characters.reduce((n, c) => n + (GSM_EXTENDED.has(c) ? 2 : 1), 0);
    return length <= GSM_SINGLE ? 1 : Math.ceil(length / GSM_PART);
  }
  return characters.length <= UCS2_SINGLE ? 1 : Math.ceil(characters.length / UCS2_PART);
}

/** A preview with the caller's sample data over the code's own samples (FR-NTF-001); unknown sample keys are refused. */
export function preview(code: TemplateCode, subject: string | null, body: string, data: Readonly<Record<string, string>>): Result<{ readonly subject: string | null; readonly body: string; readonly characterCount: number; readonly smsSegments: number }, TemplateRule[]> {
  const known = TEMPLATE_CODES[code].fields;
  const unknown = Object.keys(data).filter((key) => !Object.hasOwn(known, key));
  if (unknown.length > 0) return err(unknown.map(() => ({ field: '/data', rule: 'UNKNOWN_MERGE_FIELD' as const })).slice(0, 1));
  const values = { ...known, ...data };
  const renderedBody = render(body, values);
  return ok({ subject: subject === null ? null : render(subject, values), body: renderedBody, characterCount: [...renderedBody].length, smsSegments: smsSegments(renderedBody) });
}
