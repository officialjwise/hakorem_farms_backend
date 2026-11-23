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

const DeliveryStatus = z.enum(['SCHEDULED', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RETURNED', 'WRITTEN_OFF', 'CANCELLED']);
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

const Quantity = z.string().regex(/^(0|[1-9][0-9]{0,10})\.[0-9]{3}$/);

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
  lines: z.array(z.strictObject({ orderLineId: z.uuid(), deliveredQty: Quantity })).min(1).max(200).optional(),
  returnedReasonCode: z.string().min(1).max(64).optional(),
  returnedNote: z.string().trim().min(1).max(500).optional(),
  capturedAt: z.iso.datetime({ offset: true }),
});

const BooleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');

export const CashSummaryQuery = z.object({ date: CalendarDate.optional() });

export const DriverCashReconciliationPageQuery = z.object({
  driverId: z.uuid().optional(),
  from: CalendarDate.optional(),
  to: CalendarDate.optional(),
  varianceOnly: BooleanQuery.optional(),
  cursor: Cursor,
  limit: Limit,
});

export const DriverGoodsVariancePageQuery = z.object({
  driverId: z.uuid().optional(),
  from: CalendarDate.optional(),
  to: CalendarDate.optional(),
  cursor: Cursor,
  limit: Limit,
});

export const RouteCreate = z.strictObject({
  driverId: z.uuid(),
  routeDate: CalendarDate,
  vehicleLocationId: z.uuid(),
  deliveryIds: z.array(z.uuid()).max(100),
});

export const RouteStopsReplace = z.strictObject({ version: z.number().int().min(1), deliveryIds: z.array(z.uuid()).max(100) });

export const RoutePageQuery = z.object({ date: CalendarDate.optional(), driverId: z.uuid().optional(), cursor: Cursor, limit: Limit });

export const MyRouteQuery = z.object({ date: CalendarDate.optional() });

export const DriverPageQuery = z.object({ branchId: z.uuid().optional(), cursor: Cursor, limit: Limit });

export const OnTheWay = z.strictObject({ occurredAt: z.iso.datetime({ offset: true }), etaMinutes: z.number().int().min(0).max(1_440).optional() });

export const DeliveryFailure = z.strictObject({
  id: z.uuid(),
  failureReasonCode: z.string().min(1).max(64),
  nextAction: z.enum(['REATTEMPT', 'RETURN_TO_STOCK']),
  latitude: Coordinate.optional(),
  longitude: Coordinate.optional(),
  occurredAt: z.iso.datetime({ offset: true }),
});

/** syncDriverEvents' `DriverSyncBatch` (CR-057 point 3): each record by its own client id, never an `Idempotency-Key`. */
export const DriverSyncBatch = z.strictObject({
  proofs: z.array(z.strictObject({ deliveryId: z.uuid(), proof: ProofOfDeliveryCreate })).max(500),
  failures: z.array(z.strictObject({ deliveryId: z.uuid(), failure: DeliveryFailure })).max(500),
});

/** assignDelivery's `DeliveryAssign` (FR-DEL-004). */
export const DeliveryAssign = z.strictObject({ driverId: z.uuid(), vehicleLocationId: z.uuid() });

/** rescheduleDelivery's `DeliveryReschedule` (FR-DEL-003): the slot and why, 1 to 500 characters once trimmed. */
export const DeliveryReschedule = z.strictObject({ slotId: z.uuid(), reason: z.string().trim().min(1).max(500) });
