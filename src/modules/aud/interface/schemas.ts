import { z } from 'zod';

export const SettingKeyParam = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/).max(120);

/** The contract's `SettingUpdate`, strict; the catalogue checks the value against the key's type and range. */
export const SettingUpdate = z.strictObject({
  value: z.unknown().refine((value) => value !== undefined, 'is required'),
  branchId: z.uuid().optional(),
  validFrom: z.iso.datetime({ offset: true }).optional(),
  version: z.number().int().min(0),
});

/** The contract's `PhoneNumber`: E.164 only. A profile's numbers are printed and dialled as stored, so none is normalised. */
const PhoneNumber = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
const Time = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);

/** The contract's `OpeningInterval`: one opening of one day, in Africa/Accra time. */
const OpeningInterval = z.strictObject({
  day: z.enum(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']),
  opens: Time,
  closes: Time,
});

/** The contract's `BusinessProfileUpdate`, strict: the whole profile, an optional field left out being cleared. */
export const BusinessProfileUpdate = z.strictObject({
  version: z.number().int().min(0),
  legalName: z.string().trim().min(1).max(200),
  tradingName: z.string().trim().min(1).max(120),
  tin: z.string().trim().min(1).max(40).optional(),
  vatNumber: z.string().trim().min(1).max(40).optional(),
  address: z.string().trim().min(1).max(300),
  phone: PhoneNumber,
  whatsapp: PhoneNumber.optional(),
  email: z.email().max(254),
  logoFileId: z.uuid().optional(),
  directions: z.string().trim().min(1).max(500).optional(),
  openingHours: z.array(OpeningInterval).max(21).optional(),
});
