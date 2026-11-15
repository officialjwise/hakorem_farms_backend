import { z } from 'zod';
import { MAX_WEIGHINGS } from '../application/weights';

/** The contract's `Kilograms`, `Quantity` and `Pesewas` (carried inward as a bigint so no float touches it). */
const Kilograms = z.string().regex(/^(0|[1-9][0-9]{0,6})\.[0-9]{3}$/);
const Quantity = z.string().regex(/^(0|[1-9][0-9]{0,10})\.[0-9]{3}$/);
const Pesewas = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .transform((value) => BigInt(value));
const WeightSource = z.enum(['SCALE', 'MANUAL', 'ESTIMATE']);
const Instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const CalendarDate = z.iso.date();
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().min(1).max(512).optional();
const Bool = z.enum(['true', 'false']).transform((value) => value === 'true');
const Text = (max: number) => z.string().trim().min(1).max(max);
const AnimalStatus = z.enum(['ALIVE', 'SOLD', 'SLAUGHTERED', 'DEAD', 'CULLED']);
const HealthKind = z.enum(['VACCINATION', 'TREATMENT', 'CHECK', 'DEWORMING']);
const MortalityKind = z.enum(['DEATH', 'CULL']);
const MortalityStatus = z.enum(['REPORTED', 'PENDING_APPROVAL', 'POSTED', 'REJECTED']);
/** The most whole days a withdrawal period runs (the database check, migration 0076). */
const MAX_WITHDRAWAL_DAYS = 365;
/** The most birds one mortality record loses: a whole house of broilers. */
const MAX_HEAD = 100_000;

export const IdParam = z.uuid();

export const ListAnimalsQuery = z.strictObject({
  q: z.string().trim().min(1).max(40).optional(),
  speciesId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  status: AnimalStatus.optional(),
  sellable: Bool.optional(),
  purpose: z.enum(['GROWING', 'BREEDING']).optional(),
  weightBandId: z.uuid().optional(),
  cursor: Cursor,
  limit: Limit,
});

export const ListWeightRecordsQuery = z.strictObject({
  stockUnitId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  from: Instant.optional(),
  to: Instant.optional(),
  cursor: Cursor,
  limit: Limit,
});

/** The contract's `WeightRecordBatch`, strict. */
export const WeightRecordBatch = z.strictObject({
  records: z
    .array(
      z.strictObject({
        id: z.uuid(),
        stockUnitId: z.uuid(),
        weightKg: Kilograms,
        weightSource: WeightSource,
        headWeighed: z.number().int().min(1).max(MAX_HEAD).optional(),
        measuredAt: Instant,
      }),
    )
    .max(MAX_WEIGHINGS),
});

export const ListHealthEventsQuery = z.strictObject({
  stockUnitId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  kind: HealthKind.optional(),
  from: Instant.optional(),
  to: Instant.optional(),
  cursor: Cursor,
  limit: Limit,
});

/** The contract's `HealthEventCreate`, strict. */
export const HealthEventCreate = z.strictObject({
  id: z.uuid().optional(),
  kind: HealthKind,
  stockUnitId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  productId: z.uuid().optional(),
  dose: Text(80).optional(),
  qtyUsed: Quantity.optional(),
  withdrawalDays: z.number().int().min(0).max(MAX_WITHDRAWAL_DAYS).optional(),
  costPesewas: Pesewas.optional(),
  administeredBy: Text(120).optional(),
  notes: Text(1000).optional(),
  occurredAt: Instant,
});

export const ListMortalityRecordsQuery = z.strictObject({
  status: MortalityStatus.optional(),
  kind: MortalityKind.optional(),
  reportedBy: z.uuid().optional(),
  locationId: z.uuid().optional(),
  from: Instant.optional(),
  to: Instant.optional(),
  cursor: Cursor,
  limit: Limit,
});

/** The contract's `MortalityRecordCreate`, strict. */
export const MortalityRecordCreate = z.strictObject({
  id: z.uuid().optional(),
  kind: MortalityKind,
  stockUnitId: z.uuid(),
  head: z.number().int().min(1).max(MAX_HEAD).optional(),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
  foundAt: Instant,
  photoFileId: z.uuid().optional(),
  disposalNote: Text(500).optional(),
});

export const ListRationsQuery = z.strictObject({ speciesId: z.uuid().optional(), cursor: Cursor, limit: Limit });

/** The contract's `RationCreate`, strict. */
export const RationCreate = z.strictObject({
  name: Text(120),
  speciesId: z.uuid(),
  feedProductId: z.uuid(),
  qtyPerHeadPerDay: Quantity,
  stage: Text(40).optional(),
});

