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
  readonly defaultValue: number | boolean;
  /** The range of an integer setting; a boolean setting has neither and takes true or false. */
  readonly min: number;
  readonly max: number;
  /** Whether a branch may have its own value beside the farm-wide one. */
  readonly branchScoped: boolean;
  /**
   * A permission the person changing it must hold besides `aud.setting.manage`, for a setting only one role may change
   * (the checkout holding threshold, the Owner's: A-390 approved by the owner, 2026-11-24). Absent for most.
   */
  readonly permission?: string;
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
  // The offline till (OFFLINE_SYNC 5.2, B09b continued 2, A-277 (b)): each bound is the documented default, so the
  // owner may only make a till stricter (fewer hours, a shorter queue, a tighter clock), never looser.
  'pos.offline.max_hours': {
    key: 'pos.offline.max_hours',
    valueType: 'INTEGER',
    description: 'The most hours a till may sell offline since it last reached the server, and how long its offline pack is valid (OFFLINE_SYNC 5.1)',
    defaultValue: 8,
    min: 1,
    max: 8,
    branchScoped: true,
  },
  'pos.offline.max_queued_sales': {
    key: 'pos.offline.max_queued_sales',
    valueType: 'INTEGER',
    description: 'The most sales a till holds in its offline queue before it refuses another (OFFLINE_SYNC 5.1)',
    defaultValue: 500,
    min: 1,
    max: 500,
    branchScoped: true,
  },
  'pos.offline.allow_unverified_mobile_money': {
    key: 'pos.offline.allow_unverified_mobile_money',
    valueType: 'BOOLEAN',
    description: 'Whether a till at the branch may take a supervisor-approved mobile money tender offline, unverified until matched (OFFLINE_SYNC 5.3)',
    defaultValue: false,
    min: 0,
    max: 0,
    branchScoped: true,
  },
  'sync.clock_tolerance_seconds': {
    key: 'sync.clock_tolerance_seconds',
    valueType: 'INTEGER',
    description: 'How many seconds a time a till sends may be from the server clock (OFFLINE_SYNC 4.1, the owner on A-273 (g))',
    defaultValue: 300,
    min: 30,
    max: 300,
    branchScoped: false,
  },
  // B09b continued 2b (A-278 (c)): a synced sale older than this is still recorded, and flagged for the exception report.
  'sync.max_sale_age_hours': {
    key: 'sync.max_sale_age_hours',
    valueType: 'INTEGER',
    description: 'How many hours after it happened an offline sale may reach the server before it is flagged; it is recorded whatever its age (ADR-0027)',
    defaultValue: 8,
    min: 1,
    max: 8,
    branchScoped: false,
  },
  'pay.unverified_window_days': {
    key: 'pay.unverified_window_days',
    valueType: 'INTEGER',
    description: 'Days an unverified mobile money payment may stay unmatched before it is raised as urgent (OFFLINE_SYNC 9.9)',
    defaultValue: 3,
    min: 1,
    max: 3,
    branchScoped: false,
  },
  // The daily exception report's R18 rule (A-390 (f), approved by the owner on 2026-11-24): an address that lets this
  // many storefront checkouts end unpaid in a day, with none paid, is an item. The Owner's alone to change; the report
  // reads the value in force at each checkout, so a later change never rewrites an earlier day's items.
  'rpt.checkout_holding.unpaid_checkouts': {
    key: 'rpt.checkout_holding.unpaid_checkouts',
    valueType: 'INTEGER',
    description: 'How many storefront checkouts one address may let end unpaid in a day, with none paid, before the daily exception report raises it (R18)',
    defaultValue: 3,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    branchScoped: false,
    permission: 'rpt.exception_rules.manage',
  },
};

export type SettingRefusal = 'UNKNOWN_SETTING' | 'WRONG_TYPE' | 'OUT_OF_RANGE';

/** A new value checked against its definition: true or false for a boolean, otherwise an integer within the range. */
export function judgeSetting(key: string, value: unknown): Result<{ readonly definition: SettingDefinition; readonly value: number | boolean }, SettingRefusal> {
  const definition = SETTING_CATALOGUE[key];
  if (definition === undefined) return err('UNKNOWN_SETTING');
  if (definition.valueType === 'BOOLEAN') return typeof value === 'boolean' ? ok({ definition, value }) : err('WRONG_TYPE');
  if (typeof value !== 'number' || !Number.isInteger(value)) return err('WRONG_TYPE');
  if (value < definition.min || value > definition.max) return err('OUT_OF_RANGE');
  return ok({ definition, value });
}
