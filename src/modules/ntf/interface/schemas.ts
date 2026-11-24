import { z } from 'zod';
import { CATEGORIES, CHANNELS, TEMPLATE_STATUSES } from '../domain/templates';
import { MESSAGE_STATUSES } from '../domain/messages';

export const IdParam = z.uuid();
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().min(1).max(512).optional();
const Code = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);

export const TemplatePageQuery = z.object({
  code: Code.optional(),
  channel: z.enum(CHANNELS).optional(),
  status: z.enum(TEMPLATE_STATUSES).optional(),
  cursor: Cursor,
  limit: Limit,
});

export const TemplateCreate = z.strictObject({
  code: Code,
  channel: z.enum(CHANNELS),
  locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/).optional(),
  category: z.enum(CATEGORIES),
  subject: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(1_000),
  providerTemplateRef: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(),
});

/** Sample values for a preview: each a short text, keyed by merge field. */
export const TemplatePreview = z.strictObject({
  data: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/), z.union([z.string().max(200), z.number().transform(String)])).refine((d) => Object.keys(d).length <= 40),
});

export const MessagePageQuery = z.object({
  status: z.enum(MESSAGE_STATUSES).optional(),
  channel: z.enum(CHANNELS).optional(),
  customerId: z.uuid().optional(),
  templateCode: Code.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  cursor: Cursor,
  limit: Limit,
});

export const ProviderParam = z.enum(['GENERIC_HTTP', 'HUBTEL', 'META_WHATSAPP', 'SENDGRID']);

/**
 * A messaging provider's webhook body as the contract documents it (receiveMessagingWebhook). The route reads the raw
 * bytes and checks their signature before anything is parsed, so it validates nothing with this; the contract test does.
 */
export const MessagingWebhookBody = z.looseObject({ type: z.enum(['delivery', 'inbound']) });

export const PageQuery = z.object({ cursor: Cursor, limit: Limit });

const LocalTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);

/** `NotificationPreferencesReplace`: the whole list, in order of preference within each category. */
export const PreferencesReplace = z.strictObject({
  preferences: z
    .array(
      z.strictObject({
        category: z.enum(CATEGORIES),
        channel: z.enum(CHANNELS),
        isEnabled: z.boolean(),
        quietFrom: LocalTime.optional(),
        quietTo: LocalTime.optional(),
      }),
    )
    .max(16),
});

/** `TriggerRuleUpdate`. */
export const TriggerUpdate = z.strictObject({
  version: z.number().int().min(1),
  channels: z.array(z.enum(CHANNELS)).max(4).optional(),
  isActive: z.boolean().optional(),
  templateCode: Code.optional(),
});

export const MyNotificationsQuery = z.object({
  unreadOnly: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  cursor: Cursor,
  limit: Limit,
});
