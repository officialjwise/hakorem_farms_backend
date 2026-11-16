import { z } from 'zod';

const LocalTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
const CalendarDate = z.iso.date();

export const IdParam = z.uuid();
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().min(1).max(512).optional();

export const SlotGenerate = z.strictObject({
  zoneId: z.uuid(),
  from: CalendarDate,
  to: CalendarDate,
  weekdays: z.array(z.number().int()).max(7),
  times: z.array(z.strictObject({ startsAt: LocalTime, endsAt: LocalTime, capacity: z.number().int() })).max(24),
});

export const SlotUpdate = z.strictObject({ version: z.number().int().min(1), capacity: z.number().int() });

export const DeliverySlotPageQuery = z.object({ zoneId: z.uuid().optional(), from: CalendarDate.optional(), to: CalendarDate.optional(), cursor: Cursor, limit: Limit });
