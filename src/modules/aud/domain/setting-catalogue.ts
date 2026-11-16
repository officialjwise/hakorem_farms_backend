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
  'pur.supplier_score.price_weight': {
    key: 'pur.supplier_score.price_weight',
    valueType: 'INTEGER',
    description: 'The weight of price (against the average paid for the product) in a supplier score (FR-PUR-014); the score divides by the four weights together',
    defaultValue: 30,
    min: 0,
    max: 100,
    branchScoped: false,
  },
  'pur.supplier_score.lead_time_weight': {
    key: 'pur.supplier_score.lead_time_weight',
    valueType: 'INTEGER',
    description: 'The weight of lead time (on or before the promised day) in a supplier score (FR-PUR-014); the score divides by the four weights together',
    defaultValue: 25,
    min: 0,
    max: 100,
    branchScoped: false,
  },
  'pur.supplier_score.quality_weight': {
    key: 'pur.supplier_score.quality_weight',
    valueType: 'INTEGER',
    description: 'The weight of quality (the accepted share of what was received) in a supplier score (FR-PUR-014); the score divides by the four weights together',
    defaultValue: 25,
    min: 0,
    max: 100,
    branchScoped: false,
  },
  'pur.supplier_score.rejection_weight': {
    key: 'pur.supplier_score.rejection_weight',
    valueType: 'INTEGER',
    description: 'The weight of rejection (100 less the share sent back) in a supplier score (FR-PUR-014); the score divides by the four weights together',
    defaultValue: 20,
    min: 0,
    max: 100,
    branchScoped: false,
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