/** The contract's `RationUpdate`, strict. */
export const RationUpdate = z.strictObject({
  version: z.number().int().min(1),
  name: Text(120).optional(),
  qtyPerHeadPerDay: Quantity.optional(),
  stage: Text(40).optional(),
});

export const ListFeedConsumptionQuery = z.strictObject({ locationId: z.uuid().optional(), from: CalendarDate.optional(), to: CalendarDate.optional(), cursor: Cursor, limit: Limit });

/** The contract's `FeedConsumptionCreate`, strict. */
export const FeedConsumptionCreate = z.strictObject({
  id: z.uuid().optional(),
  locationId: z.uuid(),
  feedProductId: z.uuid(),
  qty: Quantity,
  consumedOn: CalendarDate,
  rationId: z.uuid().optional(),
  fromLocationId: z.uuid().optional(),
});

const Sex = z.enum(['MALE', 'FEMALE', 'UNKNOWN']);
const BatchPurpose = z.enum(['GROWING', 'BREEDING', 'LAYING']);
/** The largest flock one batch starts with: a whole hatchery run. */
const MAX_BATCH_HEAD = 100_000;
/** The largest litter or clutch one birth records. */
const MAX_LITTER = 30;
const Tag = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/_-]{0,39}$/);

/** The contract's `AnimalUpdate`, strict: species, acquisition, source and cost are not fields at all (FR-LIV-002). */
export const AnimalUpdate = z.strictObject({
  version: z.number().int().min(1),
  breed: Text(80).optional(),
  purpose: z.enum(['GROWING', 'BREEDING']).optional(),
  gradeId: z.uuid().optional(),
  sex: Sex.optional(),
  tagNo: Tag.optional(),
});

/** The contract's `AnimalMove`, strict. */
export const AnimalMove = z.strictObject({
  toLocationId: z.uuid(),
  note: Text(500).optional(),
});

export const TimelineQuery = z.strictObject({ cursor: Cursor, limit: Limit });

export const ListGrowthQuery = z.strictObject({
  groupBy: z.enum(['PEN', 'BATCH']),
  from: CalendarDate,
  to: CalendarDate,
  speciesId: z.uuid().optional(),
  cursor: Cursor,
  limit: Limit,
});

export const ListBatchesQuery = z.strictObject({
  status: z.enum(['ACTIVE', 'CLOSED']).optional(),
  speciesId: z.uuid().optional(),
  cursor: Cursor,
  limit: Limit,
});

/** The contract's `BatchCreate`, strict. */
export const BatchCreate = z.strictObject({
  batchNo: Tag,
  speciesId: z.uuid(),
  startedOn: CalendarDate,
  initialHead: z.number().int().min(1).max(MAX_BATCH_HEAD),
  purpose: BatchPurpose,
  locationId: z.uuid(),
});

/** The contract's `BatchUpdate`, strict. */
export const BatchUpdate = z.strictObject({
  version: z.number().int().min(1),
  purpose: BatchPurpose.optional(),
});

/** The contract's `ReasonRequest`, strict. */
export const ReasonRequest = z.strictObject({ reason: Text(500) });

export const ListBreedingRecordsQuery = z.strictObject({
  status: z.enum(['MATED', 'CONFIRMED', 'BORN', 'FAILED']).optional(),
  damId: z.uuid().optional(),
  dueBefore: CalendarDate.optional(),
  cursor: Cursor,
  limit: Limit,
});

/** The contract's `BreedingRecordCreate`, strict. */
export const BreedingRecordCreate = z.strictObject({
  damId: z.uuid(),
  sireId: z.uuid().optional(),
  matedOn: CalendarDate,
  expectedBirthOn: CalendarDate.optional(),
  notes: Text(1000).optional(),
});

/** The contract's `BreedingRecordUpdate`, strict. */
export const BreedingRecordUpdate = z.strictObject({
  version: z.number().int().min(1),
  expectedBirthOn: CalendarDate.optional(),
  status: z.enum(['MATED', 'CONFIRMED']).optional(),
  notes: Text(1000).optional(),
});

/** The contract's `BirthRecord`, strict: a weight given carries its source (FR-LIV-004). */
export const BirthRecord = z.strictObject({
  actualBirthOn: CalendarDate,
  litterSize: z.number().int().min(1).max(MAX_LITTER),
  offspring: z
    .array(
      z
        .strictObject({ tagNo: Tag, sex: Sex, weightKg: Kilograms.optional(), weightSource: WeightSource.optional() })
        .refine((kid) => (kid.weightKg === undefined) === (kid.weightSource === undefined), { message: 'a weight and its source come together', path: ['weightSource'] }),
    )
    .max(MAX_LITTER),
  notes: Text(1000).optional(),
});
