import { err, ok, type Result } from '@hakorem/kernel';

/**
 * The settings that may be changed without a deployment (FR-AUD-007), each with its type, range and the default the
 * reading code applies when no row exists. A key is only text here: AUD imports nothing from the module that reads it.
 * Pure.
 */
export type SettingValueType = 'BOOLEAN' | 'INTEGER' | 'PESEWAS' | 'PERCENT' | 'TEXT' | 'JSON';

export interface SettingDefinition {
  readonly key: string;
  readonly valueType: SettingValueType;
  readonly description: string;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
  /** Whether a branch may have its own value beside the farm-wide one. */
  readonly branchScoped: boolean;
}

export const SETTING_CATALOGUE: Readonly<Record<string, SettingDefinition>> = {
  'pur.purchase_order.approval_limit_pesewas': {
    key: 'pur.purchase_order.approval_limit_pesewas',
    valueType: 'PESEWAS',
    description: 'A purchase order whose gross is above this many pesewas needs approval by a different person (FR-PUR-005)',
    defaultValue: 200_000,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    branchScoped: true,
  },
};

export type SettingRefusal = 'UNKNOWN_SETTING' | 'WRONG_TYPE' | 'OUT_OF_RANGE';

/** A new value checked against its definition: an integer of pesewas within the range. */
export function judgeSetting(key: string, value: unknown): Result<{ readonly definition: SettingDefinition; readonly value: number }, SettingRefusal> {
  const definition = SETTING_CATALOGUE[key];
  if (definition === undefined) return err('UNKNOWN_SETTING');
  if (typeof value !== 'number' || !Number.isInteger(value)) return err('WRONG_TYPE');
  if (value < definition.min || value > definition.max) return err('OUT_OF_RANGE');
  return ok({ definition, value });
}
