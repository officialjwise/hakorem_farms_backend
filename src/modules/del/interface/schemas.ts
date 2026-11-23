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

const DeliveryStatus = z.enum(['SCHEDULED', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED']);
const Coordinate = z.string().regex(/^-?[0-9]{1,3}\.[0-9]{1,6}$/);
const Pesewas = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const DeliveryPageQuery = z.object({
  date: CalendarDate.optional(),
  status: DeliveryStatus.optional(),
  driverId: z.uuid().optional(),
  zoneId: z.uuid().optional(),
  orderId: z.uuid().optional(),
  cursor: Cursor,
  limit: Limit,
});

export const ProofOfDeliveryCreate = z.strictObject({
  id: z.uuid(),
  recipientName: z.string().trim().min(1).max(160),
  signatureFileId: z.uuid().optional(),
  photoFileId: z.uuid().optional(),
  latitude: Coordinate.optional(),
  longitude: Coordinate.optional(),
  positionAccuracyM: z.number().int().min(0).max(100_000).optional(),
  codCollectedPesewas: Pesewas,
  codVarianceReasonCode: z.string().min(1).max(64).optional(),
  codVarianceNote: z.string().trim().min(1).max(500).optional(),
  capturedAt: z.iso.datetime({ offset: true }),
});
