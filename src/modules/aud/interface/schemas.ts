import { z } from 'zod';

export const SettingKeyParam = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/).max(120);

/** The contract's `SettingUpdate`, strict; the catalogue checks the value against the key's type and range. */
export const SettingUpdate = z.strictObject({
  value: z.unknown().refine((value) => value !== undefined, 'is required'),
  branchId: z.uuid().optional(),
  validFrom: z.iso.datetime({ offset: true }).optional(),
  version: z.number().int().min(0),
});
